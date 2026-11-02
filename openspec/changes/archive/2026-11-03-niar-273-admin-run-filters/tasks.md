# Tasks

Requirement references are to this change's `administration` delta.

## 1. Protocol and server

- [x] 1.1 `LoopOrigin`, the new `LoopQuery` filters, `origin` in `LoopSummarySchema`, `LoopFiltersQuery` and `LoopFiltersSchema` in `packages/protocol/loops.ts`. (Run list)
- [x] 1.2 `LoopsStore.page()` SQL pre-filters plus `matches()` on the summary, batched scan with `nextBefore`; `origin` in `summary()`; `LoopsStore.filters()`; route `GET /admin/api/identity/loops/filters`; verify with `node --import tsx --test tests/loop-filters.node.ts tests/loops.node.ts`. (Run list, Run filter choices)

## 2. Admin web

- [x] 2.1 Process, Version, Person, Started from and Date filters in the Runs `toolbar`, Started from in run details, empty page with Older, EN and CS copy in one NIAR-273 block; verify with `npm run lint`, `npm run typecheck`, `npm run admin:build`. (Run list)
- [ ] 2.2 Browser check of `/admin/loops` at 1440 px and 390 px, EN and CS, light and dark.

## 3. Integration

- [x] 3.1 `npm test` and the loop node tests.
- [ ] 3.2 `spec openspec --project . -- validate --specs --strict` (not run: SPEC reports OpenSpec not initialized in this repository).

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
