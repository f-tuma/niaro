## RENAMED Requirements

- FROM: `### Requirement: Follow-up actions send nothing`
- TO: `### Requirement: Follow-up actions send at once`

## MODIFIED Requirements

### Requirement: Follow-up actions send at once

A `@ToAssistant` action, a button without an action and a `Form`'s button SHALL send the message at once as the person's own message, by the path and rules of a typed one; the composer's draft SHALL stay. A `Form` SHALL add its answered fields as `Label: value` lines; hidden `context` is never sent. A form, or a button outside one, SHALL send once; while the chat cannot send, it SHALL wait. `@OpenUrl` and `Link` SHALL open only an http(s) address checked again on the client.

#### Scenario: Form follow-up

- **WHEN** the person fills a generated form and presses its button
- **THEN** a message with the button's words and one `Label: value` line per answered field is sent at once and shown as the person's own message
- **AND** whatever the person had typed in the composer stays there

#### Scenario: Second press

- **WHEN** the person presses the button of a form that has already sent its answers
- **THEN** nothing more is sent and the form's fields and buttons no longer act

#### Scenario: Chat cannot send

- **WHEN** the chat is offline or an answer is still running
- **THEN** the follow-up buttons wait as Send does, and nothing is dropped or put into the composer
