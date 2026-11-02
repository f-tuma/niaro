"""Docling + Tesseract: layout and table models read each PDF page, find the
tables and run OCR on the parts that are pictures; Office files go through
Docling's own readers."""

from __future__ import annotations

import os

from common import OCR_LANGUAGES, Refused, pdf_raster_pages, prepare_image

SCRATCH = "/tmp/input"
PDF_CHUNK = 5


class Engine:
    def __init__(self, max_pages: int):
        from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import (
            PdfPipelineOptions,
            TableFormerMode,
            TesseractCliOcrOptions,
        )
        from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

        options = PdfPipelineOptions(
            artifacts_path=os.environ.get("DOCLING_ARTIFACTS_PATH") or None,
            do_ocr=True,
            do_table_structure=True,
            ocr_options=TesseractCliOcrOptions(lang=OCR_LANGUAGES.split("+")),
            accelerator_options=AcceleratorOptions(
                num_threads=int(os.environ.get("CONVERTER_THREADS", "2")), device=AcceleratorDevice.CPU
            ),
            enable_remote_services=False,
            allow_external_plugins=False,
            # One page at a time through each model: slower, but a fraction of the memory.
            layout_batch_size=1,
            ocr_batch_size=1,
            table_batch_size=1,
            document_timeout=float(os.environ.get("CONVERTER_TIMEOUT_SECONDS", "180")) - 10,
        )
        options.table_structure_options.mode = TableFormerMode.ACCURATE
        from docling.datamodel.settings import settings

        settings.perf.page_batch_size = 1
        self.formats = InputFormat
        self.converter = DocumentConverter(
            allowed_formats=[InputFormat.PDF, InputFormat.IMAGE, InputFormat.DOCX, InputFormat.PPTX, InputFormat.XLSX],
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=options),
                InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
            },
        )
        # Models load once here; each conversion runs in a forked child.
        self.converter.initialize_pipeline(InputFormat.PDF)
        self.max_pages = max_pages

    def convert(self, body: bytes, kind: str):
        from docling.datamodel.base_models import ConversionStatus

        if kind in ("png", "jpeg", "webp", "tiff"):
            path = f"{SCRATCH}.png"
            prepare_image(body).save(path)
        else:
            path = f"{SCRATCH}.{kind}"
            with open(path, "wb") as file:
                file.write(body)
        if kind == "pdf":
            import pypdfium2 as pdfium

            try:
                pages, raster = pdf_raster_pages(path)
            except pdfium.PdfiumError as error:
                raise Refused("protected" if "password" in str(error).lower() else "malformed")
            if pages > self.max_pages:
                raise Refused("page_limit")
            return self.pdf(path, pages, raster)
        result = self.converter.convert(path, raises_on_error=False, max_num_pages=self.max_pages)
        if result.status == ConversionStatus.FAILURE:
            raise Refused("malformed")
        document = result.document
        warnings = [] if result.status == ConversionStatus.SUCCESS else ["pages_failed"]
        if kind in ("png", "jpeg", "webp", "tiff"):
            return [{"source": "image", "text": document.export_to_markdown(), "method": "ocr"}], warnings, None
        if kind in ("pptx", "xlsx") and document.pages:
            names = sheet_names(document) if kind == "xlsx" else {}
            label = "slide" if kind == "pptx" else "sheet"
            return [
                {
                    "source": f"{label} {names.get(number, number)}",
                    "text": document.export_to_markdown(page_no=number),
                    "method": "native",
                }
                for number in sorted(document.pages)
            ], warnings, None
        return [{"source": "document", "text": document.export_to_markdown(), "method": "native"}], warnings, None


    def pdf(self, path: str, pages: int, raster: set[int]):
        """Docling keeps every page of a document in memory until the end, so
        long PDFs go through in chunks of pages; each chunk's memory is
        reused by the next."""
        import gc

        from docling.datamodel.base_models import ConversionStatus

        blocks, warnings = [], []
        for start in range(1, pages + 1, PDF_CHUNK):
            end = min(pages, start + PDF_CHUNK - 1)
            result = self.converter.convert(path, raises_on_error=False, page_range=(start, end))
            if result.status == ConversionStatus.FAILURE:
                if start == 1:
                    raise Refused("malformed")
                warnings.append("pages_failed")
                continue
            document = result.document
            for number in range(start, end + 1):
                if number not in document.pages:
                    warnings.append("pages_failed")
                    continue
                blocks.append({
                    "source": f"page {number}",
                    "text": document.export_to_markdown(page_no=number),
                    "method": "ocr" if number in raster else "native",
                })
            del result, document
            gc.collect()
        return blocks, warnings, pages


def sheet_names(document) -> dict[int, str]:
    """Docling gives each workbook sheet a page and a named group."""
    names = {}
    for group in document.groups:
        if str(getattr(group, "label", "")).endswith("sheet"):
            for child in group.children:
                item = child.resolve(document)
                for prov in getattr(item, "prov", []) or []:
                    names.setdefault(prov.page_no, group.name)
    return names
