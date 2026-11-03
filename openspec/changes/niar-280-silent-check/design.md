# Design

## Before

1. `ClientSession.send` persists the command and posts it. The connection drops (or the server answers 5xx without a receipt); the catch keeps the command as `pending`, `commandStates[target] = "network_error"`, `error = "network_error"`.
2. The phone's `ChatThread` rendered `RequestProgressCard` with `interrupted` (any `network_error`, offline, or a Dismiss on offer), which read "Result not confirmed" and "Status unavailable. It won't be resent.", with Check result (`session.retry()`) and Dismiss. The composer footer showed `network_error` ("Delivery unclear. Retry to check."). The web's `requestInterrupted` showed the same title with "Connection lost. Retry to check whether it finished."
3. Nothing happened until the person pressed Check result, which posted the identical command.

## Decisions

### D1. The session checks a lost outcome itself

`ClientSession` keeps a private `check` for the pending command: `{commandId, mode, failures, dueAt}`. It belongs to the kept command; `publish` drops it as soon as `pending` is another command or none, and derives `state.deliveryCheck` from it.

- A send of `message.send` or plain `service.resolve` (`checkedByItself`) whose delivery started and ended with `network_error` sets `mode: "checking"`, `error: null`. A `model_*` answer or a Stop that was not confirmed (`requestInterruptFailed`) sets `mode: "failed"` and keeps its error.
- `checkDelivery()` runs after each poll tick (`tick` → `sync().then(checkDelivery)`) and after `setActive(true)`. When the check is due, the client is online, nothing is submitting, no Stop or Dismiss is in flight and the app is in the foreground, it calls `send(pending, true)`: one POST of the identical serialized command, through the same path as Retry.
- A check that fails again counts (`failures + 1`) and is due after 2, 4, 8, 16 s. The fifth failure sets `mode: "failed"` with `error: null`, so the card's own "Couldn't finish. Try again." explains it. A new send or a person's Retry starts at zero.
- Going from offline to online (`refresh`) resets the count and makes the check due at once; so does returning to the foreground. Offline nothing is posted, so a server outage never counts toward failure.
- A command restored from the outbox after a restart starts as `checking`.
- `discardPending` sets `mode: "failed"` before asking the server, so a Dismiss is never raced by a check and an unconfirmed Dismiss shows the failed message.

Alternative considered: probe with `commands/interrupt` and show the failed message on `not_running`. Rejected: interrupting a request the server still runs (a dropped connection with a live server) stops the answer the person is waiting for. Re-posting joins it instead. A command the server never recorded is taken by the re-post; it never ran, so this repeats nothing.

Alternative considered: a timer inside the session. Rejected: the poll tick already pauses in the background and in a hidden tab, and a session started without polling (tests, tools) keeps full manual control.

### D2. Clients show checking as working

- `canRetryPending` returns false for the checking command, so no Retry appears anywhere (chat, the phone's global Retry, the web's alert).
- `chatRequestFailed(state, conversationId)`: the chat's kept request is not sending and can be retried. The phone passes Dismiss and Retry to `ChatThread` only then; the web marks the live message stopped and failed only then (or on a model error, or a failed activity).
- `RequestProgressCard` loses the `interrupted` and `connection` props and every "unknown" state: it shows Thinking (or the voice line) unless `failed`, which shows "Request interrupted", "Couldn't finish. Try again.", Try again and Dismiss. Offline it stays Thinking; the header says Offline.
- The web's progress hint is the model error's copy only; "Connection lost. Retry to check whether it finished." no longer appears for a chat request.

### D3. Copy

Removed: `progressUnknown`, `progressUnavailable`, `progressUnconfirmed` (EN and CS). `progressRetry` reads "Try again" / "Zkusit znovu".

## Verification

- `tests/reconnect-after-server-loss.test.ts` (real `ClientSession` over a fake server): an answer lost when the server dies, recorded or not, stays quiet for two minutes offline, nothing posted; after the server returns one identical POST settles it and one user message and one answer exist. A drop with the server up is checked within a second. Every read answering 500 keeps it quiet and unposted until fixed. A `model_unavailable` check shows the failed message, is never posted again by itself (through reconnects), and Dismiss lets it go on `not_running`. Retry of a failed message posts the identical command. Checks failing while reads work are one POST each, spaced out, and end failed after five. An outbox command after a restart is checked on start. In the background nothing is checked; returning checks at once.
- `tests/failed-request-recovery.test.ts`: a 500 or a dropped connection leaves `checking`, no error, no Retry; model errors leave `failed`; Dismiss rules unchanged.
- `tests/failed-request-mobile.test.tsx`, `tests/web-chat-next.test.tsx`, `tests/web-chat.test.tsx`, `tests/activity-card.test.tsx`: no "Result not confirmed", "Status unavailable", "Check result" or "Delivery unclear" (EN or CS) while checking, online or offline; the answer then appears; a failed check shows Try again and Dismiss.
- Emulator: send, stop the dev server about 1.5 s later, start it again; screenshots in the session scratchpad `n280/`.
