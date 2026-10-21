# ADR 003 — Local recorder boundary and emulator evidence

Date: 2026-09-23. Status: accepted for the isolated spike only. The original last-file-only persistence decision below is extended by [ADR 004](004-audio-recovery-journal.md); explicit recovery is now implemented.

## Decision

Keep the audio entry and app identifiers separate from the main text client. Use Expo SDK 57's `expo-audio` for capture/playback and the direct SDK-compatible `expo-file-system` dependency for local document-file checks. The main app's Meetings screen remains a placeholder.

Request microphone permission only on Start. Capture is foreground-only: app background/lock requests a final Stop and a later foreground event never authorizes a new capture. `RecorderSession` serializes start/stop, cancels pending permission/preparation after background, and retains ownership if native cleanup fails. Its ports permit deterministic error-path tests without pretending to exercise a device.

The installed Android recorder automatically pauses/resumes across lifecycle events. Explicit stop is necessary for the chosen interruption policy. Android also reports encoder errors through the completion event even when its stop Promise resolves. Saved therefore requires a successful completion event and a nonempty file, while native playback and external decoding provide separate readability evidence. Saving metadata is distinct from finalizing the audio file.

Persist only the last finalized file's metadata for this slice. Returning from a completed recording restores that file without acquiring the microphone. Unindexed files after forced termination are not automatically presented as complete. A recording journal and explicit partial-file recovery are the next step, before production recording or upload work.

Both native build commands regenerate the ignored native project to select the requested normal/audio variant. Each variant has a distinct app package and development URL scheme, preventing the Android chooser seen when both originally used `exp+agent-client`.

## Evidence and limits

The [audio runbook](../../spikes/audio/README.md) records actual emulator cases, file sizes and decoder results. One approximately 30-second recording decoded fully; playback, saved-file restart, EN/CS, background and lock were exercised. A force-stopped capture left a decodable 3.785-second orphan, discovered through ADB. This is evidence for one environment, not a guarantee for other interruption timings or devices.

The host microphone was disabled. No physical speech, Bluetooth, phone-call interruption, long recording, live voice, STT/TTS, upload, physical iOS/Android matrix or encrypted retention is claimed. The diagnostic UI uses shared primitives and native QA; standalone production audio stories remain future work.

Sources checked: [Expo audio SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/audio/), [Android emulator microphone controls](https://developer.android.com/studio/run/emulator-extended-controls#microphone), and the installed `expo-audio` Android `AudioModule.kt` / `AudioRecorder.kt` implementation. See also [ADR 002](002-runtime-and-catalog.md).
