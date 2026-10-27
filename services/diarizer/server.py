"""Speaker diarization for Niaro meetings: who spoke when.

A small HTTP service next to the Niaro server (docker compose profile
"diarization"). It runs pyannote's open model (speaker-diarization-community-1)
on the CPU, so meeting audio never leaves the machine.

  GET  /health    {"ready", "model", "error"}
  POST /diarize   body: WAV, 16 kHz, mono, 16-bit
                  query: minSpeakers, maxSpeakers (optional)
                  -> {"model", "speakers", "segments": [{"start", "end", "speaker"}]}

Speakers are numbered 1, 2, ... in the order they first speak. With
DIARIZER_TOKEN set, every request must carry it as a bearer token. One
recording is diarized at a time; others wait.
"""

from __future__ import annotations

import io
import json
import logging
import os
import threading
import time
import wave
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODEL = os.environ.get("DIARIZER_MODEL", "pyannote/speaker-diarization-community-1")
TOKEN = os.environ.get("DIARIZER_TOKEN", "")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))
# Two hours of 16 kHz mono 16-bit sound is about 230 MB.
MAX_BYTES = int(os.environ.get("DIARIZER_MAX_BYTES", str(260 * 1024 * 1024)))

# Audio arrives decoded (read_wav), so torchcodec's FFmpeg is never needed.
warnings.filterwarnings("ignore", message=r"\s*torchcodec is not installed")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diarizer")

state: dict = {"pipeline": None, "error": None}
work = threading.Lock()


def load() -> None:
    """Loads the model in the background, so /health answers at once. A
    failed download (terms not yet accepted, no network) is tried again every
    few minutes; a missing token waits for a restart."""
    import torch
    from pyannote.audio import Pipeline

    torch.set_num_threads(max(1, int(os.environ.get("DIARIZER_THREADS", "0")) or (os.cpu_count() or 2)))
    if not HF_TOKEN:
        state["error"] = "HF_TOKEN is not set: accept the model's terms on Hugging Face and set the token"
        log.error("model not loaded: %s", state["error"])
        return
    while state["pipeline"] is None:
        try:
            started = time.monotonic()
            pipeline = Pipeline.from_pretrained(MODEL, token=HF_TOKEN)
            if pipeline is None:
                raise RuntimeError("the model could not be loaded (terms not accepted?)")
            state["pipeline"], state["error"] = pipeline, None
            log.info("model %s ready in %.1f s", MODEL, time.monotonic() - started)
        except Exception as error:  # reported by /health, never the token
            first = next((line.strip() for line in str(error).splitlines()[1:] if line.strip()), "")
            message = first or str(error).splitlines()[0] if str(error) else type(error).__name__
            state["error"] = message.replace(HF_TOKEN, "[token]")[:300]
            log.error("model not loaded, trying again in 5 minutes: %s", state["error"])
            time.sleep(300)


def read_wav(body: bytes):
    import numpy as np
    import torch

    with wave.open(io.BytesIO(body)) as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("expected mono 16-bit WAV")
        rate = audio.getframerate()
        frames = audio.readframes(audio.getnframes())
    samples = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    return {"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": rate}


def turns(output):
    """(start, end, label) from pyannote 4 (exclusive when offered) or 3."""
    annotation = getattr(output, "exclusive_speaker_diarization", None) or getattr(
        output, "speaker_diarization", output
    )
    if hasattr(annotation, "itertracks"):
        for segment, _track, label in annotation.itertracks(yield_label=True):
            yield segment.start, segment.end, label
    else:
        for segment, label in annotation:
            yield segment.start, segment.end, label


def diarize(body: bytes, query: dict) -> dict:
    pipeline = state["pipeline"]
    if pipeline is None:
        raise RuntimeError(state["error"] or "model is loading")
    audio = read_wav(body)
    options = {}
    for name, key in (("minSpeakers", "min_speakers"), ("maxSpeakers", "max_speakers")):
        if name in query:
            value = int(query[name][0])
            if 1 <= value <= 20:
                options[key] = value
    started = time.monotonic()
    output = pipeline(audio, **options)
    numbers: dict[str, int] = {}
    segments = []
    for start, end, label in sorted(turns(output), key=lambda t: t[0]):
        if end - start < 0.05:
            continue
        number = numbers.setdefault(str(label), len(numbers) + 1)
        segments.append({"start": round(start, 3), "end": round(end, 3), "speaker": number})
    seconds = audio["waveform"].shape[1] / audio["sample_rate"]
    log.info(
        "diarized %.0f s of sound in %.1f s: %d speakers, %d turns",
        seconds,
        time.monotonic() - started,
        len(numbers),
        len(segments),
    )
    return {"model": MODEL, "speakers": len(numbers), "segments": segments}


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
            {"ready": state["pipeline"] is not None, "model": MODEL, "error": state["error"]},
        )

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/diarize":
            return self.send(404, {"error": "not_found"})
        if not self.authorized():
            return self.send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 44 or length > MAX_BYTES:
            return self.send(413, {"error": "too_large" if length else "empty"})
        body = self.rfile.read(length)
        if state["pipeline"] is None:
            return self.send(503, {"error": "not_ready", "detail": state["error"]})
        try:
            with work:
                result = diarize(body, parse_qs(url.query))
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
