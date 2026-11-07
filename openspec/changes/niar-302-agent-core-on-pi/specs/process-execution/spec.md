# Spec Delta

## MODIFIED Requirements

### Requirement: Native run

An admitted run SHALL execute the frozen version on the server's agent core under the person's current authority: action steps through the service catalog with argument validation, approval policy, guarded transport, audit and durable receipts (see `service-catalog`); agent steps with only their declared capabilities as tools in their own child thread; branches and returns without code. Each step SHALL recheck the version, authority and source and OAuth pins.

#### Scenario: Grant revoked mid-run

- **WHEN** the person loses access to an action used by a waiting run
- **THEN** the run stops with `process_definition_invalid` and dispatches nothing more

### Requirement: No implicit execution

A page reload, reconnect, poll, inventory read, form preparation or card opening MUST NOT start or resume a run. After a server restart, a run that stopped mid-run SHALL continue by itself under its person's current membership once its stored boundaries are proved, at most three times in a row; otherwise it SHALL fail closed. A run waiting for a person SHALL stay waiting.

#### Scenario: Restart while waiting

- **WHEN** the server restarts while a run waits for approval
- **THEN** the run stays waiting until the person decides

#### Scenario: Restart mid-run

- **WHEN** the server dies while a run executes and comes back
- **THEN** the run continues by itself from the node it stopped in, and a write whose receipt exists is not sent again

## ADDED Requirements

### Requirement: Run checkpoints in the agent core

The agent core SHALL store each run's checkpoint: the carry before and after every node it entered, the decision a node was resumed with, a pending approval or question, and the result. After a crash, a run SHALL continue from the node it stopped in only once every boundary in the checkpoint is proved from receipts and child state.

#### Scenario: Killed after a node's effect

- **WHEN** the server dies after an action's receipt was recorded but before the node's end reached the checkpoint
- **THEN** the run continues from that node, the receipt answers it and the action is not dispatched again

#### Scenario: Killed while waiting for approval

- **WHEN** the server dies while a run waits for approval
- **THEN** after the restart the run still waits for the same approval, and the write runs once after the decision
