# Proposal

Tracker: **NIAR-263**

## Why

Verified on dev: "Vymysli náhodné čtyřmístné číslo" answered "5837", and the next turn "Jaké číslo jsi napsal?" answered "4827". The thread was reused (niar-263-thread-continuity), but the earlier answer reached the model as "[Prior private response withheld]": an answer counted as private whenever the person had any saved item, observation or confirmed position, and with the pet learner that is everyone. A fresh thread got only the person's last eight messages.

## Owner decision (2026-11-05)

Earlier assistant answers in the same chat of the same person stay visible to the model. An earlier answer is withheld only when it drew on (a) a saved item that has since been forgotten, revised, expired or became unreadable, or (b) a service result the person can no longer access (receipt policy revision, grant or sign-in no longer valid). This is checked on every turn, with the continuation machinery. Earlier turns' tool results stay dropped; the model reads fresh data when it needs it. A fresh thread's earlier context gets the person's messages and the assistant's replies that pass the same check. Generated UI programs follow their answer.

## What Changes

- **Recorded per answer.** Each turn records what its answer drew on: the ids of the saved items and observations that reached the model in that turn (never content, never the thread's inherited pins), and its service receipts (the turn's carried sources and operations).
- **Checked per turn.** Each assistant message in the native thread names the run that wrote it. On every model call the domain checks those runs: each succeeded receipt must still pass the current policy revision, grant and sign-in pin, and each recorded item must still be active, unchanged, unexpired and readable. A run that fails, or whose provenance is unknown, is withheld.
- **Fresh thread.** A fresh thread's earlier messages include the assistant replies the server stored for this chat, matched by text; one that fails the check is a withheld note, and each is checked again on every turn. A reply's generated UI program goes with it when both fit in 4,000 characters.
- **Unchanged.** Earlier turns' calls still collapse into a note with results dropped. The decision model still sees only the person's messages. Process runtimes keep the old rule (any private context withholds).

## Non-goals

- Open items in Tasks, tagged skills, meetings and answered questions are not dependencies: per the decision, only saved memory and service results withhold an answer.
- Receipt age (the 30-minute context window) does not withhold an answer; it only stops the result itself being reused.

## Risk

- Recorded items are what reached the model, not what the answer cited, so an answer is withheld when any item in its context is forgotten or rewritten, even one it did not use.
- Answers written before this change carry no run id and keep the old rule.
