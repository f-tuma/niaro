# Voice reliability measurements — September 25, 2026

The current local `small` + Silero path works through an actual browser recording, OpenRouter interpretation and an isolated Radicale event. **Czech speech quality is not accepted:** the synthetic corpus passes 12/20 cases and still contains unreviewed critical-word mismatches. Physical speech, microphone routing, iOS and Bluetooth remain unverified.

September 30 correction: a physical-phone report exposed Czech speech being sent with the default English interface locale. Both interpreter prompts now detect the spoken language from the recording and preserve it without translation. Direct STT omits the optional language hint, and local Whisper uses automatic language detection. The wire `language` still selects interface/review text; it does not constrain the microphone's language. Endpointing again waits for 1.8 seconds of silence with both spectral and energy metering, preserving a 1.3-second thinking pause before a name or time. These changes address identifiable request and capture defects; the historical corpus scores below do not measure the revised prompts or establish physical speech accuracy.

## Reply text and playback synchronization — October 1, 2026

A foreground voice command now holds its reply text until audio actually starts. The client observes the accepted reply before waiting for local cache writes. Its automatic speech startup budget is eight seconds from that reply, rather than twenty seconds from sending the command; a long agent loop does not consume the playback budget. On Android, startup resolves only after the player reports both loaded and playing. Web startup awaits the media play promise. The native player has a ten-second media-load bound and a 150-second playback bound.

If automatic startup exceeds eight seconds, the client aborts synthesis/playback, releases the text and allows manual playback. Late audio cannot start after that fallback. Stop, navigation, backgrounding, preferences, replacement responses and session changes release the hold and cancel playback. This synchronizes presentation; it does not reduce provider synthesis latency or change ASR. Physical-phone timing remains an acceptance step.

Deterministic tests cover a 25-second agent run followed by delayed playback, accepted publication before cache persistence, startup timeout and late audio, real playback-state gating, native/web errors, cancellation and preferences. No microphone recording or paid speech provider was used for this change.

## Changes and measured results

- Client endpointing adapts to the ambient floor. A generated Czech phrase with a roughly -59 dBFS noise bed previously never finished; the adaptive detector finished after the phrase at 8.1 seconds. Tests preserve an immediate short word and a 1.3-second thinking pause, and reject a click as speech. Missing readings and JS stalls do not manufacture silence.
- The local transcriber filters speech using pinned Silero v6.2.0 before Whisper. An 11-second tone that previously produced text now returns `voice_empty`; synthetic noise and silence are also rejected. This is measured on these signals, not a universal noise guarantee.
- `npm run check`: **268 tests / 39 suites**, lint, types and layer boundaries passed. `npm run build`: web, iOS and Android exports passed. `npm run voice:install` passed using the existing pinned checkout and verified models. `npm run test:voice` passed actual EN/CS inference, corrected replies, malformed/silent/cancelled input, tone/noise rejection and temporary-file cleanup. The synthetic eSpeak names remained uncertain and needed correction.
- No UI component or native dependency changed in this follow-up. The previous shader/UI delivery's Android and Storybook results remain historical; no fresh physical-device claim is made.

The corpus has eight Czech phrases at normal and 0.03 gain, one phrase with seeded pink noise, and silence/noise/tone controls: **20 samples**. Cases include names, relative dates, clock times, duration, a CRM request and a negative instruction. Piper generated the speech; quieter gain is not a recording of a quieter human speaker.

| Run on the retained corpus                    | Accepted | Unreviewed critical-term mismatches | Offered review | Result |
| --------------------------------------------- | -------: | ----------------------------------: | -------------: | ------ |
| Whisper small, before Silero                  |    11/20 |                                   5 |              8 | FAIL   |
| Whisper small + Silero, adopted configuration |    12/20 |                                   5 |              7 | FAIL   |

All 17 speech samples passed the endpoint window check. Silence and noise reached the client empty-input deadline at ten seconds. A continuous tone can keep the energy-based recorder active until Done or its maximum, but the server rejects it. Corpus transcription uses the full WAV; endpointing is evaluated separately, so the corpus does not itself prove correctness of a truncated browser upload.

Remaining mismatches include `zítra` (tomorrow) → `zítá`, `CRM` → `CEM`, and `čtvrtek` (Thursday) → `4.`. Five mismatches had no review reason. This metric checks literal critical-word alternatives, **not downstream business semantics or five demonstrated wrong actions**. Word error rate ignores case/punctuation but distinguishes written numbers from words. An uncertain transcript with a missing critical term still fails. High token probabilities cannot establish faithful recognition.

The Silero corpus run used a test wrapper with the same CLI flags subsequently integrated into `LocalWhisper`; production-code inference was then verified by `test:voice` and the browser workflow. Median inference in both corpus runs was approximately 3.7 seconds on this workstation, not a production latency estimate.

A fixed vocabulary prompt was rejected: it passed only 9/20 and made the tone produce an unreviewed word. A six-case partial test of `large-v3-turbo-q5_0` took roughly 20–22 seconds per case, did not resolve all critical mismatches, and was stopped. Neither candidate was activated; they are not complete alternative-model benchmarks.

## Actual browser-to-calendar verification

Chromium at 393×852 used a synthetic Czech WAV through its fake microphone and real MediaRecorder. It called the authenticated local transcriber, stopped automatically with `silence`, and sent one normal message to real OpenRouter (`openai/gpt-4.1-mini`). The spoken request was:

> Připrav schůzku s názvem TEST hlas s Peterem Novákem zítra ve dvě odpoledne na půl hodiny.
>
> (Czech: "Set up a meeting called TEST voice with Peter Novák tomorrow at two in the afternoon for half an hour.")

Whisper spelling was imperfect, but the model produced the correct participant and **September 26, 2026, 14:00–14:30 Europe/Prague**. Before confirmation there were zero operations. Replaying the exact message returned the same proposal without another model call. Explicitly confirming the isolated TEST proposal created one event; its actual ICS was read back and verified. The UI displayed **Calendar event verified**. Page identity, nonblank content and application console checks passed. An earlier run also verified clarification for an unclear time request without another operation.

Tests used a disposable account and separate `qa-voice-*` CalDAV collections, removed in `finally`. Existing user work and calendar data were preserved; no invitations or CRM changes were made. Across this follow-up there were four paid model calls and three isolated TEST events, all cleaned up. One intermediate run reached the verified result but its screenshot selector matched three legitimate copies of the status; the selector was scoped before the final passing run. Another attempt stopped before inference because local Radicale was down; it was restarted with the existing data.

## Reproduce local speech measurements

Install the engine with `npm run voice:install`. The optional generator needs Python 3.12+, `piper-tts==1.8.0` in a separate environment and FFmpeg. It is a QA dependency only; the app does not implement TTS:

```sh
python3 -m venv .voice/eval-venv
.voice/eval-venv/bin/python -m pip install piper-tts==1.8.0
mkdir -p .voice/eval-models
```

Download `cs_CZ-jirka-medium.onnx` and its `.onnx.json` companion from [this pinned voice revision](https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/cs/cs_CZ/jirka/medium) into `.voice/eval-models/`. Verify ONNX SHA-256 `cbd5c900acacc8e8cbecd64347abb8de39c00a9d3104bed06fee92e4f319efc8` (63,201,294 bytes). Read the model card before reusing the voice beyond local QA. [Piper installation guidance](https://github.com/OHF-Voice/piper1-gpl) was checked for the generator.

Use a new output directory; the generator refuses to replace an existing corpus:

```sh
.voice/eval-venv/bin/python scripts/audio/generate_voice_quality.py \
  --model .voice/eval-models/cs_CZ-jirka-medium.onnx \
  --output /tmp/agent-czech-voice-new-run
npm run test:voice:quality -- /tmp/agent-czech-voice-new-run/manifest.json
```

The generator never records a microphone or calls a cloud API. The manifest records the model digest; Piper synthesis can vary, so retain generated WAVs when comparing engines. The evaluator runs local inference and the actual endpoint detector, prints each case and a summary, and exits nonzero on a failed corpus. It sends **zero workflow commands**. The retained corpus is `/tmp/voice-quality-cs-20260925/manifest.json`; temporary files may disappear after cleanup/reboot.

## Next acceptance step

Try the browser's actual microphone in normal and quiet Czech speech, with a natural pause before the date/time. Check name, day, time and duration, plus automatic stop after silence. Clarification is acceptable for missing/ambiguous details; confidently wrong critical values are not. Record the transcript and stop behavior before tuning another model or threshold. Calendar approval remains separate. Native frequency-band analysis is a separate future improvement.

## Callout Gemini comparison — September 25 follow-up

The subsequent user-supplied handoff identifies **`google/gemini-3.1-flash-lite`** as Callout's ASR model, through OpenRouter chat completions with `input_audio`. Its `openai/gpt-audio-mini` is the reader/TTS model; DeepSeek is its text/tool agent. We verified the [model's audio input support](https://openrouter.ai/google/gemini-3.1-flash-lite) and [OpenRouter's chat audio format](https://openrouter.ai/docs/guides/overview/multimodal/audio), then made actual paid requests using only our generated WAV corpus. No user's microphone recording was uploaded.

Both Gemini runs used the same 20 retained WAV files as Whisper. The first reproduced the supplied Czech prompt. The second tightened verbatim transcription, preserves spoken number words, forbids answering the recording and allows an unintelligible marker. A local Silero speech detector rejected the three non-speech controls before any cloud request; passing audio was sent unchanged. Temperature was omitted. Requests used the existing expiring key and persistent request cap, `zdr: true`, `data_collection: deny`, fixed model/endpoint, explicit output bound and no automatic retries. During this comparison the active app's transcriber and text model did not change; the later explicitly authorized integration is described below.

The first run exposed two rubric errors. `Zítra ve 14:45` ("tomorrow at 14:45") must fail when the source requests 14:00 for 45 minutes: the duration now requires its unit. Conversely `půl 3` is accepted as a written form of `půl třetí` (both "half past two"). **All three stored outputs were rescored under these same v2 rules**, without regenerating audio or repeating inference. Four deterministic regression tests cover these cases, negation/name boundaries and empty WER. Literal phrase checks still cannot prove general semantic fidelity.

| Pipeline                                     | Critical-phrase/control checks | Speech cases | Paid calls | Measured request cost |
| -------------------------------------------- | -----------------------------: | -----------: | ---------: | --------------------: |
| Existing Whisper small + Silero              |                          12/20 |         9/17 |          0 |     local computation |
| Gemini + original Callout prompt             |                          11/20 |        11/17 |         20 |             $0.002672 |
| Gemini + stricter prompt + local Silero gate |                          16/20 |        13/17 |         17 |             $0.002770 |

The original prompt hallucinated complete sentences for **all three** non-speech controls; the silence result was “Tak co, jaký byl víkend?” ("So, how was the weekend?"). The quiet clarification became `zítra ve 14:45`. The stricter prompt preserved 14:00 and the 45-minute duration in this run; the gate prevented the non-speech calls. Remaining strict-run failures were Peter → Petr in noisy speech, both CRM spellings → CEM, and the initial standalone negation merging into `Neschůzku` ("no" fused onto "meeting"). The negative verb `nevytvářej` ("don't create") remained present in that last case. A passing phrase score does not mean a verbatim transcript: one other sentence changed “Připrav” ("prepare") to “Naplánuj” ("schedule").

Speech-request medians were **1,301 ms** for the original prompt and **1,112 ms** for the stricter prompt. These exclude local VAD in the first comparison harness and are single runs on short synthetic samples. They are not p95, physical speech accuracy, or a guarantee of improvement on every recording. The generated voice may itself pronounce some words imperfectly. There was no broad ASR comparison or long-recording test.

The reusable CLI below implements both variants. It only accepts the known synthetic Czech case manifest and WAVs inside that corpus, uses the current rubric, and writes a private `.openrouter/asr-*.json` report including prompt, measured API cost, local preflight/total time, and partial/incomplete state on failure. It does not run a workflow command or change the app. The final CLI was separately exercised on two speech cases plus silence/noise/tone: **5/5**, two paid calls, **$0.0003365**. This is a smoke check, not a replacement for the full failing corpus.

```sh
# Existing pinned whisper.cpp checkout from npm run voice:install:
cmake --build .voice/whisper.cpp/build --target whisper-vad-speech-segments -j8

# Opt-in paid tests, each at most 20 requests, with the existing key/window/cap:
npm run test:voice:openrouter -- /tmp/voice-quality-cs-20260925/manifest-v2.json callout
npm run test:voice:openrouter -- /tmp/voice-quality-cs-20260925/manifest-v2.json guarded
```

`guarded` uses the local speech gate; `callout` deliberately reproduces the old prompt without that gate, including its failure cases. Reports return a nonzero exit for quality failures. The final CLI includes VAD time in total latency; filtered rows record their real local runtime, not a fictional network call. Manifest v2 updates scoring references while retaining the original WAVs. A new corpus generated with the checked-in cases also contains the corrected rules.

Total for this follow-up: **39 paid requests, $0.0057785 reported by the API**, zero workflow/calendar/CRM operations. `npm run check` passed **272 tests / 40 suites**, lint/types/boundaries; the two evaluation scripts also passed explicit TypeScript checking. The first sandboxed run could not complete the local HTTP/crash suites; the unchanged checks passed with local socket access. No application UI/runtime change or native build was made in this comparison.

**Integration follow-up:** the separately configured production adapter is now implemented and explicitly enabled on the test backend. Voice v4 capabilities/settings disclose cloud processing, and Gemini-specific uncertainty signals control review without fabricated confidence. The browser/native capture pipeline remains unchanged.

Actual browser MediaRecorder WebM with synthetic Czech speech stopped on silence, passed the local gate, was transcribed by Gemini and automatically submitted once to the text agent. The proposal had the correct test contact and September 26 at 14:00–14:30 Prague, with no operation or external write. API ASR took 2,056ms and cost $0.0001945; this is a single sample, not a latency distribution. It transcribed “Peterem” as “Petrem” (two Czech forms of the name) without a review reason. English synthetic AAC retained the meeting/time/duration through the same adapter. The three paid integration calls (two ASR, one text agent) do not replace the earlier 20-case evaluation. Next: physical Czech/English microphone acceptance, especially names, negation and time/duration.
