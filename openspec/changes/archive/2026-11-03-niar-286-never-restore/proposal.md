# Proposal

Tracker: **NIAR-286** (never put sent text back into the composer)

## Why

On the phone (build 6, main 47d05d0) the owner sent a message and, while the assistant was still thinking, the text came back into the composer with a blue Send button and a turning wheel. The owner's rule: sent text never goes back into the composer, for any reason (refusal, error, interruption, timeout, lost answer, Dismiss). A failed message stays visible in the chat; while an answer is pending or checked, the composer looks as it always does.

What happened, step by step:

1. A spoken message (voice reply, sent without review) lost its answer: the stream dropped, so the session kept the exact command for its own check (`commandStates.chat = "network_error"`, `deliveryCheck = "checking"`, `pending` = the command).
2. The phone's voice path ended its delivery with "not accepted, not recorded" and ran `setDraft(current || text)`: the transcript went into the empty composer. Unlike the typed path, it had no `heldForRecovery` guard (NIAR-279).
3. The session's background check (NIAR-280) posted the identical command again, which publishes `commandStates.chat = "sending"`. The phone passed `Object.values(state.commandStates).includes("sending")` to the composer as `sending`; with text in the composer, Send showed its spinner. The chat itself still showed Thinking.

Other paths wrote sent words back, or would lose them:

- Typed send, phone and web: a refusal or a thrown send put the text back (`restore()`); a confirmed Dismiss (`not_running`) put the text back.
- A refusal that arrived through a check or a Retry (not the first send) cleared the message from the chat without restoring it: the words were lost.
- A refused or dismissed message's attachments were unfrozen back into the composer's tray.
- Web "Again" with files kept its words in the composer until the message was accepted.

## What Changes

- **Files leave with the message.** Once the session takes a message with files, the composer's tray empties at once (the command keeps its frozen draft for checks, Retry and Try again) and the files show with the message on its way ("Attached files: n").
- **The session keeps failed messages.** A chat message the session took (it is pending as soon as `send` returns) and that ends neither kept for its check nor recorded nor accepted is kept in `state.failedMessages` with its command and error code: a server refusal, a local storage failure before delivery, a refusal answered to a check or a Retry. `retryFailedMessage` sends its words, files and context as a new command; `dismissFailedMessage` lets it go. Its files leave the composer with it.
- **Clients never write sent words back.** Phone (typed and voice) and web drop every restore: on refusal, error, lost answer, timeout and Dismiss. Only a send the session did not take at all (nothing became pending, nothing left the device) keeps its words in the composer.
- **Failed messages in the thread.** Phone and web show a failed message under the stored ones with its words, "Not sent." and the reason, Try again and Dismiss. A failed first message keeps the phone's chat open instead of Home.
- **No turning Send, no Stop for a check.** The phone composer no longer gets a `sending` state: a pending request already disables Send, so Send never spins. A background check's re-post is not "running" until the server streams the answer it joined (`commandRunning`, `runningChat`), so the composer keeps the microphone (phone) or Send (web) instead of Stop during checks.
- **Process answers on the phone.** A typed or spoken answer to a process question leaves the composer once taken and shows in the chat on its way; the question stays until the run records it. A refused answer shows in its chat's thread as "Not sent" with its reason and **Try again** (the same words to the same question as a new answer, while it is still open) instead of Review, which put its words back into the composer.
- **Dismiss only lets go.** A confirmed `not_running` Dismiss clears the request; nothing goes to the composer.

## Non-goals

- Keeping failed messages across an app restart: they live in the session's memory; a lost answer's command is still persisted and checked as before.
- The web's saved-answer card for a refused process answer keeps Review and Discard; Try again for it is on the phone only. The web no longer restores a taken process answer; the card holds it.

## Risk

- Try again of a message with files reuses the server-side attachment draft of the refused command; if the server no longer accepts that draft, the retry is refused again and stays a failed message (nothing is lost). Not verified against the identity server.
- A failed message is shown with the error code's copy; codes without copy read as the generic refusal.
