## RENAMED Requirements

- FROM: `### Requirement: Follow-up actions send nothing`
- TO: `### Requirement: Follow-up actions send at once`

## MODIFIED Requirements

### Requirement: Follow-up actions send at once

A `@ToAssistant` action, a button without an action and a `Form`'s button SHALL send the message at once as the person's own message, as a typed one is sent; the composer's draft SHALL stay. A `Form` SHALL add its answered fields as `Label: value` lines; hidden `context` is never sent. Only the chat's latest reply SHALL send follow-ups, each form or button once, and none while the chat cannot send. `@OpenUrl` and `Link` SHALL open only an http(s) address checked again on the client.

#### Scenario: Form follow-up

- **WHEN** the person fills a generated form and presses its button
- **THEN** a message with the button's words and one `Label: value` line per answered field is sent at once and shown as the person's own message
- **AND** whatever the person had typed in the composer stays there

#### Scenario: Second press

- **WHEN** the person presses the button of a form that has already sent its answers
- **THEN** nothing more is sent and the form's fields and buttons no longer act

#### Scenario: Reply already answered

- **WHEN** a message of the person follows a reply with buttons, for example the other choice of a Yes/No pair, also after the chat is reopened
- **THEN** that reply's follow-up buttons no longer act and nothing is sent

#### Scenario: Chat cannot send

- **WHEN** the chat is offline or an answer is still running
- **THEN** the follow-up buttons wait as Send does, and nothing is dropped or put into the composer
