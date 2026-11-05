## MODIFIED Requirements

### Requirement: Prices for routed models

In enforce mode every model a budgeted role (chat, service routes, checker, selector, background, designer, web search) can reach SHALL have a price: the first model of each route, the others only with fallback on, the escalation models when escalation is on and the models of the presets members may pick. The Usage limits and Models pages SHALL name such a model while it has no price and refuse to save; at use a call to it SHALL be refused before dispatch with `catalog_budget_price_required`.

#### Scenario: Fallback model without a price

- **WHEN** a workspace stops at limit and an administrator turns on fallback for chat to an unpriced second model
- **THEN** the Models page names that model and does not save

#### Scenario: Preset model without a price

- **WHEN** an administrator in enforce mode offers members a preset whose tier has an unpriced model
- **THEN** the Models page names that model and does not save
