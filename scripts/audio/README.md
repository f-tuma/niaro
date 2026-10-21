# Android emulator recording soak test

For short Czech request quality and silence endpointing, see the separate [voice evaluation runbook](../../docs/voice-quality.md). Its optional Piper generator and `npm run test:voice:quality` use synthetic files without ADB, a host microphone or cloud inference. The soak procedures below test a different, isolated recording app.

This is an opt-in local QA command, not an application feature or a scheduled job. It controls only the isolated `dev.agentclient.demo.audio` app on a named Android emulator. It disables host microphone forwarding and leaves that forwarding disabled. No physical phone, real speech, upload or live voice provider is used.

## Requirements and invocation

- Audio development build installed; its Metro server running at port 8083 and reachable through `adb reverse tcp:8083 tcp:8083`.
- Python 3, Android SDK `adb`, `ffprobe` and `ffmpeg` on the host.
- Open the audio app in the foreground, microphone off, at the top of its screen with Start visible. Grant its emulator microphone permission manually before the test. Do not interact with the emulator during capture.
- Choose a new output directory. The script refuses to overwrite an existing one.

```sh
python3 scripts/audio/soak.py \
  --adb "$ANDROID_HOME/platform-tools/adb" \
  --serial emulator-5554 \
  --duration 1800 \
  --interval 60 \
  --output /tmp/agent-audio-soak-new-run
```

For a quick verification, use `--duration 10 --interval 5` and a different output directory. `--help` prints all options. Start is found from the current EN/CS accessibility label and bounds, with no stored screen coordinates.

The test temporarily extends the emulator screen timeout and restores its previous value at the end. It checks that the target reports itself as an emulator, disables host microphone input, requires a foreground idle app, and observes an active RECORD_AUDIO app-op after Start. It samples the new native recording file, process ID, foreground state, active microphone app-op, and process PSS/RSS every interval. Sampling is discrete; it cannot prove continuous availability between samples. File growth and a stable process/foreground/active-microphone state are required for a passing result.

After the requested interval, the test sends Home. The application's foreground-only policy must stop recording, persist the portion as interrupted and release the microphone. It reads this test app's journal, copies the generated file, checks duration with ffprobe and decodes the complete file with ffmpeg. It then force-stops the already-idle app, relaunches through the audio development URL, checks the same saved metadata/file and verifies the passive-restoration text and microphone-off state in a fresh UI hierarchy.

Ctrl-C/SIGTERM marks the report failed and attempts microphone cleanup. A force-killed host process or lost ADB connection can prevent cleanup; inspect the emulator and stop the test app if that happens. The script never blindly taps a presumed Stop coordinate, deletes an audio file, changes permissions or clears app storage.

## Artifacts and interpretation

`report.json` is updated after each sample and on exit. Inspect `status` before interpreting any measurement as a pass. It contains the requested duration, measured elapsed times, emulator build, file growth, process PSS/RSS, saved metadata, decoder output and restart result. A nonzero script exit is a failed/incomplete test. `recording.m4a`, before/after PNG/XML snapshots and a log scoped to the app process are also retained in the output directory.

Report KiB/MiB explicitly when converting Android memory and file sizes. PSS/RSS include the Expo development runtime and native allocations; they are not JavaScript heap measurements or proof of a leak. Emulated thermal/battery metrics are not useful physical-device battery evidence. The synthetic encoded signal does not establish microphone quality, intelligibility or routing. A fully decoded file proves readability of that run, not lossless crash recovery at every possible interruption point.

The runner currently supports the existing foreground-only policy and uses Home as the terminal interruption. It does not exercise sustained background capture, OS suspension, route changes, phone calls, low disk space or power loss. Retained files and journal entries are not a production history/retention policy.

## Pure harness tests

```sh
python3 -m unittest discover -s scripts/audio -p 'test_*.py' -v
```

These ten tests do not call ADB. They reject disabled/ambiguous/offscreen Start controls, truncated runs, inactive recording, process changes, non-growing files, unordered samples absent memory fields, physical-device targets, and cleanup after an uncertain Start input. They also validate the release-only package flag guard. They complement the 84 Jest application tests; neither suite substitutes for an actual emulator run.

## Standalone release measurement

`release_soak.py` targets only the separate `dev.agentclient.demo.audio.profile` emulator package. Install the intended standalone release APK, verify its SHA-256, and open its idle audio screen with Start visible. This runner checks the installed non-debuggable flag, turns host microphone forwarding off, warms up idle for two minutes and samples recording every minute. It has no Metro dependency.

```sh
python3 scripts/audio/release_soak.py \
  --adb "$ANDROID_HOME/platform-tools/adb" \
  --serial emulator-5554 \
  --duration 1800 \
  --warmup 120 \
  --output /tmp/agent-release-soak-new-run
```

Home ends capture and must release the microphone. Successful sampling ends at `capture_complete_pending_file_validation`, **not** a fully passed test. Private recording growth cannot be sampled with `run-as` in this release build. The report includes full process/native PSS, RSS, process identity, foreground and microphone state, plus raw `meminfo` samples.

For file verification, retain the exact release APK first. After capture and memory sampling have ended, temporarily install a debug APK with the same isolated package ID and signing certificate, without launching it or clearing storage. Use `run-as` to copy the saved journal/file, check size and duration with `ffprobe`, and decode the entire recording with `ffmpeg -v error -xerror`. Reinstall the retained release APK, cold-launch it, and verify that the same saved recording is restored with the microphone off. Record these separate steps before marking the overall report passed. This local extraction procedure is outside the measured release run; do not use it on unrelated app data.
