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

A client SHALL persist a command before sending it. A lost response SHALL leave the command explicitly uncertain, and only an explicit retry SHALL resend it with its exact ids and payload. Reconnecting, rendering history or replaying events SHALL NOT send or approve anything.

#### Scenario: Connection drops while sending

- **WHEN** the network fails after a message was sent but before the response arrived
- **THEN** the message is shown as not confirmed with a retry action
- **AND** nothing is resent until the person retries

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

A client SHALL offer Stop, and the web app SHALL send an interrupt on Esc, only while its request is running. A request whose delivery failed (a model error, another server error, a dropped connection) or that was found unsent after a restart is not running; its chat SHALL show it as failed with Retry, which resends the exact command, and Dismiss, and the composer SHALL show the microphone or Send instead of Stop.

#### Scenario: Model unavailable

- **WHEN** the server answers a chat message with `503 model_unavailable`
- **THEN** the composer shows the microphone or Send, not Stop
- **AND** the chat shows the failed request with Retry and Dismiss

### Requirement: Dismissing a failed request

Dismiss SHALL ask the server about the exact command through `commands/interrupt` and SHALL NOT resend it. A `settled` answer SHALL show the recorded outcome. An `unknown` answer with `not_running` SHALL clear the request without an outcome and SHALL put an unrecorded message's text back into an empty composer. Any other answer SHALL keep the request with Retry and Dismiss and say that the stop was not confirmed.

#### Scenario: Neither running nor recorded

- **WHEN** the person dismisses a message whose request failed and the server answers `not_running`
- **THEN** the request is cleared, the message's text is back in the composer and the person can send again
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
