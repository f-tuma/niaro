# Design

## Context

See proposal.md for the motivation. Today:

- A run's failure is a journal `failure.code` (`apps/server-identity/service-process-runtime.ts`, `process-coordinator.ts`). The projection (`process-work-items.ts`) appends " Failure code: <code>" (or a step-limit sentence) to the run's explanation, which becomes the WorkItem's `context`, `result` and card notice. Clients only see that text.
- Blocked inventory reasons are mapped to copy twice: `apps/server-admin/web/app/process-problems.ts` and `blockedReasons` in `packages/ui-catalog/ProcessLaunchView.tsx`.
- `GET /v1/{workspace}/processes/runs?parentRunId=` already returns the person's own run with its admission, including the admitted `input` (`process-execution` "Run reads"); no client reads it.
- The start form is built from a server-prepared card for a selected ready inventory entry; prefilled values come from an offer or a meeting (`processOfferInitialInput`, `meetingProcessInitialInput`) and silently drop what does not fit.
- `defaultProcessSuite` (`apps/server-identity/process-proposal-suite.ts`) builds a qualifying suite from a frozen version and its pinned catalog, or a gap; only the chat pipeline (`process-proposal.ts`) calls it.

## Goals / Non-Goals

**Goals:** one shared, model-free table for failure sentences and next steps; Run again as an explicit new start on the current version; Generate test as a read in the console.

**Non-Goals:** phone Save and turn on, service names in sentences, step-level gap reasons, chat-card Run again on the web.

## Decisions

### D1. The table lives in the protocol package

`PROCESS_FAILURES` maps a code to `{action, en, cs}`; `processFailure(code, language)` returns `{code, known, sentence, action}`. Actions are `sign_in`, `run_again`, `retest`, `edit` or none. Unknown codes return a generic sentence with the code and no action; anything that is not `^[A-Za-z0-9_.:-]{1,80}$` is shown as `unknown`. Copy sits in the table, not in `packages/i18n`, because `packages/i18n` imports the protocol and the table must be complete on its own (the unit test checks every entry has EN and CS).

Choices that matter for safety: `process_action_unknown` (an unconfirmed write) has no action; Run again appears only where repeating is a fresh, reviewed start (stopped, interrupted, failed action, declined action, changed version).

_Alternative._ Server-rendered sentences only: clients could not attach an action without parsing text.

### D2. The server uses the same sentence and exposes the code

`process-work-items.ts` replaces the " Failure code: …" suffix with the table's sentence followed by "Code: <code>." (the code stays visible for support, as the restore tests require; an unknown code is already in its sentence) and, with detail access, sets `ProcessWork.failureCode`. Without detail access neither the code nor the sentence is added (as before). `failureCode` is added to every process-work profile; the pilot allows the strict-parse break for old phone builds.

### D3. Run again is a read, then the ordinary launch

Web `ProcessLauncher.runAgain(run)` and phone `ProcessLaunch` with `rerun={parentRunId, processId}`:

1. read the earlier admission with `ClientSession.loadProcessRunInput(parentRunId)` (`GET processes/runs`, scope and parent run checked by `parseProcessRunInput`) and a fresh inventory in parallel;
2. take the inventory entry for the run's process: a blocked entry yields its reason (web: a sentence from the table in the run sheet; phone: "It can't start now"), a missing one `process_not_active`;
3. open the ready entry exactly like a chosen process (`prepareProcessInput` for the **current** version) with `earlierInput` set.

The form (web `ProcessInputForm`, phone `ProcessInputCardView`) uses `processEarlierInputDraft(schema, earlier)` when it mounts: fitting top-level values fill their fields; a value that no longer fits gets `errorChanged`, earlier fields the form lacks one root `errorDropped`, and the shared validator's issues (new required fields) are shown at once. Review still validates; Start still sends the ordinary idempotent `process.start` with a new command id. Nothing is sent by Run again itself.

_Alternative._ Copying the input into the WorkItem: up to 50 runs × 64 KiB in every snapshot, and a second copy of private input to keep in sync.

### D4. Where the actions go

- Web run sheet: an `Alert` with the sentence and, as `AlertAction`, Sign in (`/connections`), or Retest/Edit to the person's own process page (Retest opens its Tests tab) or `/admin/processes/<id>` for an admin. Run again (outline) sits before Open chat (primary) in the footer. The result paragraph is hidden when the alert already carries its sentence.
- Blocked rows (web and phone) show the table's sentence; their existing row links stay.
- Phone run card: Run again in the card footer for terminal process runs, opening an inline launcher; Sign in only when the parent passes `onSignIn` (`App.tsx` belongs to the phone Save-and-turn-on change). Retest and Edit have no phone surface.

### D5. Generate test is a read endpoint

`GET /admin/api/identity/catalog/processes/tests/native/generate?organizationId&workspaceId&profile&processId&version` authorizes like `/tools` (`registry.testArtifact` decides access), resolves the model from the definition as the chat pipeline does, builds the pinned test catalog and returns `{processId, version, artifactDigest, generated: {suite} | {gap}}`. The console client checks the binding to the selected artifact, puts a suite into the editor with `setSuite(suiteToDraft(suite))`, and the page shows "Test generated from this version. Check it, then run it." or one sentence per gap. Running stays the existing explicit, recoverable Run test command.

### Invariants

- No sentence or action comes from a model or a provider message.
- Run again, Generate test and every action only read or navigate; starts and tests remain explicit commands.
- The current active version decides the form, never the earlier run's version.

## Risks / Trade-offs

- [Generic "Sign in" without a service name] → the Connections page shows which service is not signed in.
- [Gaps without a step] → the sentence says what kind of problem it is and that a hand-written test is needed.
- [A member's company-process failure with Retest/Edit] → no action is shown; the sentence still explains.

## Migration Plan

No stored data changes. Old runs keep their stored journals; their projection gains the code and the new sentence on the next read. Rollback removes the field and the endpoint.

## Verification

- `tests/process-failure.test.ts`: every code has EN and CS copy and a known action; every blocked reason and start rejection is covered; unknown and unsafe codes.
- `tests/process-run-again.test.ts`: earlier input that fits, changed and dropped fields, a new required field.
- `tests/web-menu-pages.test.ts`: Run again opens the current version's form with the earlier input and starts only after review; blocked, retired and unreadable runs open nothing.
- `tests/process-run-again-mobile.test.tsx`: phone Run again, field errors on a changed schema, blocked process; card Sign in only with a handler and a sign-in failure.
- `tests/web-processes-account.test.tsx`: blocked rows and run rows read the table.
- `tests/process-work-items.node.ts`: `failureCode` and the sentence in a failed run's projection.
- `tests/process-generate-test.node.ts`, `tests/admin-process-console-client.node.ts`: a suite for a read workflow, a gap for an agent that writes through its own tool, nothing run or posted, another workspace refused.
- Not verified here: a browser pass of the run sheet and the console, and a phone build.
