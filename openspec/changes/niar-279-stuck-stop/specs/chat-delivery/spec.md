# Spec Delta

## ADDED Requirements

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
