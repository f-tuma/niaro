# Spec Delta

## ADDED Requirements

### Requirement: Prices for routed models

In enforce mode every model a budgeted role (chat, service routes, checker, selector, background, designer, web search) can reach SHALL have a price: the first model of each route, the others only with fallback on, and the escalation models when escalation is on. Saving the usage policy, a workspace policy or the organization default that would leave such a model unpriced SHALL fail with 409 `catalog_budget_price_required`.

#### Scenario: Fallback model without a price

- **WHEN** a workspace stops at limit and an administrator turns on fallback for chat to an unpriced second model
- **THEN** the save fails with `catalog_budget_price_required`

## MODIFIED Requirements

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

### Requirement: Dispatch marking

An attempt SHALL be marked dispatched immediately before network I/O, and a call cancelled before dispatch SHALL release its hold. Every actual attempt, including a retry or a fallback to another model, SHALL require its own reservation. An attempt whose connection failed before the request was sent SHALL settle as zero.

#### Scenario: Cancelled before dispatch

- **WHEN** a call is cancelled after reserving but before dispatch
- **THEN** its reservation is released and nothing is charged

#### Scenario: Connection refused

- **WHEN** the provider's address refuses the connection
- **THEN** the attempt settles as zero and, with fallback on, the next model reserves its own call

### Requirement: Budgeted callers

Chat with its selector, checker, fallback and escalated calls, process agents, the process designer, hub fills, opens and prefetches (see `hub`), meeting record extraction (see `meetings`), and administrative model calls (naming imported service actions, OAuth adapter recommendations) SHALL use the ledger, each under its own root run. Voice transcription, spoken replies and meeting speech-to-text SHALL NOT use the ledger and SHALL count only against the provider's request allowance.

#### Scenario: Hub fill root

- **WHEN** a hub widget is filled
- **THEN** its model calls are recorded under their own root run with the hub's caps narrowed by the workspace policy
