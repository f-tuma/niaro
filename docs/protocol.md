> [Native Tasks and explicit goal return](native-tasks.md) add real scoped work and question/approval bindings. Current workflow profile: `agent-client/0.8-fixture`. The [service action extension](service-catalog.md#result-cards-in-chat) adds passive contact/event/list/detail/text presentations to `service.action` results (component capability 2, result version 1). `service.resolve` remains the explicit decision command. Stored 0.2–0.6 workflows/sessions and client persistence migrate; update clients alongside the server. Older sections below describe the preceding calendar/CRM delivery.

# Fixture protocol: agent-client/0.4-fixture

This is a private first-slice profile. No AG-UI/A2UI or arbitrary-backend compatibility is claimed. Executable definitions live in `packages/protocol/index.ts`; examples come from `packages/test-fixtures/index.ts`.

## Endpoints

Base: `http://127.0.0.1:8787/v1/a` (or isolated `/v1/b`).

| Method/path                 | Meaning                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| POST `auth/pair`            | One-use operator code exchange; strict authProfile/profile/code; returns credential, scope, grants and expiry                             |
| GET `auth/session`          | Validate bearer token and return its immutable session identity                                                                           |
| DELETE `auth/session`       | Revoke the bearer token; 204 on success                                                                                                   |
| GET `snapshot`              | Validated authoritative scope, cursor, conversations, work items and input requests                                                       |
| GET `events?after=N`        | Ordered full-entity upserts after cursor N; 409 means fetch a snapshot                                                                    |
| POST `commands`             | Strict JSON command; 202 accepted, 409 revision conflict, 422 rejected; result includes current snapshot                                  |
| GET `activity?commandId=ID` | Optional `agent-activity/1` or requested `/2` or `/3` extension: authenticated, scope-bound progress of one model request; no mutation    |
| GET `server`                | Optional `agent-server-info/2` extension: authenticated server name, component catalog and configured services; no configuration mutation |

Command bodies over 64 KiB are rejected. Unknown fields, unknown presentation versions and invalid references are rejected. Each scope contains connection/server/user/workspace IDs. The opaque bearer token establishes user/server/connection/workspace scope; the route must match the authorized workspace. All data routes require it and reject absent/expired tokens with 401 or a wrong workspace with 403. The command cannot inject scope. Pairing separately negotiates `agent-pairing/1` and the workflow profile; see [ADR 006](adr/006-server-pairing-and-session.md).

## Request progress (optional agent-activity/1, /2 and /3)

`packages/protocol/activity.ts` defines a separate, strict read-only extension; the workflow profile is unchanged and existing snapshots, commands and auth are unchanged. The response contains `profile`, authenticated `scope`, requested `commandId` and `activity` (or `null` when unavailable). Activity includes the same command ID, conversation ID, status (`running`, `succeeded`, `failed`) and two or three ordered steps:

- `understanding`: the model request is in flight.
- `crm`: included only when the server actually starts its CRM read.
- `preparing`: prepares and commits the response after preceding calls finish.

Each step is `pending`, `running`, `succeeded` or `failed`. Exactly one active/failed step follows any completed steps and precedes pending steps; a succeeded request has only succeeded steps. Completion means an accepted **message command**, never approval or successful execution of a proposed calendar operation. Stages and labels are not model-generated. There are no percentages, predicted durations, artificial delays, arbitrary text/styles or consent in this extension.

Clients opt into version 3 with `GET activity?commandId=ID&profile=agent-activity%2F3`. The default response remains `agent-activity/1` and excludes tool and workflow data. Explicit `/2` requests retain tool data but exclude workflow data, so strict older clients keep working. New clients accept all three versions. V2 adds an optional `tools` array with one aggregate `{id: "datetime", status, calls}` entry. `calls` is 1–4; status is `running`, `succeeded`, `needs_input` or `failed`. It appears only when the runtime actually invokes the shipped plugin or restores a persisted calculation. No arguments, results, service names or secrets enter progress.

V3 adds an optional `workflow: {step, stage}` object. `step` is an integer from 1 to 5; `stage` is one of `service`, `action`, `inputs` or `execute`. These values report the current server-controlled decision step and replace the generic understanding label in one compact row. The client owns the English/Czech labels; repeated steps update the row in place. This field grants no consent and carries no arbitrary model text or action arguments.

Both catalog routing and the legacy interpreter publish base progress. Plugin completion is reported after its receipt is saved; unresolved dates show `needs_input`. Repeated calculations update the same row/count. Completed calculations survive subsequent inference failure, cached-turn recovery and delegation to the legacy workflow. A single active guard spans that handoff; closed trackers ignore late callbacks. A terminal activity cannot contain a running tool, and a succeeded activity cannot contain a failed tool. Fast calculations may already be complete by the first poll; the UI never delays execution to show an animation.

Progress is transient process memory: terminal records expire after five minutes and are bounded to about 100 entries plus active calls. It is not a durable job queue. Reads require a live session and the same full connection/server/user/workspace scope. Restart does not invent or restart activity. Command replay uses the existing durable receipt without running inference/CRM again.

While its message POST is pending, the client starts checking after 250 ms, then every 500 ms after the prior check finishes, with a 2.5-second timeout. It checks scope/command/conversation, ignores late responses, and stops on completion, failure, logout or disposal. Unsupported/unavailable progress degrades to an explicitly unconfirmed state; it cannot fail the message command, silently retry it or claim that remote work stopped. Clients show progress as one "Thinking" line, like an AI chat; the stages open beneath it on request. It is replaced by the ordinary reply on command completion. Its animation respects reduced motion. A `service.action` result is shown as a card only while it awaits the person's decision (`awaiting_approval`); any other receipt, and a finished native action, shows only the answer's text and generated UI. Existing long-running work and calendar execution continue to use WorkItem/Operation states.

## Server cards (optional agent-card/1)

The client opts in with `cards=agent-card%2F1` on `snapshot`, `events`, `commands` and `server`. Negotiated discovery advertises `card.document: 1`. `ServiceResult.card` and `WorkItem.card` are passive supplements the server builds for their authoritative entities. Messages stored before model-composed cards were retired may still carry `{type: "card.document", version: 1, document}`; clients show its text. Unnegotiated responses omit these fields and retain the ordinary text, service presentations and workflow controls, including replay and conflicts. The core workflow profile is unchanged.

## Generated UI (optional agent-openui/1)

An assistant message may carry `ui: {type: "openui.program", version: 1, library: "niaro-ui@1", program}`: one OpenUI Lang program the server admitted against the shared component library, shown beside the text. Clients opt in with `ui=agent-openui%2F1` on `snapshot`, `events`, `commands` and `conversations/messages`; unnegotiated responses omit the field and keep the complete text answer. The program is presentation only: its follow-up buttons fill the person's message box and send nothing. See [generative UI](generative-ui.md).

A native question (`WorkItem.native.question`) may offer answers: `options` (2–6 labels of at most 80 characters) and `multiple: true` when several may be picked. Clients opt in with `questions=agent-question-options%2F1` on `snapshot`, `events` and `commands`; unnegotiated responses omit both fields, so strict older clients keep parsing and answer by typing. A picked answer is an ordinary `message.send` with the question's `context` and the option text (several joined by ", ").

Documents use semantic nodes and child references rather than task templates or arbitrary executable layout. The shared validator checks tree integrity, IDs, references, supported icons and primitives, form values, visible actions and size/depth budgets; the server's typed `CardBuilder` builds passive documents only.

`card.respond` answers a form of such a stored card from older app builds. It carries the normal command and idempotency IDs, conversation/message/card IDs, expected card revision, action ID, declared values and language. The server derives user intent from the stored visible label and field definitions. A newer turn, wrong scope, mismatched revision, invalid value or undeclared field is rejected. Before external dispatch, the current request is checked again. A durable result from a dispatch already in progress is preserved if another turn supersedes its source during the network call. `reply` and `submit` do not authorize a service operation: `service.resolve` and `proposal.decide` retain their explicit consent boundaries. Render, replay and local expansion remain passive.

## Message times and result types (optional)

Messages the server stores carry `createdAt` (ISO time of storing). Messages stored before this have none, and none is invented. Clients that show times opt in with `messages=agent-message-time%2F1` on `snapshot`, `events`, `commands` and `conversations/messages`; everyone else receives messages without the field, so strict older parsers keep working (the history route still rejects any other unknown parameter).

Each client also names the message result types it renders: `results=` with a comma-separated list of `type/version`, e.g. `results=process.offer%2F1,skill.proposal%2F1,process.proposal%2F1`, on `snapshot`, `events` and `commands` (`packages/protocol/message-delivery.ts`). The baseline every 0.8 client parses is always delivered: `crm.contacts/1`, `service.action/1`, `service.connection/1` and `card.document/1` (the last still behind `cards=agent-card%2F1`). Any other result, including future ones, reaches only clients that name it; the others receive the same message without `result`, i.e. its text, which every result carries as the fallback. Malformed or unknown tokens are ignored. The web app and the mobile app declare the seven types they render; the web app also asks for message times. History pages (`conversations/messages`) never carry results.

## Chat directory: rename, archive and delete

Four commands change the person's chat list for all of their clients. They use the ordinary `commands` route, scope, receipts and `commandId`/`idempotencyKey` rules (the same press repeated returns its receipt; the same ids with another payload are `idempotency_conflict`); they do not go through the client's one-command outbox, so they never wait for or block an answer.

- `conversation.rename {conversationId, title}`: `title` is at most 160 characters and already trimmed; empty brings back the server's title (the first request). The name is directory state: the conversation entity, its revision and any reply in flight are unchanged. `ConversationSummary.title` is the name when set. An archived chat can be renamed; an archive made from a named chat keeps the name.
- `conversation.delete {conversationId, cancelOpenWork?}`: accepted (`202`) also for a chat that is already deleted, so a repeated or late press succeeds. An unknown or foreign chat is `rejected/unknown_context`. A chat whose work still waits (see [open work](#cancelling-open-work)) is `rejected/operation_in_progress`; the result names that work in `openWork` for clients that ask (below). With `cancelOpenWork: true` the server first cancels the chat's open work exactly as `work.cancel` does and then deletes. A chat answering right now is `conflict/operation_in_progress` without a receipt, so the same press can be retried. A deleted chat is not listed, its message page is `404`, the snapshot omits it, and every later command naming it (`message.send`, `conversation.rename`, `conversation.create` with the same id, …) is `rejected/unknown_context` without a model call.

What deletion removes and what stays:

- The chat's messages (history ledger and live snapshot), its title and name, short-term memory and contact context. Deleting restarts the event log at a new floor (as other entity removals do): retained events held message copies, and other clients learn about the change through `events` → `409` → new snapshot. The client then re-reads its chat list (`ClientSession.getDirectoryVersion()`).
- Receipts stay for idempotency, without what the person wrote: the request text of the chat's `message.send` receipts becomes `[deleted]`, tags and an attached task are dropped, and `card.respond` values are emptied. A replay of such a command is then an `idempotency_conflict`, never a new turn.
- An archived chat's stored session copy (`conversation_sessions`) is emptied.
- A tombstone keeps the id, revision and dates so the id is never reused. A finished task that still points at the chat keeps an empty conversation entity (no messages) in the snapshot, because work references must resolve.
- The main chat (`conversation-1`) and a hub item's chat (`chat-hub-…`) are addressed by fixed ids, so deleting one empties it instead: it leaves the list and returns as a new chat with its next message.
- Native memory: after the deletion commits, the server forgets the assistant's Mastra threads of the chat (`deleteThread`: messages and thread-scoped memory) under the chat's turn lock. A deletion also starts a new native conversation generation, so a continuing main chat never resumes the old thread. Native memory has no semantic recall or resource-level working memory, so nothing of the chat is recalled elsewhere. If forgetting fails, the deletion stands and is logged (`conversation_forget_failed`); deleting again retries it.
- Storage: `public_conversation` gains `custom_title` and `deleted` (0 listed, 1 deleted, 2 emptied server-owned chat) in place at startup. Do not open the upgraded database with an older server.
- What remains: the native turn journal (`agent_service_turn`: request text, goal and final reply per turn, used for replay and recovery), audit and usage records, process runs started from the chat and their outputs, saved memories the person kept explicitly, and native run checkpoints. These are not shown in any chat and are not read back into the conversation.

### Archive and restore

Archived chats are read-only and live outside the chat list (the apps show them under Settings → Archived chats). `ConversationSummary.readOnly` is `true` exactly for archived chats: session archives (`archived-N`, written by `session: "new"`) and chats the person archived. The summary shape is unchanged.

- `conversation.archive {conversationId, cancelOpenWork?}`: the same receipts, idempotency, refusals and `cancelOpenWork` as `conversation.delete`: accepted also for a chat already archived; an unknown, foreign or deleted chat is `rejected/unknown_context`; open work is `rejected/operation_in_progress` with `openWork`; a chat answering right now is `conflict/operation_in_progress` without a receipt. A hub item's chat (`chat-hub-…`) is never archived (`rejected/unknown_context`): its runs report there.
  - Any other chat keeps its id, messages, name and native memory; it leaves the snapshot (a finished task that points at it keeps an empty conversation entity) and its short-term memory is cleared.
  - The main chat (`conversation-1`) keeps its fixed id: its messages move into a new session archive exactly as `session: "new"` does (also into `conversation_sessions`), and it continues empty in a new native conversation generation.
- `conversation.restore {conversationId}`: accepted also for a chat that is already active; unknown, foreign or deleted is `rejected/unknown_context`. The chat returns in place with its id, messages and name, under a new revision, and can be continued. A session archive (`archived-N`) restores in place too; its messages lose their references to work items of the earlier session (as its history pages always showed them).
- While archived, a chat can be read (`conversations/messages`), renamed, restored and deleted. Every other command naming it is `rejected/unknown_context` without a model call, and process answers are not published into it.
- Native memory: archiving forgets nothing; deleting the archived chat later forgets its threads as above. A restored chat continues in a new native conversation generation: its next turn never resumes the archived Mastra thread (whose source pins and task state may be stale) but starts a fresh thread, and the chat's visible history reaches the model as for any continuing chat (the person's recent requests). Authority is that of the current turn.
- Both commands restart the event log at a new floor, so every client of the person re-reads its snapshot and chat list (`ClientSession.getDirectoryVersion()`), as for deletion. Both bump the chat's `updatedAt`.
- Listing (optional): `conversations?profile=…&state=active` lists only chats that can continue, `state=archived` only the archive; filtered pages run newest first by `updatedAt` (`after` is still the last row's cursor). Without `state` a page lists every chat oldest first, as before, so older clients keep working (they show archived chats as read-only, as they did). An older server answers `state` with `400`; `ClientSession.readConversations(after, signal, state)` then reads unfiltered pages once and filters each page itself. An older server answers the new commands with `400`, which the client reports as `conversation_command_unsupported`.
- Storage: no new columns; `public_conversation.read_only` marks every archived chat.

### Cancelling open work

Open work is a WorkItem of the chat that still waits for the person or the server: `waiting_input`, `waiting_approval`, `waiting_system`, `running`, `queued` or `scheduled`, and for a process run a journal that is still `running` or `waiting`. Not open: `succeeded`, `failed`, `cancelled`, `expired` and `superseded` (a native question or approval older than the 30-minute task expiry is projected `expired`, so it never holds a chat), and a run that ended with an unconfirmed write (native `waiting_system` whose action is `unknown`, or a process run whose journal ended while a receipt stays `unknown`): nothing is left to cancel, and its WorkItem stays visible in Tasks after the chat is gone.

- `work.cancel {conversationId, workItemId, expectedWorkRevision, language}` (ordinary receipts and idempotency; like the directory commands it bypasses the client's outbox). Only the person's own work in their own scope; a foreign, unknown, archived-chat or deleted-chat item is `rejected/unknown_context`. `expectedWorkRevision` is the WorkItem `revision` the person saw: a different one is `conflict/revision_conflict`. Work already settled at that revision is accepted without a change.
  - A native question ends as `cancelled` with a short reply ("I cancelled the task…"); its exact settled suspension is closed and the checkpoint stays dormant (as MCP `task_cancel`).
  - A native approval is declined: its receipt becomes `rejected` (passive, nothing is dispatched) and the task ends `cancelled`.
  - A native run that waits for the server without a question (it stopped mid-way, e.g. a restart cut it off) is closed only after the native owner proves its retirement; an answer-less failure candidate is finalized as failed. Recorded receipts keep their outcome.
  - A waiting process run (question or approval, or a run that stopped mid-way) is cancelled through the process coordinator after the run and its agents are proved retired or suspended: the pending approval receipt is `rejected`, the journal becomes `cancelled` (`failure.code: "process_cancelled"`).
  - An effect already dispatched is never cancelled: an `unknown` write stays `unknown` and is shown on the task.
  - Work that is executing right now (a request in flight in that chat or for that process run, a receipt still `running`, a run whose retirement cannot be proved) is `conflict/operation_in_progress` ("still answering") without a receipt.
  - Fixture calendar tasks (demo) cancel in the workflow store: the open question is `cancelled`, the proposal `rejected`.
  - Each native or process cancellation finishes its Loops trace (`cancelled`, or `unknown` with an unconfirmed write) and writes an audit entry `work.cancelled` (source `chat`).
- Refusal list: a refused `conversation.delete`/`conversation.archive` (`rejected/operation_in_progress`) carries `openWork: [{workItemId, title, kind}]` (`kind`: `question`, `approval`, `process`, `task`; at most 50) when the client asks with `work=agent-open-work%2F1` on `commands`. Without it the field is omitted, so strict older clients keep parsing. A replayed refusal lists the work open now.
- Durability: native and process work commits in the identity store, the chat directory in the workflow store; they share no transaction. `cancelOpenWork` therefore cancels first (each item at its projected revision, then re-reads the projection) and deletes or archives after. If a cancellation is refused midway, the command answers `conflict` without a receipt; what was already cancelled stays cancelled, and the same press (or a new one) skips it and continues. Fixture tasks cancel in the directory command's own transaction.
- Stale runs: before a delete or archive (with or without the flag) the server closes the chat's native runs that stopped without an answer or a pending question longer ago than the task expiry, when their retirement is proved, exactly as `work.cancel` would. Such very old chats are not held by dead work.
- An older server answers `work.cancel` and `cancelOpenWork` with `400`; the client reports `work_cancel_unsupported` or `conversation_command_unsupported`.

Clients opt into `agent-reply-correlation/1` with the URL parameter
`replies=agent-reply-correlation%2F1` on `snapshot`, `events` and `commands`.
Assistant messages may then carry `replyToCommandId`, set by the server when
processing that command. It is not inferred from opaque message IDs or supplied
by the model. User messages cannot carry it. Persisted messages and event replay
retain the correlation. The HTTP layer omits it without the exact opt-in, including
command replays and conflicts, so existing strict 0.6 clients remain compatible.
Old servers return ordinary messages; a new client displays them without autoplay.

The client arms automatic speech only for its current foreground voice submission,
then reads the last correlated assistant reply after accepted delivery. Rendering
history, receiving an unrelated update or reconnecting never arms playback.

## Chat search (optional agent-chat-search/1)

`GET search?profile=agent-chat-search%2F1&q=…` searches the person's own chats (`packages/protocol/chat-search.ts`, `ClientSession.searchConversations(query, options)`). An older server answers `404`; the client reports `chat_search_unavailable` (the apps then search the loaded chats' names, as before).

- What is searched: the chat's shown name (the person's name or the first request), every message of the person and the assistant's final answer of each turn (the last assistant message with text before the person's next message; a contact list, which shows no text, does not count). Interim notes, tool outputs, card data, process journals, the native turn journal and private native transcripts are never indexed. Markdown is reduced to its text.
- Matching: words are all required; case, accents and compatibility forms are ignored (`schuzka` finds `Schůzka`); the last word matches as a prefix while it is typed (no trailing space); a long word also matches its other Czech endings (its stem less final vowels, as a prefix); `"quoted words"` must stand together. Query syntax is never passed to SQLite.
- Parameters (each at most once, anything else is `400`): `q` (trimmed, 1–200 characters; empty is `400` — recent chats come from the directory), `after` (the previous page's `nextAfter`), `limit` (1–20, default 10), `include=archived` (archived chats too), `state=archived` (only archived chats), `role=user|assistant` (only the person's messages or only answers; names then don't count). A wrong `profile` is `406`.
- Answer: `{profile, scope, results, nextAfter}`; one result per chat, best first: `conversation {id, title, updatedAt, archived}`, `titleRanges`, up to three best `matches {messageId, role, createdAt?, snippet, ranges}` and `matchCount`. A snippet is plain text of at most ~180 characters around the densest matches (`…` marks a cut); ranges are `[start, end)` UTF-16 offsets into it (or into the title), ordered and not overlapping. Clients render ranges themselves and never treat any of it as markup.
- Ranking: FTS5 `bm25` of the chat's best message, normalized per query, raised by more matching messages, a matching name and a recent change (`updatedAt`, fading over about a month). Ties go to the newer chat.
- Scope: strictly the authenticated person's server, workspace, user and connection (the same scope as the directory); deleted chats never appear.
- Limits: 40 searches per 10 seconds per person (`429 chat_search_rate_limited`); a search ranks at most 4,000 matching messages.
- Opening a result: the apps open `/chat/:id?m=<messageId>`; the web chat reads older pages until the message is shown, scrolls to it and highlights it briefly.

Storage: the workflow database holds `chat_search_doc` (scope key, chat id, message id, role: no text), a contentless FTS5 table `chat_search_fts` (folded words only; `unicode61 remove_diacritics 2`, prefix indexes 2 and 3) and `chat_search_dirty`. Triggers on `public_conversation` and `public_conversation_message` keep it in step with every write path: a removed message or a deleted chat loses its index rows in the same statement, and deleting a chat also rewrites the FTS index (`optimize`), so none of its words remains in a segment; a stored, changed or renamed chat is marked and indexed again before the person's next search. Archiving and restoring change nothing in the index: the archive state is read from the directory. Startup indexes every existing chat once (an index version in `chat_search_meta`; at most 2,000 chats right away, the rest before their person's first search). Database checks (legacy inventory, copied tuples) accept exactly this FTS5 table and its shadow tables and no other virtual table. Do not open the upgraded database with an older server.

## Entities and transitions

`Conversation` owns structured messages. `WorkItem` references its conversation and InputRequest IDs. `InputRequest` references the same conversation/work item, has a revision, bounded choices and a server resolution reason. A snapshot verifies these relationships and unique IDs.

```text
message.send("Choose Peter")
    → WorkItem waiting_input + InputRequest open (revision 1)
input.submit OR message.send with explicit context
    → local sending (no authoritative state change)
    → server InputRequest resolved (revision 2) + WorkItem running (revision 2)
server tick/event, separately
    → WorkItem waiting_approval + ActionProposal awaiting_approval (revision 1)
proposal.decide(approve, expectedProposalRevision=1)
    → ActionProposal approved (revision 2, accepted revision 1) + Operation pending
server ticks, separately
    → Operation executing → succeeded (simulated result) + WorkItem succeeded
```

`input.submit` carries commandId, idempotencyKey, conversationId, workItemId, inputRequestId, expectedInputRevision and answer.selectedContactId. Contextual `message.send` carries the same work/input IDs and expected revision in `context`; an unbound message cannot resolve an arbitrary open question. Rendering an entity or replaying an event never invokes a command.

The limited content catalog accepts `workflow.progress` v1/default, `input.choice` v1/contacts, `action.approval` v1/meeting and the passive `crm.contacts` v1 result below. It does not accept JSX, arbitrary styling, URLs to executable code, arbitrary callbacks or server-supplied permission grants. Colors, layout and labels belong to the client.

## Chat sessions

The main chat starts empty after an app launch and after four hours in the background. The first new request of such a session sends `message.send` with `session: "new"` (never on contextual replies). Before reading any model context, the server moves the live conversation's messages into the per-scope `conversation_sessions` archive and clears short-term memory (clarification history, the in-progress meeting and recent contacts). Work items, proposals and operations stay in the snapshot and remain available under Tasks; an earlier item opened from Tasks is shown in chat again. The check runs after the receipt lookup, so a replayed command never archives twice, and an empty chat writes no archive row. Archived sessions are the base for later long-term memory; they are not sent to the model today. Each also appears in the person's archive as a read-only chat that can be restored (see [archive and restore](#archive-and-restore)).

`message.send` may carry `humanTask: {id, title}` for an open item from [Tasks](human-tasks.md) that the person brought to this chat. It cannot be combined with a question answer `context`. The server stores it on that user message (`Message.humanTask`, user messages only) and the native runtime reads the item itself by id in the authenticated scope; the title is only the sender's display copy.

## Server information (optional agent-server-info/2)

The [configurable reference server](server-profiles.md) adds authenticated `GET server`. The strict `packages/protocol/server-info.ts` schema returns `profile`, `name`, authenticated `scope`, `workflowProfile`, a fixed `componentCatalog` and `configuredServices` (`interpretation`, `voice`, `contacts`, `calendar`). Calendar support is scoped: only the configured calendar account/workspace reports `caldav-test`; other scopes report `simulated`. This describes configured adapters, not credential validity, availability, permissions or approval. The voice extension remains the source of current voice availability. No credentials, paths or arbitrary rendering instructions appear here. POST is not supported; a legacy server without this extension returns 404. Version 2 adds `interpretation: "disabled"` for account workspaces with inference sharing off. The main workflow profile remains unchanged.

## Contact results (profile 0.4)

An assistant `Message` may carry a structured `result` alongside its short `text` fallback:

```json
{
  "type": "crm.contacts",
  "version": 1,
  "source": "twenty",
  "contacts": [
    {
      "id": "test-alex",
      "name": "TEST Alex Example",
      "jobTitle": "Product designer",
      "phone": "+1 202 555 0147",
      "email": "alex.novak@example.test"
    }
  ],
  "hasMore": false
}
```

The catalog bounds results to five unique contact IDs, a 160-character name/job title, validated primary email and bounded phone text. Empty results are supported; optional fields are omitted when absent or invalid. This result cannot appear on a user message or simultaneously reference a work item/input request. All fields are validated by the protocol before render. It is a read result, not a WorkItem, InputRequest, proposal or operation.

The Twenty adapter maps the workspace's primary email and phone fields, prepending a supplied calling code only to a local number. It still reads only TEST records; no extra CRM requests, writes or guessed contact data are needed. The server assembles the payload directly after the model selects the CRM read intent. The model never supplies contact fields or layout. Only the short count summary goes into subsequent model history; the structured contact values do not.

`CrmContactResults` and `CrmContactCard` own presentation in the client: initials, name/role, labeled phone/email rows, missing-data handling, empty and truncated states, and EN/CS labels. Text is selectable. Rendering does not dial, send email, fetch CRM or create an operation. Snapshot/event replay preserves the same data and is passive. Existing text-only messages remain text; they are not reparsed into inferred contacts.

Profile 0.4 requires updating/restarting the client and server together and pairing again. Server reads migrate 0.2/0.3 snapshots and stored session metadata without changing existing work, command receipts, permissions or expiry. A full stopped-server backup was created before the local upgrade. Do not open the upgraded database with an older server. Pairing remains version 1; voice has its independent version described below.

## Proposals and operations

Work items now reference `actionProposalIds` and `operationIds`; snapshots index `actionProposals` and `operations`, with matching `action_proposal.upserted` and `operation.upserted` events. Proposals and operations are separate entities. Operations retain the accepted proposal revision, immutable parameters and an idempotency key. Without a calendar target, success is simulated. With a reviewed CalDAV target, success requires an independently verified remote calendar resource.

`proposal.decide` carries `conversationId`, `workItemId`, `proposalId`, `expectedProposalRevision` and `decision: approve | reject`, plus the standard command identifiers. A status-only approval increments the proposal entity revision while retaining the reviewed prior revision. `proposal.revise` uses the same context and `changes: { participantId, startsAt }`. The server derives recipient information and a 30-minute end time in UTC. Edits must use a known contact and a future start time.

An edit cancels any approved pending attempt and requires new consent. Once execution begins, edit/reject returns a conflict; it never silently changes the approved operation. A stale revision, repeated approval under a new command ID, foreign context or ambiguous chat “yes” cannot create another operation. Error codes include `invalid_proposal`, `operation_in_progress` and `integration_unavailable`.

Database version 1 is validated and migrated to version 2 without losing existing work/receipts. Legacy unfinished contact work prepares a proposal; it cannot skip consent. The engine retains the v1-to-v2 schema migration, but the authenticated HTTP server does not adopt legacy anonymous files into a user account. Authenticated work is stored under its full scope in SQLite; existing authenticated JSON files are imported once without altering their source. See [ADR 007](adr/007-transactional-workflow-storage.md). Restart both client and server. See [ADR 005](adr/005-revision-bound-demo-approval.md).

## CalDAV effect and reconciliation (profile 0.3)

Optional `MeetingParameters.calendar` contains `provider: caldav`, `integrationId`, `label`, `collectionUrl` and `invitations: none`. It is reviewed content copied into the operation and must still match the authenticated server configuration. No secrets enter this field. Its absence means simulation, including for migrated old proposals. The synthetic `demo: true` marker does not by itself identify the effect; clients inspect the reviewed calendar target.

A successful operation result is either `{kind: simulated, reference}` or `{kind: calendar, reference, etag, verifiedAt}`. Calendar success is accepted only with a calendar target. `Operation.error` exposes bounded, non-sensitive diagnostic codes when verification is uncertain. Network/auth/response failures leave `result_unknown`, with the work waiting for the server; a successful HTTP PUT alone is not completion.

`operation.reconcile` carries commandId, idempotencyKey, conversationId, workItemId, operationId and expectedOperationRevision. It is allowed only for an unknown calendar operation under the unchanged binding. It resumes checks/conditional creation of the **same** resource; it never allocates another operation. Normal command receipts and scope checks apply. A changed remote event is not overwritten.

The worker commits a claim before network I/O, uses a 30-second claim lease, and resumes after a crash. Automatic retries are bounded to eight completed attempts; the UI then offers explicit reconciliation. GET, conditional PUT and readback use the deterministic resource identity. No scheduling invitations, email, deletion or update command exists in this profile. See [ADR 008](adr/008-local-caldav-integration.md) for the operational setup and actual crash evidence.

The internal payload remains database version 2; old profile 0.2/0.3 snapshots/session files are migrated on server read without granting new effects. Older clients must update and pair again because the wire schema has changed.

## Delivery and restore

The client indexes entities by ID inside one endpoint/scope, orders events by sequence, ignores duplicates/older revisions and asks for a snapshot on a gap. An older snapshot cannot roll back the cursor. Foreign endpoint/scope updates cannot enter the active store. Full-entity batches are applied before notifying UI subscribers.

Commands are persisted before a POST. A lost response produces an explicitly uncertain pending command; only a manual retry resends its exact IDs and payload. The server remembers receipts, rejects reuse of an ID/key with a changed payload, and returns current context for conflicts. A confirmed outcome stays confirmed even if the local cache write fails. Disconnect stops future sends from a stopped session; an already transmitted command may still complete server-side. A dropped HTTP connection does not cancel a transmitted command: the run continues (bounded by a 10-minute server deadline), and the exact retry joins it or returns its receipt. Only an explicit interrupt or server shutdown stops it. A server without any model settles a message as rejected instead of leaving it pending.

Client workflow snapshots and pending commands use AsyncStorage keyed by endpoint plus the entire authenticated scope. Session validation precedes cache reads; older anonymous cache keys are ignored. Native credentials use SecureStore, while web credentials live only in memory. Expiry hides data and stops polling; re-pairing never automatically retries a business command. Workflow caches remain synthetic, unencrypted demo storage, with no production retention policy or encrypted recording upload.

Server workflow state, scheduled jobs, events and receipts commit in one SQLite transaction before a command reply. Polling reads committed events repeatedly from the retained log, so a crash between commit and reply does not lose the change. Worker jobs resume from the database on restart without a client request. Snapshot/event reads are transactionally consistent; no volatile engine cache is authoritative. See [ADR 007](adr/007-transactional-workflow-storage.md).

Retention is bounded to 1,000 events and 2,000 command receipts per scope. Old event cursors require a snapshot. Receipts are never pruned: new commands fail at capacity, while retries of retained IDs still deduplicate. Ordinary transaction failure returns a server error without partial state; a failure after commit is an uncertain response, resolved by retrying the original IDs. A production contract still needs a retention/retry-window policy and external-provider reconciliation. One HTTP process owns a local data directory, because auth files retain their separate single-process model.

## Threat boundaries and remaining work

- Validate every incoming snapshot/event/result before rendering; do not reinterpret assistant text as an operation.
- Reject credential-bearing connection URLs; require HTTPS outside the explicit development-only private-network exception. Requests specify redirect rejection; adversarial native transport redirect behavior remains to be verified before production.
- Opaque tokens bind scope and gate all data routes. Trusted operator code delivery is the enrollment boundary; this is not an external identity provider. Production still needs identity administration, finer permission grants, production storage operations, retention and encrypted workflow caches.
- CORS restricts browser origins, not native clients. Do not expose the fixture to an untrusted network.
- Revision-bound approvals run under authenticated fixture identity. The local CalDAV profile now creates and verifies actual synthetic calendar events, with no invitations. Production deployment and personal cloud accounts remain deferred. Input resolution is not authorization to write a calendar; only explicit proposal approval is.

## Optional voice draft extension

`agent-voice/5` is negotiated separately through authenticated `GET voice`. It advertises enabled, EN/CS, a 120-second maximum and either `whisper.cpp` / `small` / `connected_server`, or `openrouter` / the actual configured model ID / `cloud`. Version 5 permits a server-selected cloud model instead of claiming a fixed Gemini model. The model ID is bounded to 200 characters; local processing still requires Whisper small. Missing, disabled or incompatible versions leave text/form input available. Update client and server together; workflow remains `agent-client/0.4-fixture`, with no persisted workflow schema change.

`POST voice/transcriptions` accepts strict `{profile, requestId, language, context, audio, stopReason?}`. `stopReason` is `user`, `silence` or `limit`; decoded upload bytes are capped at 8 MiB (base64 body cap derived from this plus 8 KiB metadata), with WAV/MP4/WebM allowed. Client endpointing samples microphone level every 100 ms, finishes after detected speech plus 1.8 seconds of silence, and discards an initially silent capture after ten seconds. Missing metering requires manual Done or the maximum timer; it is not treated as silence. Context is **either** `{conversationId}` for a new request **or** the complete `{conversationId, workItemId, inputRequestId, expectedInputRevision}` for an explicitly selected question. Partial contexts, versions 1/2, scope overrides and unknown properties are rejected. Authentication, conversation ownership and (when present) open question/revision/work state are checked before inference and again afterward.

The response echoes authenticated full scope, requestId, language and context, and includes `text` plus `reviewReasons: ("uncertain" | "repetition" | "limit")[]` (unique, maximum three). The client rejects identity/context/language mismatches. Empty review reasons allow automatic submission. Unannotated string responses are normalized to `uncertain`; hitting the limit requires review on both server and client. Whisper and Gemini warning heuristics are documented in [ADR 009](adr/009-local-voice-question-reply.md) and are heuristic, not calibrated confidence.

Transcription itself creates no workflow mutation, receipt or event. The foreground voice coordinator hands usable text to the existing `message.send` path once; uncertain text requires explicit review/send. General requests carry no question IDs and cannot implicitly answer an open question. Contextual messages retain the frozen question revision and normal server validation. Resolution source remains `chat`, meaning the text-command route, not proof of human review or original speech. Calendar approval remains a separate revision-bound action; transcription and spoken “yes” cannot grant it.

Cancel, backgrounding or context/session changes discard the draft and reject late results before handoff. Cancellation does not undo a message already sent. Sent text enters normal pending-command and server storage; audio and unsent transcripts do not. Transcription failures offer explicit retry; uncertain business delivery retains the original command ID/payload for manual retry. There is no automatic replay on reconnect.

## Renewable device sessions

Current account clients opt in via `?session=agent-device-session/1` on browser-login
`start` or backup `auth/pair`. Returned credentials additionally contain
`refresh: { profile, token, expiresAt }`; strict older clients receive the unchanged
legacy credential. `GET auth/session` still returns only the public access identity.

- `POST /v1/{workspace}/auth/refresh`: `{ profile, refreshToken, requestId }`.
  Authenticates the refresh secret, not an expired access bearer; returns a rotated
  credential. Only hashed secrets are persisted. Tokens are scoped to the original
  server/user/workspace; membership and revocation are rechecked.
- `DELETE` on that route: `{ profile, refreshToken }`. Revokes the device even when
  access has expired. A consumed refresh token can revoke the last rotation too.
- Clients durably save the rotation request ID with their old credential before
  sending it. Repeating that consumed token and ID recovers exactly the last
  rotation without extending either expiry. A recovered expired access token is
  saved, then renewed with its new refresh secret. Another rotation replaces the
  recovery slot; conflicting retries are rejected.
- Initial grants must be used within five minutes; abandoned enrollments are
  reclaimed. Active device grants survive browser logout/server restart and expire
  after the configured idle period (30 days by default). Device logout and removal
  of membership/permissions revoke them. They do not refresh external service tokens.
- Native credentials remain in SecureStore, web preview credentials in memory.
  A transport failure retains the vault; an authoritative rejection hides data and
  clears credentials. Account switches stop the old session and ignore late results.
  Renewal is single-flight and never automatically replays business commands.
- In-flight model/tool/OAuth checks use the stable device grant identity so normal
  token rotation cannot change or invalidate the initiating user. Revocation and
  current permissions still apply at commit time.
