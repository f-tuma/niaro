# Spec Delta

## MODIFIED Requirements

### Requirement: Isolated native test

A native test (`agent-process-native-tests/1`) SHALL run a frozen version through the real compiler and agent core, the native agent, catalog controller, approval logic and inference ledger in detached temporary stores with closed synthetic transports, with scripted model replies and token usage. Reports SHALL state `native_scripted` and `activationEligible: false`.

#### Scenario: Test makes no external call

- **WHEN** a native test runs a workflow that writes to the CRM
- **THEN** the write is served by its scripted fixture and no request leaves the server
