# Proposal

Tracker: **NIAR-271** (research NIAR-265, ideas PROC-07, PROC-08, PROC-09, PROC-10)

## Why

- Most dead ends members hit need no model: a sign-in, a new run, a new test. Today a failed run reads "The process failed. Failure code: process_step_limit", a blocked process has its own copy on each client (`process-problems.ts` on the web, `blockedReasons` in `ProcessLaunchView.tsx` on the phone), and nothing tells the person what to press next.
- After a fix or a sign-in, starting the same work again means filling the form again from memory.
- Members who build a process on the canvas must write fixtures and scripted replies by hand before it can be tested. The generated suite exists only on the chat path (`process-proposal-suite.ts`).

## What Changes

- **One table of failure codes.** `packages/protocol/process-failure.ts` maps each safe code (start inventory reasons, start rejections, run failures, the service failures that end a run) to a fixed English and Czech sentence and at most one action: `sign_in`, `run_again`, `retest` or `edit`. An unknown code reads "It stopped with code `<code>`." with no action; a value that is not a short code is never echoed. The server writes the same sentence (and the code) into a run's result, and the run projection carries the code as `failureCode` when the person may see details.
- **Web.** Blocked rows, a run's row and its sheet on `/processes` read the table. The run sheet shows the sentence with its action where this person can take it (Sign in opens Connections; Retest and Edit open the person's own process, or the administration page for an admin; members get no action for company processes).
- **Run again** (web run sheet, phone run card) reads the earlier run's admitted input with the existing `GET …/processes/runs`, takes a fresh start inventory and opens the ordinary form of the **current active version**, filled with that input. Values that no longer fit, fields that are gone and required fields without a value show as errors at once. Nothing is sent until the person reviews and presses Start; a process that can't start now says why and opens no form.
- **Phone.** `MobileWorkItemCard` offers Run again on finished, failed and stopped process runs (an inline launcher) and Sign in when the run stopped for a sign-in and the screen passes `onSignIn`. Blocked processes in the launcher read the table.
- **Generate test.** The console's Tests tab gets **Generate test**: `GET …/processes/tests/native/generate` returns the suite the chat path would generate for the selected frozen version, or the reason none can be made (`input_unsupported`, `scenario_unsupported`, …). The suite goes into the editor; the person reviews it and presses Run test. Generating runs nothing.
- Protocol: new `process-failure.ts`; optional `failureCode` on `ProcessWork`; `NativeTestGenerateQuerySchema`, `NativeTestGeneratedSchema`; client-core `ClientSession.loadProcessRunInput` and `parseProcessRunInput`.

## Non-goals

- The phone proposal card's **Save and turn on** (PROC-09), which another change delivers (it needs `apps/mobile/App.tsx`). The phone screen wiring `onSignIn` for the run card is part of that work.
- Naming the service in "Sign in" ("Sign in to Outlook"): the code does not carry the service, and the sentence stays fixed.
- Run again from a run's chat card on the web (`chat-work.tsx`), bulk replay or "continue from the failed step" (PROC-40).
- Saying which step a generated-test gap concerns: the generator reports only the gap code.

## Risks

- A sentence that suggests running again after an unconfirmed write would invite a duplicate effect. Mitigation: `process_action_unknown` has no action and says to check the service first; Run again is always a new admission the person starts.
- Old phone builds parse `ProcessWork` strictly and refuse the new `failureCode`. Breaking changes are allowed in the pilot; new builds ship with it.
- Earlier input from a meeting is copied as values; the new run's origin is an ordinary command start, so the meeting record is not re-read.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `process-execution`: failure sentences and next steps, `failureCode` in the run projection, Run again.
- `process-qualification`: Generate test in the console.

## Impact

- Protocol: `packages/protocol/process-failure.ts` (new), `process-work.ts`, `process-native-testing.ts`.
- Server: `apps/server-identity/process-work-items.ts`, `process-native-testing-controller.ts`, `process-native-test-http.ts`.
- Clients: `packages/client-core/session.ts`, `process-execution-reader.ts`; `packages/ui-catalog/process-input-form.ts`, `process-input-copy.ts`, `ProcessInputCardView.tsx`, `ProcessLaunchView.tsx`; web `app/processes-page.tsx`, `process-launch.ts`, `process-form.tsx`, `menu-copy.ts`, `process-problems.ts`, `process-console-page.tsx`, `process-console-copy.ts`, `lib/process-console-client.ts`; phone `MobileWorkItemCard.tsx`, `ProcessLaunch.tsx`; `packages/i18n/index.ts`.
- Tests: new `tests/process-failure.test.ts`, `tests/process-run-again.test.ts`, `tests/process-run-again-mobile.test.tsx`, `tests/process-generate-test.node.ts`; `tests/web-menu-pages.test.ts`, `tests/web-processes-account.test.tsx`, `tests/process-work-items.node.ts`, `tests/admin-process-console-client.node.ts`, `tests/helpers/process-launch-client.ts`.
