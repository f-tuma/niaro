# Proposal

Tracker: **NIAR-282** (phone cache, fewer reads)

## Why

The owner: "When I open the sidebar, the chats always load. We can take load off the server by keeping some things on the phone in a cache that updates quietly in the background."

Today every opening of the phone's menu starts empty, says "Loading…" and reads every page of the chat list (`GET conversations?state=active`, 40 chats a page) again, even when the menu was closed a second ago and nothing changed. The Tasks and Meetings screens and Settings' **Where Niaro reads** start empty after every app start until the server answers.

## What Changes

- **One small list cache on the phone** (`packages/client-core/list-cache.ts`, the app's instance in `apps/mobile/list-cache.ts`): the last server answer of a list, kept in memory for the signed-in session and in AsyncStorage for the next start. Scoped to one identity (server address, connection, server, person, workspace); everything of the previous identity is removed on sign-out, an expired sign-in or a sign-in as someone else or on another server. Versioned (the envelope and each list's item version are in the key; what no longer parses is removed). Bounded (the newest 200 chats, 50 meetings, 50 tasks of each tab's first page, 100 services; at most 256 KB a list). It holds what the server answered for these lists only: no credentials, drafts, commands or message text.
- **Chat list in the menu**: shown at once from memory (re-open) or the device (after start), with no "Loading…" over it; the server's answer replaces it as a whole when it arrives. The menu reads the server only when the list may have changed: the events cursor moved (a message or other change in any chat), the directory version changed (a rename, archive or deletion here or elsewhere; the open menu re-reads then too), two minutes passed, the person pulled to refresh, or pressed **Refresh** after a failure. A read that fails keeps the last known chats with the existing failure notice.
- **Tasks, Meetings, Where Niaro reads**: the last known list stands in until the first server answer of the session; their polling and reads are unchanged. Cached tasks can be read but not decided on until the server has answered. **Where Niaro reads** is not read again within two minutes of the last answer, and shows the last known list instead of the failure notice when a read fails.
- A spec rule for what the phone may keep (chat delta) and per list behaviour (chat, tasks, meetings, service sign-in deltas).

## Non-goals

- The web app: its storage rule (chat caches in page memory only) is unchanged.
- The process launch list (Library, Processes): it is read on request and carries launch forms that must be current when a run starts; caching it would show forms that may no longer be valid.
- Fewer polls on the Tasks (5 s visible, 15 s in the background for the badge) and Meetings (5 s visible) screens; reported separately.
- Reading only the first page of the chat list after an event and merging older chats from the cache (possible later; a full read keeps the list exact).

## Risk

- A list may be shown up to one read old: the last known state, as after a reconnect. Decisions on tasks wait for the server answer.
- Chat titles, meeting names and task titles of the signed-in person stay on the phone between runs until sign-out. The phone already keeps the open chat's snapshot (`agent-client.snapshot.v2`) on the device; the list cache keeps less.
- A stored copy is shown before the restored credential is confirmed by the server; an expired or revoked sign-in removes it as soon as the app learns of it.
