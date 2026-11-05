# Spec Delta

## ADDED Requirements

### Requirement: Workspace instructions editor

Owners and administrators SHALL edit Markdown instructions (at most 8,000 characters) and up to 6 distinct one-line starters (at most 200 characters each) per workspace and as an organization default, from the Workspaces page. Each save SHALL be a new revision bound to the revision it started from; a stale save SHALL be `409 instructions_conflict` and a member SHALL get `403 instructions_forbidden`.

#### Scenario: Two administrators save

- **WHEN** two administrators save the same workspace's instructions from revision 3
- **THEN** the first becomes revision 4 and the second fails with `409 instructions_conflict`

#### Scenario: Member opens the editor

- **WHEN** a member requests the instructions editor of their workspace
- **THEN** the server answers `403 instructions_forbidden`

### Requirement: Instructions history

Every saved version SHALL be kept with its author and time and listed newest first (at most 50 shown). Restoring a version SHALL save its text and starters as a new revision marked as restored from it. Each save and restore SHALL be audited as `instructions.changed` with the event, the scope and the revisions, never with the text or starters.

#### Scenario: Restore

- **WHEN** an owner restores revision 1 while revision 2 is current
- **THEN** revision 3 holds revision 1's text and starters and the audit names the restore without the text

### Requirement: Organization default instructions

A workspace's own instructions SHALL replace the organization default, not add to it; while a workspace's text is empty the default text SHALL apply, and while its starters are empty the default starters SHALL apply. Deleting a workspace SHALL delete its instructions and their history.

#### Scenario: Workspace without its own text

- **WHEN** a workspace has starters but no text and the organization default has text
- **THEN** the chat uses the default text and the workspace's own starters
