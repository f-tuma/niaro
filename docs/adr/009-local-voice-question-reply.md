# ADR 009 — Local voice requests and conditional review

Date: 2026-09-24; updated 2026-09-25 for voice v3 and adaptive endpointing/Silero VAD. Status: implemented bounded development path; M3 and speech quality acceptance remain open.

## Decision and behavior

An explicit voice draft starts a new request, or answers the existing open InputRequest explicitly selected through **Reply in chat**. Tapping the microphone starts capture inside the existing composer. Speech followed by silence, **Done**, or the 120-second maximum finishes capture, transcribes on the connected server and automatically sends usable text. Only uncertain/repeated/limited transcripts need editable review and **Send text**. The general `message.send` has no question context; contextual replies retain frozen conversationId, workItemId, inputRequestId and expectedInputRevision. The server resolves the same question as the form. Provenance remains `chat`, denoting the text-command route, not proof of review or faithful speech recognition.

This supersedes the September 24 flow requiring explicit upload and review for every recording. The coordinator performs one foreground handoff; no render/effect/replay sends a command. The message is visible immediately with the existing progress checklist. Failed transcription permits explicit retry; failed handoff preserves the transcript for review.
A transcript is untrusted data. Transcription never calls the workflow engine, creates an event/receipt, resolves a question, or approves a proposal. Ambiguous `yes` and unsupported phrases retain existing rejection behavior. Calendar approval stays a separate revision-bound UI action. Uncertain business delivery uses the existing exact-command manual retry; audio upload is ephemeral and never silently retried or restored.

The local baseline is **whisper.cpp v1.9.4**, commit `927cfce34f31707e17f2bff35c349632fb9e2c3a`, CPU, four inference threads, multilingual `small` model (487,601,967 bytes). Model repository revision `5359861c739e955e79d9a303bcbc70fb988958b1`; SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`. Installation is local to ignored `.voice/`, checks these pins, and installs no global package or system service. This local baseline uses no cloud/paid inference; the explicit Gemini option is documented in the v4 addendum below. Sent text can use the separately configured OpenRouter adapter; TTS is not implemented.

## Run

Prerequisites: Node/npm from README, C/C++ compiler, CMake, Git, curl and FFmpeg. `espeak-ng` is needed only for synthetic live tests. These tools were already installed on this workstation.

```sh
npm run voice:install
# Radicale setup/initialization is described in ADR 008; keep calendar:start running.
# Stop the existing fixture:calendar process before reusing its data directory/port.
npm run fixture:voice
# Separate terminals:
npm run fixture:calendar:pair
npm run web -- --port 8085
```

Pair the client to `http://localhost:8793/v1/a`, tap the microphone to start recording in the existing composer. EN/CS in More selects the interface and review language; the transcriber detects the spoken language from audio and preserves it without translation, including Czech speech in an English interface. Audio is sent after detected speech and 1.8 seconds of silence, Done, or the two-minute maximum to the displayed connected server. The limit always requires review. To answer a particular question, first choose its Reply in chat action. If the optional server extension or device recording is unavailable, text/form input remains usable. Web needs a secure context (localhost works) and MediaRecorder with `audio/webm`; other browser formats are currently unsupported.

Android uses the existing `expo-audio ~57.0.5` and `expo-file-system ~57.0.7`; the main app now declares explicit microphone permission with background recording/playback disabled. Rebuild the development APK via `npm run android -- --no-bundler` after this config change. On the tested Android permission activity, granting microphone permission backgrounds the app and requires a second explicit Record press. No late grant starts capture. Host microphone remains disabled during emulator QA.

## Extension and boundaries

- The optional `agent-voice/4` extension is independently negotiated by authenticated `GET /v1/{workspace}/voice`. Workflow remains `agent-client/0.4-fixture`; no persisted entity schema or migration changed. Older/incompatible servers are shown as unavailable, and the client retains text input.
- Authenticated `POST voice/transcriptions` accepts strict JSON: profile, requestId, language (`en`/`cs`, interface/review locale), frozen context (conversation only, or the complete explicit question identity), audio `{mimeType, base64}`, optional `stopReason: user | silence | limit`. Transcribers detect the spoken language independently. MIME allowlist: WAV, MP4/AAC, WebM. Limit: 8 MiB decoded / derived base64 JSON bound plus 8 KiB metadata; duration at most 120 seconds (+0.5s codec padding). Unknown properties, arbitrary URLs/paths and payload scope overrides are rejected.
- Authentication, conversation ownership and optional question/revision/work state are checked before inference and again before returning. Response includes full authenticated scope, requestId, language, context, text and reviewReasons; the client validates them before exposing a draft. Disconnect/revocation/cancellation abort requests; late results cannot enter another session.
- One local inference at a time; concurrent inference returns `voice_busy`. FFmpeg has 10s timeout, fixed media demuxer and file/pipe protocol allowlist, mono 16kHz PCM capped at 121 seconds. Overlong/empty/silent recordings are rejected. Whisper timeout is 90s, entire server/client request bounded to 110/115s. No shell interpolation of client input or client-selected executable/model path.
- Audio coordinator ownership and the proven native completion-event helper are shared in `packages/audio`. Voice controls have their own controller; component render does not request permission or record. Detected speech followed by silence, Done or the maximum stops capture and starts transcription; reaching the limit always requires review. Cancel, leaving Chat, changing question/revision/language/session, backgrounding or losing online state discard local drafts and stop capture. Permission refusal/late permission results have explicit states.
- Web capture stops all tracks; native capture finalizes, reads a bounded cache file, releases recorder/audio mode and deletes that temporary file. Server input/PCM/WAV/transcript files live in private temporary directories and are removed in `finally` after success, failure or cancellation. Draft audio/text is memory only; the **sent text** enters ordinary workflow storage. A process/device crash can leave temporary files; encrypted storage, crash scavenging, robust audio upload/retention and production isolation are still future work. Current automated validation uses synthetic local audio.

## Conditional review heuristic (v2)

Whisper full JSON provides segment text and token probabilities. The local adapter ignores special tokens and flags `uncertain` when lexical evidence is absent (including any segment without tokens), mean token probability is below 0.75, over 20% of lexical tokens are below 0.5, or any lexical token is below 0.12. With at least six words, a unique/total word-trigram ratio below 0.6 flags `repetition`. A caller-reported limit or decoded duration at least 119.5 seconds flags `limit`. Empty/nonlexical output is rejected. A transcriber returning only a string has no quality evidence and always requires review.

These thresholds are conservative development heuristics, not calibrated confidence. High token probabilities do not prove correct names, numbers or intent. The existing agent separately clarifies missing details/ambiguous contacts; calendar consent is never inferred. Real Czech/English recordings are needed before accepting speech quality or changing thresholds/model.

## Original September 24 verification and limits

`npm run check` passed 163 tests in 24 suites with clean lint, types and layer boundaries. `npm run test:voice` runs real local inference on generated eSpeak EN/CS audio, exercises explicit correction and existing idempotent question commands, and checks malformed/silent/pre-aborted audio and normal temporary-file cleanup. Both language samples needed name corrections. One measured direct pass: EN `Tuesday, Novac.` (3,491ms), CS `Vybe peteranomáka.` (3,404ms, a garbled name). These are measured synthetic-sample results, **not** p50/p95 or a speech quality benchmark.

Browser QA used bundled Playwright 1.62.1 because the Browser plugin is not available, Chromium at `http://localhost:8085/`, 1280×1000 EN and 390×844 CS. A fake microphone fed actual synthetic WAVs through real browser MediaRecorder → authenticated HTTP → FFmpeg/Whisper → editable review → explicit normal command. It resolved the same InputRequest and created zero operations. Snapshot before/after transcription was identical. Page identity, nonblank content, absence of overlay, console errors/warnings and horizontal overflow passed; screenshots were visually inspected. Repeated looping synthetic audio was explicitly shortened/corrected by the UI test; it was not silently normalized by application code. Evidence is temporary `/tmp/agent-voice-ui-result.json`, `/tmp/agent-voice-review-en.png` and `/tmp/agent-voice-review-cs.png`.

The Android development APK built successfully and was installed on API 37 x86_64 AVD `droid`. The native run verified recording, stop, upload to review, cache cleanup, and Home interruption without automatic restart. The emulator produced synthetic sound transcribed as `(Zvuková výstře)` (garbled Czech), not real speech. It exposed and fixed the RN AbortSignal API difference and platform recorder constructor options; final checks used a cold app start. Exports for web, iOS, Android and Storybook passed; an iOS export is not a device test.

No general Czech/English speech quality, 15+15 critical spoken scenarios, physical microphone, Bluetooth, iOS, locked/background live voice, TTS, model routing or production readiness is claimed. The next bounded step remains an EN/CS speech-quality dataset and measurement (including names, ambiguity, silence and interruption) before choosing a production STT model/provider.

## Primary references checked during implementation

- [whisper.cpp release v1.9.4](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.4), [CLI flags](https://github.com/ggml-org/whisper.cpp/blob/v1.9.4/examples/cli/README.md).
- [Pinned model repository](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1); API metadata verified model size/SHA-256.
- [Expo SDK 57 Audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/) and installed source/type declarations for recorder completion, permission, file and background semantics.

## September 25 v2 verification

The final command, browser and Android checks passed. `npm run test:voice` again passed real local inference and invalid/silent/abort cleanup. Synthetic names produced EN `Tuesday, Novac.` (3,406ms) and CS `Vybe peteranomáka.` (3,255ms); both were flagged uncertain. A separate synthetic English “Please show me my calendar for tomorrow.” transcribed exactly with no review reasons and passed actual browser recording → local Whisper → automatic message submission. A synthetic Czech meeting sentence was misrecognized and flagged uncertain. These examples do not establish physical speech accuracy, p50/p95 latency or production readiness.

Today's external model/CRM credentials have expired locally; their window was not extended and no paid request or real CRM write was made. Browser and native request completion use isolated synthetic model adapters. This distinguishes actual speech capture/transcription from simulated downstream interpretation.

## Inline voice UI and endpointing (September 25, v3)

The same composer shell now hosts recording and processing. Expo GL 57.0.2 renders a full-width standing wave and a separate outline positioned three points outside the shell; neither changes layout. The outline uses blue, sky and white in two repeated cycles with slowly varying stop positions, avoiding the former dark ink contrast. Both shaders ease in over 550 ms; the wave reveals from the center. Low/mid/high layers have separate fixed spatial frequencies, offsets, colors and timing. Browser FFT bands are 80–300, 300–2000 and 2000–8000 Hz; native expo-audio exposes amplitude only, so native spectral separation remains future work. Visual compression makes quiet speech readable, with an RMS gate for silence. Preparation reveals the curve; processing animates it; errors use a sibling absolute toast. Retry stays in the existing round control. Reduced motion freezes decorative movement; unavailable/lost GL falls back without stopping the microphone. Renderer resources and animation frames are disposed on unmount.

The capture controller samples level once per 100 ms (also shared with the visualizer, avoiding competing native peak reads). A rolling 1.2-second window estimates the ambient floor from its 20th percentile. The continuation gate is floor + 8 dB, clamped to -65…-45 dBFS; onset needs another 5 dB. After 600 ms of metered history, at least 200 ms of recent activity qualifies speech, including a short word spoken immediately after tapping. Once speech qualifies, the estimated floor can only fall. Speech followed by 1.8 seconds below the continuation gate stops with `silence`. Ten seconds of valid metering without speech discards audio; missing readings reset the silence run, and one sample contributes at most 150 ms so a stalled JS thread cannot manufacture seconds of silence. The 120-second maximum still forces transcript review. This remains an energy heuristic, not a speech classifier; short/quiet speech and changing noise require field validation. Manual Done remains available.

`agent-voice/3` changes capabilities and accepted stop reasons; update both sides. The local 8793 backend was restarted with existing data, no migration. Local Whisper accepted a synthetic WAV longer than the previous 20-second bound without a false limit reason and rejected audio over the new bound. This UI work made no paid model call or external write. The earlier v2 credential-expiry statement describes its test run, not the separately reauthorized OpenRouter window.

Sources: [Expo 57 GLView](https://docs.expo.dev/versions/v57.0.0/sdk/gl-view/), [Expo 57 Audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/), [Web Audio analyser](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData).

## September 25 speech reliability follow-up

Whisper now runs with its local Silero VAD front end: `--vad -vm <server-owned model> -vspd 200 -vsd 500 -vp 200`. This filters non-speech before recognition; it does not grant confidence to the remaining text. The fixed model is `ggml-silero-v6.2.0.bin`, 885,098 bytes, repository revision `9ffd54a1e1ee413ddf265af9913beaf518d1639b`, SHA-256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`. The installer verifies the digest; runtime accepts no client-selected model path. Existing inference limits and temporary-file cleanup remain in effect. This is a server implementation change within voice v3.

An 11-second pure tone previously produced text; tone and seeded pink noise now return `voice_empty` in actual inference. A 20-case Czech synthetic corpus improved from 11 to 12 accepted cases, but still fails with five unreviewed critical-term mismatches. The confidence heuristic is not calibrated. A separate actual browser recording passed correct participant/date/time/duration interpretation, explicit approval, CalDAV readback and duplicate-command protection. That successful workflow does not erase corpus failures. See [the retained measurements, commands and limitations](../voice-quality.md).

References: [whisper.cpp VAD documentation](https://github.com/ggml-org/whisper.cpp/blob/v1.9.4/examples/vad-speech-segments/README.md), [pinned VAD model](https://huggingface.co/ggml-org/whisper-vad/tree/9ffd54a1e1ee413ddf265af9913beaf518d1639b).

## September 25 v4: explicit Gemini ASR

`FIXTURE_VOICE_ENGINE=openrouter` / `npm run fixture:gemini` selects the fixed `google/gemini-3.1-flash-lite` ASR adapter independently of the text-agent model. The absent flag still selects Whisper. There is no automatic provider fallback. The user authorized the cloud switch after reviewing the synthetic comparison. Authenticated capabilities and the EN/CS More settings card expose the actual engine/model/location; v3 clients/servers must be refreshed together, without a workflow data migration or native dependency change.

Shared `voice-media.ts` bounds normalization and cleans private temporary audio for both engines. Before any cloud call or budget reservation, the standalone pinned Silero CLI must find speech; its centisecond intervals are validated and merged to estimate speech duration. Gemini then receives only a transcription prompt and one WAV `input_audio` block. Neither conversation history, CRM content nor scope identifiers are sent to the ASR service. Only submitted text reaches the separately configured text agent. Provider response size, exact model, single stopped completion and absence of tool calls are validated. There is no temperature override or automatic retry. Routing requests ZDR and no provider data collection, as in the evaluated configuration.

The same private OpenRouter config expiry and SQLite request cap apply to ASR and text interpretation, including failed/aborted calls. Cloud inference has a 45-second deadline bounded by credential expiry; decoding and local VAD each have 10 seconds. Parent cancellation aborts the transport and discards even a late response. Authentication and frozen context are still checked around inference. Pure non-speech, invalid audio, overlong decoded audio and pre-cancelled capture do not reserve a paid request.

Gemini supplies text, not token confidence. Its warning heuristic requires review for bracketed/unintelligible spans; at least 15 seconds of detected speech with fewer than four non-whitespace characters per speech-second; repeated trigrams (same threshold as Whisper); or the recording limit. Empty/nonlexical output is rejected. Other text sends automatically under the user's requested conditional-review behavior. These signals do not detect every paraphrase, missing negation or wrong name. No confidence percentage is fabricated. Errors remain outside the recording bubble; the input UI and waveform are unchanged.

`test:voice:gemini` uses real FFmpeg/Silero with synthetic media and a fake provider. Physical EN/CS microphone quality remains the next acceptance step.
