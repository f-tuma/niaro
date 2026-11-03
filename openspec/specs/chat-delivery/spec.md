# chat-delivery Specification

## Purpose

Chat delivery is the app API contract between the server and the web and mobile clients for chat: authenticated routes, strict idempotent commands, ordered events, negotiated message extensions, request progress and the streamed answer.

## Requirements

### Requirement: Chat API surface

The system SHALL serve chat over the workspace app API at `/v1/:workspace` with a bearer credential: `GET snapshot`, `GET events?after=N`, `POST commands`, `GET conversations` and `GET conversations/messages`, `GET activity`, `GET search` and `GET mentions`. Every route SHALL require a valid credential whose workspace matches the route, and a command SHALL NOT be able to choose its own scope.

#### Scenario: Missing or expired credential

- **WHEN** a client calls a chat route without a credential or with an expired one
- **THEN** the server answers `401` and returns no chat data

#### Scenario: Wrong workspace

- **WHEN** a credential issued for workspace A calls `/v1/B/snapshot`
- **THEN** the server answers `403`

### Requirement: Strict commands

The system SHALL accept commands only as strict JSON of a known type, reject unknown fields and invalid references, and reject a command body larger than 64 KiB. A command result SHALL carry `status` (`accepted`, `conflict` or `rejected`), a `code` and the current snapshot.

#### Scenario: Unknown field

- **WHEN** a client sends `message.send` with a field the schema does not define
- **THEN** the command is refused as invalid and nothing changes

#### Scenario: Oversized body

- **WHEN** a command body exceeds 64 KiB
- **THEN** the server refuses it without executing it

### Requirement: Idempotent command receipts

Every command SHALL carry `commandId` and `idempotencyKey`. The server SHALL keep a receipt of every command without pruning; repeating the same ids with the same payload SHALL return the recorded outcome, and reusing either id with a different payload SHALL be refused as `idempotency_conflict`.

#### Scenario: Retry after a lost response

- **WHEN** a client resends a command whose response was lost, with the same ids and payload
- **THEN** the server returns the recorded outcome and does not run the request again

#### Scenario: Same ids, different payload

- **WHEN** a client reuses a `commandId` with a different message text
- **THEN** the server answers `idempotency_conflict` and starts no new turn

### Requirement: Ordered event delivery

The system SHALL commit chat state, events and receipts together before answering a command, and SHALL deliver ordered full-entity events after a cursor. The server SHALL retain the latest 1,000 events per scope; a cursor outside the retained range SHALL be answered `409 snapshot_required`, after which the client reads a new snapshot.

#### Scenario: Cursor too old

- **WHEN** a client polls `events?after=N` with a cursor older than the retained log
- **THEN** the server answers `409 snapshot_required`
- **AND** the client loads a fresh snapshot instead of applying a gap

### Requirement: Reliable client delivery

A client SHALL persist a command before sending it. A lost response SHALL leave the command uncertain; the lost outcome of a chat message, and of a process start, answer or decision (see `process-execution` "A lost process outcome is checked without the person"), SHALL be checked by the client itself by resending the exact command with its exact ids and payload, and any other command SHALL be resent only by an explicit retry.

#### Scenario: Connection drops while sending

- **WHEN** the network fails after a message was sent but before the response arrived
- **THEN** the message is shown as still being answered, with no error and no retry action
- **AND** the client resends the exact command by itself once it can reach the server

#### Scenario: Connection drops while starting a process

- **WHEN** the network fails after a process start was sent but before the response arrived
- **THEN** the start is shown as starting, with no error and no retry action
- **AND** the client resends the exact start by itself once it can reach the server, and the server answers it from its receipt

### Requirement: Rendering sends nothing

Rendering history or replaying events SHALL NOT send or approve anything.

#### Scenario: History replay

- **WHEN** the client renders history or replays events
- **THEN** no command is sent or approved

### Requirement: A dropped connection does not cancel a request

A request already received by the server SHALL keep running when the HTTP connection closes, bounded by a 10-minute server deadline; an exact retry SHALL join the running request or return its receipt. Only an explicit interrupt or server shutdown SHALL stop it.

#### Scenario: Reload during an answer

- **WHEN** the person reloads the page while the assistant is answering
- **THEN** the answer is still produced and stored
- **AND** the retried command returns that same answer

### Requirement: Busy person lane

The system SHALL run at most one request at a time per person; a second request while one runs SHALL be refused with `503 model_busy` and SHALL leave the running request and its chat unchanged.

#### Scenario: New session while a request runs

- **WHEN** a `message.send` with `session: "new"` arrives while the same person's request is still running
- **THEN** it is refused as busy
- **AND** the running request's chat is not archived

### Requirement: Stopping a running answer

The system SHALL let a client stop its own running request through `POST commands/interrupt` (`agent-request-interruption/1`), answering `settled` with the command's result or `unknown` (`not_running`, `not_settled`). An interrupt SHALL NOT retry the original command or grant any consent. The web app SHALL send it on Esc while an answer runs.

#### Scenario: Esc during an answer

- **WHEN** the person presses Esc while the assistant is answering
- **THEN** the client asks the server to interrupt that exact command
- **AND** an effect already dispatched keeps its recorded outcome

### Requirement: Message times

Messages the server stores SHALL carry `createdAt`; messages stored without it SHALL get none invented. Clients SHALL receive `createdAt` only when they ask with `messages=agent-message-time/1`. The web app SHALL show the time on hover, the full date in its tooltip, and a divider for each new day (Yesterday, Today, then the date).

#### Scenario: Client that does not ask

- **WHEN** a client reads a snapshot without `messages=agent-message-time/1`
- **THEN** its messages carry no `createdAt`

### Requirement: Result type negotiation

Each client SHALL name the message result types it renders with `results=` (comma-separated `type/version`). The baseline `crm.contacts/1`, `service.action/1`, `service.connection/1` and `card.document/1` SHALL always be delivered; any other result SHALL reach only clients that name it, and the others SHALL receive the same message without `result`, i.e. its text. Malformed or unknown tokens SHALL be ignored, and history pages SHALL never carry results.

#### Scenario: Client without process offers

- **WHEN** a client that does not declare `process.offer/1` receives a message with a process offer
- **THEN** it receives the message text without the offer

### Requirement: Reply correlation

Clients that ask with `replies=agent-reply-correlation/1` SHALL receive `replyToCommandId` on assistant messages, set by the server for the command it processed and never supplied by the model or a user message. A client SHALL read a reply aloud only for its own current foreground voice request, never when rendering history or reconnecting.

#### Scenario: History does not speak

- **WHEN** a client reconnects and receives older correlated replies
- **THEN** nothing is played aloud

### Requirement: Request progress

The system SHALL report the progress of a running request through `GET activity?commandId=…` in versions `agent-activity/1` to `/4` (default `/1`). Progress SHALL be transient (kept about five minutes), bound to the requester's scope, never model-authored and never a claim of success. Version `/4` SHALL add the answer's `draft` (at most 18,500 characters) while the request runs; the draft SHALL never be stored and SHALL be cleared when a step calls a tool or the reply is sent back.

#### Scenario: Another person's command

- **WHEN** a client asks for the activity of a command outside its scope
- **THEN** it receives no activity for that command

### Requirement: Streaming an answer

A `message.send` or `service.resolve` sent with `Accept: text/event-stream` SHALL be answered `200 text/event-stream` as an AI SDK UI message stream: `start`, `text-start`/`text-delta`/`text-end` for the draft, `tool-input-start`/`tool-input-available` and `tool-output-available`/`tool-output-error` per tool step with safe previews, `data-openui` once a program's fence is complete, `data-tool-call-approval` when a write stops, `data-niaro-result`, `finish`, `[DONE]`.

#### Scenario: Approval chunk

- **WHEN** a write stops for the person's decision during a streamed answer
- **THEN** the stream carries `data-tool-call-approval` with the reviewed label/value pairs and no raw arguments

#### Scenario: Client without the header

- **WHEN** a client sends `message.send` without `Accept: text/event-stream`
- **THEN** it receives the ordinary JSON result

### Requirement: The stream decides nothing

The answer stream SHALL be presentation only: `data-niaro-result` SHALL carry the status and body the JSON response would carry, nothing in the stream is stored or decides anything, a keep-alive comment SHALL be sent every 15 seconds, and closing the stream SHALL NOT cancel the run. An approval shown from the stream SHALL be decided only by `service.resolve`.

#### Scenario: Stream closed mid-answer

- **WHEN** the browser closes the event stream while the answer is written
- **THEN** the run continues and the stored answer is available on the next read

### Requirement: Stop only while a request runs

A client SHALL offer Stop, and the web app SHALL send an interrupt on Esc, only while its request is running and the client is online. A request whose outcome the client is still checking is not running between checks, and a check's own resend SHALL count as running only once the server streams the answer it joined; until then the request SHALL be shown as still working and the composer SHALL keep the microphone or Send.

#### Scenario: Model unavailable

- **WHEN** the server answers a chat message with `503 model_unavailable`
- **THEN** the composer shows the microphone or Send, not Stop
- **AND** the chat shows the failed request with Retry and Dismiss

#### Scenario: Offline while the request is on its way

- **WHEN** the client goes offline while its request has not ended
- **THEN** no Stop is offered until it is online again
- **AND** the chat shows no error card for the request

#### Scenario: Check resent in the background

- **WHEN** the client resends a lost message's command to check its outcome and the server has not streamed anything yet
- **THEN** the composer shows the microphone (phone) or Send (web), not Stop
- **AND** the chat shows the message and Thinking

#### Scenario: Meeting recording during a check

- **WHEN** the person starts a meeting recording on the phone while a lost message's command is resent in the background and the server has not streamed anything yet
- **THEN** recording starts at once and nothing is interrupted

### Requirement: Failed request in its chat

A request that failed (a model error, a stop that was not confirmed, or checks that kept failing while the server answered) SHALL be shown in its chat as failed with Retry, which resends the exact command, and Dismiss. In both cases the composer SHALL show the microphone or Send instead of Stop.

#### Scenario: Model unavailable

- **WHEN** the server answers the request with a model error
- **THEN** the chat shows it as failed with Retry and Dismiss, and the composer shows the microphone or Send

### Requirement: Dismissing a failed request

Dismiss SHALL ask the server about the exact command through `commands/interrupt` and SHALL NOT resend it. A `settled` answer SHALL show the recorded outcome. An `unknown` answer with `not_running` SHALL clear the request without an outcome; its text and files SHALL NOT go back into the composer. Any other answer SHALL keep the request with Retry and Dismiss and say that the stop was not confirmed.

#### Scenario: Neither running nor recorded

- **WHEN** the person dismisses a message whose request failed and the server answers `not_running`
- **THEN** the request is cleared and the composer stays as it was, without the message's text
- **AND** the failed command was never sent a second time

#### Scenario: Already recorded

- **WHEN** the person dismisses a request whose response was lost but which the server recorded
- **THEN** the chat shows the recorded outcome

#### Scenario: Not confirmed

- **WHEN** the server cannot confirm that the request stopped
- **THEN** the request stays with Retry and Dismiss

### Requirement: A failed message stays in its chat

The phone app SHALL NOT offer a Retry of a chat message on any screen other than that message's chat.

#### Scenario: Another tab

- **WHEN** a chat message failed and the person opens Meetings, Tasks or Library
- **THEN** no Retry for that message is shown there

### Requirement: Another chat holds the request

When a chat cannot send because another chat holds the person's request, the phone app and the web app SHALL say so next to the composer, waiting or still running, with Open to that chat. They SHALL offer Stop there only while that request runs.

#### Scenario: Failed message in another chat

- **WHEN** a message failed in one chat and the person opens another chat
- **THEN** that chat says an unfinished request is waiting in another chat, with Open and without Stop
- **AND** Open shows the failed message in its own chat with Retry and Dismiss

### Requirement: A meeting does not wait for a failed request

Starting a meeting recording SHALL stop a chat request first only while it runs. A failed request SHALL NOT keep a recording from starting and SHALL stay in its chat.

#### Scenario: Recording beside a failed message

- **WHEN** a chat message failed and the person starts a meeting recording
- **THEN** the recording starts without asking the server to stop anything

### Requirement: A lost answer is not unsent

The phone app and the web app SHALL NOT put a sent message's text or files back into the composer, whatever happens to it: a lost answer, a check, a refusal, an error, a timeout, a stop or a Dismiss. A message the client took stays in its chat until it is answered, failed or dismissed. Only a send the client did not take at all, so that nothing left the device, SHALL keep its words in the composer.

#### Scenario: Connection lost mid-answer

- **WHEN** the connection drops while the answer to a message is written
- **THEN** the composer stays empty and the chat shows the request as still working
- **AND** after the client's own check settles it, nothing is in the composer to send a second time

#### Scenario: Spoken message

- **WHEN** the answer to a spoken message is lost and the client checks it in the background
- **THEN** the transcript is not put into the composer and the chat shows it with Thinking

#### Scenario: Refused

- **WHEN** the server refuses a message
- **THEN** the composer stays empty and the message stays in its chat as failed

### Requirement: Reconnecting after the server returns

A client that lost the server SHALL retry by itself, at most 30 seconds apart and at once when the app returns to the foreground, and SHALL be online again as soon as the server answers. On reconnecting it SHALL check a kept chat request's lost outcome at once by resending the identical command; a command the server recorded SHALL be answered from its receipt, and one still running SHALL be joined.

#### Scenario: Server restarted mid-answer

- **WHEN** the server stops while an answer is written and starts again
- **THEN** the phone is online again within 30 seconds without any action
- **AND** the answer appears without any action, and the message appears only once

### Requirement: A lost outcome is checked without the person

When a chat message's (or a plain `service.resolve`'s) send ends without a confirmed outcome, the client SHALL check it by itself by resending the identical command, one request per check with the same `commandId` and body: at once while online, again on reconnecting and on returning to the foreground, and at most 2, 4, 8 and 16 seconds apart while the server answers reads but not the command. It SHALL NOT check while offline or in the background.

#### Scenario: Server down for a while

- **WHEN** the server is unreachable for minutes after a message's answer was lost
- **THEN** nothing is sent until the server answers again
- **AND** then one identical request is sent and the answer appears

#### Scenario: Recorded or still running

- **WHEN** the client's check reaches a server that recorded the message or still runs it
- **THEN** the recorded answer appears, or the check waits for the running answer
- **AND** the request is not run a second time

### Requirement: No unconfirmed card

While the client checks a lost outcome, the phone app and the web app SHALL show the ordinary "Thinking" line or the answer's draft, and SHALL NOT show a "not confirmed", "status unavailable" or "check result" card, error or button, online or offline. Administrators' diagnostics SHALL keep the technical state.

#### Scenario: Offline while checking

- **WHEN** the server is unreachable after a message's answer was lost
- **THEN** the chat shows the request as still working and the header says Offline
- **AND** no error card, Retry or Dismiss is shown for it

### Requirement: A checked request that failed

The client SHALL show a request as an ordinary failed message with Retry and Dismiss only when the server says it did not finish (a model error), when a Stop or Dismiss was not confirmed, or after five checks in a row failed while the server answered reads. It SHALL then not resend it by itself.

#### Scenario: The server says it did not finish

- **WHEN** the client's check is answered with `503 model_unavailable`
- **THEN** the chat shows the request as failed with Retry and Dismiss
- **AND** the client does not resend it by itself

#### Scenario: The command keeps failing

- **WHEN** five checks in a row fail while the server answers reads
- **THEN** the chat shows the request as failed with Retry and Dismiss

### Requirement: A refused message stays in its chat

A chat message that the client took and that ends neither answered nor still checked (the server refused it, also when it answered a check or a retry, or it failed before it reached the server) SHALL stay in its chat as a failed message with its text, "Not sent", the reason, Try again and Dismiss, on the phone and on the web.

#### Scenario: Refused message

- **WHEN** the server refuses a message
- **THEN** the chat shows the message with "Not sent", the reason, Try again and Dismiss, and the composer is empty

#### Scenario: Refused after a check

- **WHEN** a message's answer was lost and the server refuses the client's check
- **THEN** the message stays in its chat as failed with Try again, and its words are not lost

### Requirement: A failed message's reason is shown once

The reason a message failed SHALL be shown once, under the failed message, on the phone and on the web. No error notice in the chat's footer or on another screen SHALL repeat it, also while the client is still settling the refused message, and Dismiss SHALL let the reason go with the message.

#### Scenario: Reason of a refused message

- **WHEN** the server refuses a message
- **THEN** the reason appears under the message and not again as an error notice

#### Scenario: Reason after Dismiss

- **WHEN** the person dismisses a refused message
- **THEN** no error notice shows its reason afterwards, also after a reconnect

### Requirement: Try again and Dismiss of a refused message

Try again SHALL send a refused message's text, files and context as a new message. Dismiss SHALL remove the refused message from its chat and SHALL NOT put its text or files into the composer.

#### Scenario: Try again

- **WHEN** the person presses Try again on a refused message
- **THEN** the same words are sent as a new message

#### Scenario: Dismissed

- **WHEN** the person dismisses a refused message
- **THEN** the message leaves the chat and the composer stays empty

#### Scenario: Message with a photo

- **WHEN** a message with a photo is refused
- **THEN** the photo is not back in the composer
- **AND** Try again sends the message with the photo

### Requirement: A message's files leave the composer with it

Once the client takes a message with files, its files SHALL leave the composer's tray at once and SHALL show with the message in its chat while it is on its way. The composer SHALL then look as it does without files: the microphone, or Stop while the request runs, and no disabled Send for the files. A message that fails SHALL keep its files for Try again; they SHALL NOT go back into the tray. A send the client did not take SHALL keep its files in the tray.

#### Scenario: Message with a photo on its way

- **WHEN** the person sends a message with a photo and the client takes it
- **THEN** the tray is empty, no disabled Send is shown, and the chat shows the message with "Attached files: 1"

### Requirement: A process answer leaves the composer

When the person answers a process question from the phone's composer or by voice and the client takes the answer, its text SHALL leave the composer at once and SHALL show in the chat as the person's answer on its way. The question SHALL stay above the composer until the run records the answer. The answer's text SHALL NOT go back into the composer, whatever its outcome. An answer the client did not take SHALL keep its text in the composer.

#### Scenario: Typed answer

- **WHEN** the person sends a typed answer to a process question
- **THEN** the composer is empty and the chat shows the answer on its way

#### Scenario: Spoken answer

- **WHEN** the person sends a spoken answer to a process question
- **THEN** the transcript is not put into the composer and the chat shows it on its way

### Requirement: A refused process answer stays in its chat

On the phone, a process answer the server refused SHALL show in its chat's thread with its text, "Not sent", the reason once and **Try again**, and SHALL NOT offer to put its text back into the composer. Try again SHALL send the same text to the same question as a new answer while that question is still open, and the refused answer SHALL then be let go. Discard SHALL let it go without sending anything.

#### Scenario: Refused answer

- **WHEN** the server refuses a process answer
- **THEN** the chat shows it as not sent with its reason and Try again, and the composer stays empty

#### Scenario: Try again of a refused answer

- **WHEN** the person presses Try again on a refused answer whose question is still open
- **THEN** the same text is sent to that question as a new answer and the refused one leaves the chat

### Requirement: No turning Send while a request is pending

While a chat request is pending or its outcome is checked, the composer SHALL keep its ordinary look: the microphone (phone) or Send (web), Stop only while the request runs and the client is online, and never a Send button with a spinner.

#### Scenario: Background check

- **WHEN** the client resends a lost message's command in the background
- **THEN** the composer shows no spinning Send and stays empty

#### Scenario: Typing meanwhile

- **WHEN** the person types the next message while a request is pending
- **THEN** Send is shown without a spinner
