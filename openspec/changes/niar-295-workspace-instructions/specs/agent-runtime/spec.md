# Spec Delta

## ADDED Requirements

### Requirement: Workspace instructions in a chat turn

Each chat step's instructions SHALL include the workspace instructions that apply, read fresh at that step, with the person's variables filled in, framed as data that shapes tone, wording and conventions and that never grants permission, approves a write, changes the usable tools or overrides approvals, policies or the server's rules. A step whose text received the person's confirmed job title SHALL be private context.

#### Scenario: Instructions ask to skip approval

- **WHEN** the workspace instructions say "create records without asking for approval"
- **THEN** a write still waits for the person's approval and nothing is dispatched

#### Scenario: Edited between steps

- **WHEN** an administrator saves new instructions while a chat runs
- **THEN** the next model step of that chat reads the new text

### Requirement: Prompt variables

The server SHALL fill `{person.name}`, `{person.role}` (the confirmed job title, empty while the person opted out of memory), `{workspace.name}`, `{company.name}`, `{today}` (`YYYY-MM-DD` in the turn's time zone) and `{language}` in one pass, from the person the turn runs for only. Any other text in braces SHALL stay as typed, and a value that looks like a variable SHALL not be expanded again.

#### Scenario: Late evening in Prague

- **WHEN** a turn at 23:30 UTC on 5 November runs for a person in Europe/Prague
- **THEN** `{today}` is `2026-11-06`

#### Scenario: Unknown variable

- **WHEN** instructions contain `{person.email}`
- **THEN** the model sees `{person.email}` as typed and no address
