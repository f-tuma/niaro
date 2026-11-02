## MODIFIED Requirements

### Requirement: Paused agent work

A chat run that asks a question or waits for an action approval SHALL be projected as a native WorkItem (the root run id as id, a `native` binding with the run's revision) in its conversation, surviving detours, new empty chats and restarts. A pending action SHALL show its canonical receipt (operation id, parameters, effect, status). Process runs are projected the same way (see `process-execution`). Every work item SHALL have a `native` binding; there SHALL be no demo work items.

#### Scenario: Question survives a new chat

- **WHEN** the assistant asks a question and the person starts a new empty chat
- **THEN** the question stays answerable in its original conversation

#### Scenario: No demo work after upgrade

- **WHEN** a workspace held demo work items from the old fixture interpreter before the upgrade
- **THEN** after the upgrade Tasks and the snapshot show only native agent and process work
