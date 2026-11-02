"""Helpers both engines share: refusals, tables, photos and Tesseract OCR."""

from __future__ import annotations

import csv
import io
import re
import subprocess

# Photos are scaled down to this many pixels before OCR: plenty for text,
# and a 48 MP phone photo would otherwise need gigabytes.
MAX_PIXELS = 16_000_000
OCR_LANGUAGES = "ces+eng"


class Refused(Exception):
    """A file this service will not read; the message is the reason code."""


def markdown_table(rows: list[list]) -> str:
    width = max(len(r) for r in rows)
    cells = [[str(c if c is not None else "").replace("|", "\\|").replace("\n", " ") for c in r] + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(cells[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(r) + " |" for r in cells[1:]]
    return "\n".join(lines)


def prepare_image(body: bytes):
    """Decodes a photo upright and small enough to read; refuses multi-frame
    images and decompression bombs before they are decoded in full."""
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 200_000_000
    image = Image.open(io.BytesIO(body))
    if getattr(image, "n_frames", 1) != 1:
        raise Refused("multiframe_unsupported")
    width, height = image.size
    if width * height > MAX_PIXELS:
        scale = (MAX_PIXELS / (width * height)) ** 0.5
        image.draft("RGB", (int(width * scale), int(height * scale)))  # JPEG decodes smaller
    image = ImageOps.exif_transpose(image).convert("RGB")
    if image.width * image.height > MAX_PIXELS:
        scale = (MAX_PIXELS / (image.width * image.height)) ** 0.5
        image = image.resize((int(image.width * scale), int(image.height * scale)))
    return image


def ocr(image, scratch: str = "/tmp/ocr.png") -> str:
    """Tesseract on one upright page or photo; turns it first when the
    orientation check is confident it lies on its side or upside down."""
    image.save(scratch)
    orient = subprocess.run(
        ["tesseract", scratch, "stdout", "--psm", "0", "-l", "osd"],
        capture_output=True, text=True, timeout=30,
    )
    angle = re.search(r"Rotate: (\d+)", orient.stdout)
    confidence = re.search(r"Orientation confidence: ([\d.]+)", orient.stdout)
    if angle and confidence and int(angle[1]) and float(confidence[1]) >= 5:
        image.rotate(-int(angle[1]), expand=True).save(scratch)
    words = subprocess.run(
        ["tesseract", scratch, "stdout", "-l", OCR_LANGUAGES, "--psm", "3", "tsv"],
        capture_output=True, text=True, timeout=120, check=True,
    ).stdout
    lines: dict[tuple, list[str]] = {}
    for word in csv.DictReader(io.StringIO(words), delimiter="\t", quoting=csv.QUOTE_NONE):
        if (word.get("text") or "").strip():
            lines.setdefault((word["block_num"], word["par_num"], word["line_num"]), []).append(word["text"])
    return "\n".join(" ".join(line) for line in lines.values())


def pdf_raster_pages(path: str) -> tuple[int, set[int]]:
    """Page count and the pages (from 1) where a picture covers a real part of
    the page, so text inside a scan or a pasted photo is read by OCR even
    when the page also has a text layer. Small logos do not count."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as raw

    document = pdfium.PdfDocument(path)
    try:
        raster = set()
        for number, page in enumerate(document, 1):
            width, height = page.get_size()
            area = 0.0
            for item in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE], max_depth=2):
                left, bottom, right, top = item.get_bounds()
                area += max(0.0, right - left) * max(0.0, top - bottom)
            if area >= 0.1 * width * height:
                raster.add(number)
            page.close()
        return len(document), raster
    finally:
        document.close()
