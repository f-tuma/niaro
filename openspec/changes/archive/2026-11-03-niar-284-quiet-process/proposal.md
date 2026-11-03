# Proposal

Tracker: **NIAR-284** (no "Not confirmed" for processes either)

## Why

NIAR-280 stopped showing "Result not confirmed" for chat messages: a lost chat answer is checked by the client in the background and simply appears. The owner wants the same for processes ("the user doesn't care"). Process commands still kept their own recovery cards:

- a start whose response was lost: "Result unconfirmed" / "Not confirmed — it may have started. Retry to check." on the phone's Processes panel and in a meeting, "Start not confirmed" on the web's Processes page, with **Retry**;
- a process answer: the "Saved answer" card with "Not confirmed. Retry sends the same answer." and **Retry same command**, on the phone and the web, shown even while a normal answer was on its way;
- a process approval decision on the phone: "Not confirmed. Retry sends this same decision." with **Retry**;
- after an exact replay the server could not verify (409 `process_start_conflict`): "The server could not verify the saved execution details. The result remains unconfirmed.";
- and the composer's "Delivery unclear. Retry to check." / the web's "Connection lost" for all of them.

Every one of these Retry buttons only posted the identical command, which the server answers from its receipt (one scoped namespace for start, answer and approval ids), joins while it still runs, or takes if it never recorded it. The client can do that alone.

## What Changes

- `ClientSession` checks a lost `process.start`, `process.answer` and process `service.resolve` by itself with the NIAR-280 mechanism: the identical saved bytes (same `commandId`, `idempotencyKey` and body), one POST per check, at once when online, again on reconnecting and on returning to the foreground, 2, 4, 8, 16 s apart while the server answers reads but not the command, never offline or in the background. A restored outbox start or decision, and a restored unknown answer, are checked the same way after a restart.
- While it checks, the kept command has no error (`error: null`, `deliveryCheck: "checking"`) and offers no Retry. Unlike a chat message, five failed checks do not make a process command fail: it stays quietly working and is checked again on the next reconnect or foreground, because a failed state would invite the person to act on a command that may already have started a run.
- The apps show the checked command as working: the launcher says "Starting…" with no button; the answer shows in the chat as the person's message on its way (no card); the decision's approval card shows it as being sent (no card). When the check settles it, the started run, the accepted answer or the decision simply shows.
- Only a failure the client knows of shows an ordinary failed state with **Try again** (which posts the identical command again): an error the server returned for it (a `process_`/`model_` code that does not settle it), a Stop that was not confirmed, or a local save that failed. A refused start or answer keeps its existing refused display.
- Copy removed (EN and CS): `processesUnknown`, `savedProcessAnswerUnknown`, `savedProcessApprovalUnknown`, the web's "Start not confirmed". Failed copy: "Couldn't finish. Try again." with **Try again** / "Zkusit znovu".

## Non-goals

- Server changes. Exact replay, in-flight joining and receipts stay as they are; admin Runs and server logs keep every technical state.
- A run's own state: a run whose write ended `unknown` keeps "Result unconfirmed" on its work card and the "check the service" sentence, because that is the server's statement about an external effect, not a delivery state.
- Human task decisions (`tasks` "Decision delivery in the apps"), directory commands, `work.cancel` and other commands keep their explicit Retry.
- The "Saved answer" card for an answer the server accepted but the run has not used yet, and for a refused answer, stays as it is.

## Risk

- A start the server never recorded is taken when a check reaches it, possibly much later (after an outage or on the next app start). Admission revalidates the intent then; a stale one is refused and shows as refused. This is what pressing Retry did before.
- A command whose exact replay the server keeps refusing without a receipt (for example 409 `process_start_conflict` after lost journal state) stays "Starting…"/sending and keeps the person's one request slot, as it did before behind a Retry that could not settle it either. It is checked again on every reconnect and foreground; admin Runs shows the detail.
