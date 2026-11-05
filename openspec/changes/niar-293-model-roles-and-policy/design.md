# Design

## D1 Shape

`packages/protocol/model-policy.ts` holds the schemas and the pure resolution shared by the server and the console:

- `RoleRoute {models: id[≤8], tier: id|null, fallback}`; an empty list without a tier turns a role off, an absent role inherits.
- `OrganizationModelPolicy {roles, tiers[≤8], options}` and `WorkspaceModelPolicy {roles, services[{serviceId, route}], options}` where workspace options are each optional (inherit).
- Options: `serverVoice` (use the server's own recognition when voice input has no models), `speech {voice|null, zeroDataRetention}` (null = the model's first reviewed voice), `selector {minConfidence}` (selector and checker certainty), `escalation {mode: stop|escalate, models, tier}`.
- `effectiveRole/effectiveRoute/effectiveOptions/policyView` resolve workspace → organization → role default (`ROLE_DEFAULTS`: background, designer, web_search → chat; checker → selector) and report the source (`workspace`, `organization`, `inherited` with `via`, `none`). `budgetedReach` lists the models budgeted roles can reach (first model, the rest only with fallback, escalation models when on).

Storage: `agent_model_policy (organization_id, revision, data)` for the default; `agent_catalog_routing` keeps one row per workspace, now holding its `WorkspaceModelPolicy`. The catalog response's `routing` became `policy: ModelPolicyView` (organization, workspace, effective).

## D2 Resolution and fallback

`ServiceCatalogStore.selectRoute(org, ws, key)` (`apps/server-identity/service-catalog.ts`) returns `{model, provider, key, route: {role, index, fallback, reason}}`. Without fallback it is exactly the old behaviour: the first model, whose own failure (`catalog_model_unavailable`) stands. With fallback it skips models that are disabled, unfit, removed, on a disabled provider or at the daily limit, with reason `fallback: <cause>`. Named wrappers keep call sites short: `resolveModel` (chat or `service:<id>`), `resolveBackground`, `resolveDesigner`, `resolveDecision` (selector), `resolveChecker`, `resolveEscalation`, `resolveVoice`, `resolveMeetingTranscription`, `resolveSpeech`, `resolveWebSearch`.

At dispatch, `fallbackAfter(selection, error)` returns the next model only for `notDispatchedCause(error)`: `catalog_provider_limit` (thrown by `useProvider` inside the dispatch guard, before `start()`), or `RequestNotSent` — a new `IntegrationError` subclass the transport throws when the socket failed before it connected (`apps/server-integrations/transport.ts`), keeping the code `integration_unavailable`. The ledger settles such an attempt as zero instead of unknown (`budgetedInferenceTransport`). Timeouts, 4xx/5xx answers, budget refusals and anything after `start()` never fall back.

Where: the native runtime's model wrapper (`apps/server-agent/runtime.ts` `model()`), through a new optional `NativeAgentSession.fallback`, builds a new model per attempt so each goes through `allowance` and its own reservation; `model-start` events carry role and reason, a moved-on step ends `failed`. The domain's `decide()` (selector/checker) loops the same way. Background callers (hub fills, meeting analysis, profile learner, OAuth suggestion) select with fallback and check `stillRouted` at dispatch instead of comparing with a fresh resolution.

Alternative rejected: falling back on provider 429/503 answers. They reached the provider; the owner's rule is "provably never reached". Left as an open question.

## D3 Checker and selector

`decideChoice` (`apps/server-integrations/decisions.ts`) keeps the decisions API for `decision` models and otherwise sends one chat completion with a single `choose {choice: enum, confidence}` tool and a forced tool choice, through `createNiaroMastraModel` (privacy fields and validation as chat). A choice outside the criteria is refused; probabilities give the choice its confidence and share the rest. The transport kind follows the model (`decision` or `model`) so the ledger reads the right usage. `mastra-domain.ts` `decide(role, …)` replaces `jev()`: `find_service`, `find_actions` and continuity use the selector; write and answer checks use the checker. Semantics are unchanged: a confident mismatch blocks, nothing approves.

## D4 Escalation

`DomainCommand.escalation` is `checker_mismatch | answer_check | used`. A write checker mismatch or an answer-check repair sets it when the effective option is `escalate` and the run has not escalated. `prepareModel` then resolves the escalation route once (reason `escalated after checker mismatch` / `escalated after answer check`) and marks it used; unavailable escalation models leave the step to the chat model. It is an ordinary model call of the same root run, so caps, model-call limits and the budget apply.

## D5 Background and designer

Background role: hub agent runs (fills, opens, prefetch; `service.ts` `hubAgentAccess`, `hub-fill.ts`), memory and profile extraction (`service.ts` profile learner access), meeting analysis (`service.ts` meeting model), action naming (`catalog-controller.ts` enrichment). Titles come from the meeting record call. The designer role picks the first priced model for chat proposals (`process-proposal.ts`); the designer page preselects it. Process definitions keep their own frozen models.

## D6 Planner and drain

`Routing.planner` only chose the loop of a new turn inside `createDrainCatalogRuntime`; production never routes a new turn there (`catalog-runtime.ts` sends only saved legacy kinds). The field is gone; a new turn in the drain is refused with `catalog_runtime_unsupported` unless a test passes a `seed` loop. The drain still finishes saved turns and uses the selector and checker roles.

## D7 Identities out of code

Jev's kind forcing and discovery addition are removed: a model's kind comes from discovery (`Router` tokenizer, output modalities) or from the administrator's entry. Reviewed voices are `CatalogModel.voices [{voice, label}]` (≤20, only on speaking models); their digest is the reviewed revision, so editing the list retires earlier personal choices. The legacy OpenRouter voice profile reads `voiceModel` from its config; `voiceCapabilities` has no default model. The web plugin's `searchModel` setting is replaced by the `web_search` role.

## D8 Budget and removal

`unpricedRouteModels` (enforce mode only) uses `budgetedReach`; saving the budget in enforce mode, a workspace policy, or an organization policy that would leave a reachable model unpriced in any enforce-mode workspace fails with `catalog_budget_price_required`. The Usage limits page and Models page show the same list. `removeModel` refuses a model named by any role, service route, tier or escalation of the organization or any workspace.

## D9 Migration

On open, every legacy row (no `roles`) becomes a workspace policy that sets chat, voice input (catalog mode only), meeting transcription, speech, selector (when enabled), service models and the options; the web plugin's `searchModel` becomes `web_search` when it names a catalog model. Per organization without a default, the first migrated workspace (by insertion) seeds it, excluding web search; every workspace then drops roles and options equal to it. The row's revision advances by one. Runs once.

## D10 Configuration bundle

`CatalogController.readModelPolicy(target, context)` and `writeModelPolicy(command, context)` are the typed read and write for NIAR-297; the write goes through the console's command path (revision, validation, epoch, audit with `policyScope`).

## Verification

`tests/model-policy.node.ts` (inheritance, tiers, fallback before dispatch only, checker on a chat model without OpenRouter, price and removal checks, migration, voices); escalation in `tests/mastra-domain.node.ts`; fallback in the native runtime; updated catalog, voice, speech and admin tests; `tests/model-policy-page.test.tsx` for the console page.
