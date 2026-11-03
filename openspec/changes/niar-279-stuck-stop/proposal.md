# Proposal

Tracker: **NIAR-279** (a server error leaves the chat stuck on Stop)

## Why

When the server answered a chat message with an error (a model error such as `model_unavailable` or `model_limit`, another server error, or a dropped connection), the phone kept showing Stop in the composer, and the chat was stuck:

- The client keeps a request that failed after it was sent as `pending` (`network_error`), so an explicit Retry can resend the exact command without a duplicate. The phone showed Stop for every pending `message.send` of the open chat, running or not; the web did the same (`isRunning = !!progressCommand`).
- Stop posts `commands/interrupt`. A request that already failed is no longer running and has no receipt, so the server answers `unknown` / `not_running`; the client read that as `requestInterruptFailed` and kept the request. Stop turned into "Retry stopping this request", which got the same answer forever.
- The progress card's Retry resent the command, which for a lasting model error (`model_limit`, `model_expired`) failed again. Nothing let the person let go of the request, so the chat could never send again.
- Outside the chat the phone showed a stray "Retry same command" on every screen for the chat's failed message.

## What Changes

- Stop is offered only while the request runs (`commandStates` is `sending`), on the phone and the web; Esc on the web likewise.
- A request that failed, or that was found in the outbox after a restart, shows its failure in its chat with **Retry** (the exact command, as before) and **Dismiss**. The composer is back to the microphone or Send.
- Dismiss (`ClientSession.discardPending`) asks the server about the exact command through the existing `commands/interrupt`. `settled` shows the recorded outcome; `unknown` / `not_running` (neither running nor recorded) clears the request without an outcome, and a message the server never recorded goes back into an empty composer; any other answer keeps the request with Retry and Dismiss and says the stop was not confirmed. Dismiss never resends anything.
- The phone's global "Retry same command" no longer offers a chat message; that message is retried or dismissed in its chat.

## Non-goals

- Server changes. `commands/interrupt` already answers what Dismiss needs.
- Process commands (`process.start`, `process.answer`, …) keep their own recovery cards.
- Starting a meeting recording while a failed message is kept still asks to stop it first (`onStartRecording` calls `interruptPending`); reported separately.
- Telling the person on the phone which other chat holds a failed message (the web already says so).

## Risk

- `not_running` is the in-process view of one server. After a server restart, a native turn that had started may still be recorded later even though the server answered `not_running`; Dismiss then clears the local request and the recorded turn appears through events as usual. Nothing is resent either way.
- A dropped connection right as the server reads the body could, in theory, let a Dismiss see `not_running` before the request registers. The person presses Dismiss seconds later; the window is the time to parse one request body.
