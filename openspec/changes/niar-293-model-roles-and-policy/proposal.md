# Proposal

Tracker: **NIAR-293**

## Why

Model choice was one chat model per workspace plus a few special models, with policy hidden in code: background work (widgets, memory, meetings, action names) always ran on the chat model, a new workspace had no model at all, the write and answer checks worked only with the OpenRouter decision model, a hidden `planner` switch picked a runtime, and model IDs (Jev, a default voice model, a reviewed voice list) were built into the code. Administrators could not send cheap work to a cheap model, share one choice across workspaces, or keep checks without OpenRouter. The owner allowed reworking the system.

## What Changes

- **Roles.** Each job Niaro does with models is a role: `chat`, `service:<id>`, `checker`, `selector`, `background`, `designer`, `web_search`, `voice_input`, `meeting_transcription`, `speech`, and reserved `embedding` and `vision`. A role maps to an ordered list of catalog models (the first is the primary) or to a tier. Roles nobody set follow another: background work, process design and web search follow chat; the checker follows the selector.
- **Tiers.** Optional named model lists of the organization (for example Fast, Standard, Strong) that roles point to.
- **Scope.** An organization default policy every workspace inherits; a workspace may override any role, service or setting. A new workspace works with the default. Both are revision-checked and audited as `catalog.routing_changed`.
- **Fallback** (per role, off by default): a call moves to the next model only when it provably never reached its provider (model or provider unavailable at selection, the daily limit, or a connection that failed before a byte was sent). Never after an unknown outcome or a sent call. Each attempt is its own budgeted call.
- **Escalation** (off by default): when the write or answer checker rejects a step, that step is repeated once with escalation models, within the same run's caps.
- **Checker as a role.** Any tool-capable chat model can check writes and answers through one forced tool call; a decision model is one option. Checks keep working without OpenRouter.
- **Visibility.** Every model step in Runs names its model, role and reason.
- **Budget.** In enforce mode every model a budgeted role can reach needs a price; budget and policy saves refuse otherwise. Model removal checks every list.
- **Admin.** `/admin/routing` becomes **Models**: organization and workspace tabs, role rows with ordered model chips, tiers, fallback, escalation and settings.
- **Removed.** `Routing.planner`; Jev identities and discovery additions; the built-in default voice model; the hardcoded reviewed voice list (now model metadata); the web plugin's search model setting (now the `web_search` role). The pre-Mastra drain runtime only finishes saved turns.

## Migration

Stored routing becomes a workspace policy that sets each role it used to decide; each organization's default is seeded from its first migrated workspace and every workspace keeps only what differs. A web plugin search model becomes that workspace's `web_search` role. Reviewed voices are entered on the speech model.

## Non-goals

- Provider presets and dropping OpenRouter-only transport rules (NIAR-294).
- Members choosing models in chat; loop limits as settings.
- Fallback after a provider answered (for example 429 or 503).

## Risks

Fallback and escalation spend more; both are off by default and every attempt is budgeted. A policy change bumps the policy epoch as routing did. Admins must re-enter reviewed voices.
