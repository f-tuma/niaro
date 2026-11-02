"""Runs a folder of test files through converter services and prints how
much of the expected text each one found, how long it took and the memory
peak of its container. A development tool; the files and their expected
strings come from manifest.json in that folder (the NIAR-250 pilot corpus).

  python3 compare.py FIXTURES name=http://host:8000[@container] ...
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path


def normal(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).casefold().replace("\\", "").split())


def expected(case: dict) -> list[str]:
    strings = list(case.get("fields", []))
    for row in case.get("table", []):
        strings += [c for c in row if c]
    for check in case.get("source_assertions", []):
        strings += check.get("contains", [])
    return strings


def convert(url: str, body: bytes, name: str, token: str) -> tuple[dict, float]:
    request = urllib.request.Request(
        f"{url}/convert?name={urllib.parse.quote(name)}",
        data=body,
        headers={"Authorization": f"Bearer {token}"} if token else {},
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.load(response), time.monotonic() - started


def peak(container: str) -> int | None:
    if not container:
        return None
    out = subprocess.run(["docker", "exec", container, "cat", "/sys/fs/cgroup/memory.peak"], capture_output=True, text=True)
    return int(out.stdout) if out.returncode == 0 else None


def main() -> None:
    folder = Path(sys.argv[1])
    services = [arg.split("=", 1) for arg in sys.argv[2:]]
    cases = json.loads((folder / "manifest.json").read_text())
    cases = cases["cases"] if isinstance(cases, dict) else cases
    token = (Path.home() / ".niaro-converter-token").read_text().strip() if (Path.home() / ".niaro-converter-token").exists() else ""
    totals = {name: [0, 0, 0.0] for name, _ in services}
    print(f"{'file':28}" + "".join(f"{name:>34}" for name, _ in services))
    for case in cases:
        path = folder / case["file"]
        if not path.exists():
            path = folder / "fixtures" / case["file"]
        if not path.exists():
            continue
        want = expected(case)
        row = f"{case['file'][:28]:28}"
        for name, target in services:
            url, _, container = target.partition("@")
            try:
                result, seconds = convert(url, path.read_bytes(), case["file"], token)
            except Exception as error:
                row += f"{'error ' + type(error).__name__:>34}"
                continue
            text = normal("\n".join(b["text"] for b in result["blocks"]))
            found = sum(1 for s in want if normal(s) in text)
            totals[name][0] += found
            totals[name][1] += len(want)
            totals[name][2] = max(totals[name][2], seconds)
            memory = peak(container)
            status = result["status"] if result["status"] != "failed" else f"failed:{result['reason']}"
            cell = f"{found}/{len(want)} {status[:18]} {seconds:5.1f}s"
            if memory:
                cell += f" {memory / 2**20:4.0f}M"
            row += f"{cell:>34}"
        print(row, flush=True)
    for name, (found, total, slowest) in totals.items():
        print(f"{name}: {found}/{total} expected strings, slowest {slowest:.1f} s")


if __name__ == "__main__":
    main()
