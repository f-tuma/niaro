"""NVIDIA's Nemotron 3 Diarization through NeMo-Speech.cpp on the CPU: up to
eight voices, about thirty times faster than real time on eight cores. The
model ships in the image (OpenMDW 1.1); nothing is downloaded at run time.

Nemotron gives turns, not fingerprints. A voice's fingerprint comes from
NVIDIA TitaNet (CC BY 4.0) through sherpa-onnx, over the stretches where that
voice speaks alone, so a saved voice can be found again. On a meeting
recorded in one room TitaNet kept different voices at a cosine of at most
0.5 and one voice above 0.85; WeSpeaker ResNet34 put them all near 0.9."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

from common import read_wav, unit, wav_rate

BINARY = os.environ.get("NEMO_SPEECH", "/opt/nemo-speech/nemo-speech")
DIARIZATION = os.environ.get("DIARIZER_GGUF", "/opt/models/nemotron-3-diarization.q8_0.gguf")
VOICE = os.environ.get("DIARIZER_VOICE_ONNX", "/opt/models/titanet-large.onnx")
# Fingerprints from another model never compare: the name says both.
MODEL = "nvidia/Nemotron-3-Diarization+titanet-large"
# A voice's fingerprint averages its longest solo stretches, up to a minute.
VOICE_SECONDS = 60.0
log = logging.getLogger("diarizer")


class Engine:
    model = MODEL

    def __init__(self) -> None:
        import sherpa_onnx

        for path in (BINARY, DIARIZATION, VOICE):
            if not Path(path).is_file():
                raise RuntimeError(f"missing {path}")
        threads = int(os.environ.get("DIARIZER_THREADS", "0")) or min(8, os.cpu_count() or 2)
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=VOICE, num_threads=threads)
        if not config.validate():
            raise RuntimeError("the voice model does not load")
        self.voice = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    def diarize(self, body: bytes, max_speakers: int | None, embeddings: bool):
        """(start, end, label) turns and, when asked, each label's fingerprint.
        Nemotron finds up to eight voices by itself; a smaller maximum is not
        a setting it takes."""
        wav_rate(body)
        with tempfile.TemporaryDirectory(prefix="diarize-") as directory:
            wav, rttm = Path(directory, "in.wav"), Path(directory, "out.rttm")
            wav.write_bytes(body)
            run = subprocess.run(
                [BINARY, "diarize", str(wav), "--model", DIARIZATION, "--preset", "v3-offline",
                 "--device", "cpu", "--format", "rttm", "--output", str(rttm)],
                capture_output=True,
                text=True,
                timeout=3600,
            )
            if run.returncode != 0:
                log.error("nemo-speech failed (%d): %s", run.returncode, run.stderr.strip()[-500:])
                raise RuntimeError("nemo-speech failed")
            turns = parse_rttm(rttm.read_text())
        return turns, self.fingerprints(body, turns) if embeddings else {}

    def fingerprints(self, body: bytes, turns) -> dict[str, list[float]]:
        """Each voice's fingerprint from where it speaks alone, longest first."""
        import numpy as np

        samples, rate = read_wav(body)
        found = {}
        for label in {t[2] for t in turns}:
            pieces = sorted(solo(turns, label), key=lambda p: p[1] - p[0], reverse=True)
            vectors, weights, total = [], [], 0.0
            for start, end in pieces:
                if end - start < 1.0 or total >= VOICE_SECONDS:
                    break
                stream = self.voice.create_stream()
                stream.accept_waveform(rate, samples[int(start * rate):int(end * rate)])
                stream.input_finished()
                if not self.voice.is_ready(stream):
                    continue
                vectors.append(np.asarray(self.voice.compute(stream), dtype=np.float64))
                weights.append(end - start)
                total += end - start
            if vectors and (scaled := unit(np.average(vectors, axis=0, weights=weights))) is not None:
                found[label] = scaled
        return found


def parse_rttm(text: str):
    turns = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 8 and parts[0] == "SPEAKER":
            start, length = float(parts[3]), float(parts[4])
            turns.append((start, start + length, parts[7]))
    return turns


def solo(turns, label):
    """The stretches of `label`'s turns that no other voice overlaps."""
    others = sorted((s, e) for s, e, l in turns if l != label)
    for start, end in sorted((s, e) for s, e, l in turns if l == label):
        cursor = start
        for other_start, other_end in others:
            if other_end <= cursor or other_start >= end:
                continue
            if other_start > cursor:
                yield cursor, other_start
            cursor = max(cursor, other_end)
        if cursor < end:
            yield cursor, end
