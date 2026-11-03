# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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

### Requirement: No turning Send while a request is pending

While a chat request is pending or its outcome is checked, the composer SHALL keep its ordinary look: the microphone (phone) or Send (web), Stop only while the request runs and the client is online, and never a Send button with a spinner.

#### Scenario: Background check

- **WHEN** the client resends a lost message's command in the background
- **THEN** the composer shows no spinning Send and stays empty

#### Scenario: Typing meanwhile

- **WHEN** the person types the next message while a request is pending
- **THEN** Send is shown without a spinner
