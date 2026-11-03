# tasks Specification

## Purpose

Tasks is each person's short list of what is left to resolve (items the assistant creates from chat and meetings and closes as work gets done), and the server's tracking of the assistant's own paused work (questions and approvals) so that a person can return to exactly that goal. It serves people in the web and mobile apps and the chat agent.

## Requirements

### Requirement: Open items

The system SHALL keep, per person and workspace, items that still have to be resolved because information, a decision or an outside step is missing. An item SHALL have a title (1–1,000 characters), detail (at most 2,000), assignee and due (each at most 160 characters or null), an optional resolved `dueDate`, `status` `open`, `done` or `removed`, a `resolution` `{by, reason, at}` (null while open) and a revision. Ordinary agent executions SHALL NOT appear in Tasks.

#### Scenario: Item from a meeting

- **WHEN** a completed meeting publishes its record with follow-ups for the person
- **THEN** each follow-up appears as an open item with the meeting identity and its source quotes (see `meetings`)

### Requirement: Item origin

Each item SHALL record its origin: a meeting (meeting id, title, record digest and 1–4 verbatim source quotes) or the agent (run, tool call and conversation), set by the server.

#### Scenario: Item from chat

- **WHEN** the chat agent creates an item
- **THEN** its origin names the run, tool call and conversation, not values supplied by the model

### Requirement: Tasks views

The web and mobile apps SHALL show Tasks with two tabs: **Open** and **Done** (items closed by the assistant or the person, and removed items). A closed item SHALL show who closed it; an agent closure SHALL read "Closed by your assistant: reason".

#### Scenario: Closed by the assistant

- **WHEN** the assistant closes an item with a reason
- **THEN** the item moves to Done and shows the reason as closed by the assistant

### Requirement: Tasks API

`niaro-human-tasks/2` SHALL use the paired app authentication and exact connection, server, workspace and user scope: `GET /v1/{workspace}/human-tasks?tab=open|done[&after=]` (at most 100 items, a stable cursor and counts `{open, done}`), `GET /v1/{workspace}/human-tasks/{id}`, and `POST /v1/{workspace}/human-tasks/{id}` with `profile`, `commandId`, `idempotencyKey`, `expectedRevision` and `decision` (`complete`, `remove`, `reopen`).

#### Scenario: Another person's item

- **WHEN** a person reads an item id of someone else
- **THEN** it is not found

### Requirement: Item limits

A person SHALL keep at most 4,000 items and a meeting record at most 80; exceeding a limit SHALL fail explicitly with `human_task_limit`.

#### Scenario: Owner limit

- **WHEN** a person already has 4,000 items and a new one is created
- **THEN** creation fails with `human_task_limit`

### Requirement: Person's own decisions

The person SHALL be able to mark an open item done (`complete`), remove it, or reopen a done or removed item. These are declarations only: they MUST NOT run an agent, a service action or prove that an external step happened. A decision not valid for the item's status SHALL be refused, and a stale `expectedRevision` SHALL conflict. Command receipts SHALL be checked before the revision: an exact replay SHALL return the original receipt, and a changed command under the same ids SHALL conflict.

#### Scenario: Reopen

- **WHEN** the person reopens a done item at its current revision
- **THEN** the item becomes open with no resolution

#### Scenario: Complete a removed item

- **WHEN** the person sends `complete` for a removed item
- **THEN** the decision is refused

#### Scenario: Lost decision response

- **WHEN** the app resends the exact decision after losing the response
- **THEN** it gets the original receipt and nothing changes twice

### Requirement: Decision delivery in the apps

The apps SHALL save a decision before sending it. An uncertain delivery SHALL keep the exact body for an explicit retry, including after reload; a definitive conflict or deleted item SHALL be reconciled with the current item before the attempt is cleared.

#### Scenario: Network drops during a decision

- **WHEN** the app cannot tell whether a `complete` arrived
- **THEN** it keeps the decision and offers to retry the same command

### Requirement: Agent creates items

The chat agent SHALL be able to call `human_task_create {title, detail, assignee, due}` (unknown values null) for something it cannot finish in the conversation; the server SHALL commit the item with the agent's turn checkpoint. An exact normalized match with any open item SHALL return `status: "duplicate"` instead of creating another. A run SHALL create at most 12 items. Creating an item MUST NOT perform a service action, create a CRM task or grant approval.

#### Scenario: Duplicate item

- **WHEN** the agent creates an item whose normalized content equals an open item
- **THEN** no new item is created and the result names the existing one as a duplicate

#### Scenario: Thirteenth item in one run

- **WHEN** the agent tries to create a thirteenth item in one run
- **THEN** it is refused with `human_task_limit`

### Requirement: Agent closes items

The chat agent SHALL be able to call `human_task_close {taskId, expectedRevision, reason}` once the conversation shows the item is resolved or no longer needed. Only an open item at that revision SHALL be closed, with `resolution: {by: "agent", reason}`; otherwise the tool SHALL return `closed: false` with `not_found`, `not_open` or `revision_conflict` instead of failing the turn. A run SHALL close at most 12 items.

#### Scenario: Item changed meanwhile

- **WHEN** the agent closes an item with an old revision
- **THEN** the result is `closed: false` with `revision_conflict` and the item stays open

### Requirement: Agent sees open items

On every turn the chat agent SHALL receive, as untrusted data, at most the 30 newest open items, the item attached to the chat with its meeting quotes, and this turn's own changes. Turns that include item data SHALL be marked private in later provider history.

#### Scenario: Instructions inside an item

- **WHEN** an item's detail contains text like "ignore your rules"
- **THEN** the agent treats it as data and no tool permission changes

### Requirement: Resolve with assistant

**Resolve with assistant** SHALL open a new chat with the item attached; the first message SHALL carry `humanTask: {id, title}` on `message.send`, which MUST NOT be combined with a question answer `context`. The server SHALL read the item by id in the authenticated scope and MUST NOT trust the sent title, which is only stored on the user message for display. The item SHALL stay attached to later turns of that chat until another message brings a different item.

#### Scenario: Answer and item together

- **WHEN** a `message.send` carries both `context` and `humanTask`
- **THEN** the command is rejected

### Requirement: Meeting deletion

Explicitly deleting a source meeting SHALL delete its items and their command receipts.

#### Scenario: Meeting deleted

- **WHEN** the person deletes a meeting that produced two open items
- **THEN** both items and their receipts are deleted

### Requirement: Paused agent work

A chat run that asks a question or waits for an action approval SHALL be projected as a native WorkItem (`demo: false`, the root run id as id, a `native` binding with the run's revision) in its conversation, surviving detours, new empty chats and restarts. A pending action SHALL show its canonical receipt (operation id, parameters, effect, status). Process runs are projected the same way (see `process-execution`).

#### Scenario: Question survives a new chat

- **WHEN** the assistant asks a question and the person starts a new empty chat
- **THEN** the question stays answerable in its original conversation

### Requirement: Question identity

Each `ask_user` call SHALL create a new input request with its own id, revision, owning work item and conversation; answering an earlier request MUST NOT resolve it.

#### Scenario: Second question

- **WHEN** a run asks a second question after the first was answered
- **THEN** the second has a new input id and the first answer cannot resolve it

### Requirement: Work projection window

The projection SHALL cover at most 400 roots, pending runs first, within the 500-WorkItem snapshot limit. An unchanged refresh SHALL emit no events, and an older run revision MUST NOT overwrite a newer projection.

#### Scenario: Unchanged refresh

- **WHEN** the client refreshes and no run changed
- **THEN** no work events are emitted

### Requirement: Explicit goal return

An answer SHALL resume a paused question only when `message.send.context` names `runtime: "mastra"`, the work id, the input id and the expected input revision; it SHALL then resume exactly that tool call regardless of the latest chat goal. An unbound reply MUST NOT resume an arbitrary run when several wait. Late voice transcripts, duplicate answers, stale revisions and wrong targets MUST NOT attach to another goal.

#### Scenario: Two runs waiting

- **WHEN** two runs wait for answers and the person replies without a bound context
- **THEN** neither run is resumed by guessing

#### Scenario: Stale question revision

- **WHEN** an answer carries an outdated input revision
- **THEN** it is refused and nothing resumes

### Requirement: Opening paused work

`task.open {conversationId, workItemId, expectedWorkRevision}` SHALL durably select a paused run after checking run, actor, scope, source TTL, policy epoch and memory, without resuming it, calling a model or dispatching a tool. Viewing or opening work SHALL never be consent.

#### Scenario: Opening is not consent

- **WHEN** the person opens a waiting approval
- **THEN** nothing is approved or dispatched

### Requirement: Approving paused chat actions

A paused action SHALL be approved or declined with `service.resolve` carrying the canonical operation id, work id and expected work revision; the server SHALL check the projection and the fresh run state under the run lock. Chat and the apps SHALL share the same receipt and approval component. Declining SHALL record the receipt `rejected` without dispatch.

#### Scenario: Stale approval

- **WHEN** an approval carries an outdated work revision
- **THEN** it conflicts and nothing is dispatched

### Requirement: Cancelling own work

`work.cancel {conversationId, workItemId, expectedWorkRevision, language}` SHALL stop the person's own open work without resuming it: a paused question ends `cancelled`, a paused approval is declined (receipt `rejected`, no dispatch), a waiting process run is cancelled, and a run that stopped without an answer is closed once its native retirement is proved. A request still in flight SHALL conflict.

#### Scenario: Cancel a waiting approval

- **WHEN** the person cancels a run waiting for approval
- **THEN** the receipt becomes rejected and the action is never dispatched

#### Scenario: Cancel during dispatch

- **WHEN** the person cancels while the run is dispatching
- **THEN** the cancel is refused as a conflict

### Requirement: Cancellation keeps recorded effects

Cancelling SHALL keep recorded receipts with their outcome, and an `unknown` write SHALL stay unconfirmed. `conversation.delete` and `conversation.archive` with `cancelOpenWork: true` SHALL first cancel the chat's open work the same way.

#### Scenario: Delete a chat with open work

- **WHEN** the person deletes a chat with `cancelOpenWork: true` while a question waits
- **THEN** the question ends cancelled before the chat is deleted

### Requirement: Expiry

A question or approval paused longer than 30 minutes SHALL be projected `expired` and SHALL NOT block deleting or archiving its chat. A run that stopped without an answer or question SHALL be projected `waiting_system`; once older than 30 minutes, deleting or archiving its chat SHALL first close it as if cancelled.

#### Scenario: Old approval

- **WHEN** an approval has waited 31 minutes
- **THEN** it is shown expired and can no longer be approved

### Requirement: Revoked context

Revoked or expired pending context SHALL lose its question or approval controls and require a fresh request instead of reusing expired facts. An unknown write SHALL never become done because a reply or command was accepted.

#### Scenario: Permission revoked while waiting

- **WHEN** the person loses access to the action of a waiting approval
- **THEN** the approval controls disappear and nothing is dispatched

### Requirement: Tasks on the phone before the first answer

The phone's Tasks screen SHALL show the last known first page of the open tab (see `chat` "Phone list cache") until the server's first answer for that tab in the session. Those items SHALL be readable, and their decisions SHALL stay disabled until the server has answered.

#### Scenario: Opening Tasks after a start

- **WHEN** the app starts and the person opens Tasks before the server answers
- **THEN** the open items from the last run are listed and their **Mark as done** and **Remove** wait for the server's list

### Requirement: List change marks

The server SHALL keep, for each person, a change mark of their Tasks and one of their Meetings, and SHALL return both in the events poll response as `lists: { tasks, meetings }` to clients that ask with `lists=agent-list-marks/1`. Other clients SHALL receive the response unchanged. Marks SHALL be opaque and SHALL NOT reveal anything about the items.

#### Scenario: An older client

- **WHEN** a client polls events without `lists=agent-list-marks/1`
- **THEN** the answer has no `lists` field

### Requirement: What moves a list change mark

The tasks mark SHALL change whenever one of the person's items is created, decided, closed by the assistant or removed with its meeting. The meetings mark SHALL change whenever one of their meetings is created, saved (upload progress, sealing, renaming, a processing step, a transcribed segment, speaker names, deleted sound) or deleted. A server restart SHALL change every mark. Reads, a repeated create and a replayed decision SHALL NOT change a mark.

#### Scenario: An item added by the assistant

- **WHEN** the assistant adds an open item for the person while their phone polls events
- **THEN** the next events answer carries a different tasks mark and the same meetings mark

#### Scenario: A replayed decision

- **WHEN** the phone sends the same decision again after a lost acknowledgement
- **THEN** the server answers from its receipt and the tasks mark stays the same

### Requirement: Tasks on the phone read after a change

The phone SHALL NOT read the Tasks list on a timer while the server sends change marks. It SHALL read it when Tasks starts being followed or its tab or page changes, when the tasks mark differs from the mark of the last read (at most every 5 seconds, the last change included), and on **Refresh**. It SHALL follow the tasks mark also while Tasks is hidden, so the Tasks badge counts the latest change.

#### Scenario: Idle on Tasks

- **WHEN** the person keeps Tasks open and nothing changes
- **THEN** the phone sends no Tasks reads after the first one

#### Scenario: Badge after a change elsewhere

- **WHEN** an item is added on the web while the phone shows the chat
- **THEN** the phone reads Tasks within seconds and the badge counts the new item

### Requirement: Tasks read on opening and on return

The phone SHALL read Tasks when Tasks opens and the last read is older than 2 minutes or predates a change, and when the app returns from the background or the connection returns. It SHALL NOT read Tasks while the app is in the background. With a server that sends no change marks, it SHALL read Tasks at most every 2 minutes while the app is in the foreground.

#### Scenario: Back from the background

- **WHEN** the app returns to the foreground
- **THEN** the phone reads Tasks once

#### Scenario: Quick reopening

- **WHEN** the person leaves Tasks and opens it again within 2 minutes with nothing changed
- **THEN** the phone shows the list without reading it

### Requirement: One task never blocks reads

When the server builds a person's task window for a snapshot, events, chat or voice request, a single task that cannot be projected or published SHALL be left out of the window, with an operator log line naming its kind, run id and error class, and the request SHALL still be answered with the other tasks. The log line MUST NOT contain the task's content. This applies to a task whose saved state is unreadable, a task that is not valid native work, and a task whose chat the person does not have.

#### Scenario: Unreadable saved run

- **WHEN** one of the person's saved runs can no longer be projected
- **THEN** the snapshot is answered without that task
- **AND** the server logs `task_projection_skipped` with its run id

#### Scenario: Unknown chat

- **WHEN** a task names a chat that is not live, stored, deleted or archived for that person
- **THEN** the task is left out and logged, and the other tasks are published

### Requirement: Request failures still fail the read

A sign-in or access change, a server that cannot answer now, a changed task window and a cancelled request SHALL still fail the read, never answer it as a shorter task list. A window over 400 tasks, with duplicate ids, or a delta that would evict tasks SHALL still be refused.

#### Scenario: Another person signed in

- **WHEN** the actor changes while the task window is being built
- **THEN** the request fails with `identity_forbidden`
