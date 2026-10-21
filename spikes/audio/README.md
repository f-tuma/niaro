# Isolated audio risk spike — DEV-002 / DEV-003

Updated 2026-09-23. A local recorder investigation, separate from the main application and business commands. This is not live voice or production meeting recording.

## Implemented behavior

SDK 57 [expo-audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/) records into the app document directory after an explicit Start and runtime permission. The screen reports native `isRecording`, allows manual Stop and playback, and stores a recording journal with the last saved file's URI, duration, size and interruption flag in AsyncStorage. EN is the default; manual CS survives restart. Nothing is uploaded or sent to a model.

A successful native completion event and a nonempty local file are required before displaying Saved. Android can resolve `stop()` while reporting an encoder failure in its completion event, so resolving the Promise alone is insufficient. Playback readiness comes from the native player; file size alone does not prove decodability. Metadata write failure keeps the valid file visible and explains the restart limitation.

The recorder session owns the microphone through `AudioSessionCoordinator`. Backgrounding or locking requests a final Stop, marks the saved portion interrupted and requires a manual new Start. Permission or preparation completing after backgrounding cannot start capture. This policy is deliberate: the installed expo-audio Android implementation otherwise pauses on background and resumes on foreground. Background recording and playback services are disabled in the config plugin and runtime audio mode. Physical OS suspension can still prevent JS cleanup; this is not a durability guarantee.

Before capture starts, the prepared file URI is persisted as pending. Startup discovers unfinished entries and unindexed native recording files. Explicit **Check file** reads native player readiness and duration without playback; **Keep recovered portion** saves an interrupted portion and makes manual playback available. It does not prove completeness or decode every frame. **Hide, keep file** persists a choice without deleting the file. Missing/empty and unreadable files have distinct explanations. A damaged/unreadable journal blocks recording until it can be loaded; a failed pending write prevents capture. See [ADR 004](../../docs/adr/004-audio-recovery-journal.md) for schema, migration and failure behavior.

For duplex voice, [LiveKit's Expo development-build path](https://docs.livekit.io/transport/sdk-platforms/expo/) remains a candidate, not an installed or tested transport. No STT/TTS provider, Jev inference, paid account or live room is selected.

## Build and run

```sh
AUDIO_SPIKE=1 npm run android -- --port 8083
# macOS with Xcode:
AUDIO_SPIKE=1 npm run ios -- --port 8083
```

The `preandroid` / `preios` scripts regenerate the ignored native project from app config before building. This prevents a previous normal/audio variant from leaving the wrong package or permissions in the generated project. Native changes belong in config/plugins; these scripts do not preserve manual edits inside generated `android/` or `ios/`.

Audio uses package `dev.agentclient.demo.audio`, scheme `agentclient-audio` and development scheme `exp+agent-client-audio`. The main app uses its original identifiers, so both can remain installed. Use separate Metro instances: audio 8083, main 8084 (or the normal default). To start only audio Metro after installation:

```sh
npm run audio:spike
```

Set `JAVA_HOME` to a JDK 17 and `ANDROID_HOME` to the Android SDK (for example `~/Android/Sdk`) if they are not already available. For an emulator connected as `emulator-5554`:

```sh
$ANDROID_HOME/platform-tools/adb -s emulator-5554 reverse tcp:8083 tcp:8083
$ANDROID_HOME/platform-tools/adb -s emulator-5554 shell am start -W -a android.intent.action.VIEW -d 'agentclient-audio://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8083' dev.agentclient.demo.audio
```

To switch the generated project back to the main app, run `npm run android -- --port 8084`. The APK at `android/app/build/outputs/apk/debug/app-debug.apk` belongs to whichever variant was last built; keep a named copy before switching. The verified audio APK from this session was copied to `/tmp/agent-client-audio-debug.apk`.

## Executed Android emulator checks

Environment: AVD `droid`, Android 17 / API 37, x86_64 with 16 KiB pages, 1080 × 2400, density 420; Expo 57.0.24, expo-audio 57.0.5, expo-file-system 57.0.7. Native UI controlled with authorized ADB input, screenshots and UI hierarchy reads.

Host microphone forwarding was explicitly disabled with `adb emu avd hostmicoff`. Android documents this control in [Extended controls — Microphone](https://developer.android.com/studio/run/emulator-extended-controls#microphone). These tests prove the emulator/native recording and file path, not actual microphone speech quality, acoustic routing or Bluetooth.

| Check                                                       | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build / install                                             | Separate audio APK built successfully; normal and audio development links select their own app                                                                                                                                                                                                                                                                                                                                                                          |
| Passive start / permission                                  | No recording on launch; denied permission leaves microphone off; explicit permission permits recording                                                                                                                                                                                                                                                                                                                                                                  |
| Timed local recording                                       | Stop pressed after 30.02 s; UI 30 s; file 366,403 bytes                                                                                                                                                                                                                                                                                                                                                                                                                 |
| File inspection                                             | `ffprobe`: AAC, 44,100 Hz, mono, 29.767982 s; `ffmpeg -v error -i /tmp/agent-audio-30s.m4a -f null -` decoded the full file without errors                                                                                                                                                                                                                                                                                                                              |
| Playback / completed-file restart                           | Native player entered Playing locally; pause worked; full app stop/relaunch restored the same file without starting the microphone                                                                                                                                                                                                                                                                                                                                      |
| Language                                                    | CS selected, then preserved after a full app restart                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Background / return                                         | Approximately 4 s captured; 48,464-byte portion finalized; return via `am start -n dev.agentclient.demo.audio/.MainActivity` kept microphone off and showed interruption                                                                                                                                                                                                                                                                                                |
| Lock / unlock                                               | Approximately 4 s captured; 55,338-byte portion finalized; microphone remained off after unlock                                                                                                                                                                                                                                                                                                                                                                         |
| Initial force-stop baseline, before recovery implementation | A 48,808-byte file survived, 3.784853 s, fully decodable; it was initially found only through ADB. The recovery extension below now discovers it as unindexed                                                                                                                                                                                                                                                                                                           |
| Automated checks                                            | `npm run check`: 60 tests in 10 suites, lint and TypeScript passed; tests cover denied permission, late permission/preparation after background, duplicate start, stop errors, empty output, metadata write failure, missing/corrupt restore data, native completion events, journal persistence before capture, corrupt/unsupported journals, traversal rejection, recovery/ignore failures, changed files, native probe timeout/release and passive EN/CS recovery UI |
| Export / SDK                                                | `npx expo install --check` passed; `AUDIO_SPIKE=1 npx expo export --platform all --output-dir dist-audio` passed for web/iOS/Android                                                                                                                                                                                                                                                                                                                                    |

A native player initialization error (`replace(null)`) was found and corrected during this run. The final player uses the SDK source hook and has its own lifecycle, separate from recorder restoration. Audio Metro also needed a restart; the final walkthrough used a running server. These intermediate failures are not successful test results.

The diagnostic screen uses shared primitives and EN/CS catalogs. Recovery cards have Storybook states for unfinished, ready, unreadable (CS), missing and unindexed files. `npm run storybook:export` passed with the new stories. The native recorder container is covered by session tests and actual Android screenshots rather than a mock permission UI. iOS permission-message localization remains pending.

### Recovery extension — executed 2026-09-23

Using the same emulator and installed native audio build, with host microphone forwarding off:

| Check                | Observed result                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kill while recording | Start, wait approximately 5 s, `am force-stop dev.agentclient.demo.audio`, relaunch; UI found an interrupted pending file, 60,471 bytes; microphone off                             |
| Manual check / keep  | Check exposed Keep recovered portion; saving removed this candidate and selected it as the last saved interrupted recording                                                         |
| File verification    | `ffprobe /tmp/agent-recovery-part.m4a`: AAC, 44,100 Hz, mono, 4.760091 s, 60,471 bytes; full `ffmpeg -v error -i /tmp/agent-recovery-part.m4a -f null -` decode exited successfully |
| Playback / restart   | Explicit Play showed Playing locally; full app stop/relaunch retained the same recovered file, with no automatic playback or recording                                              |
| Damaged fixture      | A newly created 51-byte synthetic non-audio `.m4a` appeared as unindexed; Check timed out into the unreadable explanation and did not offer Keep                                    |
| Hide                 | Hide removed the damaged candidate while its original 51 bytes remained unchanged; the ignored decision persisted on restart                                                        |
| Visual / language    | Czech discovery/check/keep/playback and English unreadable state inspected through native UI and screenshots; language choice survived restart                                      |

Reproduce on an emulator with synthetic input only:

1. Start the audio app using the commands above, then press Start microphone test.
2. During capture, run `adb -s emulator-5554 shell am force-stop dev.agentclient.demo.audio`. Relaunch using the development link above.
3. Verify Microphone off and the unfinished candidate. Check the file, then explicitly Keep if the player can load it. Play manually and inspect the contents.
4. Relaunch again; verify the saved portion remains and the same candidate is no longer offered. For unreadable output, Keep must remain unavailable; hiding must preserve the file.

A force-stop can produce readable, unreadable, empty or missing output. These measurements cover particular timings on one emulator, not every crash or OS suspension.

## Repeatable emulator soak runner

The [emulator measurement runner](../../scripts/audio/README.md) records sample timestamps, file growth, process continuity and PSS/RSS, then backgrounds the app, validates finalization, decodes the complete file and checks a cold restart. It uses synthetic emulator input with host microphone forwarding disabled. Its eight pure harness tests run separately from the application tests and are included in the CI configuration; CI does not launch an emulator.

```sh
python3 -m unittest discover -s scripts/audio -p 'test_*.py' -v
python3 scripts/audio/soak.py --adb "$ANDROID_HOME/platform-tools/adb" --duration 1800 --interval 60 --output /tmp/agent-audio-soak-new-run
```

The production validation target remains a **60-minute test with lock on reference physical iOS and Android devices**. A 30-minute foreground emulator result does not satisfy that target. No physical thermal/battery or acoustic claim follows from emulator PSS/RSS measurements.

### Executed 30-minute foreground run — 2026-09-23

The full run passed recording/file-growth checks, background finalization, full ffmpeg decoding and cold restart. It produced **1,800.034104 s / 21,914,399 bytes (20.90 MiB)**, AAC 44.1 kHz mono. All 31 samples showed the same process, foreground activity, active microphone and a growing file. The journal correctly marked the portion interrupted after Home, and restart left the microphone off. Manual playback of the long file and pause were also verified afterward.

**Open finding:** process PSS rose from 280.09 to 382.89 MiB (+102.80 MiB). A near-immediate snapshot after microphone release did not show a drop. The trend includes the development runtime and is not a proven leak or identified recorder fault. Profile it before claiming long-recording stability.

The subsequent memory investigation found stable idle memory, a large development/release difference, and unnecessary full-screen rerenders on recorder timer ticks. The status subscription now lives in `RecorderStatus`; the controls and interruption policy are unchanged. In the matched 60–300-second development windows, Native Heap PSS growth fell from **13.53 to 1.49 MiB**. The original 30-minute finding is not equivalent to this short comparison; a later 30-minute release run is documented below. The short release comparison did not establish improved native memory (Native Heap PSS +1.05 MiB before versus +3.29 MiB after, with an intermediate decline). Both files decoded completely, and release restoration kept the microphone off.

## Physical device matrix — still pending

Record device/OS/build ID, headphones and route, permission result, start/stop timestamps, duration, file URI/size, recoverability, interruptions and observed errors. Use short synthetic speech with the device owner's permission.

| Test                                                                      | iOS physical | Android physical |
| ------------------------------------------------------------------------- | ------------ | ---------------- |
| Permission denied / granted / revoked                                     | Not run      | Not run          |
| 30-second spoken recording and listening inspection                       | Not run      | Not run          |
| 60-minute recording with lock: growth, recovery, thermal/battery behavior | Not run      | Not run          |
| Lock/unlock, background and OS suspension                                 | Not run      | Not run          |
| Kill/relaunch and incomplete-file discovery                               | Not run      | Not run          |
| Wired/Bluetooth route changes                                             | Not run      | Not run          |
| Incoming call / OS interruption                                           | Not run      | Not run          |
| Duplex voice + recording conflict with real adapters                      | Not run      | Not run          |

The journal tracks finished/ignored filenames and the latest saved file; it is not a recording-history UI. All audio files remain in the document directory; no automatic deletion or production retention policy exists. AsyncStorage is not encrypted production storage. The recorder is not connected to a server or upload queue.

Next step: profile the measured memory growth with controlled idle-versus-recording runs and a build without development tooling. Then repeat the 60-minute locked-screen matrix on physical Android and iOS before enabling long/background production recording or a live transport.

### Executed 30-minute standalone release run — 2026-09-24

The exact fixed release APK was verified by hash and measured after a 120-second idle warm-up. All 31 samples showed the same foreground process and active microphone; Home stopped capture. The 1799.987664-second / 21,913,972-byte AAC file fully decoded. A cold launch of the restored exact release APK showed the same saved metadata with microphone off; manual playback and pause passed. Private file growth was not sampled during release capture.

Process PSS increased 103.91 → 112.83 MiB (+8.92), native PSS 25.75 → 34.85 MiB (+9.09), with repeated spontaneous drops. The final ten-minute window had no net growth, but one emulator run does not establish a permanent plateau or physical-device stability. See the [release runner and extraction procedure](../../scripts/audio/README.md). The physical 60-minute matrix remains open. Final checks: 84 Jest tests, lint/types, 10 Python harness tests passed.
