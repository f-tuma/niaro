# ADR 001 — bounded text workflow and server-owned state

Date: 2026-09-23. Status: accepted for the synthetic first slice; production choices remain open.

The v0.2 plan required useful executable code without completing all M0–M5. We use one npm project with populated `apps` and `packages` directories, not a set of empty workspaces. Expo is the client. A standalone Node HTTP fixture owns deterministic workflow, its event log, revisions and results. The client has no model/tool/calendar implementation.

Chat and Tasks project one normalized store and use `WorkItemCard` / `InputRequestForm`. Input submission, server resolution and work completion are deliberately distinct. A contextual chat reply is an alternative command against the same InputRequest, not a text-parsed local checklist. Snapshots restore state without replaying commands. Unknown deliveries require explicit retry with the same ID.

For this demo, periodic event polling every second is simpler than a persistent streaming transport. JSON file replacement persists synthetic state and due demo work across restarts. Tests cover persistence failure rollback and real HTTP restart. These choices do not satisfy production M2 durability, streaming, authentication or arbitrary backend compatibility.

English is the first-run UI regardless of OS locale. Manual `cs` persists; it does not set timezone, currency or speech backend. Existing server messages are not translated retroactively.

The reference's light gradient, rounded cards, blue/lilac accents and floating four-tab navigation are retained. Text contrast and minimum 48-unit controls take priority over literal mockup density. Native system fonts replace unavailable reference font files. Meetings/voice explicitly state that they are unavailable; a decorative idle wave is not an active microphone indicator.

Scope is endpoint plus server-supplied demo identity. Real authenticated identity, permissions, ActionProposal/Operation, push, encrypted cache, audio transport and first real integration remain separate decisions. See `docs/protocol.md` for concrete limits.
