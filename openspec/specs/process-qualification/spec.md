# process-qualification Specification

## Purpose

Before a process version can run, its manager tests the exact frozen version in an isolated native run with scripted model replies and simulated action results, the server qualifies the result, and a person explicitly activates it or rolls back. This capability covers native tests, qualification, activation, rollback, retests and the test console for administrators and personal-process owners.

## Requirements

### Requirement: Isolated native test

A native test (`agent-process-native-tests/1`) SHALL run a frozen version through the real compiler, native Mastra Agent and Workflow, catalog controller, approval logic and inference ledger in detached temporary stores with closed synthetic transports, with scripted model replies and token usage. Reports SHALL state `native_scripted` and `activationEligible: false`.

#### Scenario: Test makes no external call

- **WHEN** a native test runs a workflow that writes to the CRM
- **THEN** the write is served by its scripted fixture and no request leaves the server

### Requirement: Test isolation from production

A native test MUST NOT use real service endpoints, credentials, providers, populated saved memory, optional plugins or production run pins, and MUST NOT change the registry, the active version, run pins or memory.

#### Scenario: Test of a version with saved memory

- **WHEN** a test runs an agent with memory `saved`
- **THEN** it sees empty read-only memory and the person's saved memory is untouched

### Requirement: Test suites

A suite SHALL hold 1–16 cases. Each case SHALL declare typed input, the expected outcome and output or exact failure code, ordered action fixtures (at most 32), scripted model steps per strategy (at most 32), expected receipts, ordered question fixtures (at most 16 per strategy) and optionally a storage reopen. Missing, extra, mismatched or unconsumed fixtures SHALL fail the case.

#### Scenario: Unconsumed fixture

- **WHEN** a case declares an action fixture the run never calls
- **THEN** the case fails

#### Scenario: Pending question

- **WHEN** a run still waits for a question no fixture answers
- **THEN** the case fails without a terminal observation

### Requirement: Configured and generic strategies

A suite SHALL run every case both as the configured process and as the generic chat loop with an explicitly chosen generic model, with no retries, scorer inference or live fallback. `comparisonMode: "configured_only"` SHALL be accepted only for workflows without agent steps.

#### Scenario: Configured-only agent

- **WHEN** a suite for an agent process sets `comparisonMode: "configured_only"`
- **THEN** it is rejected

### Requirement: Native test API

Under `/admin/api/identity/catalog/processes/tests/native` the server SHALL offer POST (start), GET by `testId`, `/list` (by process and optional version, `after`, `limit` 1–20), `/detail` (exactly one of request id or test id) and `/tools` (runtime tool names for a version and generic model). Unknown or duplicate query keys SHALL be rejected. Requests MUST NOT supply an actor, catalog snapshot, settings, report or code.

#### Scenario: Unknown query key

- **WHEN** a GET carries `__proto__` as a query key
- **THEN** it is rejected without any dispatch

#### Scenario: Detail profile 2

- **WHEN** the console reads `/detail` with profile `agent-process-native-test-detail/2`
- **THEN** it gets `{profile, job, request, diagnostic}`; profile `/1` returns `{job, request}`

### Requirement: Test deadlines

A test request SHALL wait at most 120 seconds and then answer `504 process_test_timeout` with the job retired without a report; each case SHALL be capped at the lesser of its process deadline and 30 seconds. A client disconnect or cancellation SHALL retire the job without publication.

#### Scenario: Deadline

- **WHEN** a test does not finish within 120 seconds
- **THEN** the response is `504 process_test_timeout` and no report is stored

### Requirement: Test admission

Only a person with current management authority over the process SHALL start a test, and testing SHALL require the enforce-mode budget with model prices. One test SHALL run per process at a time (`process_test_busy`). Testing the active version SHALL be refused with `process_test_active_version` unless `retestActive: true` is set.

#### Scenario: Second test while one runs

- **WHEN** a person starts a new test while another test of the same process runs
- **THEN** it is refused with `process_test_busy`

#### Scenario: Retest the live version

- **WHEN** a manager tests the active version with `retestActive: true`
- **THEN** the test runs and the active version keeps serving

### Requirement: Test privacy and replay

Tests, reports and history SHALL be private to the person who started them; another manager SHALL see an empty history and cannot read the report. Repeating the same request SHALL return the original job without running again; another command under the same request id SHALL conflict. Reads, history and replay MUST NOT run inference or dispatch anything.

#### Scenario: Another administrator's report

- **WHEN** an administrator lists tests of a process another administrator tested
- **THEN** that history is empty for them

### Requirement: Test integrity

Before every native boundary and before publishing, the server SHALL recheck the creator's authority and that sources, catalog, baseline model and provider, budget policy revision and prices match the pinned environment. Drift, cancellation or runner failure SHALL retire the job as interrupted with no report. Reports SHALL commit with their audit and be immutable.

#### Scenario: Price changes mid-test

- **WHEN** a model price changes while a test runs
- **THEN** the job ends interrupted and publishes no report

#### Scenario: Restart during a test

- **WHEN** the server restarts while a test runs
- **THEN** the job reads as interrupted with `test_server_restarted` and is never restarted

### Requirement: Passing observations

A passing observation SHALL consume exactly its scripted model calls, match usage totals and the pinned tariff with no unknown usage or overrun, and fit the frozen caps with each call reserving at least 2,048 input tokens plus the full output. A self-declared pass or zeroed budget SHALL NOT bypass these checks.

#### Scenario: Caps too small for the price

- **WHEN** a suite's scripted calls fit the token total but one call's reservation exceeds the frozen cap
- **THEN** the observation does not pass

### Requirement: Interrupted test diagnostics

An interrupted test whose runner failed SHALL be able to show its first specific checkpoint, infrastructure or persistence cause with at most 32 receipt summaries and no inputs, outputs, questions, provider error text or stacks. Historical jobs without one SHALL return `diagnostic: null`.

#### Scenario: Runner failure

- **WHEN** a test fails while persisting a receipt
- **THEN** the detail shows that cause and receipt states without business data

### Requirement: Qualification verdict

For every completed native test the server SHALL derive a separate qualification (policy `native-scripted-runtime/2`, scope `native_scripted_runtime`, `liveAcceptance: false`) from the stored version, suite, catalog and report. A request MUST NOT supply a verdict or exempt a scenario family. A version SHALL qualify only when both strategies pass every applicable family.

#### Scenario: Supplied verdict

- **WHEN** a test request includes a qualification verdict
- **THEN** the request is rejected

### Requirement: Scenario families

The applicable families SHALL be: success and storage reopen always; missing input when the input schema has a required field; failure for actions or agents; rejection for an action that requires approval; unknown for writes. Each SHALL be proved by its semantics: a rejection with zero dispatch, missing input with no model call or dispatch, a precise failure code, an unknown write with one dispatch and no replay, a reopen without another dispatch.

#### Scenario: Missing rejection case

- **WHEN** a workflow has an approval-required write and the suite has no rejection case
- **THEN** the test is not qualified

#### Scenario: Relabeled case

- **WHEN** a case labeled unknown actually succeeds
- **THEN** the unknown family is not satisfied

### Requirement: Activation review

`GET /admin/api/identity/catalog/processes/activation/review` (profile `agent-process-activation/1`, with process, version and test) SHALL return current readiness, artifact and qualification digests, registry revision, active version, coverage and whether activation or rollback is available, without changing anything.

#### Scenario: Review after a dependency change

- **WHEN** a service used by the tested version changed since the test
- **THEN** the review reports activation unavailable

### Requirement: Activation decision

`POST …/processes/activation` SHALL take `requestId`, `type` (`activate` or `rollback`), `processId`, `revision`, `expectedActiveVersion`, `version`, `artifactDigest`, `testId`, `qualificationDigest` and `acknowledgement: "controlled_native_test_only"`. It SHALL require a matching revision and active version (`process_conflict`) and a completed qualified test of that exact version by the same person on this server in an unchanged environment. It MUST NOT run a model, service or process.

#### Scenario: Activate a qualified version

- **WHEN** the person who qualified version 2 activates it with the current revision and digests
- **THEN** version 2 becomes active and an immutable receipt is stored

#### Scenario: Someone else's test

- **WHEN** an administrator activates using another administrator's test
- **THEN** the decision is refused

### Requirement: Activation and rollback targets

Activation SHALL target the latest frozen version whose definition equals the draft (`process_activation_version_changed` otherwise). Rollback SHALL target only a version this server activated before (`process_rollback_unavailable` otherwise) and pass the same qualification and freshness checks.

#### Scenario: Rollback to a never-active version

- **WHEN** a person rolls back to a version that was never active
- **THEN** it fails with `process_rollback_unavailable`

### Requirement: Activation receipts

GET `…/processes/activation` with a `requestId` SHALL return the original private receipt to its creator. Replaying the exact decision SHALL return that receipt without switching the pointer again or rechecking the old decision against new sources.

#### Scenario: Replay after a later rollback

- **WHEN** an old activation is replayed after a rollback
- **THEN** the old receipt is returned and the current active version is unchanged

### Requirement: Latest evidence wins

Tests SHALL be ordered by a durable admission ordinal across creators. A later running, interrupted, failed or unqualified test of a version SHALL supersede an earlier qualification for new decisions (`process_test_superseded`), and a later qualified test SHALL need a new human decision. Testing never changes the active pointer.

#### Scenario: Failed retest

- **WHEN** a qualified active version is retested and the retest fails
- **THEN** a new activation of that version is refused until a newer test qualifies

### Requirement: Qualification gate at run time

Starting and continuing runs SHALL require the version's native qualification reference and admission ordinal; a missing reference SHALL fail with `process_qualification_unavailable` and MUST NOT fall back to older test records. Drift of the version's sources, catalog or runtime SHALL block new effects until it is retested and activated again.

#### Scenario: Referenced model changed

- **WHEN** a model the active version uses gets a new revision
- **THEN** new starts are refused and management lists show `retestNeeded`

### Requirement: Qualifier authority

The run-time gate SHALL re-resolve the person who qualified the version: a changed role SHALL give `process_qualification_stale` and loss of their management access `process_qualification_authority_changed`. The run actor's own permissions SHALL be checked separately; a member MUST NOT gain the qualifier's rights.

#### Scenario: Qualifier leaves the workspace

- **WHEN** the administrator who qualified the active version leaves the workspace
- **THEN** new starts fail with `process_qualification_authority_changed`

#### Scenario: Member without the action

- **WHEN** a member starts a company process whose action they may not use
- **THEN** the process is not available to them although an administrator qualified it

### Requirement: Test console

The process page in administration and the web app SHALL show the draft, versions, private tests, both strategies, qualification and the current decision, and SHALL let the manager freeze, write a suite in a structured editor, run a test, and activate, retest or roll back. Each decision SHALL require a fresh acknowledgment of `controlled_native_test_only`.

#### Scenario: Acknowledgment required

- **WHEN** a person opens the activation dialog
- **THEN** the acknowledgment starts unchecked and activation stays disabled until checked

### Requirement: Suite editor

The suite editor SHALL edit typed inputs and outputs, action results, expected receipts, scripted replies and question fixtures, and SHALL support JSON import and copying an earlier test's suite. For a literal-only return with no required input it SHALL prepare the success and reopen checks.

#### Scenario: Copy an earlier suite

- **WHEN** a manager copies the suite of an earlier test
- **THEN** the editor holds that suite with its original model choices

### Requirement: Console command recovery

The console SHALL store each freeze, test or decision command before sending it. Navigation, reload and polling MUST only read; a command whose response was lost SHALL be found by its request id and resent only by explicit human retry.

#### Scenario: Lost test response

- **WHEN** the browser loses the response to a test request and reloads
- **THEN** the page finds the job by its request id and does not send the test again

### Requirement: Generated test for chat proposals

For a process saved from chat (see `process-design`), the server SHALL generate a default suite from the frozen definition and pinned catalog that follows the ordinary path with sample values and sample action results, lets reading agents call one read first, and covers every applicable family. It SHALL refuse to generate when a hazard is reachable only through an agent's own tool call, sample values do not satisfy a schema, or limits do not fit the model's price.

#### Scenario: Read-only agent process

- **WHEN** a proposal reads the CRM and summarizes it with an agent
- **THEN** the generated suite qualifies without any model provider or service being called
