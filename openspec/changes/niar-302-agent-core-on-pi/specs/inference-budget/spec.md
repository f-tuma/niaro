# Spec Delta

## ADDED Requirements

### Requirement: Agent core requests are budgeted

Each model request of the agent core SHALL reserve in the ledger before dispatch, under one root run per agent run, and SHALL settle from the provider's reported usage. A refused reservation SHALL fail the run without a retry and without reaching the provider. A failure after dispatch SHALL keep the attempt's full hold, and each retry SHALL reserve anew.

#### Scenario: Over the cap

- **WHEN** an agent core request would exceed the workspace's enforced limit
- **THEN** it is refused before dispatch, nothing reaches the provider and the run ends unanswered

#### Scenario: Transient failure retried

- **WHEN** an agent core request times out and is retried
- **THEN** the ledger shows the failed attempt unknown with its hold and the retry settled, both under the same root run
