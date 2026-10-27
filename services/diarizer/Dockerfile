# syntax=docker/dockerfile:1
# Niaro speaker diarization: pyannote on the CPU. See docs/meetings.md,
# "Speaker diarization". Optional: started with the compose profile
# "diarization", removed by leaving it out.
FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # The model is downloaded once into the volume mounted here; the root
    # filesystem can stay read-only.
    HF_HOME=/models \
    TORCH_HOME=/models/torch \
    XDG_CACHE_HOME=/models/cache \
    MPLCONFIGDIR=/tmp/matplotlib \
    PORT=8000

# CPU-only PyTorch: the GPU build is several gigabytes larger and unused.
COPY requirements.txt /app/requirements.txt
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
      torch==2.8.0 torchaudio==2.8.0 \
 && pip install -r /app/requirements.txt

COPY server.py /app/server.py
RUN useradd --system --uid 10001 --home /app diarizer \
 && mkdir -p /models && chown diarizer /models
USER diarizer
WORKDIR /app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%s/health'%os.environ['PORT'],headers={'Authorization':'Bearer '+os.environ.get('DIARIZER_TOKEN','')}),timeout=4)" || exit 1
CMD ["python", "server.py"]
