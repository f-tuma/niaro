"""Speaker diarization for Niaro meetings: who spoke when.

A small HTTP service next to the Niaro server (docker compose profile
"diarization"); meeting audio never leaves the machine. Two images share
this server and differ in the engine (DIARIZER_ENGINE):

  nemotron   NVIDIA Nemotron 3 Diarization (NeMo-Speech.cpp) with TitaNet
             fingerprints (sherpa-onnx); the default, fast, model in the image
  pyannote   pyannote speaker-diarization-community-1; slow, needs HF_TOKEN

  GET  /health    {"ready", "model", "error"}
  POST /diarize   body: WAV, 16 kHz, mono, 16-bit
                  query: maxSpeakers, embeddings=1 (optional)
                  -> {"model", "speakers", "segments": [{"start", "end", "speaker"}],
                      "embeddings": {"1": [...], ...} with embeddings=1}
  POST /embed     body: WAV of one person speaking (16 kHz, mono, 16-bit)
                  -> {"model", "seconds", "embedding": [...]}

Speakers are numbered 1, 2, ... in the order they first speak. An embedding
is the voice's fingerprint in the model's space (unit length, so the dot
product of two is their cosine similarity); Niaro uses them only to find the
voice of a person who chose to be recognized, and keeps none of the others. With
DIARIZER_TOKEN set, every request must carry it as a bearer token. One
recording is diarized at a time; others wait.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ENGINE = os.environ.get("DIARIZER_ENGINE", "nemotron")
TOKEN = os.environ.get("DIARIZER_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))
# Two hours of 16 kHz mono 16-bit sound is about 230 MB.
MAX_BYTES = int(os.environ.get("DIARIZER_MAX_BYTES", str(260 * 1024 * 1024)))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diarizer")

state: dict = {"engine": None, "model": None, "error": None}
work = threading.Lock()


def load() -> None:
    """Loads the engine in the background, so /health answers at once. A
    failed load is tried again every few minutes; a missing token waits for a
    restart."""
    if ENGINE == "pyannote":
        from engine_pyannote import Engine
    else:
        from engine_nemotron import Engine
    state["model"] = Engine.model
    while state["engine"] is None:
        try:
            started = time.monotonic()
            state["engine"], state["error"] = Engine(), None
            log.info("engine %s (%s) ready in %.1f s", ENGINE, Engine.model, time.monotonic() - started)
        except PermissionError as error:
            state["error"] = str(error)
            log.error("engine not loaded: %s", error)
            return
        except Exception as error:  # reported by /health
            state["error"] = str(error)[:300] or type(error).__name__
            log.error("engine not loaded, trying again in 5 minutes: %s", state["error"])
            time.sleep(300)


def diarize(body: bytes, query: dict) -> dict:
    engine = state["engine"]
    maximum = None
    if "maxSpeakers" in query:
        value = int(query["maxSpeakers"][0])
        if 1 <= value <= 20:
            maximum = value
    embeddings = query.get("embeddings", [""])[0] == "1"
    started = time.monotonic()
    turns, by_label = engine.diarize(body, maximum, embeddings)
    numbers: dict[str, int] = {}
    segments = []
    for start, end, label in sorted(turns, key=lambda t: t[0]):
        if end - start < 0.05:
            continue
        number = numbers.setdefault(label, len(numbers) + 1)
        segments.append({"start": round(start, 3), "end": round(end, 3), "speaker": number})
    log.info(
        "diarized %.0f s of sound in %.1f s: %d speakers, %d turns",
        max(0, len(body) - 44) / 32000,
        time.monotonic() - started,
        len(numbers),
        len(segments),
    )
    result = {"model": engine.model, "speakers": len(numbers), "segments": segments}
    if embeddings:
        result["embeddings"] = {
            str(number): by_label[label] for label, number in numbers.items() if label in by_label
        }
    return result


def embed(body: bytes) -> dict:
    """The fingerprint of the voice that speaks most in a recording of one
    person: the same engine as diarization, so the two compare."""
    engine = state["engine"]
    turns, by_label = engine.diarize(body, None, True)
    spoken: dict[str, float] = {}
    for start, end, label in turns:
        spoken[label] = spoken.get(label, 0.0) + end - start
    spoken = {label: seconds for label, seconds in spoken.items() if label in by_label}
    if not spoken:
        raise ValueError("no speech found")
    label = max(spoken, key=spoken.get)
    return {"model": engine.model, "seconds": round(spoken[label], 1), "embedding": by_label[label]}


class Handler(BaseHTTPRequestHandler):
    server_version = "niaro-diarizer"

    def log_message(self, fmt, *args):  # request lines carry nothing private
        log.debug(fmt, *args)

    def send(self, status: int, value: dict) -> None:
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
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
        self.send(
            200,
            {"ready": state["engine"] is not None, "model": state["model"] or ENGINE, "error": state["error"]},
        )

    def do_POST(self):
        url = urlparse(self.path)
        if url.path not in ("/diarize", "/embed"):
            return self.send(404, {"error": "not_found"})
        if not self.authorized():
            return self.send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 44 or length > MAX_BYTES:
            return self.send(413, {"error": "too_large" if length else "empty"})
        body = self.rfile.read(length)
        if state["engine"] is None:
            return self.send(503, {"error": "not_ready", "detail": state["error"]})
        try:
            with work:
                result = (
                    embed(body) if url.path == "/embed" else diarize(body, parse_qs(url.query))
                )
        except ValueError as error:
            return self.send(400, {"error": "invalid_audio", "detail": str(error)})
        except Exception as error:
            log.exception("diarization failed")
            return self.send(500, {"error": "failed", "detail": type(error).__name__})
        self.send(200, result)


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    log.info("listening on :%d", PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
