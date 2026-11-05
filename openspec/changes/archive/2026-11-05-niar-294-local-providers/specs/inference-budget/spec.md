# Spec Delta

## ADDED Requirements

### Requirement: Free providers' models

For each chat, router or decision model of a provider the administrator marked free, the applied usage policy SHALL hold a zero price pinned to its current revisions, with 128,000 input and 16,384 output tokens, unless the workspace has its own price for it. Such prices SHALL never be stored or exported: a saved price equal to one SHALL be dropped. A run SHALL pin the prices that apply when it opens.

#### Scenario: Local model under enforce mode

- **WHEN** a workspace stops at limit and its chat model is on a free provider without a typed price
- **THEN** chat runs, reserves tokens against the caps and records zero cost

#### Scenario: Provider no longer free

- **WHEN** an administrator turns off free for that provider
- **THEN** the Models and Usage limits pages name the chat model as unpriced
