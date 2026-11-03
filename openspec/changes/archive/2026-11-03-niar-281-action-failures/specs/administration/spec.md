# Spec Delta

## MODIFIED Requirements

### Requirement: Run outcomes

A proposal and its approved execution SHALL be separate steps; an unverified write SHALL stay `unknown`, a declined proposal `cancelled`, and a run that was running when the server restarted `interrupted`. A failed or unconfirmed action SHALL show its recorded cause and a safe next step, or say that the cause was not recorded. A run's status SHALL be its outcome as `agent-runtime` defines it; a `succeeded` run with a failed tool step SHALL carry `failedSteps: true` and show a muted "Some steps failed" badge in the list and the detail, while its steps keep their own statuses.

#### Scenario: Unverified write

- **WHEN** a write was sent but its result could not be confirmed
- **THEN** the step and run show `unknown` and the next step asks to verify in the service before repeating

#### Scenario: Recovered run

- **WHEN** an administrator opens a run whose first mail read failed and whose reply was delivered after a corrected read
- **THEN** the run and its Reply step show Completed with a muted "Some steps failed" badge, and the first read's step shows Failed with its cause
