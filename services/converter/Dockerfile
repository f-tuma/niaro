# syntax=docker/dockerfile:1
# Niaro document conversion, MarkItDown engine: Office files, PDF text and
# Tesseract OCR (Czech, English) on the CPU, about 0.5 GB of memory. See
# docs/guides/deployment.md, "Optional document reading". Dockerfile.docling
# builds the same service with Docling's layout and table models.
FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OMP_THREAD_LIMIT=1 \
    CONVERTER_ENGINE=markitdown \
    PORT=8000

RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-ces \
 && rm -rf /var/lib/apt/lists/*
COPY requirements-markitdown.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

COPY server.py common.py engine_markitdown.py /app/
RUN useradd --system --uid 10001 --home /app converter
USER converter
WORKDIR /app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%s/health'%os.environ['PORT'],headers={'Authorization':'Bearer '+os.environ.get('CONVERTER_TOKEN','')}),timeout=4)" || exit 1
CMD ["python", "server.py"]
