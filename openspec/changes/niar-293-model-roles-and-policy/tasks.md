# Tasks

## 1. Policy model

- [x] 1.1 `packages/protocol/model-policy.ts`: roles, tiers, routes, options, organization and workspace policies, the effective view and `budgetedReach` (Model roles, Model tiers).
- [x] 1.2 Storage: `agent_model_policy` for the default, `agent_catalog_routing` rows hold workspace overrides; revision checks; `saveOrganizationModelPolicy` / `saveWorkspaceModelPolicy` audited as `catalog.routing_changed` with the scope (Organization default and workspace overrides).
- [x] 1.3 Role fit, tier, selector and voice checks on save (Role fit, Spoken reply choice).
- [x] 1.4 Typed `readModelPolicy` / `writeModelPolicy` on the catalog controller for the configuration bundle.
- [x] 1.5 Migration of stored routing and the web plugin's search model (Stored routing migration).

## 2. Resolution at use

- [x] 2.1 `selectRoute` with fallback at selection, `fallbackAfter` only for provider limit and `RequestNotSent`; zero settlement of a request never sent (Role fallback, Dispatch marking).
- [x] 2.2 Native runtime model wrapper falls back per attempt and reports role and reason (Run steps name their model).
- [x] 2.3 Selector and checker as roles through `decideChoice`; a chat model checks with one forced tool call (Write and Answer consistency checks).
- [x] 2.4 Escalation once per run after a checker rejection (Escalation after a checker rejection).
- [x] 2.5 Background role for hub fills and opens, memory and profile extraction, meeting records and action naming; designer role for chat proposals; web search role (Background work, Drafting a process from chat, Web settings).
- [x] 2.6 Voice input, meeting transcription and speech roles; methods follow the model's kind; server voice option.

## 3. Out of code

- [x] 3.1 `Routing.planner` removed; the drain refuses new turns unless a test seeds them.
- [x] 3.2 Jev kind forcing and discovery addition removed; decision kind entered by the administrator.
- [x] 3.3 Reviewed voices as model metadata; no built-in default voice model; the legacy voice profile reads its model from its configuration.

## 4. Budget and removal

- [x] 4.1 Enforce mode needs prices for every reachable model: budget, workspace and organization saves (Prices for routed models).
- [x] 4.2 Model removal checks every role, service route, tier and escalation (Model removal).

## 5. Console

- [x] 5.1 Models page: organization and workspace tabs, role chips, tiers, fallback, escalation, settings, inherited sources, unavailable and unpriced marks (Models page).
- [x] 5.2 Usage limits page names unpriced routed models and refuses to save; Overview, checklist, service model and designer read the policy.
- [x] 5.3 Runs translate role and reason; model form edits reviewed voices.

## 6. Verification

- [x] 6.1 `tests/model-policy.node.ts`; escalation in `tests/mastra-domain.node.ts`; fallback in the native runtime test.
- [x] 6.2 Updated catalog, voice, speech, output voice, budget and admin tests; `tests/model-policy-page.test.tsx`.
- [x] 6.3 `npx tsc --noEmit -p .`, eslint, `node scripts/check-boundaries.mjs`, `npm run test:mcp`, `spec openspec validate --all --strict`.
