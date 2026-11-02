"""MarkItDown + Tesseract: Office files through MarkItDown, PDF text page by
page through pdfminer, and OCR for photos and for scanned or pasted-in
pictures on PDF pages."""

from __future__ import annotations

import re

from common import Refused, fast_pdf_pages, ocr, pdf_raster_pages, prepare_image

SCRATCH = "/tmp/input"


class Engine:
    def __init__(self, max_pages: int):
        from markitdown import MarkItDown

        self.markitdown = MarkItDown(enable_plugins=False)
        self.max_pages = max_pages

    def convert(self, body: bytes, kind: str):
        if kind in ("png", "jpeg", "webp", "tiff"):
            return [{"source": "image", "text": ocr(prepare_image(body)), "method": "ocr"}], [], None
        path = f"{SCRATCH}.{kind}"
        with open(path, "wb") as file:
            file.write(body)
        if kind == "pdf":
            return self.pdf(path)
        text = self.markitdown.convert_local(path).text_content
        if kind == "pptx":
            return split(text, r"<!-- Slide number: (\d+) -->", "slide"), [], None
        if kind == "xlsx":
            return split(text, r"^## (.+)$", "sheet"), [], None
        return [{"source": "document", "text": text, "method": "native"}], [], None

    def pdf(self, path: str):
        import pypdfium2 as pdfium
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTTextContainer
        from pdfminer.pdfdocument import PDFPasswordIncorrect

        try:
            pages, raster = pdf_raster_pages(path)
        except pdfium.PdfiumError as error:
            raise Refused("protected" if "password" in str(error).lower() else "malformed")
        if pages > self.max_pages:
            raise Refused("page_limit")
        blocks, warnings = [], []
        # pdf-inspector keeps tables as tables, which pdfminer's text does not.
        fast = fast_pdf_pages(path, tables=True)
        try:
            layouts = list(extract_pages(path)) if len(fast) < pages else []
        except PDFPasswordIncorrect:
            raise Refused("protected")
        document = None
        for number in range(1, pages + 1):
            source = f"page {number}"
            if number in fast:
                blocks.append({"source": source, "text": fast[number], "method": "native"})
                continue
            layout = layouts[number - 1] if number <= len(layouts) else []
            text = "".join(item.get_text() for item in layout if isinstance(item, LTTextContainer)).strip()
            if text:
                blocks.append({"source": source, "text": text, "method": "native"})
            if number in raster or not text:
                document = document or pdfium.PdfDocument(path)
                page = document[number - 1]
                width, height = page.get_size()
                # About 200 dpi, at most 8 MP a page.
                scale = min(200 / 72, (8_000_000 / max(1.0, width * height)) ** 0.5)
                image = page.render(scale=scale).to_pil()
                scanned = ocr(image)
                if scanned.strip():
                    blocks.append({"source": source, "text": scanned, "method": "ocr"})
                elif not text:
                    warnings.append("pages_failed")
        if document:
            document.close()
        return blocks, warnings, pages


def split(text: str, marker: str, label: str) -> list[dict]:
    """MarkItDown marks slides and sheets in its Markdown; one block each."""
    parts = re.split(marker, text, flags=re.M)
    if len(parts) == 1:
        return [{"source": "document", "text": text, "method": "native"}]
    blocks = [{"source": "document", "text": parts[0], "method": "native"}]
    for name, body in zip(parts[1::2], parts[2::2]):
        blocks.append({"source": f"{label} {name.strip()}", "text": body.strip(), "method": "native"})
    return blocks
