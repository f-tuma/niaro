# syntax=docker/dockerfile:1
# Niaro speaker diarization: NVIDIA Nemotron 3 Diarization through
# NeMo-Speech.cpp on the CPU, with TitaNet voice fingerprints. See
# docs/guides/deployment.md, "Optional speaker diarization". Optional: started
# with the compose profile "diarization", removed by leaving it out. Both
# models are in the image (checked by SHA-256), so the service needs no token
# and no network. DIARIZER_DOCKERFILE=Dockerfile.pyannote builds pyannote.
FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake ninja-build git \
      pkg-config libsentencepiece-dev ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# NeMo-Speech.cpp (Apache-2.0) has no tagged releases yet: one tested commit.
ARG NEMO_SPEECH_COMMIT=536b17a41bef62d2a67a40ed3df61df26a4389fe
ARG TARGETARCH
RUN git clone https://github.com/NVIDIA/NeMo-Speech.cpp.git /src \
 && cd /src && git checkout --quiet "$NEMO_SPEECH_COMMIT" \
 && git submodule update --init llama.cpp third_party/cpp-httplib \
 # Not -march=native: the image runs on whichever server pulls it. On x86-64
 # AVX2 and FMA (any server CPU of the last decade) keep it fast.
 && if [ "$TARGETARCH" = "amd64" ] || [ "$(uname -m)" = "x86_64" ]; then \
      cpu="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; fi \
 && scripts/configure.sh cpu-diar -DGGML_NATIVE=OFF $cpu \
 && cmake --build --preset cpu-diar \
 && mkdir /out && cp -a build/cpu-diar/bin/nemo-speech build/cpu-diar/bin/*.so* /out/

# Nemotron 3 Diarization (OpenMDW 1.1) and NVIDIA TitaNet large (CC BY 4.0).
RUN mkdir /models \
 && curl -fsSL --retry 5 -o /models/nemotron-3-diarization.q8_0.gguf \
      https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf \
 && curl -fsSL --retry 5 -o /models/titanet-large.onnx \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx \
 && printf '%s\n' \
      "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1  /models/nemotron-3-diarization.q8_0.gguf" \
      "d51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77  /models/titanet-large.onnx" \
    | sha256sum -c -

FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    LD_LIBRARY_PATH=/opt/nemo-speech \
    DIARIZER_ENGINE=nemotron \
    PORT=8000

RUN apt-get update \
 && apt-get install -y --no-install-recommends libsentencepiece0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY requirements-nemotron.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt
COPY --from=build /out/ /opt/nemo-speech/
COPY --from=build /models/ /opt/models/
COPY server.py common.py engine_nemotron.py /app/
RUN useradd --system --uid 10001 --home /app diarizer
USER diarizer
WORKDIR /app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%s/health'%os.environ['PORT'],headers={'Authorization':'Bearer '+os.environ.get('DIARIZER_TOKEN','')}),timeout=4)" || exit 1
CMD ["python", "server.py"]
