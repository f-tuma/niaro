# Design

## Context

- `HumanTaskLibrary` (mounted while signed in, rendered only on Tasks) read `ClientSession.readHumanTasks(tab, after)` at once and then on `setInterval(visible ? 5000 : 15000)`; every answer also feeds `onCounts`, the Tasks badge in `App`. `MeetingLibrary` (mounted while signed in) read `readMeetings()` (and the open record when its `updatedAt` moved) on `setInterval(5000)` while visible. Both re-read on `refreshVersion` (the top bar's **Refresh**).
- `ClientSession` polls `GET events?after=<cursor>` every second (`tick`, `setInterval(1000)`), skipped while `setActive(false)` (the app's `AppState` is not `active`) or the web tab is hidden. The event log (`EventSchema`) holds conversations, work items, input requests, action proposals and operations of the agent scope (`apps/fixture-server/storage.ts`). Human tasks (`apps/server-identity/human-task-store.ts`) and meetings (`apps/server-identity/meeting-store.ts`) live in the identity database and never enter it; a task decision or a meeting's processing step does not move the cursor.
- NIAR-282 added `ListCache` with `fresh(owner, spec, mark)` and the chat drawer's mark (`<cursor>:<directory version>`); the drawer re-reads on those signals and a 2-minute window.
- Request profiles are opt-in query parameters on the agent routes (`replies=`, `chats=`, `work=`, …) because older clients parse responses with strict schemas.

## Decisions

### D1. The smallest server signal: per-person change counters in the events response

`ListMarkCounter` (`apps/server-identity/list-marks.ts`) keeps a `Map` from `[list, connectionId, serverId, workspaceId, userId]` to a number and a random 12-hex epoch created with the process. `read(scope)` returns `{ tasks: "<epoch>.<n>", meetings: "<epoch>.<n>" }`.

- `MeetingStore` owns one counter (`marks`) and passes it to its `HumanTaskStore`, so both stores of one database share it. `HumanTaskStore` bumps `tasks` after an inserted item (`create`; a repeated create returns the old item and does not bump), after every `write` (`command` and `close`; a replayed command answers from its receipt and does not bump), and after `deleteMeeting` removed rows. `MeetingStore` bumps `meetings` in `save` (every update: upload offset, seal, rename, `update` of status, failure, duration, title, `putSegment`, speaker names, audio deletion, the boot-time `interrupted`), after `create`'s insert and after `delete`.
- `IdentityService.listMarks(scope)` reads them. The events route (`apps/fixture-server/http.ts`) adds `lists` inside the same `run` as the events when the request names `lists=agent-list-marks/1` and the workspace is an account workspace served by the identity service (the scope is the authenticated device session's, the same `runtime.session.scope` the meeting and task routes use).
- `EventsResponseSchema.lists` is optional (`ListMarksSchema`: two strings, 1–64 of `[A-Za-z0-9._-]`).

Why in memory: every write goes through these two stores in the one server process that owns the SQLite file (no cluster or worker writes), the read is a map lookup on a route hit once a second per phone, and a lost counter (restart) is covered by the new epoch, which moves every mark once. A database column would cost a write per change and a query per poll for the same answer.

Rejected:

- **Task and meeting entities in the event log**: correct but large (ordering, retention, snapshots, the 2000-event batch, strict client schemas for new event types) for lists the phone reads whole anyway.
- **A version derived per poll** (`count(*)`, `max(updatedAt)`): a scan of up to 4000 items per person per second, and deletions need care.
- **A separate long-poll or push channel**: new infrastructure while the events poll already runs.

### D2. The session publishes the marks it receives

`sync()` asks with `&lists=agent-list-marks%2F1` and, after the scope check, `updateListMarks(batch.lists)`: when a mark differs from the last one, it is kept and the session's listeners are called (as `directoryChanged` does). `getListMarks()` returns the last marks or `undefined` (before the first poll, or from a server without them). No extra request.

### D3. One refresh rule for both lists (`useListRefresh`)

`apps/mobile/list-refresh.ts` reads the list's mark with `useSyncExternalStore(session.subscribe, () => session.getListMarks()?.[list])` and the foreground from `AppState` (`background` is the only state that pauses; `inactive` covers system dialogs and the screen does not re-read for them). It remembers the last read that landed: `{target, mark, at}` (mark as taken when the read began, so a change during the read reads again).

A read happens when:

| Trigger | Condition |
| --- | --- |
| Start following / new target | followed, online, foreground, and no landed read for this `target` |
| Mark moved | followed, online, foreground, mark ≠ last read's mark; at most every `minGapMs` = 5 s, trailing, skipped if another read brought the mark meanwhile |
| Screen opens | `visible` became true, online, foreground, and the last read is older than `freshMs` = 2 min or predates a mark change |
| Foreground / reconnect | the app left `background` or the session came back `online`, after a first read, while visible or followed |
| Refresh | `refreshVersion` changed |
| No marks (older server) | every `fallbackMs` = 2 min while followed, online and in the foreground; every `processingMs` = 15 s while visible with a meeting uploading, transcribing or analyzing |

Reads for the same target never overlap: one asked for during a read runs once afterwards, and only when that read did not land, the target or mark moved meanwhile, or the request was explicit (Refresh, foreground, reconnect). A read for another target (tab, page, open record) starts at once; the screen drops the old answer with its existing generation checks.

Following: **Tasks** follows always (`follow: true`), because the badge counts come with every list answer; **Meetings** follows while visible (`follow: visible`), and a change while hidden makes the next opening read. Meetings passes `online: true`: it never gated its reads on the session state and keeps showing a failed read's notice as before.

`load` resolves `false` (Meetings) or rejects (Tasks) when nothing landed; the hook then keeps the old record, so a later trigger or opening reads again.

`MeetingLibrary.load` used to drop a read asked for while another was running (the 5-second poll caught up). With reads now triggered once per change, a read asked for during another one waits for it and then reads; a read the screen dropped (`invalidate`: hidden, another record) is not waited for. Leaving the screen or opening another record drops the read under way, as the old effect's cleanup did.

### D4. Processing meetings

Every processing step goes through `MeetingStore.save` (status, `completedSegments` per transcribed segment, upload `offset` per 256 KB block, the final `ready` with its record). Each moves the meetings mark, the events poll brings it within about a second, and the open screen reads at most every 5 s. The record of the open meeting is still read only when its `updatedAt` moved. So no processing poll exists while the server sends marks; the 15-second read in the table above is for servers without them.

### D5. No safety-net timer with marks

Events cover every write path of both lists (D1), a restart moves every mark, offline is covered by the reconnect read and the background by the foreground read. The 2-minute window on opening remains as the only time-based read, in line with NIAR-282's freshness window; it costs one read per opening after a long time away and protects against an unforeseen write path.

## Requests per minute per phone

Excluding the session's own events poll (60 a minute in the foreground before and after; its answer grows by about 70 bytes).

| Situation | Before | After |
| --- | --- | --- |
| Idle on Tasks | 12 (`human-tasks`) | 0 |
| Idle elsewhere in the foreground | 4 (`human-tasks`, badge) | 0 |
| Idle on Meetings | 12 (`meetings`) + 4 (badge) | 0 |
| In the background | up to 4 (and 12 if Meetings was open) while the OS ran the timers | 0 |
| A meeting processing, Meetings on screen | 12 + 4 | one per change, at most 12; e.g. one per transcribed minute of audio |
| A task added or decided anywhere | caught by the next 5/15 s read | 1 within about a second (the badge too) |
| Opening Tasks or Meetings | 1 (Meetings), Tasks kept polling | 0 within 2 min of the last read and no change, else 1 |
| Back to the foreground | timers resumed | 1 for Tasks; 1 for Meetings if on screen |

## Verification

- Jest `tests/list-refresh-mobile.test.tsx` (fake timers, a session with marks): no read in 10 minutes idle on Tasks, hidden or shown, or on Meetings; a task mark reads and updates the badge while hidden, bursts read at most every 5 s with the last change; a meetings mark does not read Tasks; foreground reads once, the background never; Refresh always; opening reads only after the window or a change; a processing meeting moves to ready with its mark and no poll; without marks, 15 s while processing and 2 minutes otherwise, nothing hidden.
- Jest `tests/session.test.ts`: the events poll asks for the marks, a server without them works, subscribers are told only when a mark moves.
- Node `tests/list-marks.node.ts`: marks per person and list, a new epoch per process; create, decision, agent close and deletion move the tasks mark, a repeated create and a replayed decision do not; a meeting's create, upload, rename, status, segment, failure and deletion move the meetings mark, deletion also the tasks mark; reads move nothing; on the paired server the events poll carries the marks only when asked, and they move with a task from the assistant and a meeting from the phone.
- Existing Tasks and Meetings suites (`human-task-workspace`, `meeting-library`, `meeting-workspace`, `meeting-process-integration`) unchanged.
- Not verified: a device or emulator run, the request rate in a real server log, AppState behaviour on a specific phone.
