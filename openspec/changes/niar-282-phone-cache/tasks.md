# Tasks

## 1. Cache helper

- [x] 1.1 `ListCache` in `packages/client-core/list-cache.ts`: memory per session, device copy per identity, versioned envelope and item versions, count and byte bounds, identical rewrites skipped, serialized storage (`chat` "Phone list cache").
- [x] 1.2 One identity at a time: `adopt`, `forget`, late writes dropped; `followConnections` wired once in `App` (`chat` "Phone lists belong to one identity").
- [x] 1.3 Jest `tests/list-cache.test.ts`: scoping, versioning, sign-out, expiry and another identity, freshness, server answer replaces cache, bounds.

## 2. Chat list in the menu

- [x] 2.1 `ChatHistory` starts with this session's list, else the device copy; "Loading…" only with neither; the answer replaces the rows at once (`chat` "Chat list shows at once on the phone").
- [x] 2.2 Reads only after an event, a directory change (also while open), two minutes, pull to refresh or **Refresh**; menu edits update the stored list (`chat` "Chat list read only after a change").
- [x] 2.3 Jest `tests/chat-history-cache-mobile.test.tsx`: cached chats at once then updated, no read on a quick re-open, reads after event, directory change and window, pull to refresh, failure and offline keep the list.

## 3. Other lists

- [x] 3.1 Meetings: last known list until the first answer; Jest in `tests/meeting-library.test.tsx` (`meetings` "Meeting list on the phone").
- [x] 3.2 Tasks: last known first page per tab until the first answer, decisions disabled meanwhile; Jest in `tests/human-task-workspace.test.tsx` (`tasks` "Tasks on the phone before the first answer").
- [x] 3.3 Where Niaro reads: last known list, no second read within two minutes, kept on failure; Jest in `tests/member-services-mobile.test.tsx` (`service-sign-in` "Where Niaro reads on the phone").

## 4. Verification

- [x] 4.1 `npm run lint`, `npm run typecheck`, `npm run admin:build`, `npx jest --runInBand --forceExit`.
- [x] 4.2 `openspec validate niar-282-phone-cache --strict`.
- [ ] 4.3 On a phone: menu re-open without a request in the server log, cold start with the last chats shown before the first answer, sign-out leaves no `niaro.lists.v1` keys.
