# Design

## Before

1. `ClientSession.send` saves a process command before posting it: a start or decision as the `agent-client.process-command/1` outbox (`pendingProcess`, `outcome: "unknown"`), an answer as an `unknown` attempt in the answer ledger (`answerAttempts`, `answerPendingId`). The connection drops, or the server answers without a receipt (any error JSON for a start or decision, see "Uncorrelated error JSON"); the catch keeps the command as `pending`, sets `commandStates[target] = "network_error"`, `error = "network_error"` and the private `commandRejection = "network_error"` (republished as `error` by every snapshot refresh).
2. The phone's `ProcessLaunch` / `ProcessLaunchView` showed the saved start with "Result unconfirmed" and "Not confirmed — it may have started. Retry to check." and **Retry**; the web's Processes page "Start not confirmed: <name>" with the same sentence. `ProcessAnswerRecoveryCard` (phone) and `AnswerRecoveryView` (web) showed every unknown answer, including one still on its way, as "Saved answer … Not confirmed. Retry sends the same answer." with **Retry same command**. `ProcessApprovalRecovery` (phone) showed "Not confirmed. Retry sends this same decision." and, after a 409 `process_start_conflict`, "The server could not verify the saved execution details. The result remains unconfirmed.". The composer showed `network_error` ("Delivery unclear. Retry to check.").
3. Nothing happened until the person pressed Retry, which called `session.retry()` → `send(pending, true)`: one POST of the identical saved bytes (`pendingProcess.serializedCommand`, or the exact attempt command). Reopening the app restored the outbox or the answer ledger and sent nothing.

## Decisions

### D1. Process commands join the NIAR-280 check

`checkedByItself` now covers `process.start`, `process.answer` and process `service.resolve` besides `message.send` and plain `service.resolve`. Everything NIAR-280 built is reused unchanged: `check: {commandId, mode, failures, dueAt}` follows `pending`; `checkDelivery()` runs after each poll tick and after `setActive(true)`; offline→online (`refresh`) and the foreground make it due at once; it never runs offline, in the background, while anything is submitting, while a check is in flight (`checkInFlight`) or while a Stop is in flight.

- A send whose delivery started, whose command was saved, and that ended with `network_error` sets `mode: "checking"`. A process or model error code (`process_*`, `model_*`, `catalog_*`, `inference_*` from an answer that did not settle it), an unconfirmed Stop (`requestInterruptFailed`) or a failed local save (`storage_error`) sets `mode: "failed"`. A check whose own local save fails (the outbox write before the POST) also ends `failed`.
- `checkDelivery` posts only while the kept outcome is still unknown (`outcomeUnknown`): a start or decision whose `pendingProcess.outcome` is `unknown`, an answer whose attempt is `unknown`. A known outcome that waits for local storage is never posted again; an answer the projection already shows consumed (`retireConsumedAnswers` runs in the same tick before the check) is not posted.
- The check posts with `send(pending, true, undefined, owner)`, the same path as Retry, so the bytes are the saved ones (`createFlight` takes `pendingProcess.serializedCommand`; `send` refuses anything that is not `JSON.stringify`-equal to `pending`, and an answer whose attempt differs or is known throws `process_answer_attempt_changed`, caught and ignored by the check). `owner` is the notice owner of the person's own flight, so a refusal or a run that failed at once still shows where they started it.
- A restored outbox start or decision with `outcome: "unknown"`, and a restored answer ledger whose `pendingCommandId` attempt is unknown, start as `checking` after a restart. A restored raw process command without its proof envelope gets `checking` too, but `outcomeUnknown` is false for it (no `pendingProcess`), so it is never posted and simply stays quiet.
- A receipt (`finishProcessExecution`, `finishProcessAnswer`) ends the check.

### D2. A process command never fails because checks gave up

For chat, five failed checks while reads work end `failed`. For a process command `nextCheck` keeps `mode: "checking"` and sets `dueAt: Infinity` after the fifth failure: no timed checks any more, but a reconnect resets the count and a return to the foreground makes it due once again. A start the server cannot verify (409 `process_start_conflict`, `PROCESS_EXECUTION_UNVERIFIED` is still saved as local metadata) therefore stays quiet. Rationale: a failed state invites the person to act, and for a start that may have admitted a run there is nothing safe they can do that the check does not do; the goal says to keep a quiet working state when a check cannot settle it.

### D3. No error while checking

`publish` hides `error: "network_error"` while `deliveryCheck === "checking"`. The private `commandRejection` stays `network_error`, so the consumed-answer bookkeeping (`consumedDeliveryErrorUpdate`, `storageError`'s `??=`) behaves as before; only the person's view loses the error, also after each refresh. Answer attempts are saved with `error: null`. Offline the error is `connection_failed` as for chat (the header says Offline).

### D4. What the apps show

`chat-view.ts` gets three pure rules shared by both clients:

- `processCommandWorking(state, commandId)`: the kept command is sending, or the session is checking it.
- `processAnswerCardShown(state, attempt)`: an answer has a card once the server answered for it (accepted or refused) or when its delivery failed; while working it has none.
- `processDecisionWorking(state, operationId)`: the decision on this approval is working.

Then:

- **Start (phone `ProcessLaunchView` via `ProcessLaunch` and meetings, web Processes page via `pendingStart`)**: working → a running "Starting…" pill with the process name and its details, no sentence, no button; the old error/explanation is not shown. Failed (`recovery.failed`) → "Request interrupted", "Couldn't finish. Try again.", the error if any, and **Try again** (posts the identical start). Known outcomes keep their existing display (Started / Not started, Save again).
- When the session settles a start in the background, the launcher settles too: the phone's `ProcessLaunch` effect and the web `ProcessLauncher.follow()` (subscribed to the session while the page watches the launcher) call `settle` for their own start in phase `sending`, and adopt the saved start they showed as starting while idle (`watchedStart`, e.g. after a restart) with its target and input, as an explicit Retry did. The run then shows as started (or refused, with Edit).
- **Answer (phone `App`, web `chat-next-page`)**: working → no card; `selectPendingChatMessage` returns the answer, so the chat shows it as the person's message on its way (the phone already rendered `kind: "answer"`; the web now renders it like a message). Failed → the saved card with "Couldn't finish. Try again." and **Try again**. Accepted and refused cards are unchanged.
- **Decision (phone `ProcessApprovalRecovery`, `MobileWorkItemCard`; web `chat-work`)**: working → no saved card, and the approval's state is `sending`. Failed → the saved card with "Couldn't finish. Try again." and **Try again**.
- Launcher and card Retry handlers refuse an unknown command that is working, so a retained callback cannot add a POST beside the check.

### D5. Copy

Removed (EN and CS): `processesUnknown`, `processesRetrySame`, `savedProcessAnswerUnknown`, `savedProcessApprovalUnknown`, `savedProcessApprovalRetrySame`, and the web's `processUnconfirmed` / `processRetry`. Failed states use `progressFailed`, `progressFailedHint` and `progressRetry` ("Try again" / "Zkusit znovu") from NIAR-280. `savedProcessExecutionUnverified` stays for the failed state only. A run's own `processUnknown` ("Result unconfirmed") and `processResultUnknown` are about a write the server could not confirm and stay.

## Exactly once

- The client posts only the saved bytes of the kept command, with its original `commandId` and `idempotencyKey`, one POST at a time (`submitting`, `checkInFlight`, `commandStates === "sending"`).
- The server answers an exact replay from its receipt without revalidating or starting anything (`process-execution` "Exact replay and idempotency"), joins an identical command still in flight (`NativeCommandRequests.find` → the running promise), and refuses changed bytes under the same id (409 `idempotency_conflict`). Start, approval and answer share that namespace.
- A known outcome is never posted again; a consumed answer is retired from the projection before the next check.

## Verification

- `tests/process-quiet-check.test.ts` (real `ClientSession`, fake servers that keep one admission or answer per command id and answer replays from it): a start whose ACK was lost is checked on the next poll and appears, one admission, identical bytes, no later POST; a start lost while the server is down for two minutes posts nothing until it returns, then starts once; a start the server keeps failing (500 without receipt) is checked at 1, 2, 4, 8, 16 s, stays working, waits five minutes without a POST, and is checked again on the foreground; no check runs beside a check in flight; nothing is checked in the background; a start kept from before a restart is checked by the reopened app; an answer whose ACK was lost shows as the person's message on its way (no card), is checked and answered once; an answer refused with `503 process_model_unavailable` shows failed with Try again, is not resent by polls, reconnects or foregrounds, and Try again sends it once. The removed copy is gone in EN and CS.
- Phone: `tests/process-launch-mobile.test.tsx`, `tests/process-launch-view.test.tsx`, `tests/process-answer-recovery-mobile.test.tsx`, `tests/process-approval-recovery-mobile.test.tsx`, `tests/process-approval-recovery-card.test.tsx`, `tests/meeting-process-integration.test.tsx` (real server child: a lost ACK shows Starting…, no Retry; the replay reuses the one admitted run). Web: `tests/web-chat-next.test.tsx` (answer working vs failed), `tests/web-menu-pages.test.ts` (launcher: starting, Retry refused, the foreground check settles it and the launcher shows Started).
- Session suites updated where they asserted the old `error: "network_error"`: `tests/process-answer-session.test.ts`, `tests/process-execution-conflict-session.test.ts`, `tests/process-admitted-journal-loss.node.ts`, `tests/process-transport-client-http.node.ts`, `tests/process-mobile-integrated-http.node.ts`.
