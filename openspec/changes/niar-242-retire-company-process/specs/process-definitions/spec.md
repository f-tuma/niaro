## ADDED Requirements

### Requirement: Retiring a company process

Owners and administrators SHALL retire a workspace or service process with `POST …/processes/retirement` and `{profile: "agent-service-processes/2", type: "retire", id, revision}`, answered with `{profile, id, revision, retiredAt}`. Members SHALL get 403, personal processes SHALL be refused with `process_retire_forbidden`, archived ones 404 and a stale revision `process_conflict`. Retirement SHALL keep the active version pointer, versions, tests, pins and receipts.

#### Scenario: Administrator retires a company process

- **WHEN** an administrator retires a workspace process with active version 3 at its current revision
- **THEN** the answer carries `retiredAt`, the revision advances by one and version 3 stays the active version

#### Scenario: Member tries to retire

- **WHEN** a member sends a retire command for a workspace process
- **THEN** the server answers 403 and nothing changes

#### Scenario: Personal process

- **WHEN** the owner of a personal process sends a retire command for it
- **THEN** it fails with `process_retire_forbidden` and the process stays startable

#### Scenario: Stale revision

- **WHEN** an administrator retires a process with a revision older than the stored one
- **THEN** it fails with `process_conflict` and the process stays as it was

### Requirement: Restoring a retired process

Owners and administrators SHALL restore a retired process with the same route and `type: "restore"`, answered with `retiredAt: null`. Restoring SHALL NOT activate, test or start anything; the then-active version becomes startable again only through the usual qualification, source and authority checks.

#### Scenario: Restore after a dependency changed

- **WHEN** an administrator restores a process whose active version's service changed while it was retired
- **THEN** the process is restored and is listed blocked with `source_changed` until it is retested and activated

#### Scenario: Member tries to restore

- **WHEN** a member sends a restore command
- **THEN** the server answers 403 and the process stays retired

### Requirement: Retirement command replay

A retire or restore of a process already in the requested state SHALL answer its current state without changing the revision or writing audit, whatever revision it names, so a lost response can be resent. Any other mismatch SHALL fail with `process_conflict`.

#### Scenario: Lost retire response

- **WHEN** the console resends the same retire command after the process was retired by the first one
- **THEN** it receives the stored `retiredAt` and the revision does not advance again

#### Scenario: Retire after someone restored

- **WHEN** an administrator retires at revision 5 while another administrator's restore already moved it to revision 7
- **THEN** a retire naming revision 5 of a not-retired process fails with `process_conflict`

### Requirement: Retired process management

A retired process SHALL stay readable and manageable by owners and administrators: listing, reading, drafts, freezing, tests, activation and rollback work as for any company process, and none of them restores it. Management lists and reads SHALL carry `retiredAt` for a retired process and omit it otherwise.

#### Scenario: List shows retirement

- **WHEN** an administrator lists processes with profile `/2` and one of them is retired
- **THEN** that summary carries `retiredAt` and the others do not

#### Scenario: Editing a retired process

- **WHEN** an administrator saves and freezes a draft of a retired process
- **THEN** a new version is frozen and the process stays retired

### Requirement: Retiring in administration

The process page in administration SHALL show a **Retired** status for a retired process, offer **Retire** in its `…` menu only to managers of a company process and only after a confirmation saying that new starts stop and started runs finish, and offer **Restore** as the header's primary action while retired. `/admin/processes` and the service process list SHALL show the Retired status on the row. Copy SHALL exist in English and Czech.

#### Scenario: Confirmation required

- **WHEN** an administrator chooses Retire in the `…` menu
- **THEN** a confirmation dialog opens and nothing is sent until they confirm

#### Scenario: Personal process page

- **WHEN** the owner of a personal process opens it in the web app
- **THEN** no Retire control is offered and Delete stays available

## MODIFIED Requirements

### Requirement: Registry API

The registry SHALL be served under `/admin/api/identity/catalog/processes` behind the account session and the administration origin and CSRF checks: GET lists up to 100 summaries with `nextAfter` or reads one draft or version; POST `/validate` validates without writing; POST `/command` saves (`saveDraft`) or freezes (`freezeDraft`); POST `/archive` archives a personal process; POST `/retirement` retires or restores a company process.

#### Scenario: Read a version

- **WHEN** a manager reads a process with `id` and `version=2`
- **THEN** the immutable version 2 is returned with its current test status

#### Scenario: Retirement without the console origin

- **WHEN** a retire command arrives without the administration origin or CSRF proof
- **THEN** it is refused before any state changes

### Requirement: Registry audit

Every draft save, freeze, test record, activation, archive, retirement and restore SHALL commit together with a `catalog.process_changed` audit entry identifying revisions and version numbers (`processEvent` `retired` or `restored` for the last two), and SHALL roll back if the audit write fails. Audit details MUST NOT contain definitions, instructions, inputs or secrets. Deleting an organization or workspace SHALL delete its processes with their versions and pins.

#### Scenario: Audit failure

- **WHEN** writing the audit entry for a draft save fails
- **THEN** the draft is not saved

#### Scenario: Retirement audited

- **WHEN** an administrator retires a process at revision 4
- **THEN** one `catalog.process_changed` entry with `processEvent: "retired"`, `previousRevision: 4` and `revision: 5` is committed with it

#### Scenario: Audit failure on retirement

- **WHEN** writing the audit entry for a retirement fails
- **THEN** the process is not retired

### Requirement: Service removal and personal processes

Removing a service SHALL be refused with `catalog_service_in_use` while a service or workspace process uses it, retired ones included. Personal processes SHALL NOT block removal and SHALL fail closed for their owner at the next validation or run.

#### Scenario: Only a personal process uses the service

- **WHEN** an administrator removes a service used only by a member's personal process
- **THEN** the service is removed and the personal process can no longer start

#### Scenario: Retired company process uses the service

- **WHEN** an administrator removes a service used only by a retired workspace process
- **THEN** the removal is refused with `catalog_service_in_use`
