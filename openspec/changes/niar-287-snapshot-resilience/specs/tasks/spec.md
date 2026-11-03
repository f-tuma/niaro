# Spec Delta

## ADDED Requirements

### Requirement: One task never blocks reads

When the server builds a person's task window for a snapshot, events, chat or voice request, a single task that cannot be projected or published SHALL be left out of the window, with an operator log line naming its kind, run id and error class, and the request SHALL still be answered with the other tasks. The log line MUST NOT contain the task's content. This applies to a task whose saved state is unreadable, a task that is not valid native work, and a task whose chat the person does not have.

#### Scenario: Unreadable saved run

- **WHEN** one of the person's saved runs can no longer be projected
- **THEN** the snapshot is answered without that task
- **AND** the server logs `task_projection_skipped` with its run id

#### Scenario: Unknown chat

- **WHEN** a task names a chat that is not live, stored, deleted or archived for that person
- **THEN** the task is left out and logged, and the other tasks are published

### Requirement: Request failures still fail the read

A sign-in or access change, a server that cannot answer now, a changed task window and a cancelled request SHALL still fail the read, never answer it as a shorter task list. A window over 400 tasks, with duplicate ids, or a delta that would evict tasks SHALL still be refused.

#### Scenario: Another person signed in

- **WHEN** the actor changes while the task window is being built
- **THEN** the request fails with `identity_forbidden`
