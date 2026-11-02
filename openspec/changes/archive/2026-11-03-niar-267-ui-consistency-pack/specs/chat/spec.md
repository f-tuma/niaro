## MODIFIED Requirements

### Requirement: Approval in chat

A write that needs the person's decision SHALL appear in the chat as an approval card with the action, the service and the reviewed values, decided only by `service.resolve {operationId, approved}` (see `agent-runtime`). A `service.action` result SHALL be shown as a card only while it awaits the decision; afterwards the chat SHALL show only the answer's text and generated UI. On every client the card SHALL end with **Decline** and then **Approve**, right-aligned, with Approve as the only primary action; the decline action SHALL be labelled "Decline" / "Odmítnout", never with the word that closes a sheet, and a declined card SHALL read "Declined" / "Odmítnuto".

#### Scenario: Decline

- **WHEN** the person declines an approval card
- **THEN** nothing is written and the assistant continues with the declined outcome

#### Scenario: Stale approval

- **WHEN** the person approves a card whose work item revision changed
- **THEN** the server answers `revision_conflict` and runs nothing

#### Scenario: Phone and web agree

- **WHEN** the same pending write is shown on the web and on the phone
- **THEN** both show Decline before Approve, right-aligned, with the same labels

## ADDED Requirements

### Requirement: Chat header

The web chat page SHALL start with one line holding the chat's name and a `…` menu with **Rename**, **Pin**, **Archive** and **Delete**, the same actions and confirmations as the chat's sidebar row, whether or not the sidebar is visible. A chat that cannot be archived SHALL offer no Archive; a new chat that is not saved yet and an archived chat SHALL show no menu.

#### Scenario: Collapsed sidebar

- **WHEN** the person collapses the sidebar and opens the chat's `…` menu
- **THEN** they can rename, pin, archive or delete the chat from there

#### Scenario: Delete from the header

- **WHEN** the person chooses **Delete** in the header
- **THEN** the chat is deleted only after they confirm, and the app leaves the chat

### Requirement: Copied and Undo confirmations

The web app SHALL confirm a copy with a short "Copied" toast and offer **Undo** after archiving a chat ("Chat archived"), which restores the chat and reopens it when it was open. The toast SHALL be used for nothing else: never for errors, approvals or questions. One toast SHALL be shown at a time and SHALL be announced politely to screen readers.

#### Scenario: Undo an archive

- **WHEN** the person archives the open chat and presses **Undo**
- **THEN** the chat is restored, listed again and opened

#### Scenario: Error

- **WHEN** archiving a chat fails
- **THEN** the error is shown where the action was pressed and no toast appears
