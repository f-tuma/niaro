# process-definitions Specification

## Purpose

Process definitions describe repeatable company or personal work, an agent or a workflow over configured service actions, saved as drafts and frozen into immutable versions. This capability covers the definition format, validation, ownership and management authority, and the version registry; designing is in `process-design`, testing and activation in `process-qualification`, running in `process-execution`.

## Requirements

### Requirement: Definition kinds

A process definition SHALL be strict JSON with `schemaVersion: 1`, a name, a description of at most 1,000 characters, `trigger: "manual"`, closed object input and output schemas, limits, and a `kind`: `agent` or `workflow`. Definitions MUST NOT contain executable code, scripts, templates, remote schema references or an expression language.

#### Scenario: Script in a definition

- **WHEN** a definition contains a field outside the schema, such as a script or a remote `$ref`
- **THEN** it is rejected as `definition_invalid`

### Requirement: Agent definitions

An agent (a whole `agent` process or an `agent` workflow step) SHALL name a tool-capable catalog model, instructions of at most 4,000 characters, at most 16 explicit `{serviceId, actionId}` capabilities, a memory mode `none`, `conversation` or `saved`, and MAY opt into questions to the person with `humanInput: "text"`. An agent step SHALL also declare its own input and output schemas.

#### Scenario: Seventeen capabilities

- **WHEN** an agent lists 17 capabilities
- **THEN** the definition is rejected

### Requirement: Workflow definitions

A workflow SHALL have an `entry` step id and 1–64 steps of type `action` (a service action with input bindings, declared output schema and `next`), `agent` (with `next`), `branch` (`exists` or scalar `equals` condition choosing `whenTrue` or `whenFalse`) or `return` (output bindings).

#### Scenario: Lookup workflow

- **WHEN** a workflow's entry action binds its input from the process input and a return binds a field of that action's output
- **THEN** the definition is structurally valid

### Requirement: Data schemas

Process data schemas SHALL be a closed JSON Schema subset nested at most six levels: strings (optional length up to 60,000 and enum), finite numbers and integers (optional range), booleans (optional enum), null, arrays (optional size bounds) and closed objects with declared required fields. Field keys SHALL match `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` and MUST NOT be `constructor` or `prototype`.

#### Scenario: Open object

- **WHEN** an object schema allows additional properties
- **THEN** the definition is rejected

#### Scenario: Unsafe key

- **WHEN** a schema uses the key `prototype`
- **THEN** the definition is rejected

### Requirement: Bindings

A binding SHALL be a process input path, a preceding step's output path (each at most six keys) or a scalar literal (string up to 4,000 characters, finite number, boolean or null). A binding map SHALL hold at most 40 fields.

#### Scenario: Binding to a later step

- **WHEN** a step binds the output of a step that runs after it
- **THEN** validation reports `binding_invalid`

### Requirement: Limits

Every definition SHALL declare `maxSteps`, `maxModelCalls`, `maxTokens`, `maxCostMicros` (USD millionths) and `maxDurationMs`, and validation SHALL refuse values above the server cap policy, which defaults to 64 steps, 32 model calls, 100,000 tokens, 10,000,000 USD millionths and 600,000 ms.

#### Scenario: Cap exceeded

- **WHEN** a definition declares `maxModelCalls: 40` while the cap is 32
- **THEN** validation reports `limit_exceeded` at `/limits/maxModelCalls`

#### Scenario: More steps than allowed

- **WHEN** a workflow has more steps than its own `maxSteps`
- **THEN** validation reports `limit_exceeded` at `/limits/maxSteps`

### Requirement: Size bounds

A definition SHALL stay within 64 graph nodes, 16 capabilities per agent, 256 referenced resources, 5,000 traversed values, 24 nesting levels and 64 KiB of keys and string values.

#### Scenario: Oversized definition

- **WHEN** a definition holds more than 64 KiB of strings
- **THEN** validation reports `limit_exceeded`

### Requirement: Passive validation

Validation SHALL be passive: it MUST NOT discover services, call providers, run inference or dispatch actions. It SHALL resolve referenced services, actions, models, providers and the saved-memory plugin in the caller's scope under current authority and return `{valid, issues, sources}` with at most 20 `{code, path}` issues and no private values.

#### Scenario: Disabled action

- **WHEN** a definition references a disabled action
- **THEN** validation reports `resource_unavailable` at the action's path and writes nothing

#### Scenario: Action the person may not use

- **WHEN** the caller is not allowed to use a referenced action
- **THEN** validation reports `capability_denied`

#### Scenario: Saved memory unavailable

- **WHEN** an agent uses memory `saved` while the memory plugin is disabled
- **THEN** validation reports `resource_unavailable` at `/memory`

### Requirement: Validation issue codes

Validation issues SHALL use exactly the codes `definition_invalid`, `limit_exceeded`, `resource_unavailable`, `capability_denied`, `graph_invalid`, `binding_invalid` and `binding_type_unproven`.

#### Scenario: Unproven pattern

- **WHEN** an unconstrained string is bound into a field with a `pattern`
- **THEN** validation reports `binding_type_unproven` rather than accepting it

### Requirement: Graph soundness

A workflow SHALL have unique step ids, a valid entry, existing successors, no cycles and no unreachable steps.

#### Scenario: Cycle

- **WHEN** two steps lead to each other
- **THEN** validation reports `graph_invalid`

#### Scenario: Orphan step

- **WHEN** a step cannot be reached from the entry
- **THEN** validation reports `graph_invalid`

### Requirement: Binding soundness

A step output binding SHALL refer only to an action or agent step that runs on every path before its consumer, required destination fields SHALL be provably supplied, and when compatibility with the destination schema cannot be proved (for example a `oneOf`) validation SHALL report `binding_type_unproven` instead of weakening the check.

#### Scenario: Reading a skipped step

- **WHEN** a step binds the output of an action that only one branch runs
- **THEN** validation reports `binding_invalid`

### Requirement: Process owners

Every process SHALL have one immutable owner: a service (`{type: "service", serviceId}`), the workspace (`{type: "workspace"}`, shown as "Company") or one person (`{type: "user", userId}`, shown as "Personal"). All owners SHALL share the same definition format, versions, testing, activation and execution.

#### Scenario: Changing the owner

- **WHEN** a save names a different owner than the stored process
- **THEN** it fails with `process_conflict` and nothing changes

#### Scenario: Foreign user id

- **WHEN** a member saves a personal process with another person's `userId`
- **THEN** the save is refused

### Requirement: Members own only personal processes

A member MUST NOT own a workspace or service process. A member's request to create a workspace process SHALL be recorded as their personal process.

#### Scenario: Member asks for a company process

- **WHEN** a member starts a design with `owner: {type: "workspace"}`
- **THEN** the process is bound to the member's personal ownership and the review shows that owner

### Requirement: Managing company processes

Owners and administrators of the workspace SHALL manage (read, design, save, freeze, test, activate, roll back) service and workspace processes; members MUST NOT. Operator keys and membership alone SHALL NOT grant management, and request bodies MUST NOT override the actor.

#### Scenario: Member edits a company process

- **WHEN** a member saves a draft of a workspace process
- **THEN** the server answers 403

### Requirement: Managing personal processes

The owner of a personal process, whatever their role, SHALL manage it. Another member SHALL get 404. Workspace owners and administrators SHALL be able to list and read it, but any change, test, activation, rollback or archive SHALL fail with `403 process_personal_read_only`.

#### Scenario: Administrator edits someone's personal process

- **WHEN** an administrator saves a draft of a member's personal process
- **THEN** it fails with `403 process_personal_read_only`

#### Scenario: Another member reads a personal process

- **WHEN** a member reads a personal process they do not own
- **THEN** the server answers 404

### Requirement: Current authority is never cached

Validation, freezing, tests, activation and every execution step SHALL use the actor's current organization role, workspace roles, per-person allow and deny and service access, the same decisions the chat runtime uses. Actions that need the owner's personal sign-in SHALL remain designable.

#### Scenario: Grant lost before freezing

- **WHEN** the owner loses access to a referenced action and then freezes the draft
- **THEN** freezing fails validation with `capability_denied`

### Requirement: Drafts

Each process SHALL have one mutable draft with an optimistic revision. A stale revision SHALL fail with `process_conflict` and an invalid definition with `process_definition_invalid`. Saving a draft MUST NOT change the active version.

#### Scenario: Stale save

- **WHEN** two people save the same draft and the second uses the old revision
- **THEN** the second save fails with `process_conflict`

#### Scenario: Saving keeps the live version

- **WHEN** a draft of a process with active version 2 is saved
- **THEN** version 2 stays active

### Requirement: Immutable versions

Freezing SHALL append an immutable version holding the definition, a dependency manifest (service, action, model and provider revisions, saved-memory plugin digest and limit policy digest, never credential values) and a canonical SHA-256 digest. Freezing an unchanged draft SHALL reuse the latest matching version. Stored versions MUST NOT be modified.

#### Scenario: Freeze unchanged draft

- **WHEN** a draft identical to the latest version is frozen again
- **THEN** the existing version is returned and no new version is added

#### Scenario: Dependency changed

- **WHEN** an action used by version 1 gets a new revision
- **THEN** version 1 keeps its original pins and a new version must be frozen and tested

### Requirement: Freeze command receipts

Freezing through `agent-process-versions/1` (`POST /admin/api/identity/catalog/processes/versions/freeze`) SHALL require the current registry revision and a request id and SHALL store an immutable receipt readable by GET with that request id. Versions SHALL be listed newest first in pages of 20.

#### Scenario: Lost freeze response

- **WHEN** the client resends the exact freeze request after losing the response
- **THEN** it gets the original receipt and no second version is created

### Requirement: Registry API

The registry SHALL be served under `/admin/api/identity/catalog/processes` behind the account session and the administration origin and CSRF checks: GET lists up to 100 summaries with `nextAfter` or reads one draft or version; POST `/validate` validates without writing; POST `/command` saves (`saveDraft`) or freezes (`freezeDraft`); POST `/archive` archives a personal process.

#### Scenario: Read a version

- **WHEN** a manager reads a process with `id` and `version=2`
- **THEN** the immutable version 2 is returned with its current test status

### Requirement: Registry profiles

Profile `agent-service-processes/2` SHALL include workspace and personal processes with their `owner`; profile `agent-service-processes/1` SHALL stay admin-only and service-only. Members SHALL receive only their own personal processes. Management lists SHALL mark an active version that must be tested again before it can run with `retestNeeded: true`.

#### Scenario: Member lists processes

- **WHEN** a member lists processes with profile `/2`
- **THEN** only their own personal processes are returned

#### Scenario: Workspace process through profile 1

- **WHEN** a client reads a workspace process with profile `/1`
- **THEN** the request is refused before any state changes

### Requirement: Deleting a personal process

The owner SHALL delete their personal process with `POST …/processes/archive` and `{profile: "agent-service-processes/2", type: "archive", id, revision}`, answered with `{profile, id, archivedAt}`. Workspace and service processes SHALL be refused with `process_archive_forbidden`, administrators with `process_personal_read_only` and other members with 404. A stale revision SHALL fail with `process_conflict`.

#### Scenario: Deleting a company process

- **WHEN** an administrator archives a workspace process
- **THEN** it fails with `process_archive_forbidden`

### Requirement: Archived processes

An archived process SHALL behave as missing (404) for listing, reading, editing, testing, activating, starting and chat offers, and a run in progress SHALL stop at its next server step. Versions, tests, run pins and receipts SHALL be kept, so past runs keep their history. Archiving SHALL NOT be undoable from the apps.

#### Scenario: Owner deletes

- **WHEN** the owner archives their personal process
- **THEN** it disappears from their list and start inventory and its past run history stays readable

#### Scenario: Run in progress

- **WHEN** a run of the process waits for approval at the time of archiving
- **THEN** it stops at its next server step

### Requirement: Service removal and personal processes

Removing a service SHALL be refused with `catalog_service_in_use` while a service or workspace process uses it. Personal processes SHALL NOT block removal and SHALL fail closed for their owner at the next validation or run.

#### Scenario: Only a personal process uses the service

- **WHEN** an administrator removes a service used only by a member's personal process
- **THEN** the service is removed and the personal process can no longer start

### Requirement: Registry audit

Every draft save, freeze, test record, activation and archive SHALL commit together with a `catalog.process_changed` audit entry identifying revisions and version numbers, and SHALL roll back if the audit write fails. Audit details MUST NOT contain definitions, instructions, inputs or secrets. Deleting an organization or workspace SHALL delete its processes with their versions and pins.

#### Scenario: Audit failure

- **WHEN** writing the audit entry for a draft save fails
- **THEN** the draft is not saved

### Requirement: Processes in administration

The administration SHALL offer `/admin/processes` for workspace processes, `/admin/processes/design` and `/admin/processes/{id}`, and per service `/admin/services/{serviceId}/processes/design` and `/admin/services/{serviceId}/processes/{processId}`, with management controls only for owners and administrators.

#### Scenario: Direct link

- **WHEN** an administrator reloads `/admin/processes/{id}`
- **THEN** the process page opens

### Requirement: Processes in the web app

The web app's `/processes` SHALL list "My processes" (every personal process the person owns, drafts included, with state draft, tested, active vN, or blocked with the start inventory's reason) and the company processes the person can start, which stay start-only. `/processes/design` and `/processes/{id}` SHALL work with a personal scope and refuse processes the person does not own.

#### Scenario: Member opens a company process page

- **WHEN** a member opens `/processes/{id}` for a workspace process
- **THEN** the page refuses it and offers no management controls

#### Scenario: Personal process blocked

- **WHEN** an active personal process needs a sign-in the owner lacks
- **THEN** "My processes" shows it blocked with that reason and no start button

### Requirement: Canvas layout

A draft and each frozen version SHALL be able to carry a canvas layout: step positions and at most 20 notes of at most 280 characters, stored beside the definition. Freezing a new version SHALL copy the draft's layout to it, and a version's layout SHALL never change. Registry reads SHALL return `layout` beside the draft and the version. Saving a draft without a layout SHALL keep the draft's layout; positions of steps the definition lacks SHALL be dropped.

#### Scenario: A version keeps its arrangement

- **WHEN** a changed draft with a layout is frozen as version 2 and the draft's arrangement changes later
- **THEN** version 2 is read with the layout it was frozen with

### Requirement: Layout outside every digest

The layout MUST NOT be part of the definition, the immutable version artifact, the artifact digest, version reuse on freeze, or the comparison of the draft with a version.

#### Scenario: Move a step of an active process

- **WHEN** an owner moves a step of an active process's draft and saves only that arrangement
- **THEN** the draft's definition still equals the active version, freezing returns the same version with the same digest, and the process does not need a new test

### Requirement: Variables in process prompts

An agent step's configured instructions SHALL have the prompt variables (see `agent-runtime`) filled in for the person running the process each time its model is prepared, with `{today}` in the workspace's time zone. Frozen definitions, their digests and the editors SHALL keep the text as typed. Workspace instructions SHALL NOT be added to process runs.

#### Scenario: Personal report

- **WHEN** a process step says "write a summary for {person.name} dated {today}"
- **THEN** the model reads the running person's name and the workspace's current date, and the definition's digest is unchanged
