"""Document conversion for Niaro attachments: text the assistant can read.

A small HTTP service next to the Niaro server (docker compose profile
"documents"). It reads PDF, Word, Excel, PowerPoint, CSV/TSV, text and
photos locally, with Tesseract OCR in Czech and English, so files never
leave the machine. Two images share this server and differ in the engine:

  markitdown  MarkItDown + Tesseract; light (about 0.5 GB of memory)
  docling     Docling layout and table models + Tesseract; better tables and
              mixed pages, needs about 2 GB

  GET  /health    {"ready", "engine", "error"}
  POST /convert   body: the file (at most CONVERTER_MAX_BYTES)
                  query: name (the original file name, a hint only)
                  -> {"engine", "status", "reason", "pages", "blocks", "warnings"}

status is "complete", "partial" (some content could not be read, or OCR
was used and may contain mistakes; see warnings) or "failed" (reason says
why). Each block is {"source", "text", "method"}: source names where in the
file the text is ("page 3", "sheet Prices", "slide 2", "image"), text is
Markdown, method is "native" or "ocr".

With CONVERTER_TOKEN set, every request must carry it as a bearer token.
One file is converted at a time, in a child process that is killed when it
runs out of time; others get 503 busy, so the caller decides when to retry.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import multiprocessing
import os
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from common import Refused, markdown_table

ENGINE = os.environ.get("CONVERTER_ENGINE", "markitdown")
TOKEN = os.environ.get("CONVERTER_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BYTES = int(os.environ.get("CONVERTER_MAX_BYTES", str(25 * 1024 * 1024)))
TIMEOUT = int(os.environ.get("CONVERTER_TIMEOUT_SECONDS", "180"))
MAX_PAGES = int(os.environ.get("CONVERTER_MAX_PAGES", "100"))
# Text handed back; a longer document is cut at a block and marked partial.
MAX_TEXT = int(os.environ.get("CONVERTER_MAX_TEXT_BYTES", str(1024 * 1024)))
# An Office file is a ZIP; refuse ones that unpack to far more than they weigh.
OFFICE_EXPANDED = 64 * 1024 * 1024

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("converter")

state: dict = {"engine": None, "error": None}
work = threading.Lock()


def kind_of(body: bytes, name: str) -> str:
    """The format from the bytes themselves; the name only tells text apart."""
    head = body[:16]
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if head.startswith(b"PK\x03\x04"):
        try:
            names = set(zipfile.ZipFile(io.BytesIO(body)).namelist())
        except zipfile.BadZipFile:
            raise Refused("malformed")
        for part, kind in (("word/document.xml", "docx"), ("xl/workbook.xml", "xlsx"), ("ppt/presentation.xml", "pptx")):
            if part in names and "[Content_Types].xml" in names:
                return kind
        raise Refused("unsupported")
    try:
        body.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("unsupported")
    suffix = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    return suffix if suffix in ("csv", "tsv", "md") else "txt"


def office_preflight(body: bytes) -> list[str]:
    """Bounded checks before a parser unpacks an Office file. Macros, embedded
    objects and links to outside files are never run or fetched."""
    warnings = []
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        infos = archive.infolist()
        if len(infos) > 2000 or sum(i.file_size for i in infos) > OFFICE_EXPANDED:
            raise Refused("office_expansion_limit")
        if any(i.flag_bits & 1 for i in infos):
            raise Refused("protected")
        names = [i.filename.lower() for i in infos]
        if any("vbaproject" in n or "/embeddings/" in n for n in names):
            warnings.append("embedded_omitted")
        if any("/media/" in n for n in names):
            warnings.append("images_omitted")
    return warnings


def text_blocks(body: bytes, kind: str) -> list[dict]:
    """Plain text and delimited tables, read the same way by both engines."""
    text = body.decode("utf-8").lstrip("\ufeff")
    if kind in ("csv", "tsv"):
        rows = list(csv.reader(io.StringIO(text), delimiter="\t" if kind == "tsv" else ","))
        return [{"source": "table", "text": markdown_table(rows), "method": "native"}] if rows else []
    return [{"source": "document", "text": text, "method": "native"}] if text.strip() else []


def finish(blocks: list[dict], warnings: list[str], pages: int | None) -> dict:
    blocks = [b for b in blocks if b["text"].strip()]
    if not blocks:
        return failed("empty")
    kept, size = [], 0
    for block in blocks:
        size += len(block["text"].encode())
        if size > MAX_TEXT:
            warnings.append("truncated")
            break
        kept.append(block)
    if any(b["method"] == "ocr" for b in kept):
        warnings.append("ocr")
    warnings = sorted(set(warnings))
    partial = any(w in warnings for w in ("ocr", "truncated", "images_omitted", "embedded_omitted", "pages_failed"))
    return {
        "engine": ENGINE,
        "status": "partial" if partial else "complete",
        "reason": None,
        "pages": pages,
        "blocks": kept,
        "warnings": warnings,
    }


def failed(reason: str) -> dict:
    return {"engine": ENGINE, "status": "failed", "reason": reason, "pages": None, "blocks": [], "warnings": []}


def convert(engine, body: bytes, name: str) -> dict:
    kind = kind_of(body, name)
    if kind in ("txt", "md", "csv", "tsv"):
        return finish(text_blocks(body, kind), [], None)
    warnings = office_preflight(body) if kind in ("docx", "xlsx", "pptx") else []
    blocks, more, pages = engine.convert(body, kind)
    return finish(blocks, warnings + more, pages)


def child(conn, body: bytes, name: str) -> None:
    try:
        result = convert(state["engine"], body, name)
    except Refused as error:
        result = failed(str(error))
    except Exception as error:  # a parser error never carries file content out
        log.warning("conversion failed: %s", type(error).__name__)
        result = failed(getattr(error, "reason", "malformed"))
    conn.send_bytes(json.dumps(result, ensure_ascii=False).encode())
    conn.close()


def run(body: bytes, name: str) -> dict:
    """One conversion in a forked child: the loaded models are shared, a crash
    or the memory limit kills only the child, and a timeout kills it whole."""
    started = time.monotonic()
    receive, send = multiprocessing.get_context("fork").Pipe(duplex=False)
    process = multiprocessing.get_context("fork").Process(target=child, args=(send, body, name), daemon=True)
    process.start()
    send.close()
    result = None
    if receive.poll(TIMEOUT):
        try:
            result = json.loads(receive.recv_bytes())
        except EOFError:
            pass
    if process.is_alive():
        process.kill()
    process.join()
    if result is None:
        result = failed("timeout" if time.monotonic() - started >= TIMEOUT else "resource_limit")
    log.info(
        "converted %s (%d bytes) in %.1f s: %s %s",
        name.rsplit(".", 1)[-1][:8] if "." in name else "file",
        len(body),
        time.monotonic() - started,
        result["status"],
        result["reason"] or ",".join(result["warnings"]),
    )
    return result


def load() -> None:
    try:
        if ENGINE == "docling":
            from engine_docling import Engine
        else:
            from engine_markitdown import Engine
        started = time.monotonic()
        state["engine"] = Engine(MAX_PAGES)
        log.info("engine %s ready in %.1f s", ENGINE, time.monotonic() - started)
    except Exception as error:
        state["error"] = f"{type(error).__name__}: {error}"[:300]
        log.exception("engine not loaded")


class Handler(BaseHTTPRequestHandler):
    server_version = "niaro-converter"

    def log_message(self, fmt, *args):  # request lines carry nothing private
        log.debug(fmt, *args)

    def send(self, status: int, value: dict) -> None:
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self) -> bool:
        return not TOKEN or self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self.send(404, {"error": "not_found"})
        if not self.authorized():
            return self.send(401, {"error": "unauthorized"})
        self.send(200, {"ready": state["engine"] is not None, "engine": ENGINE, "error": state["error"]})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/convert":
            return self.send(404, {"error": "not_found"})
        if not self.authorized():
            return self.send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self.send(413, {"error": "too_large" if length else "empty"})
        body = self.rfile.read(length)
        if state["engine"] is None:
            return self.send(503, {"error": "not_ready", "detail": state["error"]})
        if not work.acquire(blocking=False):
            return self.send(503, {"error": "busy"})
        try:
            name = parse_qs(url.query).get("name", [""])[0][:200]
            self.send(200, run(body, name))
        finally:
            work.release()


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    log.info("listening on :%d (engine %s)", PORT, ENGINE)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
