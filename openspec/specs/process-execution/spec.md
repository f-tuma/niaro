# process-execution Specification

## Purpose

People start active, qualified processes from the web and mobile apps, chat or a meeting, review their typed input, answer their questions, approve their writes and read their results. This capability covers the start inventory, input forms, start admission, the native run, approvals, questions, interruption, recovery, run limits and the run projection with its output.

## Requirements

### Requirement: Start inventory

`GET /v1/{workspace}/processes?profile=agent-process-execution/1` SHALL list the active processes the authenticated person can start, read from each active immutable version (name, description, kind, version, artifact digest, input schema), in pages of at most 100 with a fingerprint that later pages MUST send with `after`. Reading MUST NOT decrypt credentials, refresh OAuth, reserve budget or dispatch anything.

#### Scenario: Inventory changed between pages

- **WHEN** an active version changes between two page reads
- **THEN** the second read answers `process_inventory_changed`

#### Scenario: Too many processes

- **WHEN** the workspace has more than 1,000 active processes
- **THEN** the read answers `process_inventory_limit`

### Requirement: Inventory visibility

Every role SHALL need current access to every service, action, model and provider an active version uses; a process the person cannot use SHALL be omitted. Personal processes SHALL appear only for their owner, marked `personal: true`.

#### Scenario: Someone else's personal process

- **WHEN** a member reads the inventory
- **THEN** other people's personal processes are absent

### Requirement: Blocked processes

A usable but unready process SHALL be listed `blocked` with a reason (`service_unavailable`, `model_unavailable`, `source_changed`, `connection_required`, `qualification_required`, `budget_unavailable`) and without its input schema.

#### Scenario: Owner has not signed in

- **WHEN** a process needs the person's personal sign-in that is missing
- **THEN** it is listed blocked with `connection_required`

### Requirement: Input form preparation

`POST /v1/{workspace}/processes/input?profile=agent-process-execution/1` with `{processId, version, artifactDigest, language, origin}` SHALL recheck readiness, never substitute another active version, and return an `agent-process-input/1` form with the frozen input schema, its digest and an opaque start intent. Preparation MUST NOT create a run, a pin or inference; a different language or form under the same origin SHALL conflict.

#### Scenario: Active version changed since selection

- **WHEN** a person prepares a form for version 3 after version 4 became active
- **THEN** preparation is refused and the person must select again

### Requirement: Process input values

Process inputs SHALL be at most 65,536 UTF-8 bytes of JSON matching the frozen schema exactly; strings default to at most 4,000 characters (up to 60,000 when declared) and arrays to at most 100 items. Absent fields, empty strings, whitespace, false, zero, null, empty collections and array order SHALL be preserved and kept distinct.

#### Scenario: Oversized input

- **WHEN** a start carries 70,000 bytes of input
- **THEN** admission is rejected with `process_input_invalid`

#### Scenario: Optional field left out

- **WHEN** a person leaves an optional text field absent
- **THEN** the input omits the field rather than sending an empty string

### Requirement: Typed input form

The apps SHALL render the frozen schema as typed controls (groups, ordered lists, text, numbers, enums, booleans, explicit null), validate locally without network requests, and show the complete input with version, conversation and language for review before an explicit Start.

#### Scenario: Editing makes no request

- **WHEN** a person fills and validates the form
- **THEN** no request is sent until they press Start

### Requirement: Start admission

`POST /v1/{workspace}/processes/commands?profile=agent-process-execution/1|2` SHALL accept a `process.start` (`agent-process-start/1`) built from the issued intent with command id, idempotency key, conversation, language and input. Admission SHALL validate input, expected active version and digest, origin and the qualification gate (see `process-qualification`), then store the run pin, journal and an immutable receipt atomically and answer 202 with the run state.

#### Scenario: Valid start

- **WHEN** a person starts a ready process with valid input
- **THEN** the server answers 202 with the admission and the run's current state

### Requirement: Rejected starts

A refused start SHALL answer HTTP 422 with an immutable reason such as `process_input_invalid`, `process_origin_changed`, `process_active_version_changed`, `process_not_active`, `process_sources_changed`, `process_qualification_required`, `process_qualification_stale` or `process_execution_unavailable`. A new command MAY correct a rejected start on the same unused intent; only a successful admission consumes the intent.

#### Scenario: Activated version moved

- **WHEN** a start names version 2 but version 3 is active
- **THEN** the server answers 422 `process_active_version_changed`

#### Scenario: Correcting invalid input

- **WHEN** a start was rejected for invalid input and the person sends a new command with fixed input on the same form
- **THEN** the new start can be admitted

### Requirement: Exact replay and idempotency

A command id or idempotency key SHALL identify the original receipt. Replaying the exact command SHALL return it without revalidating the old form or starting, resuming or approving anything; changed input, intent, origin, language or identity under an existing id SHALL conflict. Start, approval and answer commands SHALL share one scoped namespace, and replay SHALL still require current authentication.

#### Scenario: Lost start response

- **WHEN** the app resends the exact start after losing the response
- **THEN** it receives the original admission and no second run starts

#### Scenario: Same id, different input

- **WHEN** a start reuses a command id with changed input
- **THEN** it is refused as a conflict

### Requirement: Meeting origin

A start MAY have origin `meeting` with the meeting id, record digest, an optional selected open meeting task and its revision, and `sourceBindings` mapping input fields to `summary`, `points`, `tasks`, `selectedTask` or `transcript`. The server SHALL load those values again from the record, refuse a stale record or task, and treat the start as authorizing only that run (see `meetings`).

#### Scenario: Task closed before start

- **WHEN** the selected meeting task is closed before the person starts the process
- **THEN** the start is refused as stale

### Requirement: Native run

An admitted run SHALL execute the frozen version on the native Mastra runtime under the person's current authority: action steps through the service catalog with argument validation, approval policy, guarded transport, audit and durable receipts (see `service-catalog`); agent steps with only their declared capabilities as tools in their own child thread; branches and returns without code. Each step SHALL recheck the version, authority and source and OAuth pins.

#### Scenario: Grant revoked mid-run

- **WHEN** the person loses access to an action used by a waiting run
- **THEN** the run stops with `process_definition_invalid` and dispatches nothing more

### Requirement: Typed results

Only successful typed results SHALL flow to later steps. Every observed action result and the final output SHALL be validated against the declared schemas; an invalid output SHALL fail the run while an earlier successful write stays successful. A failed, rejected or unknown action receipt SHALL stop an agent before another model call can claim success.

#### Scenario: Output does not fit

- **WHEN** a write succeeds but the process output does not match its schema
- **THEN** the run fails, the write's receipt stays succeeded and the failure says the write was not undone

### Requirement: Agent memory modes

An agent step's memory SHALL be `none` (no conversation recall), `conversation` (native memory for that step's own thread only) or `saved` (read-only context from the person's saved memory; see `memory`). A process MUST NOT remember, revise or forget saved memory. Forget, opt-out, source revocation or expiry SHALL block continuation, and a changed memory generation SHALL require a new run.

#### Scenario: Person opts out

- **WHEN** the person opts out of saved memory while a `saved` run waits for approval
- **THEN** the run cannot continue

### Requirement: Run step and time limits

A run SHALL count every entered node and every model and tool call as a step and enforce `maxSteps` (`process_step_limit`), a model-call cap shared by all agent steps, and an absolute deadline from admission that includes time spent waiting for people. Waiting, restart and retry MUST NOT reset charges or the deadline.

#### Scenario: Step limit

- **WHEN** an agent's tool call exceeds `maxSteps`
- **THEN** the run fails with `process_step_limit` and earlier receipts keep their status

### Requirement: Run budget

Model processes SHALL require the workspace budget in enforce mode with prices for every referenced model (`process_budget_policy_required`, `catalog_budget_price_required`). All steps SHALL reserve and settle against one root ledger capped by the lesser of workspace and process limits (see `inference-budget`). Unknown usage or an overrun SHALL block further inference and new actions while known receipts stay intact.

#### Scenario: Exhausted after a write

- **WHEN** the model-call cap is reached after a successful write
- **THEN** the run stops and the write stays succeeded

### Requirement: Process approvals

A write whose action requires approval SHALL pause the run with a pending receipt. The person SHALL approve or decline with a profiled `service.resolve` carrying `workItemId` (the admitted parent run), `expectedWorkRevision` (the process journal generation), `operationId`, `approved` and language, matching the current pending operation. Declining SHALL end the run without the write.

#### Scenario: Decline

- **WHEN** the person declines a pending write
- **THEN** the receipt becomes rejected, nothing is dispatched and the run ends

#### Scenario: Old decision replayed

- **WHEN** an approval of operation A is replayed after the run now waits for operation B
- **THEN** the replay returns A's result and B stays pending

### Requirement: Approval review

The approval card SHALL show the effect, the complete parameters and the service and action revisions, revalidated against current authority, memory and sources. An incomplete or oversized review (above 131,072 characters) SHALL be shown as unavailable instead of shortened. Viewing a run SHALL never be consent.

#### Scenario: Oversized parameters

- **WHEN** a pending write's parameters exceed the review bound
- **THEN** the card says the review is unavailable and offers no approve control

### Requirement: Process questions

An agent with `humanInput: "text"` SHALL be able to ask the person a question; such versions use compiler `niaro-native-workflow/3` and need their own qualification. Clients SHALL answer with `process.answer` on profile `agent-process-execution/2`, bound to the run, journal generation, node, child run, tool call, question id and revision. Profile `/1` MUST NOT start or resume a question-capable version.

#### Scenario: Old client

- **WHEN** a client using profile `/1` starts a version that can ask questions
- **THEN** the start is refused

### Requirement: Answer binding

One question SHALL accept one answer. An answer MUST NOT answer, approve or cancel another question or action, and its text MUST NOT grant permission for a write. A consumed answer SHALL appear once as the person's chat message with its original whitespace; delivery alone SHALL NOT count as consumption.

#### Scenario: Answer to an old question

- **WHEN** an answer targets question A while the run now asks question B
- **THEN** the answer does not resolve B

#### Scenario: Answer says approve

- **WHEN** an answer's text says "approve the write"
- **THEN** no pending write is approved

### Requirement: Interruption

`POST /v1/{workspace}/processes/commands/interrupt` with the exact original command SHALL record a barrier and abort that request, answering `settled` with the result or `unknown` (`not_running`, `not_settled`). An unstarted admission or pending decision SHALL become cancelled only after the native run is proved retired; a cancelled request without admission SHALL answer `process_command_cancelled`. Interruption MUST NOT change an unknown write.

#### Scenario: Interrupt a waiting decision

- **WHEN** the person interrupts an approval request still in progress
- **THEN** it becomes cancelled after retirement is proved and the write is not dispatched

### Requirement: No implicit execution

A server restart, page reload, reconnect, poll, inventory read, form preparation or card opening MUST NOT start or resume a run. Only an explicit original command SHALL retry a proved native checkpoint, reusing its operation ids, version pin, deadline and charges.

#### Scenario: Restart while waiting

- **WHEN** the server restarts while a run waits for approval
- **THEN** the run stays waiting until the person decides

### Requirement: Checkpoint recovery outcomes

Known receipts SHALL be returned without dispatching again, and a pending approval SHALL need the original human decision. Missing native state SHALL fail with `process_checkpoint_missing`, a mismatched checkpoint with `process_checkpoint_invalid`, and missing boundary proof with `process_checkpoint_interrupted`. Unknown writes and unknown model usage SHALL never be resent.

#### Scenario: Crash after a write was sent

- **WHEN** the server dies after dispatching a write but before recording its result
- **THEN** the receipt stays unknown and the write is never sent again

### Requirement: Version pins

A run SHALL keep the version selected at admission across draft edits, activation, rollback and restart.

#### Scenario: Rollback while a run waits

- **WHEN** version 1 is restored while a run of version 2 waits for approval
- **THEN** that run resumes on version 2 after its approval and new starts use version 1

### Requirement: Run reads

`GET /v1/{workspace}/processes/runs?profile=…&parentRunId=` SHALL return private operational state of the person's own run: status (`running`, `waiting`, `succeeded`, `failed`, `unknown`, `cancelled`), pending approval or question, safe failure and output. Output beyond the portable bounds SHALL be omitted with `outputTruncated: true` while the run stays succeeded.

#### Scenario: Reading another person's run

- **WHEN** a person reads a parent run id they do not own
- **THEN** no run data is returned

### Requirement: Run projection

Clients negotiating `tasks=agent-process-work/1` to `/4` SHALL receive admitted runs as WorkItems in their conversation with provenance (run, process, version, artifact digest, actor, command, admission), status including `interrupted`, the original `journalStatus`, up to 64 receipt summaries and at most eight validated output fields. Profile `/2` adds questions, `/3` approvals and `/4` output references; lower profiles SHALL strip them and unnegotiated clients get a text fallback.

#### Scenario: Unknown write in a run

- **WHEN** a run's write ends unknown
- **THEN** its card shows it unconfirmed, never done, and asks the person to check the effect before trying again

#### Scenario: Old client profile

- **WHEN** a client negotiates only `agent-process-work/1`
- **THEN** question and approval details are stripped from its WorkItems

### Requirement: Projection authority

Every projection SHALL revalidate private read access, source TTL, OAuth pins and memory; without detail access receipts SHALL keep their status and lose private results and output. Chat runs and admitted processes SHALL share a window of at most 400 roots within the 500-WorkItem snapshot limit. An unstable projection SHALL answer `task_projection_changed`. Loops SHALL show the same provenance.

#### Scenario: Access lost

- **WHEN** the person loses detail access to a service used by a finished run
- **THEN** the run's receipt statuses stay visible and its results are hidden

### Requirement: Full output reading

After `GET /v1/{workspace}/processes/output/capabilities?profile=agent-process-output/1` the client SHALL be able to read a succeeded run's complete validated output with `GET …/processes/output?profile=agent-process-output/1&request=…`, bound to scope, admission, run, journal revision, artifact and output digest. Pages SHALL be at most 65,536 bytes and 16 children by ordinal path; requests at most 20,480 bytes. Reading MUST NOT dispatch anything.

#### Scenario: Stale page

- **WHEN** a client continues a page with a reference from an older journal revision
- **THEN** the read is rejected

### Requirement: Output redaction

Sensitive keys and values SHALL be redacted from process output before preview, hashing or paging, and a redacted node SHALL contain no hidden value.

#### Scenario: Secret in output

- **WHEN** a process output contains a field named `token`
- **THEN** the preview and pages show it redacted and its value is never returned

### Requirement: Launching processes in the apps

The web app's Processes page and the mobile app's Processes panel SHALL load the inventory, explain blocked entries, prepare the form for a selected ready version and start it only on an explicit Start. They SHALL list recent runs, at most 50 with waiting runs first. A transport acknowledgment SHALL NOT be shown as process success.

#### Scenario: Blocked entry

- **WHEN** a process is blocked for a missing sign-in
- **THEN** the app explains the missing setup and offers no Start

### Requirement: App command recovery

The apps SHALL save each start, approval and answer before sending. An unknown delivery SHALL be retried only as the same exact command (**Retry same start**); a known outcome whose local saving failed SHALL offer **Retry saving** without another request. Reload, reopen or reconnect MUST NOT resend anything, and a saved answer SHALL stay visible until the server shows it consumed.

#### Scenario: Lost start in the app

- **WHEN** the app restarts after sending a start without an answer
- **THEN** it shows the saved start with Retry same start and sends nothing by itself

#### Scenario: Saved answer survives restart

- **WHEN** the app restarts after a process answer was sent
- **THEN** the saved answer card keeps the question and text until the server shows it consumed

### Requirement: Offering a fitting process in chat

Before using services for a new request, the chat agent in the paired web and mobile apps SHALL see the processes the person can start now and MAY call `process_offer {processId, reason, input}` once, ending the turn with a `process.offer` card with the exact version, the reason and suggested values from the message (values that do not fit are dropped). An offer SHALL start nothing. MCP clients and administration sessions SHALL NOT be offered processes.

#### Scenario: Offered process changed

- **WHEN** the offered version is no longer active when the person opens it
- **THEN** the launcher asks for a new choice

### Requirement: Declining an offer

**Open process** SHALL open the launcher on the offered version with the form prefilled once. **Without it** SHALL resend the request with `message.send.withoutProcess: true`, and that turn SHALL get no processes and no `process_offer`.

#### Scenario: Person declines the offer

- **WHEN** the person chooses Without it
- **THEN** the request is handled with service tools and no process is offered in that turn

### Requirement: Failure sentences and next steps

Each safe failure code SHALL map to one fixed English and Czech sentence and at most one next step (`sign_in`, `run_again`, `retest` or `edit`) in one table shared by the server, the web app and the mobile app. An unknown code SHALL read as a generic sentence naming the code, with no next step. An unconfirmed write MUST NOT offer Run again. A client SHALL show a next step only where this person can take it.

#### Scenario: Missing sign-in

- **WHEN** a person's run stops with `connection_required`
- **THEN** the web run sheet says "A service it uses needs you to sign in." with Sign in, which opens Connections

#### Scenario: Unknown code

- **WHEN** a run stops with a code the table does not know
- **THEN** the apps say "It stopped with code <code>." and offer no next step

#### Scenario: Unconfirmed write

- **WHEN** a run stops with `process_action_unknown`
- **THEN** the sentence asks the person to check the service and no Run again is offered for it

### Requirement: Failure code in the run projection

With detail access, the run projection SHALL carry the run's safe failure code as `failureCode` and write the table's sentence into the run's result. A value that is not a short code MUST NOT be shown.

#### Scenario: Failed output

- **WHEN** a run fails with `process_output_invalid` and the person may see details
- **THEN** its WorkItem carries `failureCode: process_output_invalid` and its result says the result didn't match the declared output

### Requirement: Run again

A finished, failed or stopped process run SHALL offer **Run again** on the web and the phone. It SHALL read the earlier run's admitted input with `GET …/processes/runs`, take a fresh start inventory and open the ordinary start form of the process's **current active version**, filled with that input, and it MUST NOT send anything until the person reviews the form and presses Start, which sends an ordinary new start. A process that cannot start now SHALL say why and open no form.

#### Scenario: Schema changed

- **WHEN** the active version's input schema no longer accepts the earlier input
- **THEN** the form shows field errors for the values that no longer fit, for fields that are gone and for required fields without a value, and nothing is sent

#### Scenario: Newer version active

- **WHEN** the earlier run used version 3 and version 4 is active
- **THEN** Run again opens version 4's form with the earlier input

#### Scenario: Blocked process

- **WHEN** the process is blocked for a missing sign-in
- **THEN** Run again opens no form and the reason is shown
