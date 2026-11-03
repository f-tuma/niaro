# Tasks

## 1. Client core

- [x] 1.1 `checkedByItself` covers `process.start`, `process.answer` and process `service.resolve`; a lost process delivery sets `deliveryCheck: "checking"`, a process/model error, an unconfirmed Stop or a failed local save sets `failed`.
- [x] 1.2 `checkDelivery` posts only while the kept outcome is unknown, through `send(pending, true)` with the person's notice owner; errors of a changed command are swallowed.
- [x] 1.3 After five failed checks a process command stays `checking` and waits for a reconnect or the foreground (`dueAt: Infinity`); chat keeps failing after five.
- [x] 1.4 A restored unknown start, decision or answer starts `checking`; a receipt ends the check; a check whose local save fails ends `failed`.
- [x] 1.5 `publish` hides `network_error` while checking; the private rejection stays for the answer bookkeeping.
- [x] 1.6 `chat-view.ts`: `processCommandWorking`, `processAnswerCardShown`, `processDecisionWorking`; `selectPendingChatMessage` returns a working answer.

## 2. Clients

- [x] 2.1 `ProcessLaunchView`: working start shows "Starting…" with no sentence or button; failed shows "Couldn't finish. Try again." with Try again.
- [x] 2.2 Phone `ProcessLaunch` and web `ProcessLauncher` settle a start the session settled in the background, their own or the saved one they showed; their Retry refuses a working start.
- [x] 2.3 Web Processes page: a quiet "Starting… <name>" line while working; the failed and known states keep one action.
- [x] 2.4 Answer: no card while working (phone `App`, web `AnswerRecovery`), the web renders the working answer as the person's message; failed card reads "Couldn't finish. Try again." with Try again.
- [x] 2.5 Decision: phone `ProcessApprovalRecovery` shows nothing while working; the approval reads `sending` on the phone (`MobileWorkItemCard`) and the web (`chat-work`); failed card with Try again.
- [x] 2.6 Copy: remove the "Not confirmed" process strings (EN, CS) and the web's "Start not confirmed"; failed states use the NIAR-280 strings.

## 3. Verification

- [x] 3.1 `tests/process-quiet-check.test.ts`: lost start and answer checked by themselves and shown, one admission and one answer, server down, repeated failures, no parallel check, background, restart, a stated failure with Try again only.
- [x] 3.2 Phone and web tests updated and added: no "not confirmed" wording or Retry while working; failed shows Try again; the launcher shows Started after a background check.
- [x] 3.3 Lint, typecheck, admin build, full Jest, and the node suites `test:process-questions`, `test:process-start`, `test:process-execution`, `request-interruption*`, `work-cancel-process`, plus `process-admitted-journal-loss`, `process-execution-conflict-http`, `process-mobile-integrated-http` and `process-transport-client-http`.
- [ ] 3.4 Emulator and browser check (not done in this change: no emulator or dev server was used).
