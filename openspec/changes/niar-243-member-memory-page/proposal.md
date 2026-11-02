# Proposal

Tracker: **NIAR-243**

## Why

Saved memory promises to be "inspectable, correctable and erasable" (`memory` spec), and the memory API already serves every workspace member, but the only screen is the administration's **Built-in tools → Memory** panel, which members cannot open. A person who wants to know what the assistant keeps about them, or to remove it, has to guess exact texts for "Forget …" in chat. This is a privacy gap in the pilot.

## What Changes

- New web app page **Memory** at `/me/memory`, reached from the account menu (between Account and Archived chats) and from a link on the Account page. It is not a sidebar entry: the sidebar order of `docs/ui-system.md` stays unchanged.
- The page lists the person's own private memories in the current workspace, newest first: text, kind (Preference, Fact, Note), where it came from, when it was saved and when it expires; earlier versions of a corrected memory are shown under it. Shared workspace notes are not listed (they are not about the person and are managed by administrators).
- **Delete** on a memory erases it with its whole correction lineage after a confirmation (existing `forget` command, tombstones only).
- **Erase all** in the page's `…` menu erases every private memory of the person in the workspace after a confirmation, through a new idempotent `forgetAll` command; shared notes, chat history and receipts stay.
- A **Use memory** switch for the person's existing opt-out (`preference` command).
- Loading, empty, plugin-off, error, conflict and lost-response states; EN and CS strings.
- Memory API: `GET` accepts `scope=private` to return only the person's private records and reports `total` so the page can say when more than 200 exist; `POST` accepts `forgetAll`.
- The page works without a chat connection, like `/me`, so erasure never depends on the chat session.

## Non-goals

- Adding or editing memories on the page (chat "Remember …" and `Revise memory: …` stay the ways to do that).
- Paging beyond the newest 200 records; Erase all covers everything regardless.
- Shared workspace notes for members.
- A mobile app screen. The mobile app keeps chat commands; the page works in a phone browser. A native screen can follow if the pilot asks.
- Changing the administration Memory panel beyond what the shared schema needs.

## Risks

- Erase all is irreversible. Mitigation: destructive item only in `…`, confirmation naming the count, idempotent by request id so a lost response is resent safely without erasing memories saved afterwards.
- A memory change advances the workspace memory version and invalidates pending approvals that used memory (existing rule); erasing during a waiting approval forces a re-plan. This is the intended privacy behavior.
- The page links from the account menu, so people in workspaces where the operator never allowed the memory plugin will find a page saying memory is off.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `memory`: private-only listing with a total, the `forgetAll` command and its erasure semantics, and the web app Memory page with its states.

## Impact

- Server: `apps/server-identity/memory.ts` (`forgetAll`, private-only listing, total), `apps/server-identity/service.ts` memory route (query schema, command dispatch, response).
- Protocol: `packages/protocol/memory.ts` (`MemoryReadQuerySchema`, `forgetAll` command, `total` in `MemoryViewSchema`).
- Web app: new `apps/server-admin/web/app/memory-page.tsx` and `memory-copy.ts`, route in `app/router.tsx`, account menu item in `app/shell.tsx` (and `/me/*` without chat), link on `app/account-page.tsx`, labels in `app/copy.ts`.
- Tests: `tests/memory.node.ts`, `tests/memory-http.node.ts`, `tests/web-app-routes.test.tsx`, new `tests/web-memory-page.test.tsx`.
- Mobile: none.
