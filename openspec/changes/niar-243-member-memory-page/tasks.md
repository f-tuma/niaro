# Tasks

Requirement references are to this change's `memory` delta.

## 1. Protocol

- [ ] 1.1 Add `MemoryReadQuerySchema` (`scope: "private"` optional, strict), optional `total` in `MemoryViewSchema` and the `forgetAll` command (`scope: z.literal("private")`) to `packages/protocol/memory.ts`; extend the strict-command test in `tests/memory.node.ts` ("memory protocol: …") for `forgetAll` with `scope: "workspace"` refused; verify with `node --import tsx --test tests/memory.node.ts`. (Memory commands, Memory management API)

## 2. Store

- [ ] 2.1 Add the `privateOnly` listing and the readable total to `MemoryStore` (`rows()`, `list()`/`listWithTotal()`); tests for a person with shared notes present and for more than 200 records; verify with `node --import tsx --test tests/memory.node.ts`. (Memory management API)
- [ ] 2.2 Implement `MemoryStore.forgetAll()` (replay kind `forget_all`, lineage erasure via `erase(…, bump = false)`, one version bump, one `onMutation`, request row, `cleanup()`); tests: superseded and expired-unscrubbed rows erased, shared and other users' rows kept, version advanced once, staged remember becomes erasing, replay erases nothing newer and returns no content, kind mismatch `memory_request_conflict`; verify with `node --import tsx --test tests/memory.node.ts tests/saved-memory-native.node.ts`. (Erasing all of a person's memories, Erase-all replay)

## 3. HTTP route

- [ ] 3.1 Parse GET with `MemoryReadQuerySchema`, pass `privateOnly`, return `total`; dispatch `forgetAll` (allowed with the plugin disabled and when opted out); tests for member `scope=private`, unknown query key 400, member erase-all with plugin off, operator refused, replay response; verify with `node --import tsx --test tests/memory-http.node.ts` and `npm run test:identity`. (Memory management API, Memory commands, Erasing all of a person's memories)

## 4. Web app page

- [ ] 4.1 Add `/me/memory` to `app/router.tsx`, the **Memory** item to `UserMenu` and a link row on `AccountPage`, and let `/me/*` render without a chat session in `app/shell.tsx`; extend `tests/web-app-routes.test.tsx` (mock the page, assert `/me/memory` opens it and the first eight sidebar links stay as they are); verify with `npx jest tests/web-app-routes.test.tsx`. (Memory page in the web app)
- [ ] 4.2 Build `app/memory-page.tsx` and `app/memory-copy.ts` (EN/CS): private list with earlier versions, kind/origin/saved/expiry, Use memory switch, total line, loading/empty/plugin-off/error states; verify with `npx jest tests/web-memory-page.test.tsx` (new) and `npm run lint`. (Memory page in the web app, Memory page states)
- [ ] 4.3 Add Delete (row `…` + confirmation, `forget` at the shown revision) and Erase all (header `…` + confirmation with the count, `forgetAll`), with request-id reuse on Try again, conflict reload and success notices; verify with `npx jest tests/web-memory-page.test.tsx`. (Deleting on the memory page, Erase-all replay)
- [ ] 4.4 Browser preview on the dev server after `npm run admin:build`: `/me/memory` as a member with memories, empty, plugin off and a load error, at 1440 px and 390 px, EN and CS, light and dark; attach screenshots to the PR. (Memory page in the web app, Memory page states)

## 5. Integration

- [ ] 5.1 Run `npm run check`, `npm run admin:build` and `spec openspec --project . -- validate niar-243-member-memory-page --strict`; all pass.

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
- Revisit a native mobile Memory screen if pilot users ask for it.
