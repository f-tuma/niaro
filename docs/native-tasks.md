# Native Tasks and explicit goal return

October 3, 2026. Native catalog runs now appear in Chat and Tasks
through the same scoped WorkItem projection. A paused question or action approval
survives a detour, a new empty chat and a restart. Opening a task is passive;
answering and approving remain separate explicit commands. No new execution loop
or task scheduler was added: Mastra owns the durable run and its checkpoint.

The workflow transport profile is `agent-client/0.8-fixture`. Update server and
clients together. Stored 0.2–0.6 workflow profiles, auth sessions, credentials and
client caches migrate locally; network payloads require the current profile.
Use the existing server/Expo commands in the [README](../README.md#quick-start).
This change was not loaded into the user's running instance.

## Identity and projection

A native WorkItem has `demo:false`, its root `runId` as its ID, and a typed `native`
binding. `native.revision` pins the authoritative run state; the outer WorkItem
revision orders materialized projection events. The question has a separate
ID derived from the run and native tool call, a revision, owning work/conversation
and `runtime:mastra`. Each new ask_user call creates a new input request;
answering the previous request cannot resolve it. Pending actions project the
canonical ServiceResult receipt, including its immutable operation identity,
parameters, effect and current status. Calendar fixture input/proposal/operation
arrays stay separate; native receipts are never represented as fake calendar work.

The server lists root records, deduplicates command aliases and includes meaningful
service work or tasks that have asked for input. Plain public answers do not create
Tasks. The current projection window covers up to 400 roots, prioritizing pending
runs, within the existing 500-WorkItem transport limit. HTTP snapshot/events/commands
and voice validation reconcile this projection from identity SQLite. This repairs
a gap where execution committed before the workflow projection was written.
Repeated unchanged refreshes emit no task events or projection writes. Older
run revisions cannot overwrite a newer projection.

## Commands and authorization

- `task.open` binds conversation, work ID and expected WorkItem revision. The
  server verifies the current run, actor/workspace/server identity, source TTL,
  policy epoch and memory generation/provenance before saving a durable selection.
  It does not hydrate or resume a native checkpoint, call a model or dispatch a tool.
- A native `message.send.context` includes `runtime:mastra`, work ID, input ID and
  expected input revision. It resumes that exact suspended tool call, independently
  of the latest chat goal. Its fingerprint includes the question binding. New-session
  chat archival does not discard an explicit answer target.
- Tasks uses `service.resolve` with the canonical operation ID, work ID and expected
  WorkItem revision. The server checks both projection and fresh run state inside
  the run lock. Chat and Tasks share the existing receipt/controller/native resume
  path and critical service confirmation component. Viewing a task is never consent.

- `work.cancel` binds conversation, work ID and expected WorkItem revision. The
  server stops the person's own open run without resuming it: a paused question
  ends `cancelled`, a paused approval is declined (receipt `rejected`, no
  dispatch), a run that stopped without an answer is closed after its native
  retirement is proved. A request still in flight is a conflict. Recorded
  receipts keep their outcome; an `unknown` write stays unconfirmed. Deleting or
  archiving a chat with `cancelOpenWork: true` cancels its open runs the same
  way first. See [protocol](protocol.md#cancelling-open-work).

An unbound reply cannot resume an arbitrary goal when several runs are waiting.
A task selection is durable; after selection, ordinary continuation still uses the
existing continuity checker and fresh authority checks. Exact bound answers bypass
semantic guessing. Revoked or expired pending context becomes superseded/expired
and loses its actionable question/approval. A fresh goal is required rather than
silently reusing expired facts. Unknown writes stay unconfirmed and never become
Completed just because a reply or command was accepted.

Expiry and chats: a question or approval paused longer than the 30-minute task
expiry is projected `expired`, which is settled work, so it never keeps a chat
from being deleted or archived. A run that stopped without an answer or a
question (e.g. a restart cut it off) projects `waiting_system`; once it is
older than the expiry, a delete or archive of its chat first closes it lazily
(after proving its native retirement) as if the person cancelled it. Until
then it is listed as open work and can be cancelled from its card.

Chat questions use the same work/input identity and card as Tasks. Frozen text and
voice replies resolve their question through a shared client selector. Late voice
transcripts, duplicate answers, stale question revisions and wrong targets cannot
attach to another goal. Audio-held replies also hold their task cards.

## Verification and boundaries

The new offline suite covers detour/new-chat/restart, passive selection, exact
question identity, duplicate/stale/wrong-target replies, permission/TTL rejection,
approval after archived chat, ambiguous goals, persisted selection, concurrent
answers, stable projection refresh and an unknown write after restart. Authenticated
HTTP tests cover paired scope, stale task/approval pins and restart/replay. Existing
native memory/revocation, card and SIGKILL regressions remain in the full suite.
Run `npm run test:agent`, `npm run test:identity` and `npm run eval:trust`.

UI stories include EN/CS native questions and approvals. React Native Web preview
QA used installed Playwright because the Browser plugin is not available: localhost
preview, 1366×900 EN and 390×844 CS. Page identity, meaningful rendering, no framework
overlay, console health, screenshots and question-open/reply plus approval-to-success
interaction passed, with no horizontal overflow or console errors/warnings. This
is component/rendering evidence, not a physical Android or live-model acceptance.

The historical verification above did not restart the live server or execute
a real CRM/calendar effect. Current custom-process commands and recovery use the
same Mastra owner; the following process projection extends Tasks without another
execution loop.

## Admitted service processes — 5 October 2026

Clients opt into `tasks=agent-process-work/1`. A process WorkItem carries its original
canonical parent, conversation, native alias and immutable process/version/artifact/
actor/command provenance. Its receipt statuses come from canonical invocations;
typed process output is derived data. Loops shows the same pinned provenance.
The full [process projection contract](service-processes.md#passive-process-tasks-and-loops)
describes transport negotiation, detail authorization and output bounds.

**All** is the default Tasks filter. Failed, cancelled, interrupted and unknown
processes remain visible there and in their chat anchors. Needs input, Active and
Done keep their existing exact lifecycle filters. Unknown is unconfirmed, never
Done. Process cards keep their expandable action receipts and explain a failed
process without rewriting an earlier successful write as a failed effect.
Opening or expanding a process card is passive; ordinary chat `task.open` and
legacy approve controls are not used for it. Native questions and the mobile
execution menu are separate work.

Chat and publicly admitted processes share one deduplicated 400-root window,
bounded by the 500-WorkItem capacity. Only an explicitly authoritative window may
evict older native materializations. Incremental updates preserve other tasks.
Snapshot and outbox persist the window and an eviction cursor together; an event
reader below the persisted floor must resnapshot. Unchanged refreshes stay silent,
and receipt-only changes can advance the outer event revision without changing
the native journal revision.

Publication rechecks root membership, canonical receipts, policy/Memory generation,
source and Memory TTL, and current OAuth authorization/exact execution pins under
the authenticated identity queue. Unstable reads fail explicitly. Revoked details
are redacted while known canonical statuses remain visible. No GET/reconnect/card
render starts, resumes, refreshes OAuth or dispatches an operation.

The projection/window/account HTTP regressions and EN/CS UI stories are included
in the normal test suites. `pnpm test:process-projection` runs the focused server
checks; `pnpm exec jest --runInBand tests/process-work-card.test.tsx` checks card
presentation. Rendered Tasks/Loops QA covered six EN/CS viewport cases at 320–1440px
with installed Playwright because the Browser plugin was unavailable. Physical
Android and the full mobile execution flow still require acceptance.
