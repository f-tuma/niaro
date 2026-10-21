"""Create synthetic Czech QA recordings; never records a microphone or calls a cloud API."""
import argparse
import hashlib
import json
import subprocess
import wave
from pathlib import Path
from piper import PiperVoice


def run(*args):
    subprocess.run(args, check=True, timeout=30, capture_output=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    cases = json.loads(Path(__file__).with_name("voice-cases.cs.json").read_text())
    voice = PiperVoice.load(str(args.model))
    entries = []
    for case in cases:
        source = args.output / f"{case['id']}-source.wav"
        with wave.open(str(source), "wb") as out:
            voice.synthesize_wav(case["text"], out)
        with wave.open(str(source), "rb") as audio:
            speech_end = 500 + 1000 * audio.getnframes() / audio.getframerate()
        for variant, gain in [("normal", 1), ("quiet", 0.03)]:
            filename = f"{case['id']}-{variant}.wav"
            run("ffmpeg", "-v", "error", "-i", str(source), "-af",
                f"volume={gain},adelay=500,apad=pad_dur=3", "-ar", "16000", "-ac", "1",
                str(args.output / filename))
            entries.append({**case, "id": f"{case['id']}-{variant}", "file": filename,
                            "speechEndMs": speech_end})
        if case["id"] == "meeting":
            filename = "meeting-room-hum.wav"
            run("ffmpeg", "-v", "error", "-i", str(source), "-f", "lavfi", "-i",
                "anoisesrc=color=pink:amplitude=0.006:sample_rate=16000:seed=42",
                "-filter_complex", "[0:a]adelay=500,apad=pad_dur=3[v];[v][1:a]amix=inputs=2:duration=first:normalize=0",
                "-ar", "16000", "-ac", "1", str(args.output / filename))
            entries.append({**case, "id": "meeting-room-hum", "file": filename,
                            "speechEndMs": speech_end})
    for name, audio in [("silence", "anullsrc=r=16000:cl=mono"),
                        ("noise", "anoisesrc=color=pink:amplitude=0.006:sample_rate=16000:seed=42"),
                        ("tone", "sine=frequency=440:sample_rate=16000")]:
        filename = f"{name}.wav"
        run("ffmpeg", "-v", "error", "-f", "lavfi", "-i", audio, "-t", "11",
            "-ar", "16000", "-ac", "1", str(args.output / filename))
        entries.append({"id": name, "text": "", "critical": [], "file": filename})
    manifest = {"source": "synthetic Piper cs_CZ-jirka-medium; not physical speech validation",
                "modelSha256": hashlib.sha256(args.model.read_bytes()).hexdigest(),
                "language": "cs", "samples": entries}
    (args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(args.output / "manifest.json")


if __name__ == "__main__":
    main()
