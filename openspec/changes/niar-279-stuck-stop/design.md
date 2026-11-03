# Design

## The stuck sequence (before)

1. `ClientSession.send` persists the command, sets `commandStates.chat = "sending"` and posts it.
2. The server answers `503 {error: "model_unavailable"}` (or another failure after delivery started). `send` keeps the command as `pending`, sets `commandStates.chat = "network_error"` and `error` to the code (`packages/client-core/session.ts`, send's catch, `pendingRetained`).
3. The phone passes `onStop` to the composer whenever `pending.type === "message.send"` for the open chat (`apps/mobile/App.tsx`); the web sets `isRunning = !!progressCommand` and `stoppable` from it (`chat-next-page.tsx`). Stop replaces the microphone or Send.
4. Stop calls `interruptPending()`, which posts `commands/interrupt`. The server (`apps/fixture-server/model-service.ts` `interrupt`) finds no receipt and no running entry and answers `unknown` / `not_running`.
5. The client throws `requestInterruptFailed`, publishes it and keeps `pending`. Stop now reads "Retry stopping this request" and repeats step 4.
6. Retry resends the exact command; a lasting model error returns to step 2. `send` refuses any new message while `pending` is set, so the chat cannot move on.

## Decisions

### D1. Running means `sending`

A request runs while its target's `commandStates` entry is `sending` (the same rule as `runningChat` in `chat-view.ts`). Stop and Esc are offered only then. A request that failed keeps `network_error` (or the `storage_error` of a known outcome) and is shown as failed.

### D2. Dismiss settles with the server, never locally on a guess

`discardPending()` reuses the interrupt request (`interruptFlight(flight, discard)`), with the same flight, dedupe and confirmation as Stop:

- `settled` confirms the recorded result exactly as Stop does (`confirmCommand`).
- `unknown` / `not_running` is the server's statement that the exact command neither runs nor was recorded. `releaseUnrecorded` writes the empty outbox first, then publishes `pending: null`, `commandStates[target] = "idle"`, `error: null`, and returns frozen attachments to the draft. If the outbox write fails, the request stays and `storage_error` is shown.
- Anything else (`not_settled`, an error, a lost answer) publishes `requestInterruptFailed` and keeps the request. It does not set `flight.interruptionFailed`, which belongs to a running request.
- A known outcome whose local save failed (`flight.outcomeKnown`) needs no server question: `finishCommand` clears it locally.

`discardPending` refuses while offline, while a command is being submitted, while the request is `sending`, and for process commands, which have their own recovery.

Alternative considered: make Stop itself treat `not_running` as success. Rejected: for a running request, `not_running` can mean the server has not registered it yet, so it proves nothing; only a request whose delivery already ended can be let go on that answer.

Alternative considered: clear the request locally without asking. Rejected: after a dropped connection the server may have recorded or may still run it; the interrupt answer either shows that outcome or stops it, so a Dismiss never hides a completed action.

### D3. One place for a failed message

The failed message stays in its chat: the phone's `RequestProgressCard` and the web's progress line show Retry and Dismiss. The phone's global Retry skips `message.send`; the web already shows only "An unfinished request is waiting in another chat" with Open elsewhere. After a Dismiss that released an unrecorded message, its text returns to the composer when the composer is empty and the same chat is open.

## Verification

- `tests/failed-request-recovery.test.ts` (client-core, real `ClientSession` over a fake fetch): every model 503 code, a 500 and a dropped connection leave a kept, not-running request; Stop's interrupt is refused (`not_running`) as before; Dismiss clears on `not_running`, shows the receipt on `settled`, keeps Retry and Dismiss on `not_settled` / lost / 500, refuses while running and while offline, and works for a request restored from the outbox. The failed command is posted once; Retry posts the identical body.
- `tests/failed-request-mobile.test.tsx`: the phone composer leaves Stop for the microphone, the card offers Retry and Dismiss, Dismiss restores the text, an unconfirmed Dismiss keeps both, and Meetings, Tasks and Library show no Retry.
- `tests/web-chat-next.test.tsx`: the web composer leaves Stop for Send, the progress line offers Retry and Dismiss, Dismiss restores the text. Esc shares `stoppable` with the Stop button; the node test environment has no `window` key listener, so Esc is not exercised.
- Existing interruption, answer stream and work cancel suites unchanged.
