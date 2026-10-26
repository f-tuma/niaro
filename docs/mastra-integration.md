# Native Mastra integration for Niaro

Mastra is the runtime of every chat turn and every process run. This guide
describes how the server drives it: what the model knows, how tools are
exposed, how a turn is bounded, checked, streamed and stored. The older
"progressive execution" in [services, actions and AI routing](service-catalog.md#decision-mode-jev)
is legacy: stored turns from before October 2026 replay that way, new turns do
not use it.

**Verification status (October 26, 2026).** The loop mechanics are covered by
synthetic suites with a scripted model and scripted Jev
(`tests/agent-trust.node.ts` and the `tests/mastra-*.node.ts`,
`tests/agent-*.node.ts` suites). Live-model behaviour is measured with
`pnpm eval:trust:live` on `openai/gpt-6-luna`: the `robust.*` matrix (6 of 6,
median 23–27 s) and the `ui.*` matrix (12 of 12, median 6 s) on October 24–25,
see [agent trust](agent-trust.md). The pilot company runs the same build in
production; what the live Jev checker decides on real answers, and the
calendar and personal-OAuth chains (NIAR-46, NIAR-47), still await live
verification. The paragraphs below that mention a date are implementation
history kept for context.

Mastra owns the agent/tool loop, conversation history, native run/tool-call
identity and durable execution checkpoints. Niaro supplies direct tools,
per-step processors and a native model adapter. There is no invocation of the
old agent or progressive planner inside a Mastra Agent.

| Responsibility                                                                               | Implementation                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Native Agent, durable stream/resume/recovery and Memory                                      | `apps/server-agent/runtime.ts`, `recovery.ts`        |
| Public command, actor/conversation/run locks, aliases, passive receipts and Loops projection | `apps/server-identity/mastra-runtime.ts`             |
| Fresh permissions, source/memory pins, discovery, approvals, budgets, canonical verification | `apps/server-identity/mastra-domain.ts`              |
| AI SDK V4 provider through Niaro credentials and IntegrationTransport                        | `apps/server-integrations/mastra-model.ts`           |
| Exact authorized business effects and durable invocation receipts                            | existing `CatalogController` / `ServiceCatalogStore` |
| Long-term remember/revise/forget, attribution, expiry and opt-out                            | existing `MemoryStore` / `createMemoryRuntime`       |
| Thin current command entry with historical drain dispatch                                    | `apps/server-identity/catalog-runtime.ts`            |

The backend workspace package pins core 1.74.0, memory 1.35.0, libSQL 1.25.0,
AI SDK 7.0.127 and provider types 4.0.21. Framework imports are checked out of
mobile, client-core, protocol, UI and the browser console. The application uses
public native APIs; the native model interface is also exported by this backend
package so framework types do not leak into the app's root dependency graph.

## Direct execution and current authority

The input processor resolves the current configured model, rebuilds authorized
context and exposes the action tools of the turn at every model step. The
output processor checks the actual scoped receipts and can request a bounded
native processor retry.

### Approvals and Mastra's human-in-the-loop

A write action calls `controller.invoke` with `approve: false`; its receipt
is `awaiting_approval`, the turn records `pending = {kind: "approval",
operationId, toolCallId}` and the Mastra run suspends (`closeOnSuspend`), which
is Mastra's own suspension of a tool call: the person's decision later resumes
it with `agent.resume(runId, {resolved: true}, {toolCallId})`, the same
mechanism `requireApproval` uses underneath. Mastra's `approveToolCall` /
`declineToolCall` are not used for the decision itself: the identity of what
is approved lives in Niaro's receipt (operation id, action revision, personal
sign-in pin, revision of the work item), the decision is an authenticated,
idempotent, audited `service.resolve` on that receipt, the input was validated
before the card was shown, and a repeated or late decision cannot run the
write twice (Mastra issues #26133 and #26771 describe both gaps in the
framework's own flow). What the stream carries (`data-tool-call-approval`)
is the approval part in the shape `@mastra/ai-sdk` emits, so an AI SDK or
assistant-ui client renders it natively, while answering it stays the
`service.resolve` command.

### What the model knows about the services

The instructions carry a "Connected services" listing: every enabled service
with its description and every action the person may use, as `name (read|write):
description` (120 characters each, 12 KB in all; a service over the budget is
listed by names, and over that by its count). A description is written by the
service, so the listing is framed as untrusted data and shows only the first
sentence of each description, skipping one that reads as an instruction
("Always call this first…"): a remote MCP server cannot steer the loop through
its tool descriptions. The model therefore sees what is
connected before it searches, and an answer like "no service holds this" is
grounded in the listing rather than in a search that found nothing.

Action tools are exposed three ways, in this order of preference:

1. **Directly from the first step** for a small service: at most 8 allowed
   actions and 24 KB of input schemas in all (Microsoft 365 with 7 actions,
   a web analytics service). The model calls such an action in its first
   step. A large service (Twenty has hundreds of actions, 2–3 KB of schema
   each) is not exposed this way, since its schemas would cost thousands of
   tokens on every call.
2. **`use_actions {actions}`** with up to 8 exact names from the listing
   (an action name, its tool name, or "service action"; a name only one
   action contains also matches, since models drop prefixes). No decision
   model is involved. Unknown names come back with the closest action names.
3. **`find_service` / `find_actions`** search by need, with Jev as a hint:
   when it sees no fit, the model still gets every service, or the closest
   actions, never an empty result.

The actions the previous turn of the same chat exposed are exposed again from
the first step, so a follow-up question calls them at once. A turn exposes at
most 24 action tools; `use_actions` evicts the oldest beyond that. Checker guidance lives in a tagged native MessageList
system bucket, so replacing ordinary instructions does not discard it. Jev
remains an optional bounded selection/verification call, not a second planner.

The consistency check (Jev judging whether the reply answers the request
from the receipts) runs only where the answer carries risk: a write this
turn with any outcome, an item created or closed in Tasks, an explicit
contact lookup, or an unresolved failed or rejected write. A read-only
answer goes out without it. The check costs a model call per turn and, in
production, returned low-confidence "incomplete" verdicts on plain answers,
which cost a repair round and sometimes replaced a correct reply with a
refusal (NIAR-229).
The console no longer offers a choice between two execution engines.

Provider calls retain Niaro's endpoint, credentials, guarded transport, personal
OAuth pins and last authorization check inside the identity queue. Unsupported
file/provider tools fail before SDK prefetch. Native retries and eager/parallel
tool execution are disabled. A chat turn that reports a draft asks the provider
to stream (`stream: true` with usage in the last event); the guarded transport
hands each server-sent event to the model as it arrives, under the same origin,
address and size checks, and the model passes the growing reply text to the
draft, and a client that accepts an event stream gets the draft and each
tool step over its own request (`openAnswerStream`). The SDK still receives
the call only once the whole completion is
assembled and validated as a non-streamed one, so tool calls, finish reasons,
usage settlement, errors and the processors behave as before. Calls without a
draft observer, `doGenerate`, decisions, and transports that are not marked as
streaming (tests, the live evaluation harness) keep the buffered request.
Chat requests share persistent per-command limits:
24 model steps, 60 total inference calls, 20 catalog action attempts and 24
exposed action tools; provider daily request limits also apply. A chat answer
often reads several services and pages through records, so these are above
the generic limits the process tests simulate (12 model steps, 40 inference
calls, 12 action attempts), which stay recorded in the process test settings.
The last two chat steps offer no tools (`toolChoice: "none"`) and tell the
model to answer from the results it has and to say what it could not get, so
a long request ends in an answer instead of a step-limit failure; the second
leaves room for one checker repair. Each chat model call may write up to 8,000
output tokens (the usage limits clamp it to the model's "Max reply"); the
former 1,600 cut off reasoning models before a tool call or a table. These are request
limits alongside the durable token/cost ledger. Ledger enforcement requires an
explicit workspace policy and revision-pinned model prices; initial observe
mode records unknown usage without claiming a financial cap. Neither type of
limit guarantees model quality or an external provider's exact bill.

Each newly parsed provider tool call receives a server UUID. Provider IDs are
not trusted as native history identity: a repeated ID must not pair a current
call with an older result. Replaying a saved native call preserves its ID.

History and memory are untrusted context. Tool outputs contain opaque receipts;
fresh sensitive read results are projected into current authorized instructions.
Completed reads remain subject to scope, policy revision, expiry and source
authorization, including a read whose return value was lost before its source
projection. The same checks run immediately before service dispatch and approval.

A bounded thread authority manifest accumulates source operation IDs and memory
generation pins across turns, without copying the transcript. Every dispatch
revalidates it. A new task rotates to a fresh native thread when old authority
expires, changes or is unmapped; an explicit pending continuation keeps its exact
thread and fails before attachment. Capacity never silently drops a dependency.
Jev receives human-authored history and freshly authorized evidence. Stored
native history keeps tool arguments opaque (`{}`). What the provider sees is
projected on every model call (`projectProviderHistory`):

- A valid call the model made in the current run shows the arguments it
  actually sent. A call replayed as `{}` is one the model copies, which made
  later calls fail validation until the step limit. Arguments over 4,000
  characters (a whole process proposal) are replaced by a named
  `niaroOmitted` marker, so a request does not outgrow its budget.
- A rejected call stays opaque beside its error, and a call restored from a
  checkpoint stays opaque: its authority is derived again.
- Earlier turns' calls are not replayed: each assistant message's calls
  become one note naming them and how they ended (for example
  `find_actions (succeeded)`), and their results are dropped with them, unless
  a result belongs to the current turn (a resumed approval).
- Old private or unmarked assistant text is withheld; server-marked public
  conversation remains available.

This projection also covers old native rows without modifying executable calls.
An answered clarification retains its exact server question as bounded business
InputRequest metadata. Current authority guards its transient projection into
the native prompt and Jev, so restart can continue the original goal without
restoring private transcript arguments. New tasks and memory mutations clear it.

An action tool binds its native tool-call ID to a durable business operation
before I/O. It calls the actual CatalogController. Approval suspends that native
tool call and projects the existing typed service card. Authenticated
`service.resolve` approves the exact server operation and stored revisions;
native resume data alone never grants permission. Terminal and unknown receipts
remain passive, and an unknown write prevents another automatic write in its run.

Conversation and run locks survive the transition from waiting for a human to
processing their answer. A second concurrent continuation is rejected rather
than starting an unrelated run. Server-owned aliases bind retried answers to the
same run, thread, exact body and authenticated command fingerprint. Native
resource IDs include server, organization, workspace and person; thread IDs
add conversation/task identity. Clients cannot choose a native resource or run.

## Persistence, recovery and memory

No external Mastra server is required. LibSQL creates
`<identity-db>.mastra.sqlite` beside the identity database, with mode 0600.
Native Memory retains 40 messages. Semantic recall, embeddings, observational
memory and native working-memory extraction are disabled until retrieval and
deletion policy are evaluated. The identity service closes the native owner
before its identity database. Back up both databases and their SQLite journal
files consistently with the server stopped.

Native checkpoints and business receipts do not share a transaction. An
orphaned RUNNING checkpoint is inspected for an exact agent/run/thread/resource
binding and recovered through public `recoverActiveRuns`; current authority is
checked before attaching and before each new dispatch. Suspended runs require
the exact explicit human continuation. There is no unscoped automatic boot
recovery. Durable stream caching is disabled, and stream cleanup waits for the
native persistence tail so an old segment cannot consume a later resume.

Mastra 1.74 removes terminal successful, failed and cancelled snapshots. User
cancellation is therefore tested separately from SIGKILL. Explicit retry after
a cancelled pre-effect call may produce a new native tool-call ID. Actual hard
process recovery preserves the original saved ID. Neither case may repeat a
known committed or unknown effect. If only a business write receipt survives,
the public adapter reports that outcome without claiming the remaining task
was completed or starting fresh inference.

Long-term memory uses Niaro's explicit facts and private/shared permissions.
Native conversation history does not replace MemoryStore. A revision commits
its mutation, idempotency receipt, domain projection and new memory generation
in the same identity transaction. The next model step rebuilds context. A
subsequent forget or opt-out invalidates the committed generation before an old
native checkpoint is attached. Native memory-tool arguments are redacted to
`{}` in transcripts; executable durable checkpoints retain their original call
inputs for guarded recovery. Sensitive search results are temporary authorized context. A replayed
mutation returns the current deleted receipt rather than resurrecting its old
status. Erasing a memory item does not delete separately retained conversation
messages; general scoped conversation retention is still open.

Loops receives bounded operational events and exact business action details.
It contains no raw prompts, hidden reasoning or unrestricted provider payloads.
Unknown native tool names produce a static “Unavailable tool” failure, never a
model-controlled metadata label. Missing native traces do not reconstruct a
second transcript. The business journal has no transcript, pending-call batch
or copied conversation history.

## Remaining work and verification

Run `npm run test:agent` for native adapter, domain, scoped Loops, public runtime,
crash and trust regressions; `npm run test:identity` also covers authenticated
server flows. Fixtures use actual
Niaro stores and native Mastra APIs with synthetic transports; no paid inference
or real CRM/calendar effect is implied.

The old agent/progressive loops exist only behind the lazy historical drain
adapter. New work always uses Mastra, regardless of the old planner field.
Inventory and safely close old pending runs before deleting that adapter and
the old engines. Never convert an old pending batch into executable
native calls or replay an unknown effect.

A standalone passive inventory of an explicit copied tuple is accepted in
bounded isolated tests; see [the offline inventory procedure](self-hosting.md#offline-legacy-inventory--7-october-2026).
It opens SQLite only in a disposable complete clone; the original files are
hashed and copied without runtime bootstrap. It does not use ordinary store
constructors, resume historical engines or rewrite receipts. Enumeration and
classification are separate from snapshot provenance. An offline manifest cannot
prove original owner exit or a common checkpoint, so the standalone report stays
incomplete even when all declared rows are classified. Active or unsupported
bindings prevent any zero-work claim; canonical terminal receipts retain their
original effect meaning. This inventory supplies evidence for retiring the old engines, without
authorizing drain or engine removal. Report profile `/3` adds a redacted,
unclassified projection of native identity-journal rows and bounded counts from
the exact supported `@mastra/core@1.74.0` / `@mastra/libsql@1.25.0`
workflow-snapshot/background-task
tables. It does not read their status or private payload fields, inspect other
Mastra tables, or infer lifecycle from journal/database data. Projection
row/byte limits and schema drift stay explicit blockers; all SQLite files must
be assigned a manifest role so an omitted native database cannot look absent.
The inventory proves exact offline ownership of `service-process-1` action receipts, but not
settlement. Unmatched receipts and native lifecycle remain explicit blockers.
Observed native rows are visible, while retiring the old engines still requires
a real stopped inventory, safe drain/closure and engine removal.

The full native mechanical trust CLI is also accepted: 18 scenarios and
86 checks passed without a filter or allowed gaps, covering actual native tools,
processors, durable invocation and exact original-run recovery. This is
synthetic mechanical evidence; live-model quality and physical acceptance
remain separate.

Explicit [native Tasks selection and return after a topic detour](native-tasks.md)
are implemented. Native per-thread execution is not a multi-task scheduler.
Conversational service design, process testing/activation/versioning, service
setup and the shared mobile process harness are accepted in their
documented isolated scope. Remaining acceptance includes bounded live-model
evaluation, deferred migration/physical verification,
physical Android/audio QA and multi-process recovery
ownership. Current recovery assumes the existing single identity-server owner;
native default pub/sub leases are process-local. These limits are not hidden by
passing deterministic tests.

Primary references: [durable agents](https://mastra.ai/docs/harness/durable-agents),
[human in the loop](https://mastra.ai/docs/agents/human-in-the-loop),
[memory](https://mastra.ai/docs/memory/overview),
[snapshots](https://mastra.ai/docs/workflows/snapshots),
[observability](https://mastra.ai/reference/observability/tracing/configuration).
