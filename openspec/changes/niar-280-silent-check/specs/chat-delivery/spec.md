# Spec Delta

## MODIFIED Requirements

### Requirement: Reliable client delivery

A client SHALL persist a command before sending it. A lost response SHALL leave the command uncertain; a chat message's lost outcome SHALL be checked by the client itself by resending the exact command with its exact ids and payload, and any other command SHALL be resent only by an explicit retry. Rendering history or replaying events SHALL NOT send or approve anything.

#### Scenario: Connection drops while sending

- **WHEN** the network fails after a message was sent but before the response arrived
- **THEN** the message is shown as still being answered, with no error and no retry action
- **AND** the client resends the exact command by itself once it can reach the server

### Requirement: Stop only while a request runs

A client SHALL offer Stop, and the web app SHALL send an interrupt on Esc, only while its request is running and the client is online. A request whose outcome the client is still checking is not running between checks and SHALL be shown as still working. A request that failed (a model error, a stop that was not confirmed, or checks that kept failing while the server answered) SHALL be shown in its chat as failed with Retry, which resends the exact command, and Dismiss. In both cases the composer SHALL show the microphone or Send instead of Stop.

#### Scenario: Model unavailable

- **WHEN** the server answers a chat message with `503 model_unavailable`
- **THEN** the composer shows the microphone or Send, not Stop
- **AND** the chat shows the failed request with Retry and Dismiss

#### Scenario: Offline while the request is on its way

- **WHEN** the client goes offline while its request has not ended
- **THEN** no Stop is offered until it is online again
- **AND** the chat shows no error card for the request

### Requirement: A lost answer is not unsent

When a message's send ends without a confirmed outcome and the client keeps the exact command, the phone app and the web app SHALL NOT put its text back into the composer. Only a Dismiss that the server confirms as `not_running` SHALL return the text. A message the server refused, or one that was never sent, SHALL go back into the composer at once.

#### Scenario: Connection lost mid-answer

- **WHEN** the connection drops while the answer to a message is written
- **THEN** the composer stays empty and the chat shows the request as still working
- **AND** after the client's own check settles it, nothing is left in the composer to send a second time

#### Scenario: Refused

- **WHEN** the server refuses a message
- **THEN** its text is back in the composer

### Requirement: Reconnecting after the server returns

A client that lost the server SHALL retry by itself, at most 30 seconds apart and at once when the app returns to the foreground, and SHALL be online again as soon as the server answers. On reconnecting it SHALL check a kept chat request's lost outcome at once by resending the identical command; a command the server recorded SHALL be answered from its receipt, and one still running SHALL be joined.

#### Scenario: Server restarted mid-answer

- **WHEN** the server stops while an answer is written and starts again
- **THEN** the phone is online again within 30 seconds without any action
- **AND** the answer appears without any action, and the message appears only once

## ADDED Requirements

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
