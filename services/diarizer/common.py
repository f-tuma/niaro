"""What both diarization engines share: reading the WAV Niaro sends and
making a voice fingerprint unit length."""

from __future__ import annotations

import io
import wave


def wav_rate(body: bytes) -> int:
    """Checks the header only: mono 16-bit, as Niaro sends it."""
    with wave.open(io.BytesIO(body)) as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("expected mono 16-bit WAV")
        return audio.getframerate()


def read_wav(body: bytes):
    """Samples as float32 in [-1, 1] and the sample rate."""
    import numpy as np

    with wave.open(io.BytesIO(body)) as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("expected mono 16-bit WAV")
        rate = audio.getframerate()
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0, rate


def unit(vector) -> list[float] | None:
    """The vector scaled to length one, so a dot product is a cosine."""
    import numpy as np

    vector = np.asarray(vector, dtype=np.float64)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 0:
        return None
    return [round(float(x), 6) for x in vector / norm]
