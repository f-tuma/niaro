# Tasks: what is left to resolve

Tasks is a short overview of open items: things that still have to be resolved
but cannot be finished yet because information, a decision or an outside step
is missing. It is not a to-do list the person maintains. The assistant creates
items and closes them as work gets done; the person mostly talks them through
with the assistant.

The list has two tabs, **Open** and **Done**. Open shows the assistant's own
waiting questions and action approvals first (the native WorkItem projection from
[native tasks](native-tasks.md)), then open items. Ordinary agent executions do
not appear. Done holds items closed by the assistant or the person and items the
person removed.

## Where items come from

- **Meetings.** A completed meeting publishes its record and its open items in
  one transaction. Items keep the meeting identity, record digest and verbatim
  source quotes. Extraction keeps only what the person recording has to resolve
  or follow up on (for example arranging the next meeting or putting a date in
  the calendar); see [meetings](meetings.md).
- **Chat.** The native Mastra runtime can call `human_task_create` for something
  it cannot finish in the conversation. The model provides only title, detail
  (what is missing), explicit assignee and explicit due date; unknown values are
  null. The server determines owner, conversation, run and tool-call identity.
  The item and the native turn checkpoint commit atomically.

## Resolving an item

**Resolve with assistant** opens a new chat with the item attached above the
composer. The first message carries `humanTask: {id, title}` on `message.send`
(not allowed together with a question answer `context`). The title is the
sender's display copy and is stored on that user message, so the chat shows
which item it is about. The server never trusts it: the runtime reads the item
by id in the authenticated scope. The item stays attached to that chat's later
turns until another message brings a different one.

On every turn the model sees, as untrusted data, up to 30 newest open items, the
attached item with its meeting quotes, and this turn's own changes. It may call
`human_task_close` with an item id and a short reason once the conversation
shows the item is resolved or no longer needed. Only an open item is closed; a
missing or already closed item returns `closed: false` to the model instead of
failing the turn. Closing records `resolution: {by: "agent", reason, at}` and
is shown as "Closed by your assistant: reason". Neither creating nor closing an
item performs a service action, creates a CRM task or grants approval. Each run
can create at most 12 and close at most 12 items; create and close receipts
replay exactly and a changed replay is a conflict. Turns that include task data
are marked private in later provider history.

Behind **More** the person can mark an open item done or remove it, and reopen a
closed one. These are their own declarations; they do not run an agent workflow
or prove an external action happened. Explicitly deleting a source meeting
deletes its items and command receipts.

## API

`niaro-human-tasks/2` uses the existing paired device authentication and exact
connection/server/workspace/user scope:

- `GET /v1/<workspace>/human-tasks?tab=open|done[&after=<id>]`
- `GET /v1/<workspace>/human-tasks/<encoded-id>`
- `POST /v1/<workspace>/human-tasks/<encoded-id>` with profile, commandId,
  idempotencyKey, expectedRevision and decision (`complete`, `remove`,
  `reopen`).

An item has `status: open | done | removed` and `resolution` (null while open).
Lists contain at most 100 items, a stable continuation cursor and counts
`{open, done}`. Each owner can retain at most 4,000 items; meeting records can
represent at most 80. Limits fail explicitly.

Server receipts are checked before revision/status comparison. A replay must use
the identical command and returns its original receipt; a fresh scoped read
shows any later decision. The mobile outbox persists the exact decision before
sending it. Uncertain transport failures retain that body for explicit retry,
including after reload. A definitive conflict or deleted item is reconciled with
current scoped state before clearing the rejected attempt.

## Upgrade from `niaro-human-tasks/1`

On start the server migrates stored items once: proposed and active become open,
completed becomes done and dismissed becomes removed (with a user resolution at
the last update time). v1 command receipts are deleted because v1 commands can no
longer be replayed. Native turns saved with `human_task_propose` receipts still
replay under that name. The mobile app keeps pending decisions under a new
storage key, so a saved v1 decision is neither sent nor blocking. Update server
and app together.
