#!/usr/bin/env python3
"""Foreground recording QA on an emulator only; synthetic input, no host mic.

Open the isolated audio app at the top of its idle screen before invoking this.
The test starts using its visible Start button and ends by backgrounding it.
Artifacts are written to a NEW output directory. No audio files are deleted.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

PACKAGE = "dev.agentclient.demo.audio"
FILENAME = re.compile(r"recording-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.m4a", re.I)
JOURNAL_KEY = "agent-client.audio.journal.v1"


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def button_center(xml):
    labels = {"Start microphone test", "Spustit test mikrofonu"}
    matches = [n for n in ET.fromstring(xml).iter("node")
               if n.get("content-desc") in labels and n.get("enabled") == "true"
               and n.get("class") == "android.widget.Button"]
    if len(matches) != 1:
        raise RuntimeError("Open the idle audio screen with one enabled Start button visible")
    bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", matches[0].get("bounds", ""))
    if not bounds:
        raise RuntimeError("Start button has invalid bounds")
    left, top, right, bottom = map(int, bounds.groups())
    if right <= left or bottom <= top:
        raise RuntimeError("Start button is off screen")
    return (left + right) // 2, (top + bottom) // 2


def memory_summary(output):
    def value(label):
        match = re.search(r"\b" + label + r":\s*(\d+)", output)
        if not match:
            raise RuntimeError("Missing meminfo field: " + label)
        return int(match[1])
    return {"pss_kib": value("TOTAL PSS"), "rss_kib": value("TOTAL RSS")}


def validate_samples(samples, target):
    if len(samples) < 2 or samples[-1]["elapsed_s"] < target:
        raise RuntimeError("Recording did not reach the requested duration")
    first_pid = samples[0]["pid"]
    previous = None
    for sample in samples:
        if sample["pid"] != first_pid or not sample["foreground"] or not sample["microphone_active"]:
            raise RuntimeError("Recording/process/foreground continuity was lost")
        if previous and (sample["elapsed_s"] <= previous["elapsed_s"] or sample["bytes"] <= previous["bytes"]):
            raise RuntimeError("File growth or monotonic sample order was lost")
        previous = sample


class Device:
    def __init__(self, adb, serial):
        self.prefix = [adb, "-s", serial]

    def run(self, *args, optional=False, binary=False):
        result = subprocess.run(self.prefix + list(args), capture_output=True, timeout=20)
        if result.returncode and not optional:
            raise RuntimeError(result.stderr.decode(errors="replace") or result.stdout.decode(errors="replace"))
        if result.returncode:
            return None
        return result.stdout if binary else result.stdout.decode().strip()

    def shell(self, *args):
        return self.run("shell", *args)

    def foreground(self):
        return any(PACKAGE + "/.MainActivity" in line for line in self.shell("dumpsys", "activity", "activities").splitlines() if "topResumedActivity=" in line)

    def microphone_active(self):
        return "(running)" in self.shell("cmd", "appops", "get", PACKAGE, "RECORD_AUDIO")

    def files(self):
        result = self.run("shell", "run-as", PACKAGE, "ls", "files/Audio", optional=True)
        return {name for name in (result or "").splitlines() if FILENAME.fullmatch(name)}

    def size(self, name):
        if not FILENAME.fullmatch(name):
            raise ValueError("Unexpected recording filename")
        return int(self.shell("run-as", PACKAGE, "stat", "-c", "%s", "files/Audio/" + name))

    def screenshot(self, path):
        path.write_bytes(self.run("exec-out", "screencap", "-p", binary=True))

    def journal(self):
        # Copy only this synthetic test app's DB. Preserve WAL names for SQLite.
        with tempfile.TemporaryDirectory(prefix="audio-soak-journal-") as folder:
            for name in ["RKStorage", "RKStorage-wal", "RKStorage-shm"]:
                content = self.run("exec-out", "run-as", PACKAGE, "cat", "databases/" + name, optional=name != "RKStorage", binary=True)
                if content is not None:
                    Path(folder, name).write_bytes(content)
            connection = sqlite3.connect(str(Path(folder, "RKStorage")))
            try:
                row = connection.execute("SELECT value FROM catalystLocalStorage WHERE key=?", (JOURNAL_KEY,)).fetchone()
                if not row:
                    raise RuntimeError("Missing recording journal")
                return json.loads(row[0])
            finally:
                connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", default=os.environ.get("ADB", "adb"))
    parser.add_argument("--serial", default="emulator-5554")
    parser.add_argument("--duration", type=int, default=1800, help="Seconds, 10–3600")
    parser.add_argument("--interval", type=int, default=60, help="Sample interval, 5–60 seconds")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 10 <= args.duration <= 3600 or not 5 <= args.interval <= 60:
        parser.error("Duration must be 10–3600 and interval 5–60 seconds")
    if not re.fullmatch(r"emulator-\d+", args.serial):
        parser.error("Only an explicitly named emulator is allowed")
    args.output.mkdir(parents=True, exist_ok=False)
    device = Device(args.adb, args.serial)
    report = {"started_utc": utc(), "target_seconds": args.duration, "sample_interval_seconds": args.interval,
              "package": PACKAGE, "serial": args.serial, "status": "preparing", "samples": []}
    def save():
        temp = args.output / "report.tmp"
        temp.write_text(json.dumps(report, indent=2) + "\n")
        temp.replace(args.output / "report.json")
    def interrupted(_signum, _frame):
        raise InterruptedError("Measurement interrupted by signal")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    started = False
    original_timeout = None
    try:
        if device.shell("getprop", "ro.kernel.qemu") != "1":
            raise RuntimeError("Connected device is not an emulator")
        report["host_microphone"] = device.run("emu", "avd", "hostmicoff")
        if report["host_microphone"] != "OK":
            raise RuntimeError("Could not disable host microphone forwarding")
        if not device.foreground() or device.microphone_active():
            raise RuntimeError("Audio app must be foreground and its microphone off")
        original_timeout = device.shell("settings", "get", "system", "screen_off_timeout")
        device.shell("settings", "put", "system", "screen_off_timeout", "2147483647")
        report["environment"] = {key: device.shell("getprop", key) for key in ["ro.build.version.release", "ro.build.version.sdk", "ro.product.cpu.abi", "ro.build.fingerprint"]}
        report["screen"] = device.shell("wm", "size") + " / " + device.shell("wm", "density")
        dump = device.shell("uiautomator", "dump", "/sdcard/agent-audio-soak.xml")
        if "UI hierchary dumped to" not in dump:
            raise RuntimeError("Fresh UI hierarchy unavailable")
        xml = device.run("exec-out", "cat", "/sdcard/agent-audio-soak.xml")
        (args.output / "before.xml").write_text(xml)
        point = button_center(xml)
        device.screenshot(args.output / "before.png")
        baseline = device.files()
        start = time.monotonic()
        report["capture_requested_utc"] = utc()
        started = True  # Cleanup also handles a partially completed input command.
        device.shell("input", "tap", *map(str, point))
        time.sleep(1)
        names = device.files() - baseline
        if len(names) != 1 or not device.microphone_active():
            raise RuntimeError("Capture did not create exactly one active recording; permission must already be granted")
        name = names.pop()
        report["filename"] = name
        report["status"] = "recording"
        save()
        deadline = start + args.duration
        next_sample = start
        while True:
            time.sleep(max(0, min(next_sample, deadline) - time.monotonic()))
            sample = {"elapsed_s": round(time.monotonic() - start, 3), "utc": utc(), "bytes": device.size(name),
                      "pid": device.shell("pidof", PACKAGE), "foreground": device.foreground(),
                      "microphone_active": device.microphone_active(),
                      **memory_summary(device.shell("dumpsys", "meminfo", PACKAGE))}
            report["samples"].append(sample)
            save()
            print(json.dumps(sample), flush=True)
            if not sample["foreground"] or not sample["microphone_active"]:
                raise RuntimeError("Capture ended before the planned background interruption")
            if sample["elapsed_s"] >= args.duration:
                break
            next_sample = min(start + len(report["samples"]) * args.interval, deadline)
        validate_samples(report["samples"], args.duration)
        device.screenshot(args.output / "before-background.png")
        report["background_requested_elapsed_s"] = round(time.monotonic() - start, 3)
        device.shell("input", "keyevent", "3")
        time.sleep(2)
        if device.microphone_active():
            raise RuntimeError("Microphone remained active after backgrounding")
        journal = device.journal()
        saved = journal.get("saved", {})
        if not saved.get("uri", "").endswith("/" + name) or not saved.get("interrupted"):
            raise RuntimeError("Background stop did not persist the interrupted recording")
        if not any(e["uri"] == saved["uri"] and e["status"] == "finished" for e in journal["entries"]):
            raise RuntimeError("Recording entry is not finalized")
        report["saved"] = saved
        artifact = args.output / "recording.m4a"
        artifact.write_bytes(device.run("exec-out", "run-as", PACKAGE, "cat", "files/Audio/" + name, binary=True))
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,sample_rate,channels", "-of", "json", str(artifact)], capture_output=True, text=True, timeout=60, check=True)
        report["ffprobe"] = json.loads(probe.stdout)
        duration = float(report["ffprobe"]["format"]["duration"])
        if abs(duration - report["background_requested_elapsed_s"]) > 5:
            raise RuntimeError("Decoded duration differs from measured capture interval by more than five seconds")
        decoded = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(artifact), "-f", "null", "-"], capture_output=True, text=True, timeout=120)
        report["decode"] = {"exit_code": decoded.returncode, "stderr": decoded.stderr}
        if decoded.returncode or decoded.stderr:
            raise RuntimeError("Full decoding reported errors")
        pid = device.shell("pidof", PACKAGE)
        (args.output / "native.log").write_text(device.run("logcat", "-d", "--pid=" + pid, "ReactNativeJS:V", "AndroidRuntime:E", "*:S"))
        # Exercise persisted metadata on cold restart; no playback action is sent.
        device.shell("am", "force-stop", PACKAGE)
        started = False
        device.shell("am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", "agentclient-audio://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8083", PACKAGE)
        time.sleep(3)
        if device.microphone_active() or device.journal().get("saved") != saved or device.size(name) != saved["bytes"]:
            raise RuntimeError("Restart changed the saved recording or activated the microphone")
        dump = device.shell("uiautomator", "dump", "/sdcard/agent-audio-soak.xml")
        if "UI hierchary dumped to" not in dump:
            raise RuntimeError("Fresh restart UI hierarchy unavailable")
        xml = device.run("exec-out", "cat", "/sdcard/agent-audio-soak.xml")
        (args.output / "after-restart.xml").write_text(xml)
        texts = {node.get("text") for node in ET.fromstring(xml).iter("node")}
        if not texts.intersection({"Microphone off", "Mikrofon vypnutý"}) or not texts.intersection({"The last saved recording was restored. The microphone remains off.", "Poslední uložený záznam byl obnoven. Mikrofon zůstává vypnutý."}):
            raise RuntimeError("Restart UI did not confirm passive recording restoration")
        device.screenshot(args.output / "after-restart.png")
        report["restart_verified"] = True
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        if started:
            # Never blindly tap a button which may have reverted to Start.
            # Background the owned app, or terminate only this test package.
            try:
                if device.foreground():
                    device.shell("input", "keyevent", "3")
                    time.sleep(1)
                if device.microphone_active():
                    device.shell("am", "force-stop", PACKAGE)
            except Exception as error:
                report["cleanup_error"] = str(error)
        if original_timeout is not None:
            try:
                if original_timeout == "null":
                    device.shell("settings", "delete", "system", "screen_off_timeout")
                else:
                    device.shell("settings", "put", "system", "screen_off_timeout", original_timeout)
            except Exception as error:
                report["settings_restore_error"] = str(error)
        report["finished_utc"] = utc()
        save()
        print(json.dumps({key: value for key, value in report.items() if key != "samples"}), flush=True)


if __name__ == "__main__":
    main()
