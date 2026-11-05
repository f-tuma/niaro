## ADDED Requirements

### Requirement: Exporting a chat

The chat's `…` menu SHALL offer Export as Markdown and as JSON before Delete, downloaded by `GET …/conversations/export` with the session cookie as an attachment.

#### Scenario: Export from the header

- **WHEN** the person chooses Export as Markdown
- **THEN** the browser saves `chat-<name>-<date>.md`

#### Scenario: Someone else's chat

- **WHEN** a person asks for a chat id that is not theirs
- **THEN** the server answers 404

### Requirement: Chat export contents

A chat export SHALL hold only what the chat shows: the person's messages and the assistant's answers with their times, file names of attachments and the task a message was about. Generated UI SHALL be noted as not included; steps, tool payloads, receipts and work states SHALL be left out.

#### Scenario: Answer with generated UI

- **WHEN** an answer carried generated UI and a work item
- **THEN** the export has its text and a note, never the program or work id
