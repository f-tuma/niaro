# Service process definitions and version registry

October 3, 2026. This is the persisted definition layer for the
conversational service builder. It describes configuration for the existing
native Mastra runtime; it does not introduce another execution engine. An
internal native runner handles action/agent/branch/return workflows and
standalone agents, including native conversation Memory and the shared root
budget. The builder chat, the controlled test/activation lifecycle and the
Services setup overview are described below. Public mobile execution is
implemented and accepted in an isolated scope. End-to-end migration, physical
Android and live acceptance remain open.

Further sections below cover the internal proposal store and safe capability
projection, the conversational native adapter, authenticated designer HTTP
(instantiated once in IdentityService, with tracked interruption and shutdown
cleanup), the rendered EN/CS designer chat with proposal/diff controls,
authenticated isolated native test HTTP and private history, a separate
server-derived runtime qualification record, qualified human
activation/rollback with console controls, proof-gated native parent recovery
with actual process-crash/concurrent-owner regressions, and shared service
setup with exact lifecycle previews.

Existing services continue to work without a process. Installing this code
adds registry tables to the identity database; it does not select a process,
change routing, enable a plugin or start a run. No dependency installation or
new server command is needed.

## Workspace processes

October 7, 2026. The administration has a top-level **Processes** page at
`/admin/processes`, a conversational designer at `/admin/processes/design`,
and the existing version/test/activation console at `/admin/processes/{id}`.
Its workspace-owned agents and workflows can reference several configured
services through the same explicit `{serviceId, actionId}` capabilities.
Saved designer sessions use the same durable command recovery, scoped to the
workspace owner separately from service designer sessions.

Metadata reads select `profile=agent-service-processes/2`. The paginated list
contains existing service records in their original shape and workspace records
with `owner: {type: "workspace"}` and no `serviceId`. Workspace save/validate
commands carry that explicit profile and owner. Designer requests select
`profile=agent-process-design/2`; a workspace start also carries that profile
and owner in its body. The owner is bound at start, remains immutable on draft
edits, and is absent from model proposal tools. Service metadata/designer `/1`
responses keep their original strict shape. Their lists contain service-owned
processes only; explicit workspace reads and mutations reject before changing
state. Existing service designer URLs and local recovery keys remain valid.

The definition schema, immutable artifact digest and native compiler format
remain unchanged. Workspace ownership omits the artificial parent-service pin;
every referenced service/action/provider/model pin and current execution policy
still applies. Freezing, native qualification, explicit activation, public
inventory, Session questions/approval, run identity and receipts use the shared
existing pipeline. There is no automatic activation or broader authorization.
An unknown effect retains its original no-repeat barrier.

Startup migrates the process parent table from mandatory `service_id` to a
nullable owner checked by SQLite. Existing rows retain service ownership, IDs,
revisions, draft bytes and active version. The migration checks foreign keys,
temporarily disables enforcement before its transaction, copies the parent,
drops the original, renames the replacement, restores custom indexes/triggers,
checks foreign keys again, and restores the prior enforcement setting in
`finally`. It never renames the referenced old parent first. Child artifacts,
qualifications, commands, run pins and receipts remain byte-for-byte unchanged.

`npm run test:global-processes` covers service-only `/1` pagination and refusal,
immutable owners, exact pins, migration failure handling and a derived populated
legacy-schema control with pending approval and unknown receipts. That control
populates service rows with the current producer before rebuilding the original
NOT NULL parent; an archived old-producer continuity proof is separate. The
HTTP test runs the actual native multi-service designer, twelve qualification
observations, activation and paired Session recovery. The existing browser QA
script selects this same workspace flow with
`NIARO_PIPELINE_QA_OWNER=workspace`.

## Personal processes

October 16, 2026. Any workspace member can now design, freeze, test and
activate their own **personal process** (UI label "Personal"; workspace
processes are "Company") without an administrator. A personal process is
owned by one person, `owner: {type: "user", userId}`. It uses the same
definition schema, native compiler, qualification, activation and run
pipeline as workspace processes; only ownership and visibility differ.

### Who can do what

| Action on a process                                     | Its owner (any role) | Another member  | Owner/admin of the workspace          |
| ------------------------------------------------------- | -------------------- | --------------- | ------------------------------------- |
| Personal: list, read draft/versions/receipts            | yes                  | no (404)        | read only                             |
| Personal: design, save, freeze, native test, activate   | yes                  | no (404)        | no (403 `process_personal_read_only`) |
| Personal: appears in start inventory and chat offers    | yes                  | no              | no                                    |
| Personal: start, pin, resume a run                      | yes                  | no (404)        | no (404)                              |
| Personal: delete (archive)                              | yes                  | no (404)        | no (403 `process_personal_read_only`) |
| Workspace/service: read, design, freeze, test, activate | —                    | no (403)        | yes (unchanged)                       |
| Workspace/service: inventory and start                  | —                    | yes, own grants | yes, own grants                       |

Administrators may read someone's personal process in the console (list,
detail, versions) but cannot change, test, activate, roll back or run it.
This keeps the owner's personal grants and sign-ins the only authority behind
it; an administrator who wants the same behaviour designs a workspace process.
Promotion of a personal process to a workspace process is not implemented
(TODO: an explicit admin command that copies the draft into a new workspace
process and requalifies it under workspace ownership).

A member never owns a workspace process. A member's designer start with the
`/2` workspace profile and `owner: {type: "workspace"}` is recorded as
personal; the review reports the owner actually bound. An explicit
`owner: {type: "user"}` may omit `userId`; a supplied `userId` must be the
authenticated person. The owner is immutable: SQLite triggers reject owner
changes and saving with another owner returns `process_conflict`.

### Capabilities and current authority

The designer's capability catalogue, proposal validation, freeze and every
later check run under the person's own authority, using the same
`ServiceCatalogStore.allowed`/`serviceAllowed` decisions the chat runtime and
execution inventory use (organization role, workspace roles, per-person
allow/deny, service access). A member sees only enabled actions they may use,
plus configured tool models (model choice is not role-gated). Actions that
need a personal sign-in remain designable; the start inventory reports
`connection_required` until the owner connects.

Nothing is cached as a grant. Validation at freeze, the native test, the
activation decision and every inventory read, start, pin and resume
revalidate the owner's current authority. The qualification gate re-resolves
the person who qualified the version and requires that they can still manage
that exact process (owner/admin for workspace processes, the owner for a
personal one). If the owner loses an action grant, the process disappears
from their inventory and existing runs stop with `process_definition_invalid`;
a role change makes the qualification `process_qualification_stale` (retest);
leaving the workspace gives `process_qualification_authority_changed`.

The same enforce-mode budget rules apply: the designer requires the workspace
policy in enforce mode with a price for the designer model, native tests
require enforce mode, and runs pin the workspace policy narrowed by the
frozen process caps. Personal processes add no budget exemption. Members
cannot read the budget policy, so the designer capabilities carry
`budgetReady` (enforce mode and a price for at least one listed tool model, at
its current model and provider revision; not part of the fingerprint). While
it is `false` the web app's designer and test pages show one line ("The AI
budget isn't set up yet — ask an administrator.") and keep sending and
testing disabled, so no request is refused after the person has written it.

### Deleting a personal process

The owner deletes their personal process with
`POST …/processes/archive` and
`{organizationId, workspaceId, profile: "agent-service-processes/2", type: "archive", id, revision}`
(answer `{profile, id, archivedAt}`; a stale `revision` is
`process_conflict`). Only the owner can: another member gets 404, an
administrator `process_personal_read_only`, and workspace or service processes
are refused with `process_archive_forbidden` (they are retired by deactivating
or removing them in administration). The web app offers it as **Smazat** in
the process page's More menu, with a confirmation, and returns to the list.

Deleting archives the row (`archived_at`, added by a startup
`ALTER TABLE` when missing): versions, tests, qualifications, run pins and
receipts stay, and the audit log records `catalog.process_changed` with
`processEvent: "archived"`. An archived process behaves as missing everywhere
else: it leaves "Moje procesy", the administrators' list, the start inventory
and chat offers, and it cannot be read, edited, tested, activated or started
(404). A run already in progress is not left to finish: like a lost grant, it
stops at its next server step (`resolveRun` returns 404), because the person
asked for the process to be gone. Past runs keep their history: the pinned
version of an existing run (`pinnedVersion`) and its execution scope still
resolve for receipts, tasks and output. Archiving cannot be undone from the
UI.

Personal processes do not block an administrator from removing a service
(`catalog_service_in_use` counts only service and workspace processes); the
personal process then fails closed for its owner at the next validation or
run.

### API for members

All routes are the existing account routes; members use them with their normal
browser session (`X-Agent-Admin: 1`, same-origin) and the mobile designer uses
`/v1/{workspace}/process-design` with the same bodies.

| Step                  | Request                                                                                                                                                                  | Notes                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List my processes     | `GET /admin/api/identity/catalog/processes?profile=agent-service-processes/2&organizationId&workspaceId[&after]`                                                         | Members get only their personal rows; admins get all rows. Each row has `owner: {type: "workspace"}` or `{type: "user", userId}`.                                              |
| Read one              | same with `&id=<processId>[&version=n]`                                                                                                                                  |                                                                                                                                                                                |
| Designer capabilities | `GET …/processes/design/capabilities?profile=agent-process-design/2&organizationId&workspaceId`                                                                          | Only the caller's usable actions and tool models.                                                                                                                              |
| Start designer (new)  | `POST …/processes/design/start?profile=agent-process-design/2` with `{organizationId, workspaceId, profile: "agent-process-design/2", requestId, owner: {type: "user"}}` | Add `processId` (and optionally `baselineVersion`) to edit an existing personal process. Turns, update, acknowledge and accept are unchanged; accept saves the personal draft. |
| Save draft directly   | `POST …/processes/command?profile=agent-service-processes/2` with `{…scope, profile, type: "saveDraft", owner: {type: "user"}, id?, revision, definition}`               |                                                                                                                                                                                |
| Freeze                | `POST …/processes/versions/freeze` with `{…scope, profile: "agent-process-versions/1", requestId, processId, revision}`                                                  |                                                                                                                                                                                |
| Native test           | `POST …/processes/tests/native` (unchanged body)                                                                                                                         | Creator-private, enforce budget required.                                                                                                                                      |
| Activate/rollback     | `GET …/processes/activation/review?…` then `POST …/processes/activation` (unchanged body)                                                                                |                                                                                                                                                                                |
| Start inventory       | mobile `/v1/{workspace}/processes`, chat `process_offer`                                                                                                                 | Personal entries carry `personal: true`.                                                                                                                                       |

Compatibility: the `/2` metadata and designer schemas now accept
`owner: {type: "user", userId}`; strict clients built before this change reject
a list or review containing a personal row, and workspace rows keep their
original bytes. Execution inventory entries add `personal: true` only for
personal entries, so existing workspace entries and inventory fingerprints are
unchanged. `/1` service routes remain admin-only and service-only.

Startup migrates `agent_service_process` once more with the same copy/drop/
rename procedure as above: it adds `owner_user_id`, allows `owner_type='user'`
(checked: user rows have no service and a user, other rows have no user) and
a partial index on `(organization_id, workspace_id, owner_user_id, id)`.
Existing service and workspace rows, versions, qualifications, commands, run
pins and receipts are copied unchanged.

`tests/personal-processes.node.ts` covers the authorization matrix (own,
someone else's and workspace processes; admin read-only), capability limits
and loss of a grant before freeze, the designer turning a member's workspace
request into a personal process, an actual member-owned native qualification
and activation, inventory/offer isolation, a lost grant blocking runs and
inventory, the owner leaving or changing role, the migration of existing
rows, and deleting (who may archive, list/inventory/start exclusion, a running
run stopping while its provenance stays, the `archived_at` migration).
`tests/process-design-capabilities.node.ts` covers `budgetReady`.

## Definition version 1

`packages/protocol/service-processes.ts` defines the portable, strict
`agent-service-processes/1` metadata contract. Every process belongs to one
service, organization and workspace on this identity server. It has a name,
description, manual trigger, object input/output schemas and limits.

Two kinds are supported:

- An `agent` references a catalog tool-capable chat model, instructions,
  explicit `{serviceId, actionId}` capabilities and memory mode
  `none`, `conversation` or `saved`.
- A `workflow` describes a directed acyclic graph. `action` nodes reference
  current catalog actions; `agent` nodes declare their own inputs, outputs,
  model and capabilities. `branch` nodes choose between two successors using
  `exists` or scalar `equals`; `return` nodes bind the final output.

Bindings use typed input paths, preceding step output paths or scalar
literals. There is no executable code, remote schema reference, script,
template evaluator or arbitrary expression. Identifiers and object keys are
bounded ASCII names. Data schemas support strings, finite numbers/integers,
booleans, null, arrays and closed objects. Objects declare required fields;
schemas can add length, range, array-size and string/boolean enum constraints.

For example, this synthetic workflow reads one action result and returns it:

```json
{
  "schemaVersion": 1,
  "kind": "workflow",
  "name": "TEST lookup",
  "description": "Synthetic example",
  "trigger": "manual",
  "inputSchema": {
    "type": "object",
    "properties": { "name": { "type": "string" } },
    "required": ["name"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": { "result": { "type": "string" } },
    "required": ["result"],
    "additionalProperties": false
  },
  "limits": {
    "maxSteps": 2,
    "maxModelCalls": 0,
    "maxTokens": 1000,
    "maxCostMicros": 100000,
    "maxDurationMs": 30000
  },
  "entry": "lookup",
  "steps": [
    {
      "id": "lookup",
      "type": "action",
      "serviceId": "TEST-service-id",
      "actionId": "TEST-action-id",
      "input": { "name": { "source": "input", "path": ["name"] } },
      "outputSchema": {
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"],
        "additionalProperties": false
      },
      "next": "done"
    },
    {
      "id": "done",
      "type": "return",
      "output": {
        "result": { "source": "step", "stepId": "lookup", "path": ["value"] }
      }
    }
  ]
}
```

These IDs must be replaced with authorized catalog IDs. The fixture helper
`tests/helpers/service-process.ts` produces the same definition for isolated
tests. A declared action output schema is an expectation, not evidence of an
actual business result. The internal runner validates observed outputs and binds
them to authorized receipts before using them downstream.

## Validation and dependency pins

The validator is passive: it never discovers a service, calls a provider or
dispatches an action. It resolves existing resources in the authenticated
scope and checks enabled state, action policy, tool-model capabilities and
saved-memory plugin availability. An administrator's ability to configure a
service does not override its execution policy.

Graphs must have unique nodes, a valid entry, reachable successors and no
cycles or orphan nodes. A referenced output must come from a strict preceding
action/agent that executes on **every** path to its consumer. Required input
paths must be present according to their schemas. This prevents a branch from
reading the result of an action it skipped. Version 1 does not infer narrowed
types after an `exists` branch or support array-index paths or coalescing.

Static checks prove that bindings fit the destination schema, including
required fields, closed objects, constraints, bounded local refs, `anyOf` and
`allOf`. String `pattern` constraints can be proved for literals and finite
string enums through the existing bounded catalog matcher. Unconstrained string
patterns and unsupported constraints such as `oneOf` return
`binding_type_unproven` rather than silently weakening catalog validation.
`format` is annotation-only, matching the existing catalog validator. Actual
dispatch must still validate canonical arguments through CatalogController.

Feedback contains up to 20 `{code, path}` issues and never raw private values:

| Code                    | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `definition_invalid`    | Unsupported shape, field or duplicate capability                          |
| `limit_exceeded`        | Definition size, step/model-call count or configured cap exceeded         |
| `resource_unavailable`  | Referenced service/action/model/plugin is missing, disabled or unsuitable |
| `capability_denied`     | Current actor cannot use the service/action                               |
| `graph_invalid`         | Invalid entry, edge, cycle, duplicate or unreachable step                 |
| `binding_invalid`       | Missing required value, unavailable path or non-dominating output         |
| `binding_type_unproven` | Compatibility with the destination schema could not be established        |

Declared caps include steps, inference calls, tokens, USD millionths
(`maxCostMicros`) and elapsed milliseconds. Defaults are 64 steps, 32 model
calls, 100,000 tokens, $10 and ten minutes. The server may narrow these caps.
Definitions allow at most 64 graph nodes and 16 capabilities per agent, six
schema/path levels, 40 object fields, 5,000 traversed values, 24 raw nesting
levels and 64 KiB of traversed keys/string values. The HTTP body is separately
bounded. The runner enforces logical steps and its absolute deadline. Model
processes use the shared [usage ledger](inference-budget.md), narrowed to the
frozen token/cost caps, and a common model-call cap across all agent steps.
The registry remains passive; enforcement happens only in the trusted runner.

A frozen version pins resource revisions, the effective saved-memory plugin
configuration when used and the server cap policy. Canonical SHA-256 covers
the definition and manifest. Changed dependencies require a fresh version
and test. Current actor permissions are rechecked even when the stored
manifest has not changed. Source pins contain no credential values.

## Durable lifecycle

The SQLite registry separates these states:

1. A mutable draft has an optimistic revision. Saving a valid draft leaves
   its active version unchanged; changing its parent service is rejected.
2. Freezing appends an immutable definition/manifest/digest. A matching latest
   frozen artifact is reused. Reads cannot alter it; SQLite triggers reject
   version updates.
3. The trusted server test runner can append evidence for that exact digest.
   A pass requires success, rejection, missing input, failure, unknown and
   restart scenarios. Incomplete or failed reports do not pass. Reports are
   retry-safe and a conflicting test ID is rejected.
4. A trusted activation hook can switch to a tested, currently valid version,
   including a previous version for rollback. A run pin is immutable and
   retains the version selected at start, across draft edits, activation,
   rollback and restart.

These are **metadata hooks**, not a public test runner or activation API.
HTTP/model payloads cannot submit evidence, activate a version or start/resume
a custom run. The internal native runner obtains pins from the trusted
store rather than trusting a version supplied by a client. Starting and
resolving pins revalidate dependencies, permissions and the latest passing
test state; a failed retest revokes continuation. Run resolution is scoped to
the same organization/workspace/person. Historical reads remain passive.

Registry edits and `catalog.process_changed` audit entries commit together;
an audit failure rolls back the edit. Audit details identify draft saves,
version freezes, tests and activations with revisions/version numbers and
EN/CS labels. Definitions, instructions, inputs and secrets are not copied
into audit details. The tables are part of the normal identity backup;
organization/workspace deletion cascades through their versions and pins.

## Authenticated metadata API

All routes are under `/admin/api/identity/catalog/processes`, require the
existing account session and owner/admin workspace authority (members: only
their own personal processes, see [Personal processes](#personal-processes)), and use the
existing administration origin/CSRF boundary. An operator key or membership
alone does not grant management. Request bodies cannot override the actor.

| Request          | Input                                                                            | Result                                                     |
| ---------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| GET base         | `organizationId`, `workspaceId`, optional `after`                                | Up to 100 summaries and `nextAfter`                        |
| GET base         | Scope plus `id`, optional `version`                                              | Draft record or immutable version with current test status |
| POST `/validate` | Scope, `serviceId`, `definition`                                                 | `{valid, issues, sources}` without writes                  |
| POST `/command`  | Scope, `type: "saveDraft"`, optional `id`, `serviceId`, `revision`, `definition` | `{process}`                                                |
| POST `/command`  | Scope, `type: "freezeDraft"`, `id`, `revision`                                   | `{process, version}`                                       |

Use validation feedback to repair a proposal before saving it. Invalid
definitions return `process_definition_invalid` on save; stale revisions
return `process_conflict`. Commands for activation, testing or execution are
not accepted. There is no builder UI in this delivery, so no new UI story;
the only console additions are labels/rows in the existing audit detail.

## Internal native execution, October 3, 2026

`apps/server-agent/process-workflow.ts` compiles the frozen DAG into a real
Mastra Workflow. Every node has a native branch selecting an execution step
or a skipped path; native maps join their output before the next node. The
topological order supports split/merge graphs without a JavaScript expression
language or a second interpreter loop. Native schemas check the input, every
observed action result and the final output. Extra fields are rejected by the
declared closed schema, rather than silently projected away.

`createServiceProcessRuntime` is a trusted backend factory, **not an HTTP API**.
It resolves the authenticated actor, pins an active tested immutable version,
and binds a separate run namespace to server/org/workspace/user and the
canonical input digest. It shares `nativeCatalogOwner` with normal chat; there
is no new Mastra server, storage owner or dependency installation.

Action steps call the existing CatalogController, including canonical argument
validation, current policy, OAuth execution pins, approval policy, guarded
transport, audit and durable receipts. Stable operation IDs include the run and
node. Only successful typed results reach downstream nodes. Native suspension
records the exact node and operation; both the application journal and native
checkpoint must agree before accepting an approval. Rejection terminates the
process without a write. Resuming after a closed/reopened native store uses its
checkpoint and does not repeat earlier completed steps.

Every attach/step/dispatch/publish rechecks the version, current authority and
read-source TTL/OAuth pins. Successful write results also retain their execution
pin. Step charges and an absolute duration deadline persist through waiting,
restart and retry; skipped native gates and resumed approval steps do not spend
another logical step. The current deadline includes human waiting time. Process
inputs are limited to 64 KiB of UTF-8 JSON. Catalog result limits still apply.

An invalid output can fail the process even when its business action succeeded;
the successful receipt stays successful. Failed/rejected/unknown processes
replay passively. An uncertain business receipt wins over an unfinished parent
checkpoint and blocks further execution. A native checkpoint interrupted while
active is **not automatically restarted**: explicit reconciliation is covered by
the test/activation lifecycle. Identity and native databases do not share an atomic transaction, so
this is not a general exactly-once guarantee or multi-process lease.

The server persists bounded operational trace metadata as `service-process-1`
turns. Existing scoped Loops reads them and joins action details through this
run's actual receipts. Raw prompts, hidden reasoning and arguments are not trace
metadata; the existing authorized action-detail view can show bounded business
inputs/results from its receipts. Passive inspection does not execute a process.

### Native agent steps and memory

Standalone `agent` definitions compile to one native agent step and a typed
return. Embedded `agent` steps use the same existing native Agent, tools,
processors and durable execution as chat, inside the parent Workflow. The
compiler identity is `niaro-native-workflow/2` for model processes; action-only
definitions keep `/1`, so their existing suspended checkpoints still resolve.
There is no generated JavaScript or extra interpreter/model loop.

Each agent step has a server-owned child run ID and a separate thread, derived
from the root, scoped resource and node. Its bound input digest and typed output
are durable. Only declared catalog capabilities become tools; there is no global
discovery or additional memory-write capability. Native tool IDs bind parent
receipts and Loops to the actual call. An approval must match the parent node,
operation and child native tool checkpoint. After resume, the first model step
loads freshly authorized receipt data, including the action just confirmed.
Tool arguments and old private transcript copies do not substitute for that data.

- `none` disables conversation recall/storage in Mastra Memory. Durable
  execution checkpoints still retain executable data needed for approval/resume.
- `conversation` uses native Memory for that scoped child thread, not a shared
  transcript between agent steps or separate process runs.
- `saved` adds read-only context from the trusted, actor-scoped Niaro memory
  runtime supplied by the backend factory. The existing plugin must be enabled
  and pinned. The process does not automatically remember, revise or forget.
  The domain journal stores generation and cumulative provenance/expiry pins,
  not retrieved memory text. Native executable checkpoints remain private server
  data; this feature is not a new retention or global erasure policy.

Saved memory is revalidated before attach, model/tool dispatch and final publish.
Forget, opt-out, source revocation or expiry blocks continuation before native
hydration; a changed generation requires a new run rather than replaying stale
context. Inputs, service results and memory are data, never approval authority.
A typed derived result does not prove that a business write happened: failed,
rejected or uncertain action receipts stop the agent before another model can
invent a successful outcome.

### One frozen budget for the process

Model processes require an explicit **enforce** policy and pricing pins for every
referenced model/provider before any graph step can execute. Missing configuration
returns `process_budget_policy_required` or `catalog_budget_price_required`;
the runner does not silently configure pricing or weaken the frozen limits.
All children reserve and settle against the **parent root ledger**, using the
minimum of workspace and process token/cost caps. The immutable policy digest
also includes process caps. Child changes, restart and retry cannot reset it.
Every attempted inference, including a cancelled reservation, counts toward the
shared model-call cap. Skipped graph nodes consume no inference.

Logical charges include visited graph nodes, model dispatches and distinct native
tool calls. Exact approval resume reuses its tool charge; synthetic standalone
return/gates do not add charges. The absolute deadline still includes waiting.
Unknown usage/overrun blocks further inference and new actions; known business
receipts stay intact. Budget guard failures preserve specific diagnostic codes.
Declining approval and reading a completed result remain available after a budget
policy change, with normal scope and business authorization still required.

The [native Tasks and explicit goal return](native-tasks.md) foundation is
implemented. The internal compiler acceptance is complete. Designer and test/activation controls are described below.
Proved native crash recovery below admits an explicit retry of a proved native parent checkpoint;
boot and metadata reads never restart it. Services rework, mobile entry points
and migration are covered in later sections.

The native API choice follows the pinned installed declarations and official
[control flow](https://mastra.ai/docs/workflows/control-flow) and
[suspend/resume](https://mastra.ai/docs/workflows/suspend-and-resume) docs.
Agent steps reuse the public [durable Agent](https://mastra.ai/docs/harness/durable-agents)
API and the installed pinned declarations.

## Conversational proposal foundation

The separate `agent-process-design/1` contract keeps configuration work outside
the executable registry. `ProcessDesignStore` is synchronous and belongs inside
the identity queue; every call receives the currently authenticated owner/admin
actor. Sessions are creator-private and fixed to an existing service and scope.
Its constructor creates proposal/command tables, but the identity service does
not yet instantiate it or expose designer HTTP routes.

A proposal holds a brief, unresolved questions, named assumptions and either a
structurally typed candidate or `null`. An incomplete briefing and semantically
invalid candidate can survive a database reopen without becoming an executable
draft. Structurally malformed updates fail before committing a revision. Model
updates cannot supply actor, baseline, human acknowledgment, confirmation choice
or accepted-process identity. Native tool adapters must derive their durable
command identity from the exact run/call pair, rather than letting the model
choose request identities.

An edit captures a fixed comparison baseline and registry revision. A selected
frozen version is a comparison baseline; the current draft remains the initial
candidate. Definition changes use stable workflow step IDs and bounded previews.
Authoritative baseline/current dependency manifests provide separate resource
revision changes; absent validation/source history is explicitly `unavailable`,
never fabricated as removed dependencies or known prior approval policy.

Human acknowledgment binds the exact assumption ID/text digest. Editing an
assumption invalidates its acknowledgment. Confirmation expectations are a
separate human command: `catalog` preserves the current catalog policy,
`every_write` requires every referenced write to already use `always` approval,
and unsupported `grouped` approval blocks acceptance. Instructions cannot lower
catalog policy or create a stronger enforcement guarantee. Questions and
unacknowledged assumptions also block saving.

`designCapabilities` projects local configuration through an explicit allowlist,
including IDs/revisions, descriptions, effect, approval and schema. Owners/admins
still pass `catalog.allowed` for every action. Model entries use actual usable
tool-model/provider revisions; no URL, binding, header, credential, schema
example/default or annotation is returned. Schema projection preserves supported
constraints and local refs through the existing catalog validator. Unsupported,
oversized or credential-named schema fields yield a whole-schema unavailable
reason. Such referenced schemas block acceptance even when a generic agent's
registry validation would otherwise pass. `configured` is configuration and
permission, not proof of connection readiness or a successful dispatch.

Pages share a complete-snapshot fingerprint and reject stale cursors. Passive
proposal validation uses a one-pass capability index, the registry's exact
effective limits and existing validator. Reads refresh current validity; they
perform no discovery, action authorization/personal-token retrieval, inference,
saved-memory retrieval or business dispatch. Catalog text and proposed
instructions remain untrusted input for the future native adapter.

Acceptance requires explicit human action, current proposal revision and the
exact server-calculated review digest, including current capability revisions.
The registry CAS catches another administrator's draft edit. Draft, normal
registry audit, terminal design state and immutable metadata receipt share nested
SQLite savepoints. An audit failure rolls everything back. Replay returns the
original receipt without saving twice; fresh reads separately refresh validation.
Acceptance changes only the draft, preserving frozen/active versions. It cannot
freeze, test, activate or run a process. An accepted design session is terminal;
further edits start a new session against the saved process.

Content ingestion is bounded to 6,000 visited values, 24 levels and 64 KiB of
keys/strings. It rejects recognized bearer/basic/API-key/private-key/URL-userinfo
patterns and static credential-named literals before proposal persistence.
This is not detection of arbitrary credentials pasted as ordinary text. Keep
credentials in existing server configuration; do not paste them into the future
designer conversation or definitions. Current and frozen baseline content pass
the same ingestion guard. Native text ingestion, transcript protection,
multi-turn structured context, budget settlement and authenticated request
reauthorization still need their designer adapter tests.

## Verification and next step

```sh
npm run test:processes
npm run test:process-design
node node_modules/typescript/bin/tsc --noEmit
node --import tsx scripts/build-admin.mjs
```

Tests use synthetic catalogs/providers, a real authenticated loopback HTTP
server and temporary SQLite files. They cover typed bindings, branches,
invalid graphs, scopes, source revocation, default changes, atomic audit,
immutable versions, activation gates, failed retests, rollback and restart.
The metadata HTTP test asserts zero external transport calls. The internal
runner tests use actual Mastra storage/workflows plus synthetic transport,
including branches, restart/resume, rejection, unknown writes, output mismatch,
source/actor revocation, concurrent retry, version pins and persisted deadlines.
`tests/service-process-agent.node.ts` adds actual native Agent/Memory tests,
shared child budget limits, fresh receipt projection after approval, read-only
saved memory and forget/opt-out, revocation, exact diagnostics and scoped Loops.
Real SIGKILL cuts after a synthetic model or service response but before its
authoritative commit. Two restarts retain the unknown usage hold or uncertain
write, without model resend or duplicate dispatch. An unproved active parent
checkpoint fails with `process_checkpoint_interrupted`; the response-gap tests
prove refusal to repeat. Proved native crash recovery below separately proves known-boundary recovery. The earlier action-only gap test
is still a simulation, alongside the existing generic native crash regression.
Neither live-model quality nor physical mobile execution is measured here.
Proposal tests use isolated SQLite/catalog/plugin/audit stores and cover reopen,
creator privacy, revisions/idempotency, human acknowledgment, confirmation
semantics, resource revocation, schema uncertainty, stable definition/dependency
diffs, fixed version comparisons, credential ingestion, active-version preservation
and accepted-receipt replay after restart. They assert no business invocations,
inference, new activation or automatic registry mutation from proposal updates.

The next step was to connect this proposal foundation to the existing native
Agent/Memory owner, shared session budget and isolated administrative tools, then
authenticated HTTP and the EN/CS conversation/proposal UI. Real isolated tests and
activation, the service menu and mobile entry points follow below.

## Native design conversation

The internal conversational domain adapter for the designer:
`ProcessDesignConversation` uses the existing `nativeCatalogOwner`, durable
Mastra Agent and guarded model transport, without native conversation Memory. It does not
implement a second inference loop or generate executable TypeScript. Its
strict turn commands and passive turn DTOs extend `agent-process-design/1`;
the mobile protocol remains unchanged.

The trusted caller supplies a freshly authenticated CatalogContext and an
AbortSignal. Each actor lookup verifies owner/admin role and the original
proposal creator. Request binding, identity, parent service, designer model
and provider pins, budget policy and turn state are rechecked at model
preparation, dispatch, tool mutation and final publication. The designer
model is selected by the human and pinned for the whole session, separately
from any model references in the proposed executable process.

Only five model tools exist:

- `design_list_capabilities` reads the authorized local inventory in pages.
- `design_get_capability` requests the exact permitted action schema/policy.
- `design_read_proposal` reads the current structured proposal.
- `design_update_proposal` replaces the model-editable brief/candidate using
  the current optimistic revision.
- `design_validate_proposal` validates passively.

Their arguments cannot specify scope, actor, session, request identity,
acknowledgments, acceptance, testing or activation. They cannot call business
or discovery services, even for reads, or access personal saved memory.
Tool outputs contain compact receipts. Each subsequent model step receives
freshly authorized proposal/capability/schema context. The run uses native
memory mode `none`: execution checkpoints stay durable, but no prior turn is
recalled from native Memory. The domain's journal projection is the only
history, including clarification text, in bounded context: the latest 12
prior turns up to 16 KiB. Each user message therefore reaches the model once. Original submitted text and completed replies remain
in the private durable journal; failed/interrupted candidates are not replies.
The existing ingestion guard rejects known credential patterns and excessive
content, but cannot recognize every arbitrary secret pasted in ordinary text.

Native thread/resource and budget root IDs are server-derived from server,
organization, workspace, creator and proposal session. Every new turn gets its
own server-derived run ID bound to its exact command digest. All turns and
native repair attempts share one root ledger and its pinned policy. Designer
caps default to 32 model calls, 1,000,000 tokens and 10,000,000 USD millionths
($10), narrowed by workspace policy; at most 64 turns and 24 tool receipts per
turn. These caps are separate from candidate execution limits and are not
model-editable. **Enforced budget mode and matching model/provider pricing
are required before a conversation starts.** Observe-only workspace defaults
therefore require explicit human setup. An unknown-usage attempt keeps its
full reservation, so later turns continue only within the remaining caps;
policy/model revision changes and exhausted limits cannot be bypassed by retry
or another turn in the same session.

The identity queue protects short authorization/journal operations and is
released during inference. One active native tail per session is allowed.
A proposal edit, its idempotent proposal command and the native tool receipt
commit in one SQLite savepoint. A repeated native call with matching canonical
arguments returns its existing receipt; changed arguments conflict. Same-command
replay and passive get/list never execute inference or tools again.

A final assistant reply is staged privately with the exact current review
digest. Completion is published only after actual native retirement and
settlement proof and fresh authorization. Concurrent proposal/dependency changes
reject the staged reply instead of presenting it as current. Known failure or
interruption preserves submitted text and committed proposal edits and exposes
a safe diagnostic code rather than provider error text.

Construct the adapter **once after acquiring the identity process lock**.
On a genuine owner restart, orphaned running turns become interrupted and their
old run IDs remain non-attachable: no automatic native execute/recover/resend.
An exactly staged candidate may be passively promoted only with native retirement
proof and an unchanged, currently authorized review. A surviving checkpoint
keeps the candidate hidden. Explicit new work after restart retains the same
root ledger and respects unknown holds. Within a live process, an unretired
native tail blocks another turn until passive proof succeeds.

`pnpm test:process-design` runs isolated proposal/capability tests and actual
native Agent/Memory conversation tests with a synthetic provider, including
five real SIGKILL cuts: before native start, proposal/receipt commit before native
acknowledgment, provider response before usage settlement, staged reply before
native retirement, and retirement before domain publication. Each cut is replayed
after two restarts without new model calls or proposal revisions. This does not
prove live-model design quality or physical Android acceptance. The designer HTTP section below adds
actual local HTTP tests using account sessions and the same native adapter.
The EN/CS designer UI, test/activation, Services menu, mobile
process execution and migration are covered in later sections.

## Authenticated designer HTTP

The designer exposes the following routes below
`/admin/api/identity/catalog/processes/design`. All replies include the
`agent-process-design/1` profile. Use an authenticated owner/admin account
with current workspace access; operator-key sessions and members are denied.
Proposals and conversations are private to their original creator, including
between administrators. Every query/body explicitly identifies organization
and workspace; strict schemas reject model-supplied actor or authority fields.

| Method | Suffix          | Strict contract and reply                                                  |
| ------ | --------------- | -------------------------------------------------------------------------- |
| GET    | `/capabilities` | Catalog target plus optional `after`; safe capability page                 |
| GET    | (base path)     | `DesignRead`; fresh proposal review                                        |
| POST   | `/start`        | `DesignStart`; immutable receipt and fresh review                          |
| POST   | `/update`       | `DesignUpdate`; immutable receipt and fresh review                         |
| POST   | `/acknowledge`  | `DesignAcknowledge`; exact assumption digests, receipt and review          |
| POST   | `/accept`       | `DesignAccept`; exact review digest, inactive draft receipt and review     |
| POST   | `/turns`        | `DesignTurnStart`; recorded running, completed, failed or interrupted turn |
| GET    | `/turns`        | `DesignTurnRead`; passive exact turn, including running state              |
| GET    | `/turns/list`   | `DesignRead`; passive ordered turn history                                 |

The protocol schemas in `packages/protocol/process-design.ts` define the
fields and bounds. Turn start requires a unique human `requestId`, current
proposal `revision`, selected tool-capable `modelId`, nonblank `text` and
optional `language` (`en` default or `cs`). Preserve that exact command to
check a lost reply. A same-command POST returns its recorded state; changed
contents under the same command identity conflict. A different turn cannot
start while the previous native tail is unretired. GET/list perform passive
proof and fresh authorization; they never recover or resend native work.

Every recorded turn also returns `model: {id, revision, providerId,
providerRevision}` from its original server-owned conversation binding.
This is the human-selected designer model, separately from candidate execution
models. Historical failed/interrupted replies retain that original selection
even when the current catalog changes. Earlier persisted turn rows need no
migration: projection reads the original binding, not per-turn JSON or current
catalog selection. The public DTO omits creator, budget caps, root/thread/resource
IDs and private staged replies. Rebuild/restart the bundled server and client
together when adopting this required designer response field; the mobile
profile is unchanged.

The shared strict capability schemas live in the protocol package. The web
client's capability reader loads a complete snapshot before exposing it,
merges service actions split across flat pages and includes later model pages.
Scope, fingerprint, completion and cursor progress must agree; a changed
snapshot restarts once from an empty inventory. Only metadata GETs occur.
Designer turn POST has a 125-second client timeout, just beyond the two-minute
server deadline; ordinary passive catalog reads retain their 50-second timeout.

Existing admin Host, Origin, Fetch-Site and JSON admission checks apply.
POST uses exact same-origin `Origin`, `X-Agent-Admin: 1` and
`Content-Type: application/json`, with a 128 KiB body bound. The server
privately pins the original request method, URL, relevant headers and account
user/session. Each native boundary reauthenticates the same account session
and rechecks workspace membership, creator, model/provider, budget and
proposal state. Sign-out, changed headers or revoked authority cannot rebind
the creator or publish a reply. Raw request headers are not journaled.

Turn inference runs outside the identity queue, so polling and authorization
changes remain responsive. The request has a two-minute deadline and an
abort signal shared with native/model dispatch. A disconnected response,
including one already closed when its body ends, cannot admit new inference.
Shutdown closes admission, aborts tracked requests, waits for their native
cleanup and short queue operations, then closes native storage and identity
SQLite. Terminal cleanup retains submitted text and safe failure/interruption
codes with the server-bound creator even after publication authority is lost.
Candidate replies remain private. Interruption preserves committed proposal
edits; it does not undo them or acknowledge/accept the proposal.

IdentityService constructs the proposal store after obtaining its process
lock and attaches the conversation adapter once using the stable workflow
server ID. Backend restart loads these routes. The console below exposes draft
design and acceptance; there is no designer test, activation, run or resume endpoint.

### Designer console

The console adds `/admin/services/:serviceId/processes/design` with validated
`sessionId` or `processId`/`baselineVersion` search parameters. Services has a
Processes tab using the real paginated registry. Designing a change starts
from the current draft unless a baseline version is explicitly selected.
Active version remains separate from the saved draft. Only account owner/admin
management controls appear; authorization is rechecked server-side.

The EN/CS view pairs conversation with structured brief, candidate steps,
branches, return bindings, execution model, memory, action effect/approval,
schemas and limits. Definitions and technical metadata disclose progressively.
Server diff, truncated changes, missing dependency history, validation paths
and blockers remain visible. Capability links point to actual service/provider
routes. Configured capability metadata makes no connection/readiness claim.

`ProcessDesignClient` persists one immutable pending command before dispatch
in versioned `sessionStorage`, scoped by local login generation, account,
expiry, role, organization, workspace, service and proposal. Pending starts
also bind their exact process/version route. The local Processes list retains
only known conversation IDs; their private history requires fresh reads.
Source refresh reads capabilities, proposal and full ordered history and
checks scope, unique request/turn IDs, original model pins, fingerprint and
proposal revision. A raced snapshot is retried once as GETs. Lost turn replies
also use the exact passive reader. Running/unknown work gates new commands;
failed/interrupted work still refreshes committed proposal edits.

Reload, shell Refresh and bounded polling never POST. Human retry replays the
same validated body after passive recovery; it cannot substitute model,
language, revision, text or review digest. A lost start has no known session
to read and needs explicit exact replay. Lost ACK/accept receipts likewise
retain their command. Definitively rejected messages remain visible and
persist independently of a newly typed composer. Corrupt recovery bytes are
preserved and block writing/dispatch. Storage failures prevent dispatch.

Human assumption ACK sends the displayed exact digests and review revision.
The save dialog captures the displayed review digest and closes on any source
change. Acceptance only saves a valid, unblocked draft; it cannot test,
activate or execute a process. Existing active version is unaffected.
Logout/expiry/session broadcasts unmount private views, abort owned requests,
purge local recovery and rotate local authority even when cleanup fails.
Revoked reads hide review/history/composer immediately. Late responses and
React StrictMode remounts are fenced by controller lifecycle generations.

QA uses `tests/admin-design-fixtures.ts` as a synthetic DOM fixture instead
of mobile Storybook: the admin console uses DOM/Radix, not the RN component
runtime. Installed Playwright was used because Browser plugin was unavailable.
Four EN/CS desktop/360px/dark/reduced-motion runs prove passive mount,
Markdown escaping/no remote images, exact ACK/accept, stale dialog invalidation
and actual Services/Processes navigation; zero runtime/console errors or
horizontal overflow. A separate rendered flow proves explicit start and
model selection, Enter without sending, lost reply, passive reload,
interrupted/rejected text persistence and account revocation. Only three
explicit POSTs occur; resource errors are intentional transport/409/403
fixture failures, and unrelated endpoints have complete fixture responses. Runners/screenshots are temporary `/tmp/niaro65-designer-*`.
Eleven meaningful recovery tests are included in `pnpm test:process-design`.
Full server regression passed760/760, and final designer regression80/80
after storage hardening. Clean-context plan and independent read-only review
closed with11/11 independently executed client tests and no blocking findings.
No live-provider, business, audio or physical Android acceptance is implied.

Direct designer URLs also have an anchored server SPA allowlist entry, with
an optional trailing slash. Actual loopback tests prove200 HTML for
session/process links and401 without HTML for deeper unknown paths and the
protected designer API. The app-login suite passes8/8; the final full server
regression passes760/760. This closes the reload gap that intercepted browser
fixtures cannot exercise. Independent source review covered the narrow HTTP
follow-up; its separate loopback attempt was sandbox-blocked rather than
reported as a passing run.

## Isolated compiler contract tests

The internal test store is the first part of the test/activation lifecycle. It is not exposed through HTTP,
the designer, or model tools. `createProcessTesting` reserves a creator-private
job before work and resolves an inactive frozen version through `testArtifact`;
it never activates the process or creates a production run pin. The strict
`agent-process-contract-tests/1` schemas bound JSON, scenario IDs, ordered
fixtures, expected outcomes and exact failure reasons. The same bounded
credential-pattern ingestion guard used by proposals precedes persistence.

The existing process compiler and native workflow executor run over a real
Mastra Dataset/Experiment in separate temporary LibSQL stores. The pinned
dataset contains the exact submitted suite. A closed action/agent boundary
requires the expected node, kind and bound input, serves a static output or
explicit failure/unknown, and refuses missing or extra fixtures. It cannot
access catalog credentials, live transports, providers or production Memory.
Mastra experiment mocks alone are not a sandbox; custom tasks enforce their
own closed boundary, with no retries or implicit live fallback.

Reports separate observed outcomes from assertion verdicts. Expected failure
must match its exact code; infrastructure faults never count as a passing
failure scenario. Input validation happens before boundary dispatch. Synthetic
approval rejection dispatches nothing. Suspension can close and reopen the
native workflow store before resuming, or a completed native result can be
read again without a second dispatch. Missing/unconsumed fixtures, wrong output
and an unexercised reopen fail. These are **compiler contract tests**: static
agent output does not test real Agent reasoning, business policy or transport
reliability. Reopen is an actual storage reopen, not a SIGKILL crash test.

Each private journal record retains the original suite, frozen version,
artifact/source/suite digests, compiler, runner and installed core/libsql/Zod
versions, copied observations and safe audit events. Native persisted experiment
and result identities/input/ground truth/output are checked before copying.
Temporary native stores are then removed; dataset/experiment/run IDs are
execution provenance, not remotely inspectable retained records. Report and
audit commit together. Terminal reports are immutable, new tests have their
own IDs, and one running test per process prevents overlapping reservations.
Exact command replay and private historical reads do not execute tests again.
Current source and creator authority are rechecked before native boundaries
and report publication. Revocation retains an interrupted job without a
private staged report; historical reports remain creator-readable under current
workspace management authority after dependency edits.

Construct `ProcessTestingStore` once after acquiring the identity owner lock.
Its constructor marks orphaned running reservations interrupted, without
attaching or repeating a native run. The live IdentityService does not yet
instantiate this internal test store; that lifecycle/API integration came
later. Reports always have `activationEligible: false` and never call
`recordTest`, change registry `testStatus` or alter `activeVersion`.

```sh
pnpm test:process-contract
pnpm test:identity
```

Twelve executed regressions cover actual native cases/reopen, closed fixtures,
failure-oracle integrity, static agent scope, creator privacy, immutable replay,
audit rollback, two journal reopens, source/actor revocation and retained
retest history. Clean-context independent plan and review also executed12/12.
The complete server regression passed772/772 across62 files. The final schema
consistency hardening additionally passed the same12 tests. No new physical,
live-provider or business acceptance was performed. Still open at this stage:
actual native Agent/domain adapters, generic-loop comparison, crash
reconciliation and explicit authenticated test/activation/rollback with UI.

## Isolated native Agent comparison

An internal `runProcessNativeComparison` runner supports the test lifecycle.
It uses the existing process runtime, native Mastra Agent/Workflow owner,
CatalogController, approval/resume logic and inference ledger. A closed test
resolver pins the exact inactive frozen artifact only in a detached catalog;
it never calls production `recordTest` or `activate`. The live IdentityService
does not instantiate this runner or expose it through HTTP or model tools.

The separate `agent-process-native-tests/1` report is qualified
`native_scripted`, with `activationEligible: false`. Unlike the internal test store's static
Agent boundary, this runner actually executes the native Agent and its tools.
Its model responses and token usage are explicitly scripted. This proves
runtime/domain behavior on the declared cases, not live LLM quality, latency,
production readiness or permission to activate a process.

`ServiceCatalogStore.processTestCatalog` reads the exact source revisions and
an explicitly selected baseline model without calling credential-capable
provider/model/inventory getters. The strict descriptor contains action
schemas/bindings, effects, approval policies, current actor roles, model
metadata and enforced workspace budget settings. It excludes real endpoints,
credentials and auth configuration. Both strategies use synthetic endpoints,
no service auth, empty read-only saved memory, disabled optional plugins and
disabled generic decision inference. These substitutions are stamped in the
report. The trusted caller must continue checking current actor/source
authority; a single failed check retires the entire experiment and blocks
publication even if a later callback would allow it.

One pinned Mastra Dataset version contains the bounded declarative suite and
its independent expected outcomes. Separate configured/generic Experiments
run sequentially with no retries, no scorer inference and no live fallback.
The generic strategy uses the actual Niaro catalog loop, including discovery
before exposing an action; it is not a replacement planner. Every case has its
own detached catalog, native stores, receipts, approvals and budget ledger.
Before report copy, persisted native rows must match the experiment summary,
dataset item/version, input, ground truth and output. The temporary stores are
removed afterward; IDs are execution provenance, not retained inspectable runs.

The suite allows at most 16 cases, 32 model steps and 32 action fixtures per
strategy/case. JSON ingestion also bounds total size/depth and rejects unsafe
keys, non-JSON values and recognized credential patterns. A model step declares
the selected model, required available tools, one text/tool-call response and
token usage. Ordered business fixtures declare exact service/action/input,
approval decision and response/failure/unknown. The closed transport checks
actual domain receipts before guarded dispatch, checks MCP tool arguments and
HTTP methods, mocks only supported MCP control traffic and refuses every
unconfigured request. It never invokes the network transport.

Each observation records model calls, business dispatches, actual approval
decisions, storage reopen, budget accounting and the ordered canonical receipt
ledger (IDs/revisions/input/effect/status/result/failure/dispatch count). The
oracle compares that entire ledger, typed output, outcome and the precise
failure code for each strategy. Matching reply text cannot hide a missing or
extra action, fake approval, remaining suspension, unconsumed fixture or
infrastructure fault. Generic native terminal failure causes are taken from
stored state; an exhausted native budget cannot masquerade as malformed output.
A successful write receipt stays succeeded when its later derived output fails.
An unknown write remains unknown and is never automatically resubmitted.

Reports distinguish frozen `declaredLimits` from `effectiveBudgetLimits`:
each case is capped at the lesser of the artifact deadline and 30 seconds,
token/cost caps are narrowed to workspace policy, and all process Agent nodes
share the frozen root model-call cap. The report also stamps the native Agent
12-step ceiling per invocation and the generic domain's independent safety
ceilings. Scripted usage is accounted by the actual tariff ledger; it is not a
measurement of a provider's invoice.

Terminal commands are replayed without new model or action dispatch. Restart
cases exercise either completed storage close/reopen or native suspension,
approval close/reopen/resume. These are real storage reopens, not SIGKILL or
concurrent-owner crash qualification. A passing subset does not imply coverage
of every required scenario. The six scenario families and false-pass guards
are covered by the executed regression suite:

```sh
pnpm test:process-native
pnpm test:processes
pnpm test:identity
```

Durable native reservations/reports are added below. The lifecycle still needs
authenticated test controls, exact-version activation/rollback and crash
reconciliation. The generic comparison presently compares controlled runtime
outcomes and model-call counts on the same declared cases; it cannot establish
that a live specialized agent chooses better actions than the general loop.

Nineteen native regressions passed, and the complete server suite passed
791/791 across 63 files, including the admin build. TypeScript, targeted
ESLint, formatting, import boundaries and diff checks passed. Independent
clean-context planning and skeptical review verified the false-pass fixes
and adjacent runtime regressions without remaining blockers. The existing
admin bundle-size warning remains. No live-provider, business or physical
acceptance was performed in this batch.

## Durable native test journal

Durable native testing connects `runProcessNativeComparison` to the existing
`ProcessTestingStore` through the internal `createProcessNativeTesting` adapter.
Both compiler-contract and native profiles share the same private command
namespace, SQLite journal, savepoints, terminal immutability trigger and one
running reservation per process. They keep distinct typed requests and reports;
using a report ID with the other profile returns `process_test_not_found`.

A native request explicitly selects `agent-process-native-tests/1`, an inactive
frozen process version, its digest/current revision, an idempotency request ID
and a bounded declarative suite. It cannot supply a source/catalog snapshot.
The server derives and retains the safe catalog, exact artifact/source/catalog/
suite/compiler/runtime/runner stamps, actor epoch and execution settings before
any inference. The generic baseline's model/provider and the enforced budget
policy revision, settings and prices are pinned alongside artifact dependencies.
A policy change followed by a return to the same settings still invalidates the
running test.

Current management authority, creator and version scope precede every private
read or replay. Exact command replay reads the original running or terminal job
before resolving current sources or loading the runner. It therefore retains
historical results after configuration/runtime edits without another inference
or effect. Changed command content/profile conflicts; a new request ID is a new
retest and cannot replace an older report. Test-ID lookup also verifies the
server namespace. Process validation and baseline metadata reads do not invoke
credential-capable model/provider getters; live dispatch retains its ordinary
credential checks.

The actual detached native runner executes outside the identity queue. Short
serialized checks revalidate the same creator, current management authority,
epoch and all catalog/source/policy pins before native boundaries and final
publication. Report and safe native-test audit commit in one savepoint. The
journal checks exact stamps, execution settings and both strategy/case/scenario
sets. It independently compares observable outcome/output/codes, canonical
receipts, approvals, infrastructure and requested reopen against the stored
suite. Passing observations must consume the exact scripted model-call count
and match the usage totals and pinned per-call tariff, with no unknown usage or
overrun. Sequential reservation and settlement must also fit the frozen
token/cost/call caps (each scripted call is predicted to reserve its scripted
input, at least the 2,048-token floor and at most the price's input ceiling,
plus the full output ceiling, as the [ledger](inference-budget.md) reserves a
real request's own size); exact usage totals alone cannot prove an executable pass. A self-declared passing verdict or zeroed budget cannot bypass these
checks.

Revocation, source drift, cancellation and runner failure retire the reservation
as interrupted with no staged report. Construct the shared store once under the
identity owner lock: it atomically interrupts orphan reservations after restart,
without native attach, resume, inference or effect. Historical reads and repeated
reopens do not republish the result or change production process evidence,
`testStatus`, active version, invocation tables or Memory.

The native and compiler-contract qualifications remain
`activationEligible: false`. This batch adds no public test endpoint, UI controls
or IdentityService journal bootstrap. Those controls, qualified activation,
rollback and actual crash/concurrent-owner reconciliation remain later work.
Storage reopen is not SIGKILL qualification; scripted results do not establish
live model quality. No startup command, dependency, mobile rebuild or live model
or CRM test is required.

Run `pnpm test:process-native` for the existing 19 native comparison regressions
and 18 journal regressions. The latter use actual configured/generic native runs
and durable stores, including concurrent commands, both profile directions,
creator/server/scope admission, credential-getter spies, baseline/source/tariff/
policy ABA and epoch drift, cancellation, final publication, semantic/usage
forgeries, audit rollback, orphan recovery and immutable failed/successful retest
history. New audit event names have EN/CS labels; existing console layout and
interaction are unchanged, so this internal-only addition uses the existing
admin build and type checks instead of a new Storybook flow or browser acceptance.

Final verification for this batch: 18/18 journal regressions and the complete
809/809 server tests across 64 files, including the admin build after the last
cap guard. TypeScript, targeted ESLint, formatting, dependency boundaries and
diff checks passed. Clean-context planning and independent skeptical review
reproduced and closed semantic, usage and stamped-limit forgeries. The reviewer
ran the three focused files before the last small cap guard, then verified that
last guard with independent probes. No remaining concrete P2 was reported.
The existing bundle-size warning remains; live inference/business, new browser
or physical-device acceptance were not performed.

## Authenticated native test HTTP

The server instantiates one shared `ProcessTestingStore` in
`IdentityService.attachWorkflow(serverId)`, after the stable workflow server ID
is available and while the existing identity owner lock is held. Both internal
adapters share this journal. Attaching the same server again reuses it; attaching
a different server is rejected. Startup recovery is passive and does not attach
or drive a native test.

Only an owner/admin account session with current workspace access can use:

- `POST /admin/api/identity/catalog/processes/tests/native`: the strict existing
  `NativeTestRequestSchema`, including explicit `agent-process-native-tests/1`
  profile, original request ID, process ID/current revision, inactive frozen
  version/digest and bounded declarative suite. No query parameters are accepted.
  The response is `{job}`. A new request waits for the isolated comparison; an
  exact concurrent retry returns its existing running job immediately.
- `GET /admin/api/identity/catalog/processes/tests/native`: strict
  `organizationId`, `workspaceId`, `profile` and `testId`, returning `{job}`.
- `GET /admin/api/identity/catalog/processes/tests/native/list`: strict scope,
  `profile`, `processId`, optional positive safe-integer `version`, optional
  `after` test ID and `limit` from 1 to 20 (default 20). It returns
  `{organizationId, workspaceId, profile, summaries, nextAfter}`.

Unknown or duplicate query keys, including `__proto__`, are rejected. POST
cannot supply an actor/session, source/catalog snapshot, runtime settings,
report or executable code. Invalid JSON/oversized bodies are bounded by the
existing catalog reader (128 KiB and a 10-second body deadline). Compiler-contract
reports remain internal; they are not accepted as native requests or native
history. New native admission rejects the selected active version with
`process_test_active_version`; exact replay is checked before this guard and
before current source/runtime resolution.

Detail/history require the original creator's current management access.
Another admin sees an empty history for that process and cannot read its report.
SQLite filters creator, organization, workspace, native profile, process/version
and the exact server command namespace **before** keyset pagination. The
namespace predicate uses a deterministic digest function with the server ID as
an explicit argument; it does not rewrite immutable terminal JSON. Results sort
by test ID ascending. `after` must name a matching private native job in the same
process/version; inaccessible or mismatched cursors return `process_test_not_found`.
Summaries contain status, safe stamps, timestamps, failure and nullable comparison
counts, with no full report, stored suite or environment. To find a lost first
response, match the original `requestId` in this private process history.

All GETs, history, exact replay and repeated identity reopens are passive: no
comparison dispatch/source resolution, inference, native attach/resume, business
transport or new result audit. Existing source/model/runtime edits cannot rewrite
a historical report. A different command using the same request ID conflicts;
a different request while that process has a running test returns
`process_test_busy`. Native and compiler-contract profiles still share this hold.

The entire request retains its original account, session and relevant HTTP
headers. The server derives the exact domain actor fields instead of forwarding
membership IDs into strict process APIs. Fresh authority/request, epoch, source,
provider/baseline and tariff/policy checks precede each actual native boundary
and atomic publication. The detached configured/generic runner remains outside
the identity queue, so polling, revocation and sign-out can proceed while it runs.

The overall HTTP deadline is 120 seconds; each case retains its existing effective
30-second maximum. These are cancellation deadlines, not permission to close the
database before the native work has drained. The HTTP response returns an explicit
504 `process_test_timeout` after deadline retirement (a private `test_aborted`
job with no report). Disconnect/cancellation also retires the reservation without
publication. Shutdown rejects new admission, aborts tracked tests and awaits their
cleanup before closing SQLite and releasing the owner lock. Restart reads the
original immutable interrupted job and cannot restart its native work.

`pnpm test:process-native` includes six private history regressions and fifteen
actual loopback HTTP regressions, in addition to the previous comparison/journal
coverage. They use real account cookies, SQLite, native configured/generic runs
and isolated synthetic transports: success, two reopens, concurrent replay/busy,
strict admission, creator/server/profile pagination, header/session/role revocation,
source/provider/epoch and policy ABA, body-end disconnect, cancellation, deadline
and shutdown drain. Production credential getters are guarded and production
invocations, inference, process evidence/run pins and Memory remain unchanged.

All reports still say `native_scripted`, `activationEligible:false`. This adds
no test/activation UI, live-model quality acceptance, production effect, mobile
module/APK or SIGKILL/concurrent-owner qualification. Those remain later
work. No rendered flow changed, so existing admin build/type checks cover this
backend API addition; no new Storybook/browser acceptance is claimed.

Final verification: 830/830 server tests across 66 files, zero failures
or skips, including the admin build after strict-query hardening. TypeScript,
targeted ESLint with zero warnings, formatting, dependency boundaries and diff
checks passed. Independent clean-context planning/review reproduced and closed
the `__proto__` query admission gap; the reviewer separately reran the final
15 HTTP tests and verified rejection with zero dispatches. No remaining concrete
P1/P2 was reported. The existing admin bundle-size warning remains. Client tests,
new browser QA, live inference/business and physical-device acceptance were not
repeated in this backend-only batch.

## Server-derived native runtime qualification

A separate qualification record is added to newly completed native jobs.
The immutable native report continues to say `native_scripted` and
`activationEligible:false`. Qualification uses the named policy
`native-scripted-runtime/2`, the explicit scope `native_scripted_runtime` and
`liveAcceptance:false`. A `qualified` verdict is controlled runtime evidence;
it does not activate a process or establish live model quality.

The server derives the verdict from the originally stored frozen artifact,
bounded suite, safe catalog and actual configured/generic report. The request
cannot supply a verdict. The policy independently checks exact stamps and
source/capability/model bindings, declared and effective safety limits, typed
input/output, the ordered fixture/receipt ledger, approval decisions, known
usage and sequential tariff reservations. Comparisons require a passing
observation in both strategies with consumed model/action fixtures and no
infrastructure failure. An explicit `comparisonMode:"configured_only"` suite
is also supported for frozen workflows without agent nodes. It omits
`genericModelId`, generic scripts, generic questions and the generic experiment;
its report contains only configured observations and labels the absent
comparison. No model/provider configuration is needed for that mode. Agent
definitions still require the two-strategy comparison. Neither fewer model calls nor scripted latency is a
live quality claim.

Every applicable scenario family must be meaningfully exercised in the same suite:

- Success uses valid input, typed output and matching receipts.
- Rejection includes an actual approval rejection and a rejected receipt with
  zero dispatch for that action.
- Missing input demonstrates an absent required field and no model call,
  approval, receipt or dispatch.
- Failure identifies the declared adapter or typed-output failure with its
  precise safe domain code.
- Unknown includes an uncertain write receipt with one dispatch and no replay.
- Restart exercises the requested storage reopen and matching successful result
  without another model/action dispatch.

Coverage lists applicability, case IDs and safe reason codes in a deterministic
order. The server derives applicability from the exact frozen definition and
pinned action policies: success and storage reopen always apply; missing input
applies when the input schema declares a required field (including nested
fields); failure applies to actions or agents; rejection applies to an action
requiring approval; unknown applies to write capabilities. Every supplied case
must prove its asserted semantics, including supplied inapplicable scenarios.
A passing subset cannot omit an applicable hazard, and relabeling a case cannot
qualify it. Clients cannot submit applicability exemptions. For a literal-only
Return with no required input, the console can prepare success and completed
reopen checks using that exact literal output as the oracle.

Historical `/1` qualifications retain their original six-family shape and exact
digest. Reads, replays and activations do not upgrade them. New `/2` verdicts
include an explicit applicability boolean for every family.

The separate record binds the server namespace, organization/workspace,
original creator, test ID, process/version and all native stamps. Its report and
original environment digests cover the stored catalog, execution settings and
authority epoch; `qualificationDigest` covers all provenance and verdict fields.
The terminal report, qualification, completion audit and qualified/failed audit
publish in one SQLite savepoint. Any failure rolls them all back. The existing
terminal trigger makes the stored result immutable.

The existing authenticated detail response includes the full private record.
Private history includes only its bounded verdict/coverage and digest, without
full provenance, suite, catalog, environment or report. Exact replay and reads
return the original result after source edits and reopen, without current
qualification recomputation, inference, service transport or new audit.
Passive metadata/schema exports may load with the server; reads never execute
the native comparison or allocate its isolated runtime stores. Historical
terminal jobs without the optional record stay historical; reading
or replay never upgrades them. Interrupted jobs have no staged report or verdict.

This slice changes no production registry evidence, `testStatus`, active pointer,
run pins, Memory or native attachment. Active-version test admission is unchanged.
Next, an explicit human activation/rollback command must bind a reviewed exact
qualification and recheck current actor/session, sources, catalog, runtime,
compiler, policy and budget before a CAS pointer change. Latest failed or pending
qualifying retests must prevent stale-pass reuse, while other immutable run pins
remain independent. The test/activation UI and actual
SIGKILL/concurrent-owner reconciliation are separate work. Populated saved Memory, optional
plugins, real credentials/transport and live model quality remain unqualified.

`pnpm test:process-native` includes the actual six-family policy, semantic and
binding forgeries, atomic journal publication/audit rollback and passive
historical compatibility regressions. Fixtures use isolated native stores and
closed synthetic transports. EN/CS audit labels use the existing audit detail
renderer; no new rendered flow or Storybook/browser acceptance is claimed.

Final implementation verification: 31/31 named qualification tests (9 top-level)
and 863/863 server tests across 67 files, zero failures or skips, including the
admin build. TypeScript, scoped ESLint with zero warnings, formatting, layer
boundaries and diff checks passed. Independent clean planning/skepticism
reproduced and closed zero-inference Agent, unavailable-tool/discovery,
suspended-read reopen and repeated uncertain-write false qualifications.
The unchanged deterministic ranking is shared with generic execution, including
actual router and seven-action catalog regressions. Final independent review passed 72/72 qualification/journal/history/HTTP tests
with no remaining concrete P1/P2, and an additional eight-action native probe
passed. No browser, client/device or live-provider acceptance was added.

## Human activation and rollback

The account-only lifecycle uses the existing identity queue, process registry,
test journal and native executor. An explicit owner/admin decision can promote
the exact qualified native runtime evidence into trusted registry metadata and
switch the active pointer. The original report remains `activationEligible:false`;
its separate verdict remains `native_scripted_runtime` and `liveAcceptance:false`.
The administrator acknowledges `controlled_native_test_only`. The decision
does not run a model, service, Memory tool or native continuation and is never
an Agent/Domain tool.

All routes are under `/admin/api/identity/catalog/processes/activation` and use
profile `agent-process-activation/1` and the authenticated account's current
organization/workspace management authority:

- `GET /review` accepts `profile`, `organizationId`, `workspaceId`, `processId`,
  `version` and `testId`. It validates current readiness and returns the exact
  artifact/qualification digests, registry revision, active version, bounded
  coverage and whether activation or rollback is available. It does no mutation.
- `POST` accepts those scope fields plus `requestId`, `type` (`activate` or
  `rollback`), `processId`, `revision`, `expectedActiveVersion` (nullable),
  `version`, `artifactDigest`, `testId`, `qualificationDigest` and the literal
  `acknowledgement: "controlled_native_test_only"`. Actor, report, environment,
  outcome and unknown fields are rejected. Use a new request ID for a new
  human decision; keep the original payload for an explicit retry.
- `GET` accepts `profile`, `organizationId`, `workspaceId` and `requestId` and
  returns the original private receipt. Exact POST replay returns that same
  receipt before source/runtime resolution. Neither read nor replay switches
  the pointer again, reaudits or revalidates the old decision against new sources.

The request pins its original account/session and HTTP fingerprint, including
Content-Type. Operator-only, member, anonymous, revoked or changed sessions are
refused. A body-end disconnect admits no decision. Authentication is rechecked
inside the queue; freshness validation and the metadata savepoint are synchronous.
Receipt reads remain private to the decision creator with current management
authority. A second manager cannot read or promote another creator's report.

For a new decision, both registry revision and expected active version must
match. The native job must be completed, fully qualified, from this server and
the exact private creator/scope/process/version/artifact/test/digest. The server
rebuilds the original creator's safe catalog using their current membership,
then compares the complete source/catalog/compiler/runtime/runner stamp,
execution settings, baseline model/provider and budget revision and prices with
the saved environment. The organization-wide authority epoch stays in the stored
environment but is not compared: it also moves for unrelated people and
services, while the catalog already pins the creator's role, workspace roles
and every source, grant, model and provider revision the process uses. Draft edits require freezing and testing
the new version. Activation targets the latest frozen version whose definition
still matches the draft. Rollback may target an older version only if this server's
successful lifecycle history shows it was previously activated; it applies the
same current qualification and freshness checks.

Every new native reservation has a durable `INTEGER PRIMARY KEY AUTOINCREMENT`
admission ordinal inserted atomically with the job and start audit. Latest
evidence is ordered by this ordinal for server/org/workspace/process/version,
across all creators. UUID order, timestamps, completion order and implicit SQLite
row IDs are not used. For a new human decision, a later running, interrupted,
failed or passing-but-unqualified test supersedes the old accepted result. A
later qualified test requires a new human decision, including when the active
version number is unchanged. History
without an admission ordinal stays readable/replayable but needs a new explicit
test before promotion; no historical ordering is invented during migration.

Native testing of an active version remains refused by default. The explicit
native test request flag `retestActive: true` opts into an isolated retest with
the existing runner and limits. Exact old test replay still precedes this guard.
Reservation immediately supersedes old readiness for new decisions;
interruption or bootstrap retirement does not reveal the previous pass again.
Test start and completion never change the active pointer or the accepted
qualification binding, so the live version keeps serving while it is re-tested
until a person activates or rolls back again. Its own accepted job and durable
admission ordinal must still exist: a lost proof blocks fresh execution (an
error that reserves no start receipt) until the exact proof is restored.

Trusted test projection, persistent native qualification binding, pointer CAS,
immutable private receipt and safe activation/rollback audit commit together.
Audit or receipt insertion failure rolls all metadata back. Registry `testStatus`
records the accepted historical projection; use current activation review for
readiness. The persistent native lineage survives subsequent legacy trusted test
metadata, so an old-style passing fixture cannot erase the native gate.

New run pins, activation and resolution of existing pins check that native
binding passively. A native-bound version without an attached gate fails closed.
The gate validates the original qualification creator; the executor separately
enforces the actual run actor's current source/action permissions. A member
does not gain the creator's rights. Source, catalog, creator or runtime drift of
one version blocks its new effects (re-testing it does not), while activating or
rolling back another version never redirects its immutable run pins. Pointer changes do not increment organization authority
epochs and thereby invalidate unrelated qualified runs.

`pnpm test:process-activation` covers actual six-family qualification, private
receipt replay, exact CAS/digests, active retests, latest ordering across creators
and VACUUM/reopen, incomplete and failed retests, lineage preservation, current
authority/source/budget/runtime drift and atomic rollback. It also runs two actual
suspended native Agent executions: v1 activation, v2 activation, v1 rollback,
two store reopens and successful approvals on their original versions. Local
HTTP tests use real account/session boundaries and closed synthetic transports.
No live model/CRM effect, browser/device acceptance or SIGKILL proof is implied.

The console section below supplies test/activation controls, and proved native crash recovery supplies actual crash / concurrent-owner evidence. Services, mobile harness and
migration acceptance are separate. Saved Memory, optional plugins, actual connection readiness
and live model quality remain outside this controlled-runtime qualification.

Final verification: 17/17 lifecycle tests and 8/8 actual HTTP tests,
all included in 888/888 server tests across 69 files with zero failures or skips
and the admin build. TypeScript, scoped ESLint with zero warnings, formatting,
layer boundaries and diff checks passed. Independent clean planning and review
found no remaining concrete P1/P2; the reviewer separately passed six named
focused regressions and an additional synthetic creator/run-actor probe.

## Process test and lifecycle console

Open **Services → Processes → Tests and versions**, or follow **Tests and versions**
after accepting a designer proposal. The EN/CS route
`/admin/services/:serviceId/processes/:processId` presents the current draft,
immutable version selection, creator-private tests, both native strategies,
server qualification and the current human decision. Draft acceptance and page
navigation do not freeze, run or activate a process.

Freeze explicitly reviews the current registry revision. The new strict
`agent-process-versions/1` protocol has bounded descending version pages (20),
`POST /admin/api/identity/catalog/processes/versions/freeze`, and a creator-private
GET by original request ID at that same path. One minimal immutable command
receipt wraps the existing registry freeze operation. Registry revision/version,
freeze audit and receipt use one savepoint; receipt replay precedes source/CAS
checks. Original human session/fingerprint and identity queue remain authoritative.
The previous freeze command remains compatible.

The structured scenario editor has an explicit generic comparison model, up to
16 cases, editable typed input/output data, isolated action results, ordered
expected receipts and configured/generic scripted model replies. Model text and
JSON-array tool names preserve whitespace, order and arbitrary nested data;
editing incomplete fields does not send a command. Optional JSON import and an
explicit action to copy an old test's original suite supplement the field editor.
They do not replace it or silently change original model selections.

`GET /admin/api/identity/catalog/processes/tests/native/tools` projects the actual
shared runtime tool names for the selected version and explicit generic model.
Configured names remain local to each workflow agent node, including repeated
names with different action/model associations. Generic catalog action names are
candidates discovered by `find_actions`, not all initially exposed tools. This
metadata read resolves no credentials, runs no inference and creates no test job.
Do not infer tool availability or live readiness from a name in this inventory.

`GET /admin/api/identity/catalog/processes/tests/native/detail` requires an
explicit profile and exactly one original request ID or test ID. The original
`agent-process-native-tests/1` detail remains exactly `{job, request}`. The
console explicitly requests `agent-process-native-test-detail/2`, whose strict
envelope is `{profile, job, request, diagnostic}`. Its job and request still use
the unchanged `/1` execution profile; `diagnostic` is bounded or `null`. The new
detail profile is rejected on POST, list, read and tools endpoints. Missing,
duplicate or unknown query fields and two or zero selectors are rejected.
Neither detail includes the retained environment or catalog snapshot.
Historical detail remains readable when current activation eligibility is
blocked. Report groups distinguish expectation pass/failure,
simulated action outcomes, qualification coverage/reasons, current decision
eligibility and live acceptance. They expose ordered receipts, observed outputs,
assertions, infrastructure codes, budgets, limits and provenance on demand.
A passing rejected/unknown simulation never claims a successful business action.

An interrupted native test may now explain its first specific checkpoint,
infrastructure or persistence cause. This is private evidence beside the
existing test journal, not a terminal report or activation authority. The
runner captures validated scalar checkpoint facts and at most 32 canonical
receipt summaries before closing its isolated stores. Pending, running,
succeeded, failed, unknown and rejected receipt states retain their actual
meaning. Unavailable facts are omitted; no input, output, question, provider
error text or stack is copied into the diagnostic. Later validation or cleanup
errors cannot replace a captured primary cause. The evidence is attached only
to a `test_runner_failed` interrupted job after checking its original suite,
pinned environment and current authority; revocation, source changes and abort
discard it. Historical jobs without evidence return `diagnostic:null`.

The EN/CS report distinguishes an incomplete, unqualified test from a terminal
historical report. It presents the cause, a next step and supplied action states;
technical identifiers, codes and phase remain expandable. A successful write
is still shown as successful if a later question or result-persistence step
fails. A complete expected domain denial, invalid-output or unknown simulation
keeps its existing report and qualification semantics. Reading, refreshing,
reopening or replaying an original test request performs no new model call or
business effect. A new execution requires a new explicit test request; replay
of an interrupted original only returns its stored outcome.

The client persists one exact freeze/test/decision command before dispatch in
session storage scoped to login generation, account, organization, workspace,
service and process. Mount, polling, reload, pagination and response-loss recovery
perform GETs only. A missing request receipt is ordinary absence, not proof of
completion or permission loss. An unknown response retains the exact outbox;
only a human explicitly retries it. Definite rejection preserves the editor and
original rejected command, including a positively rejected busy admission.
Malformed/foreign stored bytes stay untouched and block sending; a storage-write
failure admits no command. Authority loss fences late reads/POST responses and
purges private data. Baseline changes invalidate tool inventory. Every paginated
summary binds the selected immutable artifact, and current review closes stale
confirmation dialogs. The native POST timeout is125 seconds for the server's
bounded120-second operation; catalog GETs keep their shorter timeout.

Activation, active-version retest/reacceptance and rollback review exact version,
artifact, test and qualification IDs, registry revision and previous active
version. A fresh human acknowledgement of `controlled_native_test_only` starts
false for every decision. The server retains its own freshness/latest-evidence
checks. A historical receipt is displayed separately from the current active
pointer; rereading or replaying it never restores its historical pointer.

`pnpm test:process-console` runs29 focused regressions (all included in normal
identity/process/native test commands):16 new API/store tests, one complete
actual HTTP lifecycle and12 client/suite tests. These cover both strategies for
all six families, freeze/activate v1 → freeze/activate v2 → rollback v1, explicit
active retest, private original recovery and receipts across two reopens, exact
response-loss replay, bad scope/ID/artifact/pagination, storage failure, authority
fencing, busy rejection and exact scenario roundtrips. The complete server suite
passed918/918 in76 files, zero failures/skips, with the admin build.

A public cutover check also exposed a missing HTTP shell allowlist for direct
console links/reload. The exact anchored process-ID route now serves only GET
HTML; nine actual login/HTTP checks cover direct/trailing-slash/query links and
private API, nested path, file, encoded slash and POST denial. The POST without
Origin is correctly rejected403 by the existing CSRF guard.

This is controlled runtime evidence: scripted model replies, isolated synthetic
action results, empty read-only saved Memory and disabled optional plugins.
It does not establish live provider/model/service quality or actual
SIGKILL/concurrent-owner recovery. Crash qualification is covered separately,
as are the overall Services rework, mobile execution and migration.

Rendered QA uses the installed Playwright runtime because the Browser plugin is
absent. The real built console communicates with an isolated reference-server
fixture using real owner account HTTP and durable native stores; model/action
responses are synthetic. EN1440×1000, CS360×844, CS dark1440×1000 and reduced-motion
1366×900 passed field authoring, multiline exact text, explicit freeze/test/ACK,
private reports and active-pointer checks, with zero unexpected console errors
and no document horizontal overflow. Desktop also passed real UI v2→v3 activation
and v2 rollback, with exactly seven explicit POSTs; the other modes made three.
Lost freeze/native/decision responses were recovered by passive reads/reload,
not automatic retry. A separate two-agent workflow exposed the same local tool
name mapped to both nodes/actions and made zero POSTs. Evidence screenshots and
scripts are temporary `/tmp/niaro88-console-*`; they contain only synthetic data.
These are browser acceptance checks, not physical Android or live-provider tests.
The React Native Storybook does not render the server-admin DOM; this recorded
actual browser matrix is the justified Storybook exception for these components.

A clean-context built-in plan and separate skeptical source/controller review
found and reproduced paginated artifact misbinding, positively rejected busy
admission blocking the editor, and overwritten local workflow tool labels. The
fixes and their regression checks are included; the reviewer repeated its own
probes and reported no remaining concrete P1/P2. It did not independently rerun
the complete regression or perform live requests. No external CLI/session was
needed and the earlier designer external-session consent was not extended.

## Proved native crash recovery

An explicit retry of the **same original internal process command** may use
Mastra `Run.restart()` after passive proof of its persisted parent checkpoint.
This does not add a process execution engine. The immutable run pin, scope,
input, compiler, exact serialized native graph and active paths must agree.
Every saved carry, chosen branch, mapping and final result must follow from
original typed inputs and canonical receipts or an exactly retired child Agent.
The compiler preserves the persisted mapping representation for versions 1/2.
Completed native entries between snapshot publication and pointer advancement
are handed to Mastra's existing completed-entry restart semantics.

The server rechecks the original actor's current authority, service/action
revisions, execution pins and source expiry. Child output also requires its
exact run/thread/resource retirement and settled native ownership, original
Memory/source pins and unchanged enforced budget policy. A staged typed output
written before child retirement is insufficient. Bounded child decision history
records consumed human approvals with their original tool call and operation;
a saved native resume payload must agree with that history and canonical receipts.
Historical child rows without that proof cannot infer replacement approval.
If the parent still retains consumed approval A while its child now awaits B,
the server proves A against the child's decision history and original succeeded
write, then restores B unchanged. A cannot approve B; B needs its own explicit
human response. This also covers a crash before the parent records B.

Known receipts are returned directly without OAuth refresh or transport. A
known pending approval can restore native suspension but cannot approve itself.
Only the original explicit human resume can dispatch its pending write. A
completed native parent can publish its proved output without native start or
restart. Recovery preserves original operation IDs, version pin, deadline and
charges; replacing the active version affects later new runs, not the old pin.

Missing native state after recorded progress returns
`process_checkpoint_missing`; malformed or mismatched identity/graph returns
`process_checkpoint_invalid`; absent or inconsistent boundary proof returns
`process_checkpoint_interrupted`. Unknown model usage and unknown writes keep
their original reservations/receipts and cannot be resent. An unretired child
with an incomplete model/tool boundary is deliberately refused, rather than
sampled again. Authoritative domain failures retain their safe diagnostic code.

Isolated native comparison jobs are a different lifecycle: their ephemeral
experiment stores are not reattached after a server crash. The existing
`openIdentity` OS-held SQLite lock rejects a competing process before auth
migrations/store construction. After actual owner SIGKILL, the shared journal
atomically interrupts the original orphan once with `test_server_restarted`.
GET/history/controller replay and a second reopen make no provider/service calls,
republish no staged report and preserve admission, qualification and activation
evidence. The newest interrupted admission blocks older qualified activation;
it requires a fresh explicit isolated test and human decision.

`tests/service-process-crash-recovery.node.ts` uses actual child SIGKILL at
canonical read/write receipt, pending approval, staged/retired child output and
terminal parent boundaries, followed by two reopens. It includes corrupted proof,
authority/model/budget/Memory revocation, cancellation, original deadline and
version-pin checks. `tests/process-owner-crash.node.ts` holds a real native
experiment at a receipt and before report publication, rejects another actual
OS owner, kills the owner, then verifies passive recovery and qualification gates.
These suites use synthetic services/models with real Mastra and persisted stores;
no live-model quality, CRM effect, physical Android or mobile invocation acceptance
is implied. Run them through `pnpm test:processes`; owner tests also run under
`pnpm test:process-native`.

Final verification on October 4, 2026: 35 process crash/recovery cases and two
actual competing-owner cases are included in the full `pnpm test:identity`
regression: **955/955 across 78 test files**, zero failures, cancellations or
skips, including the admin build. TypeScript, scoped ESLint with zero warnings,
Prettier, layer boundaries and diff checks passed. A clean-context plan and
independent skeptical review reproduced and closed terminal-status spoofing,
cached-output budget bypass and the second-approval parent/child gap. Final
review found no remaining concrete P1/P2; its focused reruns are separate from
the full regression. The lifecycle's compiler validation, six-family native/generic
comparison, exact-version qualification/activation/rollback, console and actual
crash/ownership acceptance are now covered in the controlled
`native_scripted_runtime` scope. `liveAcceptance:false` remains explicit.
The Services surface is described below. The mobile harness and
migration remain open.

## Service setup and lifecycle overview

The EN/CS Services entry now starts with an explicit assistant/manual choice.
Both keep the existing connection templates and forms. A confirmed connection
save opens its exact service ID; the assistant route then offers the same native
designer as **Configure with assistant** in an existing service's menu. No new
runner, model credential tools, automatic discovery or inferred activation is
introduced. Paused services require an explicit connection edit before design.
Unconfirmed Microsoft personal sign-in keeps the saved service and a repair
notice, including after reload; successful settings save clears that notice.

The service Overview displays purpose, neutral connection/credential metadata
and a passive process picker. The shared workspace inventory is requested once
for all service cards, rather than once per card. The selected process reader
binds organization, workspace, service, process and profile on every response.
It reads the record, current capabilities and bounded immutable history, fetches
an older active artifact by its exact version if necessary, then verifies that
the record revision and active/latest pointers still match. One passive retry
handles a concurrent snapshot change; a second change produces a visible error.
Aborted or foreign late responses cannot publish a partial snapshot.

Draft, active version and latest saved version remain distinct. Each saved
artifact has its own isolated test state. Definition previews share the native
designer's renderer for purpose, inputs/outputs, models, memory, action bindings,
confirmation/effect rules and workflow structure. Historical definitions remain
immutable; current capability labels are metadata, not proof that a historical
connection is usable. Private native reports stay in the existing authenticated
test/version console, with explicit navigation to further history.

Management visibility and query identity include the current session authority,
principal, role and organization/workspace. Denial hides cached process data.
Setup callbacks cannot navigate after the original scope unmounts. Rendering,
selection, reload and history reads do not invoke a model, business action,
test, freeze or activation. Existing metadata endpoints may use POST for icon,
sign-in status or provider/hosted-server inventories; they are not execution.

Verification on 4 October 2026:

- **7/7 reader regressions**: inventory pagination/shared key, foreign scope and
  cursors, older active versus newer failed/untested artifacts, snapshot races,
  malformed bindings/history, late abort and canonical definition comparison.
- **962/962 full server tests in 79 files**, zero failures/cancellations/skips,
  including the admin build. TypeScript, scoped ESLint with zero warnings,
  Prettier, boundaries and diff checks passed.
- Actual Playwright against isolated account HTTP: EN1440×1000, CS360×844,
  CS dark1440×1000 and reduced1366×900. Overview/version/draft selection,
  passive reload and service-menu navigation use zero mutation POSTs. Desktop
  inventory uses one shared process list. The new-service assistant flow uses
  one connection save, one explicit designer start and one explicit message;
  inference occurs only for that message, with zero business effects. Manual
  Twenty/custom paused setup uses one service save and cannot auto-enable it.
- Microsoft setup proves actual service save, rejected OAuth second stage,
  persistent reload notice and successful settings repair without duplicate
  creation. Hosted/provider metadata is synthetic. Global administration denial
  and an actual owner-in-another-org/member-in-target-org account prove no
  management controls, process requests, inference or effects for the member.
  All nine flow variants have zero unexpected console errors or horizontal
  overflow; expected OAuth/administration403 responses are recorded separately.
- Screenshots and temporary scripts are under `/tmp/niaro67-*`. Browser plugin
  was not available; the installed Playwright runtime was used. Server-admin DOM
  uses Radix and is outside the mobile Storybook, so actual EN/CS browser QA is
  the explicit Storybook exception. Clean-context plan and independent read-only
  skeptical review closed the member management CTA finding and found no
  remaining concrete P1/P2; the reviewer independently ran the seven reader tests.

No dependency, protocol, database, routing or existing connection migration is
required. Native controlled qualification remains `liveAcceptance:false`.
Physical Android, live model/CRM/OAuth quality and public mobile invocation are
not accepted by this UI work. Mobile execution and migration remain open.

## Exact process start admission

October 4, 2026. This is the internal admission prerequisite for mobile execution.
`agent-process-start/1` is a strict typed contract, not an HTTP endpoint, a model
tool, a new runner or a public `CommandSchema` dispatch. IdentityService constructs
one `ProcessStartStore` in `attachWorkflow` under the existing identity owner.
The sections below supply authorized inventory/forms and the authenticated
request coordinator, then Tasks/Loops projection, human question resume and
mobile acceptance.

Only a trusted server caller issues an opaque intent. It binds server, connection,
organization, workspace and user to the original conversation/message/card/action
and form revision, or to an explicit command origin. It freezes the human-seen
active version, artifact digest, complete form digest and input schema. The model's
button label or recognition of a process name grants no authority. The new typed
`resolveCardSubmission` preserves raw values; existing ordinary cards retain their
textual answer behavior. A trusted scalar-field mapper binds card IDs to frozen
closed object paths. It never parses the button prose into an instruction.
Array inputs and non-identifier enum values need the structured form contract
below; this limited card mapper is not a claim that all process schemas already
have mobile controls.

The synchronous identity savepoint validates the exact origin and bounded JSON
against the frozen schema, checks the expected active version and immutable digest,
and stores the original command, canonical fingerprint/input digest, run pin,
initial `service-process-1` journal and immutable admission receipt together.
The shared schema preserves nested objects/arrays, null, false, zero, empty strings,
whitespace and array order. It rejects non-JSON data, inherited/accessor containers,
unsafe keys, extra schema properties and inputs over 65,536 UTF-8 JSON bytes.
Nested mappings create own containers even for allowed keys such as `toString`.

Command IDs and idempotency keys both identify the original receipt. An exact replay
returns it before revalidating the old form, current active pointer, source readiness
or qualification. Current authenticated membership, connection binding and private
read policy remain mandatory. `pinnedVersion` reads immutable historical provenance;
`resolveRun` retains the fresh execution gates. Replaying an admission never starts,
resumes, approves or reports successful execution.

Definitive bounded domain rejection also has an immutable receipt, with no pin or
journal. Reusing that exact command after changing the active pointer returns the
same rejection. A new command may correct invalid input using the still-unconsumed
intent; only a successful admission redeems the intent once. Changed input, intent,
origin, language or identity under an existing command/key is an idempotency conflict.
Malformed/oversized envelopes and authentication failures are not admitted commands.
Unexpected storage failures roll back the full write rather than manufacturing a
successful or definitive rejected receipt.

The receipt contains an immutable internal run alias and native/domain parent ID.
The existing identity algorithm stays unchanged:

```text
scopeDigest = processDigest([serverId, organizationId, workspaceId, userId])
parentRunId = processDigest(["service-process-1", scopeDigest, runId])
```

Public command IDs may exceed the native ID grammar; they remain original aliases
in the ledger. Existing compiler `/1` and `/2`, workflow names, native checkpoint
IDs and older pins stay intact. The receipt freezes its original compiler identity
and `startedAt`, so later recovery cannot refresh its deadline. Passive replay checks
immutable root bindings; normal trace, status, child and operation progress may change.
A missing/foreign pin or journal is a proof gap; replay does not create a replacement.

Only the identity ledger, run pin and domain seed are atomic. Mastra persistence
`identity.sqlite.mastra.sqlite` and chat `workflow.sqlite` are separate databases.
Native execution and chat publication must use the original admission and existing
crash proof; no cross-store atomicity is claimed. The durable store has no credential
parameter: the public coordinator must validate the live device/account credential in its request
queue before **every** call, including reads and replay, and recheck execution
permission at native boundaries.

Validation: 14 direct focused cases plus four actual SIGKILL cuts at pin/seed/receipt
inserts and immediately after commit. The workers explicitly use SQLite WAL and
synchronous FULL. Two reopens retain no partial admission before commit, or exactly
one original receipt/pin/journal after commit, with no native database, inference,
invocation or business dispatch. Three injected write failures also roll back the
whole transaction. An explicit isolated native start consumes the admitted seed;
later passive reads accept its legitimate progress without another dispatch.
This is synthetic local contract evidence, not physical Android, live model/CRM,
new owner-lock acceptance or public mobile execution. Native qualification remains
`liveAcceptance:false`.

## Passive execution inventory and structured inputs

Account clients negotiate `agent-process-execution/1` explicitly:

- `GET /v1/:workspaceId/processes?profile=agent-process-execution/1` reads the current execution user's active processes. Further pages send both `after` and the returned `fingerprint`.
- `POST /v1/:workspaceId/processes/input?profile=agent-process-execution/1` explicitly prepares a form, using `{processId, version, artifactDigest, language, origin: {type: "command", conversationId, requestId}}` from the reviewed selection. It persists an opaque intent only.

Both routes authenticate the current device/account credential, parent session and workspace membership inside the identity queue **before** constructing the model/service runtime. Organization, user and connection scope come from the grant. Duplicate, unknown or spoofed query/body fields are rejected. Fixture workspaces do not expose these routes. Older clients keep their ordinary cards. This adds no label-to-message conversion or execution; the separate public coordinator below supplies explicit process commands.

The execution projection reads names, purpose, version, digest and input schema from the immutable **active artifact**. It does not use administrative draft summaries/catalog inventory or disclose instructions, source identities, creator reports, credentials or inactive versions. Every role, including owners/admins, must satisfy current service access, workspace roles and all action policies. Inaccessible/deleted dependencies omit the process. An authorized unavailable process returns a bounded generic reason without its input schema. Enabled services/actions/models/providers, original source revisions, saved-memory settings, qualification, linked OAuth account/expiry, provider quota and the first inference reservation's exact tariff/token/process caps are checked without decrypting credentials, refreshing OAuth, reserving a budget or dispatching transport.

Pagination fingerprints bind the authenticated scope and current visible entries. A changed inventory or invalid cursor returns `process_inventory_changed` rather than mixing pages. One read scans at most 1,000 active processes; exceeding that explicit server bound returns `process_inventory_limit`.

Preparation rechecks current readiness before **both new and replayed** intents. It never substitutes a different active version. The server builds `agent-process-input/1` semantic form metadata, hashes its exact scope/language/origin/version/schema and freezes it in the start admission intent. A language or form substitution under the same origin conflicts. No run pin, admission command, journal, invocation or inference is created by reads or preparation.

`ProcessInputCardView` renders the frozen ProcessData schema using local controls: lazy object groups, ordered arrays with stable item identities, strings, finite numbers/integers, literal enums, booleans and explicit null. Optional presence is separate from the value: absent, empty/whitespace text, empty objects/arrays, false, zero and null remain distinct. Validation preserves the draft, supports more than twelve fields and enforces the same exact 65,536 UTF-8 JSON-byte boundary as admission. The existing registry's whole-definition bound (5,000 nodes and 65,536 key/string bytes) also applies; a 4,999-node definition with 1,577 input leaves fits the guarded form contract. Arrays never allocate their nested minimum-size trees during rendering.

Render, expansion, edits and validation issue no network request. A supplied callback receives typed JSON only after explicit local review; without a coordinator the controls are disabled. A changed immutable binding or scope clears old drafts. Public execution/approval dispatch is the public coordinator below; Tasks/Loops projection, native questions and the actual mobile menu/device acceptance follow later. This slice does not claim physical Android or live CRM/model/OAuth acceptance.

Validation on 5 October 2026: **17** direct store/protocol cases, **4** real synthetic account/device HTTP cases including restart/queued revocation, **52** form/renderer Jest cases and **23** existing card regressions. The full server suite passed **1,001 tests in 83 files**, including its admin build. Independent clean-context review reproduced and rechecked budget/quota/unlinked-account fixes. Rendered EN/CS browser evidence in the temporary `/tmp/niaro91-ui` harness includes 12 viewport/state cases and four interactions; no overflow, app console error or request from an edit was observed.

## Public native process coordinator

Account clients explicitly negotiate `agent-process-execution/1` on these separate routes:

- `POST /v1/:workspaceId/processes/commands?profile=agent-process-execution/1` accepts the original strict `agent-process-start/1` command from the frozen input intent, or a strict process `service.resolve` command.
- `GET /v1/:workspaceId/processes/runs?profile=agent-process-execution/1&parentRunId=<exact parent>` reads private operational metadata only.
- `POST /v1/:workspaceId/processes/commands/interrupt?profile=agent-process-execution/1` takes `{profile: "agent-process-execution/1", command: <exact original command>}` and returns control settlement or an explicit unknown reason.

A process approval carries `profile`, `type: "service.resolve"`, `commandId`, `idempotencyKey`, `conversationId`, `workItemId` (the canonical admitted parent), `expectedWorkRevision`, `operationId`, `approved` and `language`. The server freezes the full original decision plus original admission and pending node before resume. A new command must match the authoritative journal revision and pending operation. An exact replay reads that original binding before considering the current pending state: replay A can expose B but cannot approve B. Start and decision command/idempotency namespaces cannot collide. Rejected admission returns422; admitted execution returns202 with its actual running/waiting/succeeded/failed/unknown/cancelled state. The response includes the immutable admission and bounded process metadata, not a fabricated chat receipt or Snapshot. Native output exceeding the portable JSON bounds is omitted with `outputTruncated: true`; its successful native status and private original output remain intact.

The authenticated mobile bridge constructs the existing native process runtime with the same read-only saved-memory adapter, identity queue, native catalog owner, process lock and durable run/version identity. It does not select an ordinary default chat model or resolve/unseal unrelated service credentials. Current device/session/membership and source/action/model/OAuth/Memory/budget authority still gate actual native model/tool boundaries. Deadline is measured from the original admission, including human waiting. Ordinary chat routes reject `service-process-1` journals; unknown kinds also fail closed. Each process operation links to its original parent before invoke. A scoped passive historical-journal fallback protects older operations that predate those links.

Process and chat adapters share request registration, exact idempotency ownership, per-scope permits and the existing global capacity. A process request registers before its first asynchronous authorization check. Interruption records an immutable exact original-command barrier before abort. An interrupted unstarted admission or still-pending exact decision becomes cancelled only after native retirement proof; later B is unchanged. Replays of the interrupted request only read its recorded result and never dispatch. A cancelled request without an admission returns `process_command_cancelled`. Response-body disconnection is checked before admission, including synchronous destruction at body end. Shutdown aborts the shared requests and waits for their native/transport tails before closing identity or native storage.

Ownership cleanup requires original scope/admission/pin/journal plus an exact native parent graph/input checkpoint and every child retirement/suspension proof. A private adapter-owned proof can retire an abandoned revoked scope without granting public history or execution authority. Fresh authenticated retries can retire older unavailable-delivery contexts; concurrent retries refresh request ownership after proof. Unknown/missing proof retains the permit. A suspended checkpoint is insufficient while native Memory persistence fails; successful persistence plus the exact suspension binding proves settlement. Definitive action outcomes close the matching child pending approval even when its error interrupts later child finalization. Control `settled` means no request tail remains; an unknown business effect stays unknown and cannot be resent.

Passive GET, inventory, input preparation, snapshot, task opening, poll and reconnect never start/resume a process. Only an explicit original command may use the existing proof-gated recovery; checkpoint IDs/compiler1/2 are unchanged. The passive Tasks/chat/Loops projection is described below, followed by native questions and the mobile process menu.

Validation on5 October2026: **20** direct coordinator/native cases and **6** actual synthetic-account/device HTTP cases, including real reopens,64KiB input/envelope, revocation/disconnection and shutdown tails. The full server suite passed **1,027/1,027 tests in85 files**,0 fail/cancel/skip/todo (125381.958125ms), including its admin build. Existing workflow16/16 and native agent19/19 direct regressions also passed. TypeScript, scoped ESLint with0 warnings, Prettier, dependency/UI boundaries and diff checks passed. Independent clean-context plan and two read-only skeptical reviews verified the fixed boundaries. Existing native SIGKILL/owner recovery tests remain in the full suite; this slice does not claim new public-process SIGKILL cuts, live CRM/OAuth/model quality or physical Android acceptance. There is no new rendered UI, dependency or native binary in this backend contract.

## Passive process Tasks and Loops

Workflow clients negotiate `tasks=agent-process-work/1` alongside their card and
reply-correlation profiles on snapshot, events and ordinary commands. The mobile
session adds this parameter automatically. Older strict clients receive the safe
text projection with the new process metadata/card removed; the workflow profile
and event cursor stay unchanged.

One SQL window selects at most 400 canonical chat and publicly admitted process
roots. It filters command aliases and non-task chat before applying the limit,
prioritizes pending work and requires the exact connection/server/organization/
workspace/user admission scope. Internal console/test runs stay private. A process
WorkItem uses the original canonical admitted parent ID and conversation.
`native.process.provenance` carries the original native run alias, process/version,
artifact digest, actor, command and admission identity. Loops displays the same
verified provenance. No existing native checkpoint ID or compiler ABI is renamed.

Projection reads canonical invocation receipts for effect/status evidence, even
when the journal generation has not changed. `native.revision` records the journal
generation; the outer WorkItem revision advances for changed receipt/card content.
Unchanged synchronization emits no event. Up to 64 distinct receipt summaries are
portable; cards show the last twelve actions in an expandable disclosure and at
most eight validated output fields from the pinned successful process artifact.
Output is derived data. A write that succeeded remains successful if subsequent
output validation fails; the failed process explains that the earlier write was
not undone. Canonical unknown receipts override a still-running journal; startup
interruption is visible as unconfirmed completion. `journalStatus` preserves the
original native journal status separately.

Every projection validates current private read, source TTL, service/action and
personal OAuth execution pins, Memory generation/provenance and expiry. Missing
detail access retains canonical receipt statuses and a safe explanation, while
removing private result summaries/output. The authenticated publication queue
rechecks the selected roots, receipt bytes, policy/Memory generations, expiry and
current OAuth access/account pins. Token expiry or connection replacement invalidates
a previously captured window even without a policy-epoch change. Reads never
refresh OAuth, infer, start/resume or dispatch a business operation. Three unstable
HTTP attempts return `task_projection_changed`; a worker rejects a stale window
instead of publishing older data.

Window replacement is explicit and atomic with the workflow snapshot/outbox.
It removes only native WorkItems outside the selected window and respects the
500-item transport capacity after existing fixture work. Incremental updates do
not evict unrelated work. Eviction advances a persisted `eventFloor`; clients below
that cursor must read a snapshot and cannot replay an old upsert to resurrect an
evicted task. Loops remains the separate durable history view.

Tasks defaults to **All**, including failed/cancelled/unknown/interrupted work.
Other filters retain their exact needs-input, active and succeeded meanings. Chat
anchors retain terminal process cards, and snapshots preserve `work.card`.
EN/CS cards explain failures and keep completed action receipts. Selecting a
process card is passive and does not send ordinary `task.open`, approve or resume.
Question and execution controls come later; no fabricated legacy action
binding is used to enable them.

Verification: twelve direct projection cases, four durable-window cases and two
real synthetic account/device HTTP cases; seven mobile-card Jest cases and EN/CS
stories. These cover admission before publication, two reopens, exact provenance,
receipt-only changes, failed output after successful write, unknown/cancelled work,
stale events, capacity/eviction, rollback/lost commit response, access/TTL/OAuth
expiry and replacement, old-client negotiation, and fail-closed publication.
Actual installed Playwright checked Tasks at EN1440/390 and CS320/390 plus Loops
at EN1440/CS390: filter/expand interactions, provenance, no overflow, app console
errors or external requests. Browser plugin was unavailable. This is synthetic
rendering/contract evidence, not physical Android or live provider/business
acceptance; `liveAcceptance:false` remains.

Final regression on 5 October 2026: **1,045/1,045 server tests in 88 files**,
0 fail/cancel/skip/todo (135098.044022ms), including the admin build and existing
native SIGKILL/owner cases; **911/911 Jest tests in 92 suites**. TypeScript, scoped
ESLint with zero warnings, Prettier, Storybook discovery, boundaries and diff
checks passed. Clean-context planning, separate skepticism and final independent
review reproduced and closed the publication/OAuth/Memory-source gaps; no
remaining concrete P1/P2 was found.

## Pinned compiler and trusted answer consumption

Existing runs now pass their immutable journal `compilerVersion` explicitly into
native workflow identity, compilation, checkpoint reconciliation and coordinator
retirement. Supported saved compilers are checked against the definition rather
than compared with the selector for new admissions. Compiler `/1` remains for
static action workflows; `/2` supports both action and agent workflows. The
admission selector still chooses `/1` or `/2`. `/3` is not enabled.

The persisted schemas, step/workflow IDs, serialized graph and exact
`carrySchema` mapping function remain compatible. Unsupported compilers,
`/1` agent graphs, replaced mapping graphs and mismatched checkpoints fail
closed. Historical runs are not recompiled under a new admission version.

The shared native Agent session has an optional trusted
`consumeQuestionAnswer(metadata, resumeData): Promise<string>` hook. On an
exact resumed `ask_user` call, the runtime awaits it before publishing the
successful tool boundary or passing the canonical answer to the next model
request. Rejection or an invalid return stops execution without that completion
or another model request. A non-Error rejection is normalized before the fatal latch, including
`Promise.reject()` and falsy values. Sessions without the hook retain the existing chat
question behavior. This hook is a domain integration boundary, not an
alternative agent loop or permission supplied by model content.

Cancellation during the awaited hook prevents another model request. If the
trusted consumer has already committed and then returns, a successful tool-end
can still record that consumed fact. Exact domain authority, interruption,
consumption-before-native-ACK and recovery windows remain native-question acceptance
work; that event never grants approval or permission for another action.

This preparation does not implement public `process.answer`, process questions,
new question storage, compiler `/3`, or mobile question controls. Those belong to
native questions and answers. It also does not change source/Memory/OAuth/budget authority or historical
qualification. When `/3` is added, new-admission selection and the qualification
of already pinned runs must remain distinct without weakening those guards.

Offline coverage includes pinned `/1`/`/2` graph digests and saved row reads,
explicit `/2` action resume while new admission selects `/1`, passive retirement,
trusted consumption success/rejection, ordinary chat, and the existing actual
SIGKILL checkpoint recovery regressions. See STATUS.md for executed totals and
limits; no live provider or business effect is required.

## Fatal native boundary failures

Every rejected native execution boundary now latches an `Error`, including
`Promise.reject()` and null, empty string, false or zero. Non-Error rejections
become the cause-free `niaro_native_execution_rejected`; arbitrary rejection
payloads are not published. An existing `Error`, including a domain
`IdentityError`, retains its identity and remains the first fatal cause even
when the failure observer also rejects.

A rejected invocation or tool observer stops subsequent tools, model requests
and finalization. Its failed tool event carries the normalized error and no
successful output. An observer may itself reject that publication, but cannot
allow execution to continue. Trusted question-consumption rejection still has
its dedicated error and publishes no completed question boundary.

This changes execution failure handling, not canonical receipt truth: a
previously completed write stays completed and an unknown write stays unknown.
No workflow/compiler ABI, public protocol, question storage, approval authority
or model configuration changes. Ordinary chat and existing approvals use the
same native runtime. Sixteen new regressions exercise invocation and observer
failures and original domain Error identity; independent probes also cover model,
provider, finalization, batch-tool and replay boundaries. These are isolated
scripted tests, not live service acceptance.

## Exact native process questions and answers

New definitions explicitly opt into human questions with `humanInput: "text"` on
an Agent node or Agent process. This freezes compiler
`niaro-native-workflow/3`, a separate graph and resume schema. Omitted historical
definitions keep their original `/1` or `/2` graph, digest and qualification.
Enabling questions requires a newly frozen and qualified artifact; a previous
qualification cannot authorize the expanded tool set. The admission selector
and supported saved compiler checks remain separate.

The model's `ask_user` tool supplies only the exact question. The server binds it
to the original parent, node, child run, thread, resource and tool call, question
ID/revision/text digest, frozen artifact/compiler/input and admission. Parent and
child journals distinguish a question from an action approval. Native suspension
proof checks the full private question and exact active paths and nested foreach
state; a matching tool ID alone is insufficient. Multiple questions in one model
turn keep their original ordered tool calls and individually consumed answers.
Mastra's resumed foreach output may use the exact original full-batch payload
for a successful sibling; it must still match that sibling's original call at
its index. Before trusted consumption the adapter retains the already-proved
native foreach cursor on the same tool checkpoint. After owned recovery it can
restore a missing outer resume-label alias only from the complete, exact inner
question suspension. Ordinary proof stays strict; missing retained evidence or
changed paths, payloads, sibling outputs and labels cannot be reconstructed.

Question-aware clients negotiate `agent-process-execution/2` on the existing
command, run-read and interruption routes. Start and action approval retain
their existing strict command shapes. The new `process.answer` command has
profile `/2`, original command/idempotency and conversation IDs, `workItemId`,
`expectedWorkRevision`, node/child/tool-call/question IDs and question revision,
original answer text and language. The revision is the **process journal
generation**, not the outer task/event revision. A native resume references a
server answer binding; it does not accept caller-supplied resume text. Profile
`/1` cannot start or resume compiler `/3`, including joins to an existing request.

The identity database owns immutable question, answer-binding and consumption
rows. Start, resolve and answer share one scoped command/idempotency namespace.
One question accepts one canonical answer; SQL consumption and the synchronous
domain journal save commit together. An exact historical answer retry reads its
original binding before considering the current question. Answer A therefore
cannot answer, approve, cancel or rewrite B. Current device/membership, source,
Memory/OAuth, budget and original deadline remain required at native boundaries,
including a floor-sized model reservation (2,048 input tokens plus the output
ceiling) before consuming an answer.
Human waiting never resets the budget, elapsed time or charged logical steps.

Stored consumption alone does not prove native completion or release request
ownership. Suspended proof and running consumption-before-ACK recovery proof
are separate; missing, changed or forged native evidence fails closed. Native
terminal output requires its own retirement proof. Passive reads, snapshots,
poll, reconnect, history and opening cards never dispatch or resume a model.
Only an explicit original command may enter proof-gated recovery.

Workflow clients negotiate `tasks=agent-process-work/2`. The public question has
only its safe target and original text; private checkpoint proof, resource and
thread stay server-side. A current question projects `waiting_input` and the
actual journal revision. Profile `/1` strips new fields and projects
`waiting_system`; unnegotiated clients receive the existing compatible fallback.

Typed text and reviewed voice use the same frozen answer factory. It captures
the connection, authenticated scope, conversation, parent, immutable provenance,
journal generation and complete public question once. Recording, transcription
and dispatch check that original target; a late A transcript cannot target B.
`ClientSession` uses its existing durable outbox, explicit retry and interruption
owner, not a second process state machine. A failed snapshot-cache write cannot
hide a pending answer. App reopening and reconnect do not automatically resend it.

Delivery acknowledgement is distinct from consumption and task success. Only an
actually consumed answer projects one canonical user message with its original
whitespace, conversation and task binding. Publication and its durable marker
commit together; archive, redaction, eviction and restart cannot resurrect that
message. A bound but unconsumed answer produces no history. The mobile draft is
retired only when that canonical message is visible; pre-consumption failure
preserves the text and explanation. An answer containing `approve`, operation
IDs or success-shaped JSON never grants permission to perform a write.

Native scripted qualification uses real isolated admission and question stores.
Each case may supply ordered `questions.configured` and `questions.generic`
fixtures, each bounded to 16 exact question/answer pairs. Both strategies use the
same corresponding human answer. Missing, mismatched or still-pending fixtures
fail the experiment without fabricating a terminal observation. The admin suite
editor supports editing, ordering, removing and copying these fixtures in EN/CS;
omitted legacy fixtures remain omitted on round-trip.

`pnpm test:process-questions` includes actual native/domain/store/coordinator,
budget, paired-account HTTP, qualification, history and subprocess SIGKILL
coverage. Crash sites include issue before pending save, native child suspension
before parent publication, bound answer before resume, consumed answer before
native ACK, B publication before response, child output before retirement and
native terminal before parent save. Each reachable boundary uses real persisted
stores and reopens. A literal child-suspend-before-first-pending-save site is not
reachable: the native invocation saves pending before it suspends. The two
adjacent reachable cuts cover that ordering without inventing a crash site.

The complete mobile process menu, start/form/approval controls and physical
Android acceptance remain open. Scripted native qualification is still
`liveAcceptance: false`; it does not establish live model or CRM quality.

## Durable local answer recovery

The mobile Session keeps submitted process answers as scoped local delivery
evidence. This is separate from canonical chat and the server's process journal.
The record contains the exact original command, frozen public question target,
raw answer, delivery outcome and its own failure code. It preserves submitted
text across a full application restart; subsequent unsent editor changes are
not covered by this record.

One retained versioned envelope is authoritative for process pending delivery.
It is keyed by the full endpoint/connection/server/user/workspace identity and
validates the embedded endpoint and Scope. It holds at most 32 unresolved
records and 2,000,000 UTF-8 bytes, using the same bounded serializer/parser.
Capacity refusal preserves the existing records and explains the local failure;
unresolved text is never silently evicted.

The frozen record is saved before dispatch. A known outcome is saved before the
compatibility outbox is cleared. Unknown delivery retains the byte-identical
original command for explicit retry. Known delivery followed by a storage error
retries local persistence only. Reconnect, polling, rendering and recovery never
resend an answer. Initial authorization and recovery share one barrier; unreadable
or malformed authoritative storage blocks all new commands until an explicit
refresh can recover it. Failure of the disposable snapshot cache is separate.

Delivery acceptance does not prove consumption or task success. Only a fresh,
authorized projection with the original ownership/provenance and an exact
`answerHistory` command/question/raw-answer match can retire the local record.
An empty retained envelope suppresses stale compatibility pending bytes after
consumption or explicit discard, including when the pending cleanup write fails.
Archived/redacted chat messages cannot recreate consumed text. No canonical
message is reconstructed from local evidence.

Chat and Tasks show saved-answer cards with the original question, selectable
text and a per-attempt explanation. Review is explicit and validates the full
original question before restoring its conversation and editor context. An old
answer A cannot move to B. Unknown delivery offers exact retry and cannot be
discarded to bypass the pending barrier. Known records allow explicit removal of
the local copy. Draft edit generations protect newer edits, including identical
text, from delayed consumption callbacks.

This client change does not complete the full mobile harness: process
start/resolve transport, inventory/input menu, exact action confirmations and the
integrated authenticated end-to-end acceptance follow in the sections below.

## Shared client process command transport

ClientSession accepts explicit `process.start` and profile-bearing
`service.resolve` through the same CommandFlight, ordered storage queue, retry
and interruption barrier used by ordinary chat and answers. Profile-free
`service.resolve`, including its optional native work fields, remains an
ordinary command. Process execution requires `processExecution` or
`processQuestions` opt-in. Question-capable clients use execution `/2` in the
transport query and interrupt wrapper; start bodies retain start `/1`, and
approval bodies retain execution `/1`. Inventory and input form responses keep
their existing profiles.

A new start freezes the complete reviewed ready inventory entry, issued input
card/intent, endpoint/Scope, conversation, language and submitted input. A new
approval freezes the original parent, `work.native.revision`, pending receipt
and run/process/version/artifact/start-command/admission provenance. The outer
projected WorkItem revision and question-only journalRevision are not the
approval generation. Capture/assert factories require a fresh scoped projection;
explicit original retries use their saved target, even when B is now projected.

The existing pending key stores one bounded tagged envelope containing the
strict immutable command, its exact serialized bytes, target, negotiated
transport profile and delivery outcome/error. It is written before POST, and a
known outcome marker is saved before clearing pending. Known local persistence
retry never resends transport. Initial settlement and concurrent local retries
share a per-flight promise; ownership and queue-before-publish ordering protect
a listener's newer D from a delayed old clear. A failed unknown rewrite blocks
POST even if readback sees unchanged old bytes. Exact known-marker readback can
recognize a storage error raised after commit.

Unreadable or corrupt shared pending storage blocks new commands even when a
known or empty answer envelope exists. Only an authoritative unknown answer
record conclusively owns that compatibility outbox. An old raw process command
without frozen proof is retained but cannot infer proof from the current B.
Ordinary raw pending commands remain compatible; recovery never automatically
resends any command.

A runtime response must bind the original Scope, transport profile and command.
Start receipts additionally match original intent, origin, process/version,
artifact/form digests, idempotency and canonical command digest; admitted input
is checked against the submitted input and both canonical digests. Portable
SHA-256 uses React Native JavaScript primitives and matches the server's
sorted-key JSON identity. A valid HTTP422 rejected-admission envelope is parsed
before generic errors and keeps its exact rejection reason. Malformed, foreign
or unproven replies retain the original pending command. Delivery acceptance
only invalidates the projection and triggers a passive refresh; it never
fabricates successful work.

Approval responses bind the outer decision command ID and original admission,
parent/run/process/version/artifact. A legitimate response to A may expose B or
a question. The public envelope has no separate decision receipt/digest, so the
client does not claim an independent proof of that business decision or effect.
The process menu/input UI, detailed shared approval card and whole rendered
HTTP/Session flow follow in the sections below.

## Chat offers a fitting process

Before the chat assistant uses services for a new request from the mobile app,
it sees the processes the person can start now (name, description and input
fields). When one clearly does what the message asks, it calls `process_offer`
and ends the turn with a `process.offer` message result: the process, its exact
version and suggested values for declared input fields taken from the message.
Values that do not fit a field are dropped. The offer starts nothing.

The card shows the process, the assistant's one-sentence reason and the
prefilled values; the reply text does not repeat the choices. **Open process**
opens **Processes** on that exact version with the form prefilled, once: a later
**Choose another process** or refresh is an ordinary choice. The person reviews
and starts it through the reviewed start below, and **Back to chat** closes the
panel. A changed or unavailable process asks for a new choice. **Without it**
resends the original request with `message.send.withoutProcess: true`; the
server then lists no processes and hides `process_offer` for that turn, so the
assistant handles it with service tools. With no process to offer, chat behaves
as before. MCP and browser clients, which cannot review a process start, are
never offered one.

## Processes from chat

October 17, 2026. A person can create a personal process by asking for it in
chat ("Create a daily summary for me", or "add a daily summary to my overview"
when no process on offer fits). Nothing is saved until they press **Save and turn on**
on the card the turn ends with.

**Proposal.** The chat agent (web and mobile clients, the same ones that get
`process_offer`) has the tool `process_propose {request, name?, addToHub,
sessionId?}`. It runs the real designer conversation of `/processes/design`
(`ProcessDesignConversation`) for a new personal design session (`owner:
{type: "user"}` for members and administrators alike), under the person's own
capabilities and inference budget, with the workspace chat model as designer
model when the budget prices it (else the first priced tool model). The
person's words go to the designer with a short frame (personal process; when
`addToHub`, no required inputs and no write without approval). Session start
and turn use request ids derived from the tool call, so a replayed call
returns the same session and turn without new inference. The tool returns a
compact summary as data (never instructions) and the turn ends with a
`process.proposal` message result (`packages/protocol/process-proposal.ts`):
name, kind, numbered human-readable steps (service · action, AI step, branch,
return fields), inputs, outputs, which services it reads or writes, the
designer's assumptions (with digests) and questions, `hubEligible` (no
required input and every action a read or a write that always asks for
approval, as `unattendedEffect` on the hub) and `addToHub` (pre-ticked when
asked and eligible). Its `status` is `ready`, `questions` (answer in chat:
the agent calls `process_propose` again with that `sessionId`; or continue in
the designer) or `budget` (`budgetReady` is false: nothing was designed, the
card says to ask an administrator). The agent instructions send "add X to my
overview" without a fitting addable process and "create a process that…" to
this tool instead of pointing at Processes.

**Save and turn on.** `POST /v1/:workspace/process-proposals?language=cs|en`
with `{profile: "agent-process-proposal/1", type: "accept", sessionId,
requestId, revision, reviewDigest, assumptions: [{id, digest}], addToHub}`
(8 KiB, pairing rate limit) returns the status at once and runs the pipeline
in the background under the same app credential (re-authenticated at every
step; aborted on shutdown); `GET …/process-proposals?sessionId=` reads it.
Status: `open | running (phase saving | testing | activating | hub) | done |
stopped | failed`, with `processId`, `version`, `hub: added | failed`,
`hubFailure`, `failure` or `gap`. Each step uses the same store the console
uses, under the person's authority:

1. The review must still be the one on the card (`revision`, `reviewDigest`,
   else `process_proposal_changed`). Unacknowledged assumptions are
   acknowledged only when the press carried exactly their digests (the card
   showed them). The design is accepted (personal draft saved).
2. **Limits are sized for the model calls.** Every model call, in a test and
   in a real run, reserves its own request size inside the process's own caps
   before it is sent: the estimated input (at least 2,048 tokens, at most the
   price's `maxInputTokens`) plus the price's full `maxOutputTokens` and their
   tariff ([reservation semantics](inference-budget.md)). A price whose max
   input is the whole context window (200 000 + 8 000) therefore still fits a
   100 000-token process; a prompt larger than what remains is refused before
   dispatch. The designer often writes caps no call fits (for "number of companies
   in the CRM": 1 200 tokens, $0.10). The smallest useful run needs one call per
   agent step, two when the agent may use a tool (the call and its answer);
   calls run one after another. Steps, model calls and time are sized for an
   ordinary run as the runtime counts them (`service-process-runtime.ts`
   `charge`): every entered node is a step (an agent process's synthetic
   return is not); inside an agent step every model call and every tool call
   (including a question) is a step too, in the same ledger. An agent that
   can use services plans 3 tool calls and needs tool calls + 1 model calls;
   the duration covers the whole run (15 s + 10 s per model call + 5 s per
   service call). For the CRM count: 1 node + 4 model calls + 3 tool calls =
   8 steps, 4 model calls, 70 s (the designer's 2 steps stopped the first
   real hub refresh at its tool call with `process_step_limit`). The pipeline
   then raises `maxTokens` and `maxCostMicros` to `maxModelCalls ×` a typical
   call of the process's models (32 768 input tokens, capped by the price,
   plus the full output and their tariff; 4 × 40 768 capped at 100 000 for
   the CRM count). It never lowers what the designer wrote, never goes above
   the registry ceiling (64 steps, 32 calls, 100 000 tokens, $10, 10 min) or
   the workspace budget, and saves that draft
   (`apps/server-identity/process-proposal-limits.ts`). Only when the
   smallest useful run cannot fit even at the floor (`calls × (2 048 + max
output)` and its tariff above the ceiling or the workspace run limit, for
   example a 15 000-token workspace limit with an 8 000-token max reply: 2 ×
   10 048 = 20 096) the pipeline stops with `gap:
model_reservation_too_large` and `reservation {tokens, costMicros,
maxTokens, maxCostMicros, calls}`, before saving when the design is not yet
   accepted. The card names both numbers and links administrators to
   **Usage limits** (`/admin/usage`: lower the model's max reply or raise
   the run limit); members are told to ask one. After that the same card's
   next press continues.
3. The saved draft is frozen (`agent-process-versions/1`), or its latest
   version reused when it is exactly the draft.
4. A default native test suite is generated from the frozen definition and
   pinned catalog (`apps/server-identity/process-proposal-suite.ts`) and run
   through the ordinary native test (`agent-process-native-tests/1`). It
   follows the definition's ordinary path with sample values (the literal `"Ukázka"`, 1,
   `true`, every declared field) and sample action results. An agent step
   that can read (a read that asks for no approval, whose input schema the
   required-field samples satisfy) first calls that tool with sample input
   and a sample result, then answers with sample JSON, so the test spends the
   same steps, model calls and service calls as a real run; other agents
   answer directly. A read on an MCP service is expected as MCP returns it:
   its receipt keeps the whole `tools/call` result, so the sample result is
   `{content: [{type: "text", text: "{\"value\":\"Ukázka\"}"}]}`; the
   native test's MCP stand-in returns a fixture output that already has this
   shape as it is (any other output is still sent as one text block), so
   receipt and fixture match in both strategies. The generic baseline (the
   first agent's model) repeats the same actions through `find_actions` and the
   action tools. It covers every applicable family: success and completed
   reopen; missing input (one required field left out); failure (the first
   step on the path: a read fails, an agent replies invalid JSON, a write
   returns a result that does not fit its declared output); rejection and
   uncertain write on the first static action step that asks for approval or
   writes. Each model call is checked first: its scripted input (at least the
   2 048-token floor) plus the full output must fit the frozen caps on top of
   the earlier calls. It is controlled scripted evidence like every native
   test (`native_scripted_runtime`, `liveAcceptance: false`); nothing reaches
   a model provider or a service. When something cannot be generated safely
   (a hazard only an agent's own tool call reaches, an input or action schema
   the samples do not satisfy, limits too small for the model's price), the
   pipeline **stops** after freezing (`gap`) and the card links to the
   process page, where a person writes the test as before.
5. A qualified test is activated (`agent-process-activation/1`, the person's
   press being the acknowledgement of `controlled_native_test_only`).
6. When ticked, it is added to the overview with refresh `daily`; nothing
   starts now, the overview refreshes it when it next opens. An ineligible
   process fails only this step (`hub: failed`).

Every step is idempotent (per-session ids for accept, freeze and the
overview item, per-press ids for acknowledgement, test and activation), so a
new press after a failure continues from the furthest step reached, a
repeated press returns the current status, and a press while one runs is
`409 process_proposal_busy`. A done proposal whose active version has limits
an ordinary run outgrows (turned on before steps were sized) reads with
`resize: true`; its next press saves the sized draft, freezes, tests and
activates a new version and keeps the overview item. A restart marks a
running save as
`process_proposal_interrupted`. Budget not ready refuses the press with
`409 process_proposal_budget_not_ready`. Only the person who drafted it can
read or press it (another person gets 404); members only ever save personal
processes, and the registry, test journal and activation store recheck that.

**Card.** The web chat renders it in `app/chat-cards.tsx`
(`ProcessProposalView`, copy in `app/chat-copy.ts`): "Personal" badge, steps,
inputs, services, assumptions, the **Add to overview** checkbox (disabled
with the reason when ineligible), **Save and turn on** and **Edit**
(`/processes/design?sessionId=…`). While saving it follows the status
(Saving… / Testing… / Turning on… / Adding to overview…), then shows On ✓
(· on your overview), or a short reason with **Open in Processes**; a stop
names its reason in one line (for example "Saved. Its AI step writes by itself, so write its test in
Processes."), and the two limit stops (`limits_exceeded`,
`model_reservation_too_large`) keep **Save and turn on** for a new press, as
does a done proposal with `resize` ("Its limits are too small for a real run. Save it
again."). The mobile app shows the name and **Open in the web app**.

**Designer.** The designer's instructions describe the same sizing, and its
update, validate and read tool results add `limitsAdvice` (`raise` with the
sized limits, or `reservationTooLarge`) whenever the candidate's limits are
below them; the registry validation itself is unchanged, so existing
processes stay valid.

Tests: `tests/process-proposal-suite.node.ts` (generated suites qualify with
actual native runs for a model-free read, read → agent → return, an agent
alone, a confirmed write, an agent and a confirmed write; an agent that can
only write through its own tool is a gap; the CRM-count agent with designer
caps and a whole-context price (200 000 + 8 000): small caps refused as they
are and qualified once sized to 81 536 tokens, a 15 000-token workspace limit
reported as the floor gap), `tests/process-proposal.node.ts`
(status store: per person, retried press, busy, restart),
`tests/process-proposal-http.node.ts` (real app API with synthetic model and
service transports: chat → designer → card, nothing saved, stale card,
save → freeze → test → activate → overview, replay, another person,
administrator, ineligible overview, stopped test, a whole-context price under
a too small run limit stopped with the floor numbers, then sized, tested,
activated and ready to run once the limit is restored, no budget),
`tests/mastra-domain.node.ts` ("process_propose …"),
`tests/web-process-proposal.test.tsx` (card).

Not yet: hazards that only an agent's own tool call reaches (an agent with a
write capability) still need a person's test; the generated test proves the
runtime path with sample data, not the quality of a live model's answers.

## Mobile process selection, inputs and reviewed start

The authenticated mobile Workspace exposes **Processes** in chat and Tasks.
Opening or closing its accessible persistent panel does not start a process or
load a form. **Load processes** uses `ClientSession.loadProcessInventory()`; an
explicit ready-entry selection shows its purpose, agent/workflow kind and exact
version. Blocked entries explain the unavailable service, model, account, source,
qualification or budget. **Prepare form** calls `prepareProcessInput(request,
reviewedEntry)` with a stable original request origin. Both readers use existing
Session authentication, credential renewal and cancellation, not App fetch.

Inventory pagination returns a single immutable full Scope/fingerprint. Mixed,
foreign, repeated, duplicate or nonadvancing pages fail closed; a changed list is
discarded and restarted once with an explanation, never partially selected.
Explicit client resource limits are **4 MiB per response page, 16 MiB aggregate,
10 pages and 1,000 entries**, with **2 MiB per input-card response**. Independent
schema guards retain the registry's 5,000-node/65,536 UTF-8 key/string budget and
the valid 1,577-leaf form; the form guard is not reused as a small global page
limit. These client caps are not a claim that every worst-case registry page fits;
a limit error exposes no partial selectable list.

The actual ProcessInputCardView remains mounted while reviewing and after closing
the panel. Its typed draft preserves omitted fields, null, false, zero, whitespace,
empty collections and array order. Review shows the complete submitted JSON with
quotes and escapes, exact version, conversation and frozen language; no truncated
input can hide behind an enabled Start. Back to edit uses the same draft. A form
first mounted after explicit saved-start recovery uses only schema-validated
original input, with distinct stable array identities. Invalid saved input cannot
become a blank editable replacement.

Session reference, language, conversation and chat generation identify a distinct
React owner. Changed contexts mount a new owner before delayed old results can
publish into it; cancellation is not the sole fence. Inventory/selection changes
advance its read generation, and handlers from an older rendered model cannot
review or start a newer form. A synchronous start latch and the existing frozen
command factory prevent duplicate taps. Offline, stale, needsSnapshot, another
pending request and recovery-blocked storage visibly disable execution. A resolved
`send()` promise is not acceptance; the exact command's state and frozen pending
view determine the result.

The immutable `SessionState.processPending` is derived from the existing scoped
pending envelope, not another ledger. Unknown delivery shows original input and
**Retry same start**, preserving exact command bytes even if the UI context has
changed. Known accepted/rejected delivery with incomplete local saving offers
**Retry saving** without another POST, including offline recovery. Admission
rejection keeps its specific translated reason and original editable input. A
legacy raw command without proof cannot acquire a different current form.
Acknowledged handoff is not process/business success; Tasks and chat continue to
use authoritative server projection.

Exact native process approvals below supply the action approval controls;
integrated mobile process HTTP acceptance supplies the whole rendered, authenticated HTTP/Session integration acceptance. This launcher
does not add a second Mastra runner, native dependency or external service effect.

## Exact native process approvals

Mobile Connections explicitly enables `ClientSessionOptions.processApprovals`. This negotiates `agent-process-work/3` for Work delivery and retains the existing question-aware execution transport. It does not introduce a compiler version or runner: process start and resolve bodies, saved native artifacts and Mastra execution stay unchanged. Both older Work profiles explicitly strip `approval` and `approvalUnavailable`; `/1` also strips existing question metadata. Unnegotiated clients keep the safe textual projection. The nested approval result deliberately omits a generated card, so card negotiation cannot accidentally grant authority.

A complete `native.process.approval` identifies the original waiting node, service/action IDs and revisions, and an awaiting-approval `ServiceResult` from the original invocation through `presentServiceAnswer`. It matches the unique pending receipt and parent link, pinned artifact/node and original admission. Current private read, service/action authority, receipt dependencies/contact source, source freshness, OAuth execution pin and Memory are revalidated. Projection uses capture–Memory validation–recapture; new decisions use the same held identity/authority checks before durable binding, with Memory validation outside the serial queue and a production Memory-generation observer. Recorded original retries remain separate from new decisions.

Incomplete, malformed, oversized or mismatched review returns a safe unavailable reason rather than shortening material parameters or aborting the task snapshot. Full review JSON is limited to 131,072 characters. Earlier unknown receipts preserve uncertainty and prevent a later pending action from obtaining review authority. Known earlier effects and receipt statuses stay visible; a transport ACK cannot turn an action or process into success.

The shared `ServiceActionCard` displays the effect, complete JSON and client-owned source/workspace/native-parent/service/action revision frame. The mobile adapter freezes the target belonging to the rendered review, then compares it against the current Session store before sending. Endpoint, scope, provenance, node, operation, parameters and `native.revision` must still match; the outer projected Work revision is independent. Connection object, language, conversation and chat-generation changes create a new UI owner. Old callbacks, unmount, double press, pending/outbox recovery, offline/stale views and accepted transport cannot mint another decision.

Historical persisted targets from the shared command transport remain parseable without a new review only for explicit exact retries. New approvals always require the complete review. A saved decision A reopens with its original bytes and target even while B is current; no inventory/current B lookup reconstructs its authority. Saved process approval recovery implements human-readable identification of saved A and offline retry of local persistence for a known outcome. Integrated mobile process HTTP acceptance subsequently covers the whole rendered HTTP flow. Component RN-web and isolated HTTP/Session tests are separate evidence; neither is a physical Android or live business acceptance claim.

## Saved process approval recovery

The mobile saved-decision surface derives exclusively from the existing `state.processPending` command, target, outcome and error. It adds no persisted ledger, fake WorkItem, protocol profile, runner or storage version. `ServiceActionReview` is shared with the actionable card; the local snapshot has neutral original-effect wording and no fresh approve/reject controls.

Unknown retry uses the exact original serialized command. A known accepted/rejected outcome whose marker or cleanup could not be saved instead retries local persistence, including offline, without another command or service POST. A passive snapshot refresh is permitted after saving. A known delivery with a native failure keeps that failure visible and does not claim business success. Historical validated targets without an approval review retain the saved receipt, effect and scope while explaining unavailable parameters; current B cannot fill that gap.

The adapter revalidates original endpoint/full scope, command and target. Immediately before retry it compares both complete frozen values and outcome against the current outbox. Session/context owner remount, unmount and synchronous flight guards reject retained callbacks and duplicate taps. Current B remains canonical and unavailable for new decisions while A owns the outbox; raw/proofless/corrupt/mismatched targets cannot retry. Paired HTTP/Session/persistent-storage/rendered acceptance for the full native process is the integrated acceptance below.

## Integrated mobile process HTTP acceptance

The test-only `mobileHttpChildFixture` wraps the existing coordinator HTTP fixture in Node IPC, keeping SQLite and Mastra out of the Expo/Jest loader. It does not introduce an execution layer or public fixture administration endpoints. Browser origins are explicit loopback-only test configuration; production defaults remain unchanged. Incoming command observation records complete UTF-8 bytes without putting the request stream into flowing mode before authentication.

The full native agent scenario has two questions, exact Unicode answers, two separate write approvals and validated typed output. Its canonical counts are five model calls, two service POSTs and five process command POSTs, with zero ordinary command POSTs. Real authenticated Loops reads match the original artifact and succeeded run and remain passive. Test activation uses synthetic recorded qualification evidence; saved Memory gate tests enable real Memory with empty synthetic data. These are execution acceptance fixtures, not live qualification or activation-console acceptance.

The 17 Node integration cases cover lost acknowledgements, file-backed client/server reopen, exact original retry, rejected stale new decisions, local known-result saving failures, denial, failed and unknown actions and invalid output after successful writes. They also exercise current service/action/model/Memory/budget/device/member gates. The browser loss observer sends one unchanged real request and discards its actual response; only that observer ignores client cancellation, allowing truthful telemetry if authoritative history settles the client flight first. Fresh authoritative question history can settle lost answer A locally on reopen while B remains current. Lost approval A retains its original complete target and retries exact bytes; neither current B nor a regenerated command can replace it.

The rendered command `pnpm test:process-mobile-web` exercises the actual App and shared Session against that HTTP server. It covers EN/CS, narrow/wide screens, typed inputs and exact multiline answers, Chat/Tasks history, saved original approvals, offline local saving, positive localized failure/unknown/rejected receipts and actual nested scrolling of long parameters. It uses no canned WorkItem or Session state. See the self-hosting instructions for the optional external Playwright runtime and the precise remount/native-peripheral limits. The final root matrix passed 28 cases and 485 checks with 42 screenshots; all 98 source fingerprints were unchanged. There were zero external requests or unexpected errors/warnings; the two deliberately revoked starts produced expected HTTP 422 responses and visible rejection. Fresh independent review passed 43 focused HTTP tests, four held-dependency probes, the four-assertion focus probe and four final rendered cases with 80 checks. Its 98 fingerprints exactly matched the root matrix; no actionable P1/P2 remain. The accepted scope excludes physical Android/native audio/SSO and live qualification or business effects; migration and physical acceptance remain open.

## Qualified CRM/Calendar pipeline

The test-only `pipelineHttpChildFixture` extends the real designer HTTP fixture
in Node IPC. It keeps SQLite and Mastra outside the Expo bundle. Administration
and mobile clients use actual authenticated endpoints and schema validation;
only known synthetic model/CRM/Calendar transport is scripted. Passive setup
creates services and actions, with no process, activation or business receipt.
The designer calls `design_update_proposal`; the human acknowledges assumptions,
accepts the draft, freezes it, executes the native suite and explicitly activates
the qualified artifact. This is distinct from the integrated mobile acceptance's recorded test evidence.

The immutable compiler `/3` workflow is CRM lookup → specialized agent with an
exact text question → Calendar availability → native availability branch →
approval-always meeting create → readback → typed output. The create request
contains contact ID, participant name/email, calendar ID, title, absolute start
and end with offset, and IANA time zone. The adapter's canonical input contains
the actual HTTP body. Unavailable slots take the non-writing branch and return
a typed unavailable result; missing input dispatches nothing. The native suite
qualifies all six scenario families against both configured and generic agents,
12 observations per artifact, before controlled-test activation.

The public HTTP/Session tests cover success, denial, pre-dispatch Calendar
failure, lost reply after dispatch, unavailable slots, missing input, lost answer
and approval acknowledgements, and fresh service/model/permission drift. Known
success has one meeting POST and readback; denial and pre-dispatch failure have
zero meeting POSTs. Unknown has one uncertain POST, no readback and no resend.
Native-test failure uses a scripted CRM rejection; public pre-dispatch failure
uses Calendar. Exact answer whitespace/newline survives transport and original
command retries. Lost-ACK tests reuse the same Session and exact command after
server restart; they do not establish pending client reconstruction, which has
separate integrated mobile acceptance evidence.

The optional rendered harness drives actual Services/designer/test/activation
screens and actual App/Connections/ClientSession rather than manufacturing Work
state. It records complete incoming command bodies, validates canonical action
receipts and reads authenticated Loops for the same provenance. Source hashes
cover bundled client and complete backend, administration, protocol and fixture
source roots. See the status document for the final executed matrix and counts.
The final checkpoint passed five cases, 279 checks and 15 screenshots with all
382 source hashes unchanged, no external calls or unexpected errors/warnings.
Five anonymous pre-login overview 401 responses were expected. A separate root
CS360 scroll probe passed 66 checks and exposed the last bounded output value
inside the actual clipped chat viewport; its source hashes match the matrix.
App remount retains the web vault and is not a full browser reload or physical
native storage test. No live model, CRM, Calendar, SSO or audio quality is implied.

The existing output card is bounded to eight top-level fields. The complete
validated result remains in runtime HTTP output and canonical readback receipts,
but meeting ID/status can fall outside that card. Accessible full output disclosure is separate work; the current summary is
not claimed to contain every field. Migration and physical acceptance remain open.

## Original identity secret and copied process restore

`openIdentity` rejects an existing `identity.sqlite` whose original `secret` file
is absent before database open or key generation. Failure leaves database bytes
unchanged and releases the owner lock; adding back the original secret permits
reopen. A successful open still runs the release's normal schema migrations.
Fresh identities still generate a private secret. Malformed existing secrets
are not replaced. A valid-format wrong key can bootstrap but fails decryption of
the synthetic configured provider; returning the original key recovers the same
ciphertext. This guard detects a missing key, not arbitrary matched-set damage.

The restore helper is test-only: it closes the owner, copies every regular file
under the fixture root with original permission bits, compares byte hashes and
checks integrity and foreign keys for all SQLite files before runtime reopen.
Before capturing the test baseline it performs a complete WAL checkpoint and
requires closed sidecars; busy or orphaned native state refuses copying. Integrity
inspection uses a disposable complete clone, including WAL/SHM, so a normal
read-only SQLite connection cannot change the protected original or target.
It relocates configuration paths and preserves the original server ID. The
actual activation and Session regression suspends A on qualified v1 and B on
qualified v2 before copying identity, secret, native and workflow state. Passive
reopen retains both pins and full approval snapshots without inference or
dispatch. Explicit rollback selects v1; old activation receipt replay preserves
that pointer. A/B then resume their own versions with exactly two writes, a new
run selects v1 and its denial adds no write, and resolved HTTP replay/reopen adds
no inference or effect.

Three historical catalog-router tests use authentic retained `agent-1` journals
and the current router for succeeded/rejected/unknown continuation and replay.
They preserve canonical receipt identity, actor, input and original journal kind;
new ordinary chat chooses native Mastra. Historical denial remains its original
plain cancellation reply, without inventing a modern result envelope. This is
not paired HTTP coverage of legacy/progressive question histories.

Eight additional paired HTTP tests produce authentic `agent-1` and
`progressive-1` journals with the retained runtime, then stop and copy the entire
server tuple. Only the current runtime is used after the copy. Six original
pending approvals continue to succeeded/rejected/unknown with the same operation,
input, actor and revision bindings. Two waiting questions are produced before
an outer command receipt exists; the first current public command recovers the
original question without a new model or decision call. Two actual owner
reopens, passive snapshots and exact-byte replay preserve raw identity/workflow
ledgers, receipts, journal kind and the entire protected source manifest/modes.
Fresh command-ID context continuity is a separate acceptance condition.

Two additional genuine paired HTTP negatives qualify and activate a native
artifact with twelve observations and suspend its original approval before
copying. A copied foreign server ID refuses bootstrap; restoring only its exact
original bytes recovers the original pin and approval with one write, followed
by passive replay. Removing only the copied canonical native SQLite family
preserves passive pending history but the original approval returns
`failed/process_checkpoint_missing`. Work context, result and a reachable card
notice explain the failure; the canonical action receipt remains
`awaiting_approval` without a fabricated result. Exact replay and owner reopen
add no model or service dispatch. Whole hashes and original authority are
preserved in both branches.

The restore tests also cover deferred libsql native finalization after awaited `close()`.
A separate GC-enabled worker uses the actual qualified, activated and paired
waiting run, verifies its exact suspended parent checkpoint against the trusted
journal, refuses a real held-reader checkpoint and orphaned sidecars, and proves
original whole hashes after forced GC and passive paired reopen/replay. GC is
only a fault probe, not part of the snapshot barrier. This is fixture stability;
the production runbook requires the owner process to have exited.

Two further genuine paired regressions cover a missing completed native test
and a concrete same-server-ID mixed set. Deleting the copied completed job with
foreign keys enabled also removes its original admission ordinal; form
preparation and fresh start/approve/deny fail without backfilling either record
or dispatching a model/service. A mixed set retains the earlier waiting domain
and workflow snapshot but replaces its native database with a genuinely denied
later checkpoint. The original approval returns a visible
`process_checkpoint_interrupted` failure while its canonical action receipt
remains `awaiting_approval`. Exact replay and owner reopen add no effects.
Recovery is proved on a separate complete original snapshot fork with its
original client cache: the original pin completes with exactly one write.
Neither test resets receipts or client cursors inside a live failed copy, and
all protected original bytes and modes remain unchanged.

The bounded synthetic restore acceptance is complete. The legacy question sections below prove
original-question context and current READ/Memory continuity across an
interleaved native run; pre-existing legacy failures covers original failed
legacy receipts; unverifiable saved execution covers admitted domain proof loss and saved execution recovery.
These explicit cases close the matrix without implying arbitrary corruption
recovery. The [restore runbook](self-hosting.md#matched-restore-and-process-rollback)
requires one matched stopped snapshot and controlled passive validation. Process
rollback changes future version selection and does not compensate business
effects. Neither these tests nor compiler compatibility imply support for an
untested old server binary or production failover.

A genuine isolated negative probe found the missing-reference gap, now
addressed. The native owner now requires the original qualification reference for
activation, form preparation, admission and execution of an existing pin. A
missing reference returns `process_qualification_unavailable`; it cannot fall
back to historical `recordTest` evidence. Only a detached contract store retains
that legacy behavior. Passive version provenance and exact recorded terminal
replay remain readable without granting a new execution permission.

Two permanent copied-tuple regressions qualify and activate a real native
artifact, then delete only the copied reference or its native admission ordinal.
Missing ordinal returns `process_test_superseded`; completed qualification and
historical passed evidence do not backfill it. A new public start and fresh
approve/deny decisions fail without model or service dispatch. Restoring the
exact original reference or ordinal row, including its original sequence,
permits the original pending run to finish on the same pin with one write.
Passive reopen before approval and exact replay after a completed owner reopen
add no inference or effect. It neither retests nor activates a replacement
artifact; the protected original tuple stays byte-identical. These two proof
loss cases do not establish that every mismatched native/checkpoint set is safe.
The bounded restore acceptance also covers missing native family/job and the
declared same-ID mixed checkpoint case. Actual inventory/drain and engine
removal, and the deferred physical acceptance, remain open.

Some lower-level HTTP tests seed explicitly synthetic private qualification
metadata so they can exercise unrelated execution boundaries through the real
gate. Those observations were not executed. They do not create a production
exception, a false native-run audit event or evidence of actual qualification.
The copied-reference regression and the qualified CRM/Calendar pipeline use the actual isolated
native qualification runner instead.

Budget exhaustion and policy drift are separate conditions. A frozen model-call
limit can stop the next model turn after a succeeded write, preserving its
canonical receipt. Changing the budget policy during an in-flight service call
also invalidates the saved qualification environment. If the response cannot be
committed under current authority, the dispatched write remains `unknown`;
neither the HTTP error nor a stale client snapshot makes it safe to repeat it.

## Native budget failure explanations

Ordinary native chat preserves the server-owned causes for missing model
pricing, exhausted or overrun budgets, unverifiable usage, changed policy and
oversized estimated input. In-run failures use the existing retirement and
terminal publication proof; they retain canonical succeeded/unknown actions
and their cards. The step limit retains its original distinct explanation.
EN/CS replies preserve the submitted text and explain the cause and next step.
An uncertain write still requires checking its effect before another attempt.

A budget rejection before native execution uses the existing rejected
`integration_unavailable` envelope and a specific durable reply. It does not
become `revision_conflict` merely because its internal HTTP status is 409.
Real revision conflicts and revoked publication remain guarded. The shared
client banner now refers to the request and its reply instead of claiming
that every such failure concerns a calendar connection. Provider error codes
cannot claim the server-owned `catalog_budget_` namespace; historical
`provider_response` receipts also retain provider, rather than internal-price,
presentation. Comparison reports preserve exact budget codes for configured
and generic strategies without weakening qualification expectations.

Twelve real paired HTTP/ClientSession cases cover missing tools/decision
pricing, frozen exhaustion, pre-native continuity rejection, and exhaustion
after confirmed or uncertain writes, in both languages. Prices and limits are
configured through the owner API before each attempt. Missing pricing is
tested before writing; post-write cases use actual frozen exhaustion after
three model calls, one mandatory decision and one service POST. Two actual
owner reopens, exact-byte replay and passive refresh preserve messages, cards
and raw identity/workflow ledgers with no additional dispatch. These are
synthetic transport regressions, not live-model or physical acceptance.

## Complete passive output and shared mobile detail

A successful process keeps its bounded eight-field card preview and explicitly
states the displayed/total field count, clipping and redaction. The complete
safe value is available through `agent-process-output/1`; it is not placed in
the card document or the process-start envelope. Root output remains an object
validated against the original pinned output schema. Empty strings, null,
false, zero and empty containers remain distinct values.

The authenticated capability GET is
`processes/output/capabilities?profile=agent-process-output/1`. A strict,
same-Scope capability lets ClientSession negotiate `agent-process-work/4`.
Older or unsupported servers retain work/3 and a localized availability
explanation. Earlier work profiles strip output references and metadata in
both snapshots and events.

The passive GET `processes/output?profile=agent-process-output/1&request=...`
accepts a JSON request containing the exact output reference, ordinal path and
cursor. The reference binds Scope, admission/origin, parent run, native journal
revision, pinned provenance/artifact, sanitized output digest and redaction
version. Property/item paths use ordinals; secret keys are not path or cursor
contents. Continuations bind the same reference, path and next offset. Readers
reject mixed, skipped, repeated, malformed, stale or oversized pages.

Sensitive keys, unsafe labels and sensitive values are structurally redacted
before hashing, preview or paging. A redacted node contains no hidden value;
the public digest is not a hash of the raw secret. Each page is at most 65,536
actual UTF-8 serialized bytes and 16 children, with fewer children when long
escaped values need more bytes. Requests are at most 20,480 bytes. Reader-only
resource limits are 8 MiB/131,072 value nodes and 24 path segments; valid scalar
strings retain the existing 4000-character schema limit. Exceeding reader limits
does not rewrite a successful business result as failure.

Tasks and output reads share capture, Memory validation outside the identity
queue, fresh capture and final publication validation. The proof recursively
checks operation/source receipts, dependencies, contact sources and verified
Memory pins against current scope, status, authorization, TTL and OAuth pins.
The traversal is bounded to 256 receipts and 1024 dependency edges per root;
missing, malformed, foreign, cyclic or excessive dependencies fail closed.
Neither a saved epoch nor a previously successful receipt is sufficient proof
of current disclosure authority.

Historical events are gated before profile downgrade by the exact freshly
authorized current WorkItem body. Other saved process bodies lose private
cards, result/context, references, approval/question/answer detail and receipt
summaries. Event identity/sequence, entity/native revisions, provenance and
recorded operation IDs, effects and statuses remain unchanged; stored history
is not rewritten. Final snapshot/event queue reads revalidate the task window,
returning `503/task_projection_changed` if authority changed before delivery.

One shipped mobile inspector serves Chat and Tasks through MobileWorkItemCard.
It reads only after explicit opening, navigates pages and subtrees, and displays
selectable literal text with EN/CS controls. It performs no command, approval,
model or service dispatch and does not persist fetched pages. Session, Scope,
conversation, language, chat generation, native revision and digest changes
hide private values and cancel reads. Late responses cannot reopen an old
owner. Closing/reopening starts from the root; detail navigation resets scroll.
The modal backdrop permits pointer dismissal without taking keyboard focus.

## Legacy question continuity into native Mastra

A new human answer to a paused `agent-1` or `progressive-1` question can start
one fresh `mastra-1` root with the original goal, exact question and currently
authorized completed READ receipts. The old journal is parsed as bounded,
untrusted context. Its pending calls, executable plans, approvals and write
authority are never adopted by the new root. A subsequent write still requires
a new reviewed human approval.

The original authenticated message receipt and its canonical question must
bind to the same Scope, actor and conversation. This proof is also required for
`progressive-1`, whose historical journal does not carry conversation identity.
The binding records the exact original journal digest, request and source
receipt digests in the existing native command journal. It does not create a
second runner or continuation ledger. Only one accepted native root may bind
an original question; ambiguous or duplicate bindings are rejected.

The original question must still be inside its 30-minute resume window.
Inherited sources are limited to 32 current authorized READ receipts, including
their dependencies. Current receipt status, Scope, policy, TTL, OAuth pins and
Memory validation are checked before decisions, model calls, action dispatch
and publication. The Tasks publication observation includes the original raw
journal and public question proof, so an otherwise inert journal change or
expired question also invalidates a previously captured view. A forget or
opt-out change cannot be bypassed by the saved context.

Message, Tasks and approval contexts forward the owner's current validation
method with its original receiver, then any request-specific guard. Copying a
context must not freeze or remove a guard that changes during inference. A
late authority conflict therefore cannot publish even a safe fatal answer.

Lost or expired continuation proof produces an explicit EN/CS explanation to
start a new chat and check current data. A new command in the same conversation
does not bypass that refusal. Exact original retries and passive reopens keep
the old history and receipts. Broader legacy executable-state drain and the
full migration matrix remain later work.

## Conversation-bound legacy questions

Legacy handoff discovers the outstanding question through its current
authenticated public command/question proof and conversation. A newer native
domain run may move the global catalog cursor without hiding that question.
The selected origin starts a fresh native thread, including when unrelated
native work used the same conversation. The intervening run does not supply
thread authority, READ sources or Memory pins. Original public command IDs and
idempotency keys may differ; their existing provenance tuple is preserved.

The passive query returns at most 400 potentially outstanding origins; an
additional candidate causes an explicit refusal. Multiple proved questions,
hidden pending handoffs and duplicate canonical bindings also fail closed.
One valid accepted root permanently consumes its origin before this limit,
without refreshing the old deadline, public proof or current access. Canonical
identity and strict origin metadata are validated before pending/accepted
classification, so a malformed known decision marker cannot disappear and
cause a second continuity decision. Alias copies remain distinct from roots.
Pending uniqueness is rechecked before accepting an asynchronous decision.

This is passive context transfer through the existing journal and queue, with
the legacy question continuity execution/publication guards intact. No historical executable
calls, tool-call identities or approvals become native write authority. Known
completed agent histories and older progressive records with absent or false
pendingInput remain passive; conversation identity is never inferred from
assistant text. Explicit new-session and exact-command recovery paths retain
their existing meanings.

The genuine synthetic regression covers both old runners, a completed
authenticated native-domain C2, then a real public HTTP/ClientSession C1 answer
after reopen. It checks actual provider context and preserved raw receipts.
The public fixture still rejects an unknown C2 conversation before inference;
this does not establish two publicly admitted conversations. Failed/cancelled
intervening-run controls use the supported C1 conversation with explicit native
new-session admission. Validation concerns known canonical adoption bindings
with available original references; arbitrary corrupt database recovery and
broader matched restore/drain acceptance remain separate work.

## Correlated process outcome announcements

Chat and Tasks share `ProcessCommandNoticeView`. Its bounded display metadata
comes from a strictly validated process response and binds the exact command,
connection, Scope, conversation, native root/revision and provenance. Its
ephemeral UI owner also binds the ClientSession instance, identity, language
and chat generation. A late response cannot attach an old process explanation
to a fresh command or another conversation.

An unknown effect asks the person to verify the original action before trying
again. Human rejection is described as a declined action; previously recorded
effects remain available. A failed process shows an allowlisted safe reason
or an explicit result-to-review explanation. Actual admission, configuration,
authorization, storage and transport errors retain their own causes.

Runtime and local error causes are distinguished by typed ephemeral metadata,
not by matching their raw strings. Thus a provider's failure code cannot
masquerade as a later local authentication or storage error. An accepted saved
answer without a current correlated native notice shows that its result needs
review; its historical raw code is not presented as a current diagnosis.

The original answer ledger, command bytes, canonical receipts and recovery
barriers stay authoritative. The optional bounded notice uses the existing
process outbox; it introduces no second command ledger. Rendering, reopening
and local persistence retry do not grant approval or create another business
dispatch. The view has named accessible announcements and EN/CS stories.

## Exact saved-memory retention

New and revised Memory records use one clock reading for `createdAt`,
`updatedAt` and the retention deadline. The deadline is exactly the current
retention policy after creation, even if the clock advances between operations.
Exact request replay retains the original record and timestamps. Existing
source, permission, forgetting, opt-out and transaction rules are unchanged.

## Pre-existing legacy failures

Both retained runners can passively restore a canonical failed write recorded
before a complete stopped matched copy. A current authenticated original
message and resolve read that original receipt even when no outer command
receipt existed at the copy boundary. Progressive raw history may retain its
old approval projection; current public cards use the canonical failed state.
No historical approval becomes executable native authority.

The genuine regression produces failure through the retained runtime, after
claim but before guarded dispatch. It preserves original identity, input,
revisions, policy, audit and operation link. A dispatched write failure remains
unknown with verify-first guidance. The shared-key fixture proves absent
optional execution pins and dependencies, rather than a populated OAuth pin.

The ten-case matrix includes both kinds and succeeded, rejected, unknown,
question and failed. Existing approval cases copy pending and finish in the
current runtime; the two new failed cases copy an already failed receipt.
Immediate exact retries, two actual owner reopens and changed-input conflicts
preserve raw ledgers, complete source hashes/modes and all inference/service
attempt counts. Independent observers inspect every original-operation card,
including earlier messages, and require failed text without active approval.
The unverifiable saved execution section subsequently closes admitted-journal loss and saved-command
explanation. This is isolated restore evidence; broader legacy drain,
physical device and live-service acceptance remain separate work.

## Unverifiable saved execution

An exact current `process.start` or profiled `service.resolve` HTTP409 body
containing only `error: process_start_conflict` does not prove an admission,
business failure or a specific missing journal. Session retains its original
unknown delivery and exact serialized command, target, execution profile and
provenance. Only private presentation metadata in the existing outbox changes.
There is no new wire profile, receipt, native notice or execution authority.

The EN/CS recovery explanation says the server could not verify the saved
execution details and the result remains unconfirmed. Its private marker is
published only after the owned queued write succeeds, with a second owner
check after the await. Rejected unknown writes do not use known-outcome
readback semantics. Restore validates the entire original outbox and identity
before showing it. Current storage/auth/interruption failures and a genuine
native notice take precedence; provider or thrown raw strings cannot select
the internal marker or translation key.

Genuine stopped-copy journal loss retains one explicitly declared FK orphan,
the original canonical invocation and all other identity/native rows. First
original start/approval409, exact retries and two owner/Session reopens add no
work. A separate conflicting present journal receives the same general copy.
Restoring the intact original proof permits the saved same-byte decision once;
replay adds no effects. Passive history is not a repair or a new grant.

The accepted QA record distinguishes genuine
backend HTTP, synthetic-transport rendered UI, whole-suite and independent
source scopes. It closes the bounded restore matrix; it does not establish
engine removal, arbitrary corrupted-data recovery or old-binary downgrade.
