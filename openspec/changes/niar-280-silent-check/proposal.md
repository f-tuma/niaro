# Proposal

Tracker: **NIAR-280** (stop throwing "Result not confirmed" at the person)

## Why

The owner: "That it keeps throwing 'Result not confirmed' at me really annoys me. The user doesn't care. Why do we put it in his face? Just keep it out of the user's UI."

When a chat message's send ended without a confirmed outcome (a dropped connection, a 5xx without a receipt, a server restart mid-answer, a message found in the outbox after a restart), the phone and the web showed a card "Result not confirmed — Status unavailable. It won't be resent." with **Check result** and **Dismiss**, and the phone's composer also said "Delivery unclear. Retry to check." The same card showed for a request still on its way while the client was offline. Check result only re-posted the identical command, which the server answers from its receipt, joins while it still runs, or takes if it never recorded it. The person had to do a check the client can do alone.

## What Changes

- The client checks a lost outcome by itself (`ClientSession`, `packages/client-core/session.ts`): it posts the identical command again (same `commandId`, same body, one POST per check) right away when online, again on reconnecting and on returning to the foreground, spaced out (2, 4, 8, 16 s) while the server answers reads but not the command, and never while offline or in the background. A recorded command is answered from its receipt, a running one is joined, and nothing runs twice.
- While it checks, the chat shows the ordinary "Thinking" line (the answer's draft, if any) with no error, no Retry and no Dismiss. The composer stays empty (NIAR-279). Offline, the header's Offline line is the only sign.
- The request shows as an ordinary failed message ("Request interrupted · Couldn't finish. Try again." with **Try again** and **Dismiss**) only when the server says it did not finish (a `model_*` failure), when a Stop or Dismiss was not confirmed, or when five checks in a row failed while the server answered reads. Dismiss keeps the NIAR-279 rules (`commands/interrupt`, only `not_running` returns the text). A failed request is not posted again by itself.
- The "Result not confirmed", "Status unavailable. It won't be resent." and "Unconfirmed" copy is removed (EN and CS), and the progress card's Retry reads "Try again" / "Zkusit znovu" instead of "Check result" / "Ověřit výsledek".
- `SessionState.deliveryCheck` (`"checking" | "failed" | null`) tells clients which of the two the kept chat request is; `canRetryPending` offers no Retry while checking; `chatRequestFailed` names the failed case for both clients.

## Non-goals

- Server changes. Admin diagnostics (Runs) and server logs keep every technical state.
- Process commands (`process.start`, `process.answer`, process `service.resolve`) keep their own recovery cards and ledgers; their "Not confirmed" copy is unchanged (reported, not changed).
- Other commands (directory commands, approvals, `work.cancel`) keep their explicit Retry.

## Risk

- A message the server never recorded (it was lost before the server stored it, or the server died before recording it) is taken when the check reaches the server, possibly much later than it was sent, e.g. after the server was down for an hour or on the next app start. That is the same as pressing Check result before; the person still sees the message as sent and working.
- Five failed checks while the server answers reads end in the failed message; a server that keeps flapping offline and online keeps checking quietly.
