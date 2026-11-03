# Design

## Context

- `apps/mobile/ChatHistory.tsx` (the menu drawer) mounted `OpenChatHistory` on every opening with empty rows and read every page of `ClientSession.readConversations(after, signal, "active")` (40 chats a page) before the list was complete; nothing survived closing it.
- `ClientSession` (`packages/client-core/session.ts`) already exposes the two change signals the drawer needs: the events cursor (`getSnapshot().store.cursor`, which moves with every ordered event of the person's scope: messages, work, operations) and `getDirectoryVersion()` (bumped by rename, archive, restore and delete from this client and by a `409 snapshot_required`, which is how archives and deletions elsewhere arrive; `chat` "Directory changes reach every client"). The web sidebar (`apps/server-admin/web/app/chat-history.tsx`) re-reads on the directory version.
- `apps/mobile/pet-profile-model.ts` is the precedent: AsyncStorage, a key per identity, a server answer always replaces the stored copy.
- `ClientSession.identityKey` is `JSON.stringify([address, connectionId, serverId, userId, workspaceId])`.
- Spec rules on storage: `chat` "Browser storage" covers the web app only (page memory, presentation choices in `localStorage`); `app-pairing` "Device sign-out and revocation": signing out in the app hides local data. Nothing said what the phone may keep between runs, so this change adds it (`chat` delta "Phone list cache").

## Decisions

### D1. `ListCache` in client-core, one instance in the app

`packages/client-core/list-cache.ts` is framework-free (the boundary check forbids React there):

- `peek(owner, spec)`: synchronous, this session's items (memory, keyed by the `ClientSession` object in a `WeakMap`).
- `read(owner, spec)`: memory, else the device copy; a copy that no longer parses (envelope version, item schema, JSON) is removed and not shown. A server answer written meanwhile wins over the device copy.
- `write(owner, spec, items, {fresh, mark})`: memory and device; `fresh: false` for local edits (shown, kept, but not counted as a server answer).
- `fresh(owner, spec, mark)`: the server answered in this session within `spec.freshMs` with the same `mark`. Device copies are never fresh, so each list is read once per signed-in session at least.
- `invalidate`, `adopt(identityKey)`, `forget()`.

`apps/mobile/list-cache.ts` holds the app's instance on AsyncStorage (`phoneLists`) and `useListSeed(session, spec)`: the last known items until the screen's own read answers, and `remember(items)`.

Rejected: a generic stale-while-revalidate hook owning the reads. Meetings and Tasks poll with their own ownership and generation rules, and the drawer reads pages with duplicate and cursor checks; seeding their state is smaller and changes none of that.

### D2. Keys, scope, size

- Device keys: `niaro.lists.v1:<name>.<itemVersion>:<identityKey>`; the index `niaro.lists.v1.index` = `{version, identity, keys}`.
- Lists: `chats.1` (`ConversationSummarySchema`, newest 200 active chats), `meetings.1` (`MeetingSchema`, 50), `tasks-open.1` and `tasks-done.1` (`HumanTaskSchema`, first page, 50), `services.1` (`MemberService`, 100). Each list at most 256 KB; a longer list is halved until it fits.
- One identity at a time: `followConnections(connections, phoneLists)` (one effect in `App`) adopts the identity of a connected session, which removes every key of another identity in the index, and `forget()`s on `signed_out` and `expired`. Writes and reads of any other identity, and late writes after a sign-out (an epoch check in the storage queue), are dropped. Storage work is serialized; an identical rewrite (same items) is skipped, so a 5-second poll does not rewrite the device.
- Contents: only what the server answered for these lists. The cache never receives credentials (vault), drafts or commands (their own outbox keys).

### D3. Drawer freshness

On opening, the drawer starts with `peek` (no flash on re-open), else reads the device copy and shows it when it arrives first; "Loading…" shows only when there is neither. It then reads the server unless `fresh(session, CHAT_LIST, mark)` with `mark = "<events cursor>:<directory version>"` and no explicit refresh. While open, a change of the directory version re-reads (`useSyncExternalStore` on the session). With chats on screen, the pages are collected and replace the rows once; without, each page shows as it arrives (as before). The answer is written with the mark taken when the read began, so an event during the read makes the next opening read again.

Freshness window: 2 minutes (`CHAT_LIST.freshMs`). Events cover messages and work in any chat; the directory version covers archives and deletions; renames on other devices and anything a server does not put into events are covered by the window. Coming back to the foreground needs no extra rule: the session's sync on return moves the cursor when something happened, and a longer absence passes the window.

Pull to refresh (`RefreshControl`, online only) and **Refresh** after a failure always read. A failed read keeps the rows with the failure notice. Renames, archives and deletions from the menu update the rows and the stored copy at once (`fresh: false`) and the directory version re-reads the list.

Server reads per menu opening (filtered server, N active chats, P = ceil(N/40) pages):

| | Before | After |
| --- | --- | --- |
| Re-open within 2 minutes, nothing changed | P | 0 |
| Re-open after a message, or after 2 minutes | P | P, quietly, last list shown |
| First opening after the app starts | P, list empty until page 1 | P, last list shown from the device |

### D4. Other lists

- **Meetings** (`MeetingLibrary`): `shownMeetings` is the device list until the first answer (`loaded`); every answer is remembered. Polling unchanged.
- **Tasks** (`HumanTaskLibrary`): the first page of the current tab shows its last known items until the first answer for that tab; actions are blocked meanwhile (`blocked`), cards stay readable. Each first-page answer is remembered. Polling unchanged.
- **Where Niaro reads** (`MemberServices`): the last list shows until the answer and instead of the failure notice; not read again within 2 minutes in the same session.
- **Process launch list**: not cached (proposal, non-goals).

## Verification

- Jest `tests/list-cache.test.ts`: kept per identity and read back by the next run; another identity reads nothing; the server answer replaces the copy (also when it arrives during a device read); freshness by window, mark, invalidate, session; versioned envelope, item version and damaged copies removed; bounds by count and bytes; identical rewrites skipped; sign-out, expiry and another identity remove everything, and late writes after sign-out are dropped.
- Jest `tests/chat-history-cache-mobile.test.tsx`: after start the device list shows before the server answers with no "Loading…", then the answer replaces it at once and is stored; a quick re-open makes no call and shows the list in its first frame; an event, a directory change while open and the end of the window read again; pull to refresh reads; a failed read keeps the list with the notice; offline shows the last list and no pull.
- Jest `tests/human-task-workspace.test.tsx`: the last known open items show at once with **Mark as done** disabled until the server answers, then the answer replaces them. `tests/meeting-library.test.tsx`: the meetings from the last run are listed before the server answers, then replaced. `tests/member-services-mobile.test.tsx`: the last known services show at once, no second read within two minutes, the device copy stands in for a failed read.
- Existing drawer, tasks, meetings and services suites unchanged in behaviour (`tests/conversation-history-mobile.test.tsx` counts pin writes by key now, since the chat list is written beside them; suites that render Meetings, Settings services or service cards without an AsyncStorage mock now use the library's Jest mock).
- `npm run lint`, `npm run typecheck`, `npm run admin:build`, `npx jest --runInBand --forceExit`.
- Not verified: a device or emulator run (not used for this change), AsyncStorage timing on a slow phone, a real 409 from another device reaching an open menu.
