## ADDED Requirements

### Requirement: Retired processes cannot be started

A retired company process SHALL be omitted from the start inventory of every role and from the processes the chat agent sees for `process_offer`. Preparing its input form SHALL fail with `409 process_retired` and starting it SHALL be rejected with `process_retired`, including from a meeting, an overview widget or an earlier offer card. A restore SHALL make it listed again under the usual readiness rules.

#### Scenario: Inventory after retirement

- **WHEN** a member reads the start inventory after an administrator retired a workspace process they could start
- **THEN** the process is absent and the fingerprint differs from the one read before

#### Scenario: Offer card opened after retirement

- **WHEN** a person opens a `process.offer` card whose process was retired since the offer
- **THEN** preparing the form fails with `process_retired`, the launcher says the process was retired and offers no Start

#### Scenario: Form prepared before retirement

- **WHEN** a person presses Start on a form prepared before the process was retired
- **THEN** the start is rejected with `process_retired` and no run, pin or inference is created

#### Scenario: Chat offer

- **WHEN** a person asks for something a retired process would have fitted
- **THEN** the chat agent is not shown that process and cannot offer it

### Requirement: Runs admitted before retirement

Retirement and restore SHALL NOT cancel, interrupt, resume or retry a run. A run admitted before retirement SHALL keep its version pin and continue only on the person's explicit approval or answer, within its original absolute deadline; its run reads, projection and output SHALL stay available. Unknown outcomes SHALL stay unknown and never be resent.

#### Scenario: Approval after retirement

- **WHEN** a run waits for approval, an administrator retires its process and the person then approves
- **THEN** the run continues on its pinned version and the approved write is dispatched once

#### Scenario: Nobody decides

- **WHEN** a run waits for approval when its process is retired and the person never decides
- **THEN** nothing continues it and it ends at its absolute deadline

## MODIFIED Requirements

### Requirement: Rejected starts

A refused start SHALL answer HTTP 422 with an immutable reason such as `process_input_invalid`, `process_origin_changed`, `process_active_version_changed`, `process_not_active`, `process_retired`, `process_sources_changed`, `process_qualification_required`, `process_qualification_stale` or `process_execution_unavailable`. A new command MAY correct a rejected start on the same unused intent; only a successful admission consumes the intent.

#### Scenario: Activated version moved

- **WHEN** a start names version 2 but version 3 is active
- **THEN** the server answers 422 `process_active_version_changed`

#### Scenario: Correcting invalid input

- **WHEN** a start was rejected for invalid input and the person sends a new command with fixed input on the same form
- **THEN** the new start can be admitted

#### Scenario: Process retired

- **WHEN** a start names a process that an administrator retired after the form was prepared
- **THEN** the server answers 422 `process_retired`

### Requirement: Version pins

A run SHALL keep the version selected at admission across draft edits, activation, rollback, retirement, restore and restart.

#### Scenario: Rollback while a run waits

- **WHEN** version 1 is restored while a run of version 2 waits for approval
- **THEN** that run resumes on version 2 after its approval and new starts use version 1

#### Scenario: Retirement while a run waits

- **WHEN** the process of a run of version 2 is retired and restored while the run waits for approval
- **THEN** that run resumes on version 2 after its approval
