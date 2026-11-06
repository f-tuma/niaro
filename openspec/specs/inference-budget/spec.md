# inference-budget Specification

## Purpose

The inference budget lets owners and administrators bound what each assistant run may spend on language models, and records every model call's reservation and measured usage durably, so spending is admitted before dispatch and never silently lost or repeated.

## Requirements

### Requirement: Workspace usage policy

Each workspace SHALL have one usage policy with a mode (`observe` or `enforce`), a token cap per run (`maxTokens`, at most 10,000,000), a cost cap per run in USD millionths (`maxCostMicros`, at most 1,000,000,000) and model prices. A workspace without a saved policy SHALL use revision 0 in `observe` mode with 1,000,000 tokens, $10 and no prices. The caps SHALL apply per root run, not as a workspace-wide quota.

#### Scenario: New installation

- **WHEN** a workspace has never saved a usage policy
- **THEN** model calls are recorded but no cap is enforced

### Requirement: Model prices

A price SHALL name a model and pin its model revision and provider revision, with `maxInputTokens` (2,048–1,000,000), `maxOutputTokens` (1–128,000), and input and output prices in USD millionths per million tokens; explicit zero SHALL be valid for a free model. A policy SHALL hold at most one price per model and only for chat, router or decision models of the workspace.

#### Scenario: Stale price

- **WHEN** a saved price names a model or provider revision that is no longer current
- **THEN** saving the policy is refused with `409 catalog_conflict`

#### Scenario: Unknown model

- **WHEN** a price names a model that is not a chat, router or decision model of the workspace
- **THEN** saving is refused with `409 catalog_model_unavailable`

### Requirement: Policy administration

Owners and administrators SHALL read the policy at `GET /admin/api/identity/catalog/budget?organizationId=&workspaceId=` and replace it with `POST /admin/api/identity/catalog/budget` carrying the complete policy and its current revision, using their account session. Members MUST NOT read or change it. A successful save SHALL increment the revision and record a `catalog.ai_changed` audit entry in the same transaction.

#### Scenario: Member attempts change

- **WHEN** a member posts a usage policy
- **THEN** the server answers `403 identity_forbidden`

#### Scenario: Concurrent edit

- **WHEN** an administrator saves a policy with an outdated revision
- **THEN** the save is refused with `409 catalog_conflict` and nothing changes

### Requirement: Usage limits page

The administration's Usage limits page SHALL list the workspace's tool-capable chat, router and decision models, fill prices from the providers' published list prices on request, accept typed prices, and offer observe and Stop at limit (enforce). In enforce mode it SHALL warn while a listed model has no price, and SHALL refuse to save while a model a role can reach has no price or a price's smallest call does not fit the caps.

#### Scenario: Enforce without prices

- **WHEN** an administrator chooses Stop at limit while a listed model has no price
- **THEN** the page warns that unpriced models cannot run under the limit

#### Scenario: Routed model without a price

- **WHEN** an administrator chooses Stop at limit while the background role's model has no price
- **THEN** the page names that model and does not save

#### Scenario: Caps below the smallest call

- **WHEN** the token cap is smaller than a price's 2,048 input tokens plus its output ceiling in enforce mode
- **THEN** the page does not save

#### Scenario: Prices on a phone

- **WHEN** an administrator opens Usage limits on a 390 px wide screen
- **THEN** each model shows its full name and the labelled Input, Output, Max request and Max reply fields

### Requirement: Prices of changed models

On the Usage limits page, a listed model's price pinned to an older model or provider revision SHALL be marked and explained as not used until confirmed, with one **Confirm prices** action that saves it at the current revisions; it SHALL NOT be presented as unsaved changes. Prices of models the page does not list SHALL be kept unchanged on save and SHALL NOT be reported as changed.

#### Scenario: Price of a changed model

- **WHEN** an administrator opens the page after a listed model's provider was edited
- **THEN** that model's price is marked as not used until confirmed, **Confirm prices** saves it at the current revisions, and no unsaved-changes bar appears

#### Scenario: Price of a disabled model

- **WHEN** an administrator opens the page while a priced model is disabled
- **THEN** nothing is reported as changed and saving keeps that price as it was

### Requirement: Runs pin their policy

A root run SHALL pin the policy revision and digest, organization, workspace and user when it opens. When the policy changes, further model calls of an already pinned run SHALL be refused with `catalog_budget_policy_changed`; its ledger and completed receipts SHALL stay as they are. Child agents of a process SHALL share the parent root run, with caps narrowed to the minimum of the workspace and the process's frozen caps and the process's model-call cap.

#### Scenario: Policy edited mid-run

- **WHEN** an administrator changes the policy while a chat run is active
- **THEN** the run's next model call is refused with `catalog_budget_policy_changed`

### Requirement: Reservation before dispatch

Every budgeted model call SHALL reserve, under the identity queue and before network I/O, an upper bound for that request: input equal to the request's estimate (serialized UTF-8 bytes plus 1,024), at least 2,048 and at most the price's `maxInputTokens`; the price's full `maxOutputTokens`; and the tariff cost of both plus any provider fee the request adds. In-flight reservations of the same run SHALL count against its headroom.

#### Scenario: Concurrent calls

- **WHEN** two calls of one run reserve at the same time and only one fits the remaining headroom
- **THEN** one is admitted and the other is refused before dispatch

### Requirement: Dispatch marking

An attempt SHALL be marked dispatched immediately before network I/O, and a call cancelled before dispatch SHALL release its hold. Every actual attempt, including a retry or a fallback to another model, SHALL require its own reservation. An attempt whose connection failed before the request was sent SHALL settle as zero.

#### Scenario: Cancelled before dispatch

- **WHEN** a call is cancelled after reserving but before dispatch
- **THEN** its reservation is released and nothing is charged

#### Scenario: Connection refused

- **WHEN** the provider's address refuses the connection
- **THEN** the attempt settles as zero and, with fallback on, the next model reserves its own call

### Requirement: Enforce mode

In `enforce` mode a call SHALL be admitted only when its model has a price and its reservation fits what is left of the run's token and cost caps after measured usage and outstanding holds, and the run's model-call cap is not reached. Chat output SHALL be clamped to the price's `maxOutputTokens`. Refusals SHALL happen before dispatch, write no attempt, and use no model call.

#### Scenario: Unpriced model

- **WHEN** enforce mode is on and the selected model has no price
- **THEN** the call is refused with `catalog_budget_price_required`

#### Scenario: Prompt larger than the model allows

- **WHEN** a request's estimate exceeds the price's `maxInputTokens`
- **THEN** the call is refused with `catalog_budget_request_too_large`

#### Scenario: Run cap reached

- **WHEN** a call's reservation does not fit the run's remaining tokens, cost or model calls
- **THEN** the call is refused with `catalog_budget_exhausted`

### Requirement: Measured usage

The system SHALL record the provider's raw usage for each attempt before parsing or later abort checks. A provider-reported cost SHALL be kept as the charge, rounded up to USD millionths, with source `provider`. When the provider reports valid tokens but no cost, a configured tariff SHALL price them with source `tariff`. Invalid reported cost MUST NOT fall back to a tariff, and missing or inconsistent counts SHALL stay unknown rather than zero.

#### Scenario: Cost missing

- **WHEN** a provider reports tokens but no cost for a priced model
- **THEN** the attempt is charged by the tariff with cost source `tariff`

### Requirement: Ledger contents

Recorded attempts SHALL hold model, revisions, kind, status, reserved and actual amounts, cost source and overrun, and MUST NOT hold prompts, credentials or business arguments. A run's summary SHALL report known amounts plus outstanding holds and the number of unknown calls, never presenting unknown usage as zero.

#### Scenario: Inspecting an attempt

- **WHEN** an attempt is read from the ledger
- **THEN** it contains no prompt text or credential

### Requirement: Overruns

Usage above an attempt's reservation SHALL be recorded as an overrun, after which the run's further model calls SHALL be refused with `catalog_budget_overrun` in enforce mode.

#### Scenario: Provider overruns the estimate

- **WHEN** a provider reports more tokens than the call reserved
- **THEN** the overrun is recorded and the run's next call is refused with `catalog_budget_overrun`

### Requirement: Unknown outcomes

An attempt whose usage stays unknown (lost connection or timeout after dispatch, a success without usable usage, a gateway timeout 408/504/524, a restart mid-call) SHALL keep its full reservation as its charge, and the run MAY continue within its caps. A provider rejection without a completion (other non-2xx, no usage) SHALL be settled as zero. An unknown attempt MUST NOT be resent automatically, treated as free, or cleared by restart or resume.

#### Scenario: Timeout after dispatch

- **WHEN** a dispatched call times out without usage
- **THEN** the run is charged its reservation and may continue if the caps still allow

#### Scenario: Provider rate limit

- **WHEN** the provider answers 429 without usage
- **THEN** the attempt is settled as zero

### Requirement: Usage from before the ledger

A run whose inference predates the ledger SHALL count that inference as unknown history, and in enforce mode its further model calls SHALL be refused with `catalog_budget_usage_unknown`.

#### Scenario: Old run resumed

- **WHEN** a run with pre-ledger inference continues in enforce mode
- **THEN** its next model call is refused with `catalog_budget_usage_unknown`

### Requirement: Recovery on start

At server start an undispatched reservation SHALL become cancelled and a dispatched attempt without a committed result SHALL become unknown and keep its hold.

#### Scenario: Crash after provider response

- **WHEN** the server is killed after the provider answered but before the usage was committed
- **THEN** after restart the attempt is unknown, keeps its charge and is not sent again

### Requirement: Budget never undoes effects

A budget refusal MUST NOT turn a completed write into a failure or authorize repeating a write. Reading recorded results and declining an approval SHALL remain possible after a budget refusal or policy change.

#### Scenario: Cap reached after a write

- **WHEN** a run's write succeeded and its next model call is refused by the budget
- **THEN** the write's receipt stays succeeded and the write is not repeated

### Requirement: Readiness checks

Features that must run under a cap (the process designer and custom agent steps, see `process-design` and `process-execution`) SHALL start only when the workspace is in enforce mode with a priced model and the smallest call (2,048 input tokens plus the output ceiling) fits the caps; otherwise they SHALL say so and point to Usage limits before any model call.

#### Scenario: Designer in observe mode

- **WHEN** a person opens the process designer while the policy is in observe mode
- **THEN** the designer explains that usage limits must stop at the limit and sends no model call

### Requirement: Budgeted callers

Chat with its selector, checker, fallback, escalated and knowledge search calls, process agents, the process designer, hub fills, opens and prefetches (see `hub`), meeting record extraction (see `meetings`), knowledge indexing (each document its own root run) and administrative model calls SHALL use the ledger, each under its own root run. Voice transcription, spoken replies and meeting speech-to-text SHALL NOT use the ledger and SHALL count only against the provider's request allowance.

#### Scenario: Hub fill root

- **WHEN** a hub widget is filled
- **THEN** its model calls are recorded under their own root run with the hub's caps narrowed by the workspace policy

#### Scenario: Embedding a file

- **WHEN** knowledge indexes a file a member sent
- **THEN** its embedding calls are recorded as kind `embedding` under their own root run of that member, with input tokens and no output, and count against the provider's daily limit

### Requirement: Provider request limit

The provider's daily request limit SHALL be counted separately from the ledger, and reaching it SHALL report `catalog_provider_limit`.

#### Scenario: Daily limit reached

- **WHEN** the provider's daily request count is exhausted
- **THEN** the call is refused with `catalog_provider_limit`, not a budget code

### Requirement: Prices for routed models

In enforce mode every model a budgeted role (chat, service routes, checker, selector, background, designer, web search, embedding) can reach SHALL have a price: the first model of each route, the others only with fallback on, the escalation models when escalation is on and the models of the presets members may pick. The Usage limits and Models pages SHALL name such a model while unpriced and refuse to save; a call to it SHALL be refused before dispatch with `catalog_budget_price_required`.

#### Scenario: Fallback model without a price

- **WHEN** a workspace stops at limit and an administrator turns on fallback for chat to an unpriced second model
- **THEN** the Models page names that model and does not save

#### Scenario: Preset model without a price

- **WHEN** an administrator in enforce mode offers members a preset whose tier has an unpriced model
- **THEN** the Models page names that model and does not save

#### Scenario: Embedding model without a price

- **WHEN** a workspace stops at limit and its embedding model has no price
- **THEN** a knowledge pass sends no request and its status lists `catalog_budget_price_required`

### Requirement: Free providers' models

For each chat, router, decision or embedding model of a provider the administrator marked free, the applied usage policy SHALL hold a zero price pinned to its current revisions, with 128,000 input and 16,384 output tokens, unless the workspace has its own price for it. Such prices SHALL never be stored or exported: a saved price equal to one SHALL be dropped. A run SHALL pin the prices that apply when it opens.

#### Scenario: Local model under enforce mode

- **WHEN** a workspace stops at limit and its chat model is on a free provider without a typed price
- **THEN** chat runs, reserves tokens against the caps and records zero cost

#### Scenario: Provider no longer free

- **WHEN** an administrator turns off free for that provider
- **THEN** the Models and Usage limits pages name the chat model as unpriced
