# Tasks

Requirement references: PD = `process-definitions`, PE = `process-execution`, PQ = `process-qualification`, HUB = `hub` (this change's deltas).

## 1. Protocol and storage

- [ ] 1.1 Add `retiredAt` (optional ISO) to `ProcessSummarySchema`, `WorkspaceProcessRetirementSchema` / `WorkspaceProcessRetirementResultSchema` to `packages/protocol/service-processes.ts`, `process_retired` to `PROCESS_START_REJECTIONS`, `retired`/`restored` to the audit `processEvent` enum and `retired` (optional `true`) to `ProcessActivationReviewSchema`; verify with `npm run typecheck`. (PD Retiring a company process, PD Registry audit, PE Rejected starts, PQ Decisions on a retired process)
- [ ] 1.2 Add the `retired_at` column to `agent_service_process` in `ServiceProcessStore` (same `PRAGMA table_info` guard as `archived_at`) and fill `retiredAt` in `summary()`; verify a pre-owner and an October-7 database both open and list unchanged in `node --import tsx --test tests/process-owner-crash.node.ts tests/personal-processes.node.ts`. (PD Retired process management)

## 2. Retire and restore command

- [ ] 2.1 Implement `ServiceProcessStore.setRetired()` (authority via `row(…, "manage")`, `process_retire_forbidden` for personal owners, state replay no-op, revision check, audit in the same savepoint) with tests for owner/admin success, member 403, personal refusal, archived 404, stale `process_conflict`, replay without a second audit, audit failure rollback; verify with `node --import tsx --test tests/process-retirement.node.ts` (new, added to `test:processes` and `test:identity`). (PD Retiring a company process, PD Restoring a retired process, PD Retirement command replay, PD Registry audit)
- [ ] 2.2 Route `POST /admin/api/identity/catalog/processes/retirement` in `process-controller.ts` with `authorized()` and `context.transaction`; HTTP tests for origin/CSRF refusal and the result shape; verify with the same test file. (PD Registry API)
- [ ] 2.3 Assert `catalog_service_in_use` still refuses removing a service used only by a retired workspace process; verify in `tests/process-retirement.node.ts`. (PD Service removal and personal processes)

## 3. Start paths

- [ ] 3.1 Filter `retired_at IS NULL` in `executionInventory()`; split `activeRunVersion()` into private readiness (used by `executionEntry()`) and the public admission gate that throws `409 process_retired` after the authority checks; route `executionArtifact()` and the new-pin branch of `pinRun()` through it, leaving `resolveRun()` untouched. Tests: inventory omission and fingerprint change, form `process_retired`, start 422 receipt then admission on the same intent after restore, chat `processOffers` empty, `retestNeeded` still reported; verify with `npm run test:process-execution` and `npm run test:process-start`. (PE Retired processes cannot be started, PE Rejected starts)
- [ ] 3.2 Prove a run waiting for approval at retirement continues once on its pin after the person approves and a never-decided one ends at its deadline; verify with a case in `tests/process-retirement.node.ts` using the coordinator harness of `tests/process-coordinator.node.ts`, plus `npm run test:process-coordinator`. (PE Runs admitted before retirement, PE Version pins)
- [ ] 3.3 Add `process_retired` EN/CS to `packages/i18n` and map it in `apps/server-admin/web/app/process-problems.ts`; verify the launcher/offer refusal text in `tests/web-processes-account.test.tsx` with `npx jest tests/web-processes-account.test.tsx`. (PE Retired processes cannot be started)

## 4. Qualification while retired

- [ ] 4.1 Report `retired: true` in the activation review and prove tests, activation and rollback of a retired process work and keep it retired; verify with `npm run test:process-activation`. (PQ Decisions on a retired process, PD Retired process management)

## 5. Overview widgets

- [ ] 5.1 Add `retiredProcessIds()` to the store and the hub dependency Pick; project retired process items in `cards()` (failed `process_retired`, last output kept, not stale, waiting runs untouched) and skip them in `begin()` with a stored `process_retired` result; tests for open, explicit refresh (runner not called), waiting run and restore; verify with `node --import tsx --test tests/hub.node.ts tests/hub-http.node.ts tests/hub-open.node.ts`. (HUB Retired process widgets, HUB Process widget eligibility)
- [ ] 5.2 In the web app card, read `process_retired` through `hubWidgetProblem()` with the admin fix link and hide refresh for it; verify with `npx jest tests/web-hub.test.tsx` and `npm run admin:build`. (HUB Retired process widgets)

## 6. Administration UI

- [ ] 6.1 Add `lib/process-retirement.ts`, the Retire `…` item with `ConfirmAction`, the Retired badge, Restore as primary action, the activation-dialog note and the Retired row badge in `ProcessRows`, with EN/CS copy in `process-console-copy.ts`; verify with `node --import tsx --test tests/process-retirement-client.node.ts tests/admin-service-process-overview.node.ts tests/admin-process-console-client.node.ts` and `npm run lint`. (PD Retiring in administration)
- [ ] 6.2 Map `retired`/`restored` in `audit-page.tsx` with EN/CS labels in `apps/server-admin/web/i18n.ts`; verify with `npm run typecheck` and `npx jest tests/audit.test.ts`. (PD Registry audit)
- [ ] 6.3 Check `/admin/processes`, a process page (retire confirmation, Retired, Restore) and an overview widget of a retired process at 1440 px and 390 px, EN and CS, light and dark, on the dev server; attach screenshots to the PR. (PD Retiring in administration, HUB Retired process widgets)

## 7. Integration

- [ ] 7.1 Run `npm run check`, `npm run test:processes` and `spec openspec --project . -- validate niar-242-retire-company-process --strict`; all pass.

## Workflow follow-up

- Record the "retirement gates admission, not continuation" decision in `docs/architecture.md` when archiving.
- Archive the change after review; archive is not proof of deployment.
