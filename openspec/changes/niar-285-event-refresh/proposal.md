# Proposal

Tracker: **NIAR-285** (event-driven refresh of Tasks and Meetings on the phone)

## Why

Every phone keeps asking the server for lists that rarely change. `apps/mobile/HumanTaskLibrary.tsx` read `GET human-tasks` every 5 s while Tasks was on screen and every 15 s while hidden (for the badge of waiting work); `apps/mobile/MeetingLibrary.tsx` read `GET meetings` every 5 s while Meetings was on screen. That is 12 to 16 list reads a minute per phone that is just open, each a full list with counts, and more when the OS keeps the app's timers running in the background. NIAR-282 made these screens show their last known list at once; it left the polling in place and reported it separately.

The session already polls `GET events?after=<cursor>` every second while the app is in the foreground (and never in the background). Human tasks and meetings are not part of that event log, so the phone could not know when to read them.

## What Changes

- **A change mark per list on the server** (`apps/server-identity/list-marks.ts`): a per-person counter for Tasks and one for Meetings, in memory, bumped by every write of `HumanTaskStore` (create, decision, agent close, deletion with a meeting) and of `MeetingStore` (create, every saved step: upload progress, seal, rename, processing status, transcribed segment, speaker names, audio deletion, and deletion). The marks carry a random epoch per server process, so a restart changes every mark once.
- **The events poll carries the marks** for clients that ask: `events?after=N&lists=agent-list-marks/1` answers with `lists: { tasks, meetings }` (`packages/protocol/list-marks.ts`, optional in `EventsResponseSchema`). Clients that do not ask (older phones, whose strict schema would refuse the field) get the response unchanged.
- **The session exposes them**: `ClientSession.getListMarks()`, and subscribers are told when a mark moves (`packages/client-core/session.ts`, in the existing events poll; no new request).
- **Tasks and Meetings read on change, not on a timer** (`apps/mobile/list-refresh.ts`, `useListRefresh`): a read when the list starts being followed or its tab, page or open record changes; when its mark moves (at most every 5 s, the last change included); when the screen opens and the last read is older than 2 minutes or predates a change; when the app comes back from the background or the connection comes back; and on the screen's **Refresh**. Nothing runs in the background. Tasks follows its mark also while hidden, so the badge stays right.
- **Meetings being processed** move on screen with their mark, since every processing step saves the meeting. No poll is needed for them.
- **Safety net only for servers without marks**: when the events poll brings no marks (a server before this change), Tasks and Meetings read every 2 minutes while followed in the foreground, and every 15 s while a meeting on screen uploads or processes.

## Non-goals

- The session's own 1-second events poll (unchanged; the marks ride on it). Making it slower or long-polling is a separate change.
- The web app's Tasks and Meetings pages (their reload rules are unchanged).
- Putting tasks and meetings into the ordered event log as entities.
- A pull gesture on these screens: the phone's manual refresh for Tasks and Meetings is the top bar's **Refresh** button.

## Risk

- Marks live in the server process's memory: with more than one process writing the same database a change in another process would not move the mark here. Niaro runs one server process per database; the design records this assumption.
- A phone that cannot reach the events poll (offline) learns nothing until it reconnects; the reconnect and foreground reads cover that.
- The first mark a session sees after start differs from "no mark", so Tasks reads once more shortly after start (one request per app start).
