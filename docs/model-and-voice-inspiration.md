# Inspiration from the Callout project

Notes from another project's write-up, taken as inspiration, not as an
implementation plan. They do not change the scope, integration permissions, our
own results or approval rules. They are input for later decisions; no new model
or cloud audio was turned on because of them.

## What carries over to our design

- Separate transcription → text decision → optionally speaking the finished
  result. The local Whisper and the server text model already have separate
  roles. The next approved direction remains a general voice request with
  transcript review; TTS comes as a separate option.
- The model carries no permission. Keep our explicit confirmation of a specific
  draft revision; agreeing-sounding words in the conversation do not replace it.
- For future multi-step work, evaluate the whole result with stubbed tools and a
  real integration pass. The current test measures bounded structured intents,
  not a general tool loop. Report model time, whole-action time, cost and quality
  separately.
- For TTS, verify fidelity with an independent transcription and listening,
  especially names, numbers, dates and negation. A transcript from the same model
  can be a helper filter, not proof of audio fidelity. Limit phone number
  normalization to recognized data types; keep the original displayed text.
- Use our own TEST records instead of temporarily overwriting real data. After an
  uncertain write, verify its identity; do not adopt the general advice to retry
  POST automatically as a guarantee of idempotence.

## Candidates, not a configuration change

The public [OpenRouter catalog](https://openrouter.ai/api/v1/models) was re-read
on September 24, 2026 without a key. It currently lists:

| Candidate                    | Structured outputs in the catalog                     | Reasoning                   |
| ---------------------------- | ----------------------------------------------------- | --------------------------- |
| `deepseek/deepseek-v4-flash` | yes                                                   | not required                |
| `inclusionai/ling-3.0-flash` | parameter not listed; `response_format` and tools yes | not required, on by default |
| `z-ai/glm-5.3-flash`         | yes                                                   | required                    |

DeepSeek is a good candidate for a later comparison against our contract. For
Ling, first verify that the specific endpoint is compatible with the required
strict schema; `response_format` alone is not proof. The catalog also does not
prove availability under our `zdr`, no-data-collection and price limit settings.
The 15/15 results and latencies in the write-up are another project's
measurements, not ours.

The active GPT-4.1 mini stays unchanged. We do not run another paid benchmark
just to adopt this inspiration.

The official [TTS documentation](https://openrouter.ai/docs/guides/overview/multimodal/tts)
confirms a separate `/api/v1/audio/speech`, PCM/MP3 and discovery via
`output_modalities=speech`. The chat [audio interface](https://openrouter.ai/docs/guides/overview/multimodal/audio)
has a different contract and requires streamed output. Claims in the write-up
about specific voices, Czech quality, long-recording limits and temperature
preference are experience with that model and endpoint combination, not
universal rules. No new audio call was made.

Siri and wake phrases remain future platform research. The write-up does not
change the current explicit start of recording or the scope of today's access.

## ASR follow-up — September 25, 2026

The original project's agent answered specific questions. Its answer separates
three actual roles:

| Role in Callout             | Model according to the answer  |
| --------------------------- | ------------------------------ |
| Audio transcription         | `google/gemini-3.1-flash-lite` |
| Text agent / tools          | `deepseek/deepseek-v4-flash`   |
| Reading the finished answer | `openai/gpt-audio-mini`        |

ASR uses OpenRouter `POST /api/v1/chat/completions` with base64 `input_audio`,
not a dedicated transcription endpoint. The original agent explicitly does not
claim a win against Whisper; the model was not chosen based on such a test. The
answer describes a Czech transcription prompt, no temperature/vocabulary, whole
WAV recordings and limits on long inputs. Its latency and cost experience is not
our measurement.

The official [model page](https://openrouter.ai/google/gemini-3.1-flash-lite) and
[audio contract](https://openrouter.ai/docs/guides/overview/multimodal/audio) were
verified; the model successfully transcribed our synthetic WAVs. **Our result:**
the original prompt 11/20, a stricter prompt with a local Silero filter 16/20,
the current Whisper + Silero 12/20 with the same corrected metric. The stricter
variant is not flawless. After explicit approval, a separate Gemini ASR adapter
was wired in and activated on the test backend, including local speech detection
and accurate labeling in settings.
[Exact results and how to repeat the test](voice-quality.md#callout-gemini-comparison--september-25-follow-up).
