# Tasks

## 1. Server signal

- [x] 1.1 `ListMarksSchema` and `LIST_MARKS_PROFILE` in `packages/protocol/list-marks.ts`; optional `lists` in `EventsResponseSchema` (`tasks` "List change marks").
- [x] 1.2 `ListMarkCounter` with a per-process epoch; `HumanTaskStore` and `MeetingStore` bump it on every write, not on replays or reads; `IdentityService.listMarks(scope)`.
- [x] 1.3 The events route adds `lists` for `lists=agent-list-marks/1` on account workspaces; other requests unchanged.
- [x] 1.4 Node `tests/list-marks.node.ts` (stores and the paired server's events poll); added to `test:identity` and `test:meetings`.

## 2. Session

- [x] 2.1 `ClientSession` asks for the marks in its events poll, keeps them (`getListMarks`) and tells subscribers when one moves.
- [x] 2.2 Jest in `tests/session.test.ts`.

## 3. Phone lists

- [x] 3.1 `useListRefresh` in `apps/mobile/list-refresh.ts`: reads on start, target change, mark change (5 s apart), opening after 2 minutes or a change, foreground, reconnect and Refresh; nothing in the background; a sparse read only without marks (`tasks` "Tasks on the phone read after a change").
- [x] 3.2 `HumanTaskLibrary` drops its 5/15 s timer and follows its mark also while hidden for the badge.
- [x] 3.3 `MeetingLibrary` drops its 5 s timer, follows its mark while visible, reports processing meetings for the fallback, and serializes its reads (`meetings` "Meetings on the phone read after a change").
- [x] 3.4 Jest `tests/list-refresh-mobile.test.tsx`.

## 4. Verification

- [x] 4.1 `npm run lint`, `npm run typecheck`, `npm run admin:build`, `npx jest --runInBand --forceExit`; node suites for meetings, tasks, work items and events.
- [x] 4.2 `openspec validate niar-285-event-refresh --strict`.
- [ ] 4.3 On a phone: no `human-tasks` or `meetings` requests in the server log while idle; a task added on the web reaches the badge within seconds; a processing meeting moves through its steps on screen.
