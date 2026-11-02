"""pyannote's open model (speaker-diarization-community-1) with PyTorch on
the CPU: careful but slow, about a third of real time on eight cores. Needs
a Hugging Face token whose account accepted the model's terms."""

from __future__ import annotations

import os
import warnings

from common import read_wav, unit

MODEL = os.environ.get("DIARIZER_MODEL", "pyannote/speaker-diarization-community-1")
HF_TOKEN = os.environ.get("HF_TOKEN", "")

# Audio arrives decoded (read_wav), so torchcodec's FFmpeg is never needed.
warnings.filterwarnings("ignore", message=r"\s*torchcodec is not installed")


class Engine:
    model = MODEL

    def __init__(self) -> None:
        """Downloads the model into the mounted volume once; the server tries
        again after a failed download (terms not accepted, no network)."""
        import torch
        from pyannote.audio import Pipeline

        # More threads than about eight only contend: on a 20-core host 8 threads
        # diarized 300 s of sound in 100 s, all 20 in 157 s.
        torch.set_num_threads(max(1, int(os.environ.get("DIARIZER_THREADS", "0")) or min(8, os.cpu_count() or 2)))
        if not HF_TOKEN:
            raise PermissionError("HF_TOKEN is not set: accept the model's terms on Hugging Face and set the token")
        try:
            pipeline = Pipeline.from_pretrained(MODEL, token=HF_TOKEN)
        except Exception as error:  # reported without the token
            first = next((line.strip() for line in str(error).splitlines()[1:] if line.strip()), "")
            message = first or str(error).splitlines()[0] if str(error) else type(error).__name__
            raise RuntimeError(message.replace(HF_TOKEN, "[token]")[:300]) from None
        if pipeline is None:
            raise RuntimeError("the model could not be loaded (terms not accepted?)")
        self.pipeline = pipeline

    def diarize(self, body: bytes, max_speakers: int | None, embeddings: bool):
        """(start, end, label) turns and, when asked, each label's fingerprint."""
        import torch

        samples, rate = read_wav(body)
        options = {"max_speakers": max_speakers} if max_speakers else {}
        output = self.pipeline({"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": rate}, **options)
        return list(turns(output)), voice_embeddings(output) if embeddings else {}


def turns(output):
    """(start, end, label) from pyannote 4 (exclusive when offered) or 3."""
    annotation = getattr(output, "exclusive_speaker_diarization", None) or getattr(
        output, "speaker_diarization", output
    )
    if hasattr(annotation, "itertracks"):
        for segment, _track, label in annotation.itertracks(yield_label=True):
            yield segment.start, segment.end, str(label)
    else:
        for segment, label in annotation:
            yield segment.start, segment.end, str(label)


def voice_embeddings(output) -> dict[str, list[float]]:
    """Each voice's embedding by its pyannote label, unit length."""
    vectors = getattr(output, "speaker_embeddings", None)
    annotation = getattr(output, "speaker_diarization", None)
    if vectors is None or annotation is None:
        return {}
    found = {}
    for label, vector in zip(annotation.labels(), vectors):
        if (scaled := unit(vector)) is not None:
            found[str(label)] = scaled
    return found
