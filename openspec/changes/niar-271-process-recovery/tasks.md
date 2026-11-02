# Tasks

Requirement references are to this change's `process-execution` and `process-qualification` deltas.

## 1. Failure table

- [x] 1.1 `packages/protocol/process-failure.ts` with EN/CS sentences and actions; `tests/process-failure.test.ts`; verify with `npx jest tests/process-failure.test.ts`. (Failure sentences and next steps)
- [x] 1.2 `ProcessWork.failureCode`; the projection writes the table's sentence; update `tests/process-work-items.node.ts`; verify with `node --import tsx --test tests/process-work-items.node.ts`. (Failure sentences and next steps)
- [x] 1.3 Web blocked rows, run rows and run sheet use the table; phone launcher blocked rows use it; remove `process_source_changed_own` and `processBlockedKey`; verify with `npx jest tests/web-processes-account.test.tsx`. (Failure sentences and next steps)

## 2. Run again

- [x] 2.1 `ClientSession.loadProcessRunInput` and `parseProcessRunInput`; `processEarlierInputDraft` and its copy; verify with `npx jest tests/process-run-again.test.ts`. (Run again)
- [x] 2.2 Web `ProcessLauncher.runAgain`, `ProcessInputForm` `earlierInput`, run sheet Run again; verify with `npx jest tests/web-menu-pages.test.ts`. (Run again)
- [x] 2.3 Phone `ProcessLaunch` `rerun`, `ProcessInputCardView`/`ProcessLaunchView` `earlierInput`, `MobileWorkItemCard` Run again and Sign in; verify with `npx jest tests/process-run-again-mobile.test.tsx`. (Run again, Failure sentences and next steps)

## 3. Generate test

- [x] 3.1 `NativeTestGenerateQuerySchema`, `NativeTestGeneratedSchema`, controller `generate`, `GET …/tests/native/generate`; `tests/process-generate-test.node.ts`. (Generate test in the console)
- [x] 3.2 Console client `generateTest`, Tests tab button and outcome line, EN/CS copy; `tests/admin-process-console-client.node.ts`. (Generate test in the console)

## 4. Integration

- [x] 4.1 `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`, `npm run test:processes`, `npm run test:process-console`, `openspec validate niar-271-process-recovery --strict`.
- [ ] 4.2 Browser pass on the dev server: a failed run's sheet with Sign in and Run again, a changed form showing errors, Generate test on a canvas-built process; desktop and 390 px, EN and CS, light and dark.
- [ ] 4.3 Phone build: Run again from a run's card; Sign in once the screen passes `onSignIn`.

## Workflow follow-up

- Phone: pass `onSignIn` to `MobileWorkItemCard` (open the screen where services are signed in) together with the proposal card's Save and turn on.
- Archive the change after review; archive is not proof of deployment.
