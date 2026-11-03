# Design

## Before

- Phone `submitMessage` cleared the draft on send and called `restore()` when the send ended not accepted and not recorded, and in `.catch`; `restore()` skipped only a command the session still held (`heldForRecovery`, NIAR-279).
- Phone voice (`createVoiceReply` → `onSubmitted`): on "not accepted, not recorded" it ran `setDraft(current || text)` with no guard. A lost answer (`network_error`, kept for the check) is "not accepted, not recorded", so the transcript landed in the composer at once.
- Phone and web Dismiss: on a released message (`discardPending()` → `releaseUnrecorded`) the text went back into an empty composer, and `releaseUnsubmittedAttachments` unfroze its files back into the tray.
- `confirmCommand` settled a refused message's attachments as `rejected`, unfreezing them in the tray.
- The NIAR-280 check calls `send(pending, true)`, publishing `commandStates[target] = "sending"`. The phone composer got `sending` from any command state, so Send spun whenever there was text; `runningChat` (Stop on both clients) also read `sending`.
- A refusal that arrived through a check or Retry finished the command with `pending: null`; the restore closure of the first send had already run, so the words disappeared.

## Decisions

### D1. "Taken" is decided synchronously

`ClientSession.send` publishes `pending` for a command it takes before its first `await`. The public `send` is now a thin wrapper around the old body (`deliver`): it calls `deliver`, and if the chat message is pending right after the call it was taken. Clients use the same test right after calling `send`: taken words have left the composer for good; a send that was not taken (another request in flight, offline, a schema error) keeps its words in the composer. On the web, where assistant-ui empties the composer on submit, the words of a send that was not taken are put back at once; they never left the device.

### D2. The session keeps failed messages

When a taken `message.send` settles (resolved or thrown), `keepUnsent` adds it to `state.failedMessages` unless it is still pending (its check, Retry or Dismiss settles it), was accepted (`acceptedCommandId`, set in `confirmCommand`), is recorded in the store (logical id or `message-<commandId>-`), or is already kept. The error is the thrown code, else the session's error, else `requestRejected`. At most 20 are kept; `invalidate` clears them. The wrapper covers every path that ends a taken message without an outcome: a refusal answered to the first send, to a check or to a Retry; a storage failure before delivery; a retired flight.

- `retryFailedMessage(commandId, newId)` sends `{...command, commandId: newId, idempotencyKey: newId}` (same text, files, context, task, mentions). If that send is not taken (offline, another request), the entry is put back.
- `dismissFailedMessage(commandId)` removes it. Nothing is sent and nothing goes to the composer.

Alternative considered: keep a refused message as `pending` with Retry/Dismiss. Rejected: an identical resend is answered from the refusal's receipt, and a pending command blocks the composer.

Alternative considered: `retryMessageCommand` (native retry with `retryOf`). Rejected: `retryOf` binds to recorded native work; a refused message has none.

### D3. Attachments leave with the message

`AttachmentRuntime.settleSend` gets `failed`: the message left the composer and failed, so the tray is cleared like on `accepted`. `confirmCommand` (not accepted), the pre-delivery failure in `deliver`'s `finally`, and `releaseUnrecorded` (Dismiss) use it. `rejected` (the session never took the message) still unfreezes the files in the tray. Try again sends the failed command's own `attachments` (draft id, revision, items).

### D4. A check is not a running request

`commandRunning(state, command)`: the command state is `sending` and either no check is in progress or the server is streaming (`activityConnection === "live"`). `runningChat` uses it (phone Stop, the web's other-chat notice and history), and so does the web's `isRunning` (Stop, Esc, assistant-ui's running flag). A check that joins a running answer offers Stop as soon as the answer streams.

Starting a meeting recording on the phone interrupts the pending request only when `commandRunning` says it runs; during a check's resend it starts recording at once.

The phone composer gets no `sending` prop: while anything is pending, `busy` already disables Send, so a spinner on Send has nothing left to say. The `ChatFooter` prop is removed; `Composer` keeps its optional `sending` for other screens.

### D5. Thread

- Phone `ChatThread` renders `failedMessages` of the chat under the stored messages: selectable text, a caption ("Attached files: n." when it has files, "Not sent." and the reason) and Try again / Dismiss. Try again is available online and when nothing is pending. A chat whose only content is a failed message counts as a conversation (no Home).
- Web: `failedMessage()` thread entries with `kind: "failed"`; `UserMessage` shows the bubble at full opacity, the caption and Try again / Dismiss through `NextChat.retryFailed` / `dismissFailed`.
- `failedMessageReason`: the code's copy, except `network_error` ("Delivery unclear", NIAR-280 forbids it) and `storage_error` (reads as a setting); those and unknown codes read as `requestRejected`.

### D6. Copy

Added `messageNotSent` ("Not sent" / "Neodesláno") and `messageFiles` ("Attached files: {n}" / "Přiložené soubory: {n}").

## Verification

- `tests/never-restore-session.test.ts` (real `ClientSession` over a fixture server): the owner's sequence (lost answer, check re-post caught in flight: `sending` but not running, Thinking with the message, no Stop; then a refusal) ends with the message in `failedMessages`; Try again posts the same body with new ids and is accepted. A model error or checks that keep failing end as a failed pending request with Retry, never as failed-unsent. A refusal at once is taken synchronously and kept; Dismiss removes it. A send not taken is not kept. An accepted message is never kept.
- `tests/failed-request-mobile.test.tsx` (phone `Workspace`): the owner's report through voice (transcript never in the composer, no Send during the check, no Stop, Thinking, failed message with Try again); the typed sequence with refusal, model error and given-up checks (composer empty throughout, no busy Send even with newly typed text, Dismiss keeps it empty); refusal shows the failed message with Try again and Dismiss; a send not taken keeps its words. Against main 47d05d0's `App.tsx` these tests fail: the transcript lands in the composer and Send reports busy.
- `tests/web-chat-next.test.tsx`: refusal stays as a failed message, Try again and Dismiss call the session, the composer stays empty; a send not taken keeps its words; the owner's sequence on the web (no Stop during the check until the answer streams, words never return); Dismiss keeps the composer empty.
- `tests/attachment-client-ui.test.tsx`: a file-only message whose local outbox write failed leaves the tray, shows as failed, and Try again sends it.
