# Proposal

Tracker: **NIAR-255**

Status: **Design accepted for bounded implementation.** The [owner decision](reviews/implementation-readiness-20261030/owner-decision.md) records independent closure, the exact three-voice inference and playback decisions, and the separate S1–S3 backend Dispatch. Client/UI ownership and implementation acceptance remain pending.

## Why

A person currently hears the workspace's one configured output voice and cannot choose their own timbre. Let the person choose a supported output voice in mobile settings or web `/me`, with a clear Server default that follows the current workspace voice.

## What Changes

- Add a personal output-voice preference shared by that person's mobile and web sessions in the same organization/workspace, with owner-only read/write, persistence, conflict handling and cross-account response isolation.
- Keep the workspace's `speech.voice` as explicit **Server default**; show its current label (Cedar in the inspected configuration). An invalid or removed personal choice falls back to that current value and explains the fallback.
- Advertise only a bounded server-reviewed catalogue bound to the exact provider/model/method and authenticated actor. Proposed initial alternatives for the current OpenRouter `openai/gpt-audio-mini` reader route are Alloy, Echo and Shimmer, inferred from the exact upstream Chat Completions/model contract plus OpenRouter audio semantics. That inference still needs review; missing reader metadata does not prove alternatives unsupported, and fallback-only does not fulfill the personal-choice outcome.
- Negotiate a separate `agent-output-voice/1` settings resource while preserving the strict `agent-speech/1` shapes. Clients select advertised opaque options; only the server resolves provider voice IDs and revalidates them at speech dispatch.
- Use text labels and save immediately on an explicit option selection, with no extra Save confirmation; retain the last acknowledged state until success and keep a stale-choice Reset reachable even when speech is unavailable. Opening/saving settings never triggers synthesis, preview, recording, provider discovery, workflow commands or automatic paid retries.
- Clarify the voice spec's phone-only boundary to allow a web preference editor while retaining phone-only voice input/playback. Propose that saving the new output-voice preference affects the next requested synthesis without stopping/restarting existing audio; the existing spoken-replies toggle still cancels playback.

## Non-goals

Browser recording/playback, input-transcription profiles, speaker identity/biometrics, voice cloning, a preview player, automatic model/provider switching, pet/weather settings, new providers, runtime operator catalogue administration, dependencies, a new speech spend ledger or durable speech HTTP deduplication.

## Risks

The provider has no per-model reader voice metadata, and published method schemas do not prove every routed backend accepts a choice. Treat the initial pin as a visible review decision; unknown routes stay Server default only, provider refusals keep text, and no fallback call is added. Preserve existing authorization, concurrency, provider quota, cancellation and workflow idempotency without claiming the unwired speech spend-budget or durable speech replay guarantees.

## Capabilities

### New Capabilities

None; extend the existing voice and model-routing capabilities.

### Modified Capabilities

- `voice`: personal mobile/web editor, strict separate settings contract, isolation, lifecycle, dispatch revalidation, no-preview behavior and playback preference clarification.
- `models-and-providers`: preserve workspace spoken-reply routing as Server default and constrain server-reviewed output catalogues to the exact authorized route.

## Impact

Add a protocol module, server catalogue/preference store and authenticated settings handler; integrate the existing speech dispatch through `apps/server-identity/service.ts`, `service-catalog.ts`, `mobile.ts` and `apps/fixture-server/http.ts`. The primary UI/client owner later adds ClientSession methods, mobile VoiceSettings and a web `/me` section with EN/CS states and tests. Existing main specs and all production files remain untouched by this draft; `design.md` names exact proposed file boundaries and verification. No dependency, provider activation or deployment is included.
