# Design

## Context

See proposal.md for the motivation. Today:

- `GET|POST /admin/api/identity/memory` is handled inline in `apps/server-identity/service.ts` (~L4706–4850). It refuses the operator session, resolves the actor with `workspaceActor()` (any organization member of the workspace, members included), re-checks membership and plugin/policy revisions in `check()` inside every commit, dispatches `remember` / `revise` / `forget` / `preference` to `MemoryStore`, and always answers the full `agent-memory/1` view (`MemoryViewSchema` in `packages/protocol/memory.ts`, at most 200 items). The GET query is parsed with the strict `WorkspaceTarget`, so any extra key is a 400 today.
- `MemoryStore` (`apps/server-identity/memory.ts`): `rows()` selects private rows of the actor plus shared rows when `allowShared` is on (status active/candidate/superseded, published, unexpired, `LIMIT 2000`); `list()` decrypts, filters with `readable()` and slices to 200. `forgetImpl()` checks the revision, calls `erase()` (whole lineage → `status='deleted'`, content dropped from the native store via `publication='erase_pending'` and `cleanup()`, request fingerprints nulled, one `bump()` of the workspace memory version), records a request row (`agent_memory_request`, kind, fingerprint, state) and reports through `onMutation` → audit `memory.changed`. `replay()` answers a repeated `requestId` and refuses a different kind with `memory_request_conflict`.
- The only UI is `MemoryRecords` in `apps/server-admin/web/memory-panel.tsx` (admin Plugins → Memory), which keeps a `retry` ref so an unknown outcome is resent with the same `requestId`.
- Web app: routes in `apps/server-admin/web/app/router.tsx` (`/me` → `AccountPage`), shell and account menu in `app/shell.tsx` (`UserMenu`: Administration, Account, Archived chats; `/me` renders even without a chat session), account page `app/account-page.tsx` inside `MenuPage`, strings in `app/copy.ts` and per-page copy files. `tests/web-app-routes.test.tsx` pins the first eight sidebar links to the order of `docs/ui-system.md`.

## Goals / Non-Goals

**Goals:** a member-facing, private-only view of saved memory with single delete, erase all and opt-out, built on the existing API with the smallest protocol additions, following the memory spec's erasure and replay rules.

**Non-Goals:** add/edit on the page, paging past 200, shared notes for members, a mobile screen, restyling the admin panel.

## Decisions

### D1. Placement: `/me/memory`, from the account menu, not the sidebar

Memory is personal data about the account, like devices and archived chats, not a work view onto services; the sidebar is reserved for the work areas listed in `docs/ui-system.md` and pinned by `tests/web-app-routes.test.tsx`. So: route `/me/memory` (child-free sibling of `/me`, "/account/*" is taken by public pages), an account-menu item **Memory** / **Paměť** (`Brain` icon) between Account and Archived chats, and a **Memory** row on the Account page linking to it. The shell's no-session exception changes from `path === "/me"` to `path === "/me" || path.startsWith("/me/")` so erasure works when the chat connection is down (device limit, reconnect).

*Alternatives.* A sidebar entry (would change the documented order and the test, and put a rarely used privacy screen among daily work views); a section inside `/me` like Archived chats (the list of up to 200 items plus history makes the account page long, and Erase all needs its own header `…` menu).

### D2. Server: private-only read with a total

- `packages/protocol/memory.ts`: `MemoryReadQuerySchema = WorkspaceTarget.extend({scope: z.literal("private").optional()})` (still strict). `MemoryViewSchema` gains `total: z.number().int().nonnegative().optional()` — always sent by the server, optional so recorded fixtures stay valid.
- `MemoryStore.list(actor, {…, privateOnly})`: `rows()` takes the flag and adds `scope='private' AND user_id=?` without the shared branch; a new `listWithTotal()` (or `list()` returning `{items, total}` for the HTTP caller only) counts readable items before the 200 slice. Capacity is 2,000 private items, already within `rows()`'s `LIMIT 2000`, so the count is exact.
- The route parses GET with `MemoryReadQuerySchema`. The POST response stays the full view (the admin panel depends on it); the page uses it only to learn the outcome and then re-reads with `scope=private` (one extra GET).

*Alternative.* Filtering `scope === "private"` in the client: shared notes (up to 2,000) could push the person's own records out of the 200-item window, and `total` would be wrong.

### D3. `forgetAll` command

`MemoryCommandSchema` gains `command.extend({type: z.literal("forgetAll"), scope: z.literal("private")})`. Route: allowed when the plugin is disabled and when opted out (same as `forget`), dispatched to `MemoryStore.forgetAll(actor, {requestId}, commit)` behind `serialRequest`:

1. `replay(actor, requestId, "forget_all", fingerprint({scope}))` → if found, run `cleanup()` and return (no erasure; a different kind under that id is `memory_request_conflict`).
2. In one `gate` + `atomic`: `commit.check()`; select distinct `lineage_id` of the actor's private rows with `status<>'deleted'` (any publication, expired included); `erase()` each lineage with a new `bump = false` parameter; one `bump(actor)` if anything was erased; record the request row (kind `forget_all`, `memory_id` NULL, state `committed`); `onMutation(actor, "forget", "console")` once → one `memory.changed` audit entry.
3. `cleanup()` removes the native payloads of the `erase_pending` rows (existing mechanism; it is idempotent and also runs at startup).

Staged `remember` requests of the person become `erasing` through `erase()` exactly as with `forget`, so a remember that finishes after the erase cannot publish content. Shared rows are never selected. The memory version advances once, so pending approvals that used memory are re-planned (existing `Memory change invalidates pending work`).

*Alternatives.* Client loops over `forget` for each item: at most 200 visible, so it cannot erase everything; N round trips, N version bumps, partial erasure on failure. A `forgetAll` that also takes an expected version: the workspace memory version moves with anyone's change, so it would conflict constantly; "erase everything that is mine now" is the intent, and replay is protected by the request id instead.

### D4. Page model and command recovery

New `apps/server-admin/web/app/memory-page.tsx` + `memory-copy.ts` (EN/CS):

- Query key `["app", "memory", userId, organizationId, workspaceId]`, `GET identity/memory?…&scope=private`, parsed with `MemoryViewSchema` and checked against the target (as `MemoryRecords` does); refetch on window focus, no polling.
- Grouping: items with status `active`/`candidate` are rows; `superseded` items are attached to the row whose `supersedesId` chain reaches them and shown in a closed `Disclosure` **Earlier versions** (n). A superseded item whose head is not in the window (expired head) is shown as its own row with an "Earlier version" badge so nothing stored is hidden.
- Row: content (`whitespace-pre-wrap break-words`), meta line: kind (`Badge variant="outline"`: Preference/Fact/Note), origin (`user_message` "From chat", `user_note` "Added manually", `verified_operation` "From a service"), `RelativeTime` saved, expiry date; candidate rows get `StatusBadge tone="neutral"` "Not used". Trailing `MoreActions` with **Delete** (`variant="destructive"`).
- Header: `PageHeader` title **Memory** / **Paměť**, muted count (`plural()`), `MoreActions` with **Erase all** / **Smazat vše** (hidden when total is 0). `SettingRows` with **Use memory** / **Používat paměť** switch (`preference` command), meta "Memory is off in this workspace" when `enabled` is false.
- Confirmations: `ConfirmAction` "Delete this memory?" + "It is erased with its earlier versions." / "Smazat vzpomínku?" + "Smaže se i s dřívějšími verzemi."; "Erase all memories?" + "{n} memories are erased for good." with Czech plural forms.
- Commands reuse the `MemoryRecords.mutate` pattern: a `retry` ref keyed by the command's signature keeps the `requestId` until a known outcome; a network error or 5xx shows an `Alert` with **Try again** that resends the same command; a 4xx clears it. `memory_conflict` → refetch and "This memory changed. Check it and try again."; `memory_context_changed` → **Try again** (nothing was committed). After success: refetch the private view, `role="status"` notice "Deleted" / "Smazáno" or "All memories erased".
- States: `Skeleton` while loading; `Empty` (one sentence + hint "Start a message with “Remember” to save something." / "Začni zprávu slovem „Zapamatuj si“.") when enabled and empty; `Empty` "Memory is off in this workspace." when disabled and empty; error `Alert` with Retry and no stale list; "Showing 200 of {total}" line when `total > items`.

### D5. Mobile app

Not now. The mobile app has no settings screen for memory, chat commands ("Remember…", "Forget…", `Revise memory: …`) keep working there, and the web page is checked at 390 px for phone browsers. No protocol change affects mobile (new fields are optional, the new command is web-only).

### Invariants

- The page never shows or erases another person's or a shared memory; `forgetAll` selects only `scope='private' AND user_id=<actor>` in the actor's workspace.
- No erased content is ever returned, including on replay.
- One request id = at most one erasure; resending is only an explicit human action.
- The sidebar order and its test stay unchanged.

## Risks / Trade-offs

- [Large erase in one transaction] → ≤ 2,000 private rows plus their lineages; `erase()` is per-row UPDATEs inside one savepoint, well within SQLite limits; native payload removal runs after commit in `cleanup()`.
- [Extra GET after each command] → one small request; keeps the admin POST response unchanged.
- [Memory link visible where the plugin was never allowed] → the page says memory is off; see open questions.
- [Erase during a waiting approval forces a re-plan] → intended privacy behavior, existing spec.

## Migration Plan

No storage change (a new request `kind` value in an untyped TEXT column). Additive protocol fields. Rollback of the server build leaves erased memories erased.

## Verification

- `tests/memory.node.ts`: `forgetAll` erases all private lineages (including superseded and expired-unscrubbed), leaves shared and other people's rows, bumps the version once, writes one audit, replays without erasing a newer memory, conflicts on kind mismatch, turns a staged remember into erasing; `list` with `privateOnly` and the total.
- `tests/memory-http.node.ts`: `scope=private` for a member with shared notes present, `total`, unknown query key 400, member `forgetAll` with plugin disabled and opted out, `scope: "workspace"` refused, operator session refused, replay response contains no erased content.
- `tests/web-memory-page.test.tsx` (new, react-test-renderer with a mocked `api` like `tests/web-processes-account.test.tsx`): private list and grouping, Delete sends `forget` with the shown revision only after confirming, Erase all only from `…` and after confirming, conflict reload, same `requestId` on Try again after a network error, plugin-off note, empty and error states, CS strings.
- `tests/web-app-routes.test.tsx`: mock the page, assert `/me/memory` opens it and the first eight sidebar links are unchanged.
- Commands: `npm run test:identity`, `npx jest tests/web-memory-page.test.tsx tests/web-app-routes.test.tsx`, `npm run typecheck`, `npm run lint`, `npm run admin:build`, `npm run check`, `spec openspec --project . -- validate niar-243-member-memory-page --strict`.
- Browser preview (web has no Storybook; CONTRIBUTING asks for screenshots): on the dev server (`https://aa.f-tuma.dev`), `/me/memory` as a member with memories, empty, plugin off and after an error, at 1440 px and 390 px, EN and CS, light and dark; confirm the account menu item and that the sidebar is unchanged.

## Open questions for the owner

1. **Menu item when memory was never allowed.** Decision taken: always show **Memory** in the account menu; the page explains memory is off. Alternative: hide it unless the plugin is enabled or the person has memories (costs one read when the menu opens).
2. **Shared notes.** Decision taken: not shown to members on this page. If people should see what the workspace shares with the assistant, a read-only section could follow.
3. **Native mobile screen.** Decision taken: not now (D5).
