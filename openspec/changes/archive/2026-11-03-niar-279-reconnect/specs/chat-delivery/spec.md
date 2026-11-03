# Spec Delta

## MODIFIED Requirements

### Requirement: Stop only while a request runs

A client SHALL offer Stop, and the web app SHALL send an interrupt on Esc, only while its request is running and the client is online. A request whose delivery failed (a model error, another server error, a dropped connection) or that was found unsent after a restart is not running; its chat SHALL show it as failed with Retry, which resends the exact command, and Dismiss, and the composer SHALL show the microphone or Send instead of Stop.

#### Scenario: Model unavailable

- **WHEN** the server answers a chat message with `503 model_unavailable`
- **THEN** the composer shows the microphone or Send, not Stop
- **AND** the chat shows the failed request with Retry and Dismiss

#### Scenario: Offline while the request is on its way

- **WHEN** the client goes offline while its request has not ended
- **THEN** no Stop is offered until it is online again

## ADDED Requirements

### Requirement: A lost answer is not unsent

When a message's send ends without a confirmed outcome and the client keeps the exact command for Retry and Dismiss, the phone app and the web app SHALL NOT put its text back into the composer. Only a Dismiss that the server confirms as `not_running` SHALL return the text. A message the server refused, or one that was never sent, SHALL go back into the composer at once.

#### Scenario: Connection lost mid-answer

- **WHEN** the connection drops while the answer to a message is written
- **THEN** the composer stays empty and the chat offers Check result and Dismiss
- **AND** after Check result settles it, nothing is left in the composer to send a second time

#### Scenario: Refused

- **WHEN** the server refuses a message
- **THEN** its text is back in the composer

### Requirement: Reconnecting after the server returns

A client that lost the server SHALL retry by itself, at most 30 seconds apart and at once when the app returns to the foreground, and SHALL be online again as soon as the server answers. Reconnecting SHALL NOT resend a kept command; Check result SHALL resend the identical command, and a command the server recorded SHALL be answered from its receipt.

#### Scenario: Server restarted mid-answer

- **WHEN** the server stops while an answer is written and starts again
- **THEN** the phone is online again within 30 seconds without any action
- **AND** Check result shows the answer, and the message appears only once
