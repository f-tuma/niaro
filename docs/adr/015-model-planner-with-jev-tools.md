# ADR 015 — The language model plans, Jev chooses

Date: 2026-09-29. Status: accepted; selectable per workspace (`routing.planner`), and the default stays `jev`.

The progressive runtime lets Jev drive the whole turn: it picks the service, then the action, then decides whether another step follows. Bounded choices suit Jev, but open reasoning does not. Multi-step tasks such as "find Jane, check my calendar tomorrow and book a meeting" broke down between steps. This ADR turns that around: a chat model reasons about the task, and Jev does the narrow choices it is good at, as tools.

## Decision

- **The planner is the chat model** (`apps/server-identity/agent-runtime.ts`, turn kind `agent-1`). It works in a tool loop, bounded to 12 model calls, 40 inferences and 12 action calls per turn.
- **The model never sees the catalog.** Its tools are:
  - `find_service {need}`: Jev chooses one enabled service from the names, descriptions and action names. When Jev is not confident, up to three candidates come back.
  - `find_actions {service, need}`: Jev ranks the actions of that service. A word prefilter first cuts large catalogs to 32. The model gets the top two when Jev is confident and four otherwise. Only these become callable `action_*` tools, at most ten per turn.
  - The internal plugins (date and time) and `ask_user`.
  - A tool the model was not offered is refused with `unknown_tool`.
- **Jev also checks the work:**
  - Before a write is proposed, Jev decides whether its arguments match the request. A mismatch goes back to the model as `checker_mismatch` and never reaches the person.
  - Before the final answer, Jev decides once whether the answer is complete. An incomplete answer sends the model back to work.
- **Writes still need approval.** A write pauses the turn with the approval card. Approving or declining appends the outcome and resumes the same loop. The model must not claim success before the write's result.
- **Time and timezone come from the phone.** The model is told they are authoritative. A question about a timezone or today's date is never sent to the person.
- **Follow-ups.** An answer to `ask_user` within 30 minutes may continue in the same session with current, authorized read receipts. New sessions start fresh. Typed working context, interruption recovery and optional scoped long-term memory are defined in [ADR 016](016-scoped-agent-memory.md).

## Consequences

Each step costs one chat model call, so turns take longer and cost more than with Jev alone. In return, a task can span several services. Without a decision model, `find_service` and `find_actions` fall back to listing the candidates, and the model chooses among them itself. Service descriptions now carry weight, because they are what Jev reads to choose a service.
