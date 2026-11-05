## MODIFIED Requirements

### Requirement: Budgeted callers

Chat with its selector, checker, fallback, escalated and knowledge search calls, process agents, the process designer, hub fills, opens and prefetches (see `hub`), meeting record extraction (see `meetings`), knowledge indexing (each document its own root run) and administrative model calls SHALL use the ledger, each under its own root run. Voice transcription, spoken replies and meeting speech-to-text SHALL NOT use the ledger and SHALL count only against the provider's request allowance.

#### Scenario: Hub fill root

- **WHEN** a hub widget is filled
- **THEN** its model calls are recorded under their own root run with the hub's caps narrowed by the workspace policy

#### Scenario: Embedding a file

- **WHEN** knowledge indexes a file a member sent
- **THEN** its embedding calls are recorded as kind `embedding` under their own root run of that member, with input tokens and no output, and count against the provider's daily limit

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
