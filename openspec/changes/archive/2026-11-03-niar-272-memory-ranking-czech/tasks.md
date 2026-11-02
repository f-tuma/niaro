# Tasks

Requirement references are to this change's `memory` delta.

## 1. Ranking

- [x] 1.1 Add `apps/server-identity/memory-ranking.ts` (folding, stop list, prefix rule, BM25) and use it in `MemoryStore.search()`; keep preferences first and the recency/id tie-break. (Lexical memory ranking)
- [x] 1.2 Fixed synthetic CS/EN set with expected leading results, deterministic ordering and no-plaintext-on-disk tests in `tests/memory-ranking.node.ts`; verify with `node --import tsx --test tests/memory-ranking.node.ts tests/memory.node.ts`. (Lexical memory ranking)

## 2. Never-kept categories

- [x] 2.1 Document the list in `docs/guides/memory.md` and test that the filter refuses each category. (Never-kept categories are shown)
- [x] 2.2 Show the list in About you on web (`pet-page.tsx`, `pet-copy.ts`) and phone (`PetProfile.tsx`, `pet-profile-copy.ts`), EN and CS; verify with `npm test`. (Never-kept categories are shown)

## 3. Integration

- [x] 3.1 `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`, the memory and profile node tests.
- [ ] 3.3 `spec openspec --project . -- validate --specs --strict` (not run: SPEC reports OpenSpec not initialized in this repository).
- [ ] 3.2 Browser and phone check of the About you disclosure, EN and CS, light and dark.

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
