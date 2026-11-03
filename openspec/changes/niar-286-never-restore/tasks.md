# Tasks

## 1. Client core

- [x] 1.1 `send` wraps the delivery; a taken chat message that ends neither kept, accepted nor recorded is kept in `failedMessages` with its error.
- [x] 1.2 `retryFailedMessage` (new ids, same words, files and context; kept when not taken) and `dismissFailedMessage`.
- [x] 1.3 Attachments of a message that failed after it left the composer, or was dismissed, leave the tray (`settleSend(..., "failed")`).
- [x] 1.4 `commandRunning`/`runningChat`: a background check is not running until the answer streams; `selectFailedMessages`, `failedMessageCaption`; `heldForRecovery` removed.

## 2. Clients

- [x] 2.1 Phone typed send: no restore on refusal, error or lost answer; a send not taken keeps its words.
- [x] 2.2 Phone voice: no transcript into the composer after a failed delivery.
- [x] 2.3 Phone and web Dismiss: no text back.
- [x] 2.4 Phone composer without the `sending` spinner; Stop through `runningChat`.
- [x] 2.5 Failed messages in the phone and web threads with Try again and Dismiss; a failed first message keeps the phone chat open.
- [x] 2.6 Web send: no restore once taken (messages and process answers); "Again" with files leaves the composer once taken; Stop through `commandRunning`.
- [x] 2.7 Copy: `messageNotSent`, `messageFiles` (EN, CS).

## 3. Specs

- [x] 3.1 Deltas for `chat-delivery` (lost answer, Dismiss, Stop during a check, failed messages, no turning Send) and `voice` (a failed spoken send).

## 4. Verification

- [x] 4.1 Client-core test of the owner's sequence with a real session (refusal, model error, given-up checks, refusal at once, not taken, accepted).
- [x] 4.2 Phone tests: the owner's voice report and the typed sequence; refusal, Dismiss, not taken.
- [x] 4.3 Web tests: refusal, not taken, the owner's sequence, Dismiss.
- [x] 4.4 Lint, typecheck, admin build, full Jest, and the interruption, answer stream and conversation node suites.
- [ ] 4.5 Phone and web by hand against a dev server: lost answer mid-stream, refusal, Dismiss, a refused message with a photo and its Try again.
