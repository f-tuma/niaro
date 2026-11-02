## ADDED Requirements

### Requirement: Member service projection

The system SHALL give each authenticated person, on the web and in the app, a read-only list of every enabled service they may use in the workspace: their own active services, services with a personal sign-in for them and services with an enabled action they may run. Each entry SHALL say whose account its reads and its changes run under (`own` or `company`), which reads and changes the person may run now, and their sign-in state.

#### Scenario: Switched-off actions

- **WHEN** a person switched off every action of a sign-in service for themselves
- **THEN** the service stays listed with nothing to run

#### Scenario: Other people's own services

- **WHEN** a member has an own service and a colleague opens the list
- **THEN** the colleague does not see it

### Requirement: Own activity in the member projection

Each entry of the member service projection SHALL carry only the person's own last successful read (time) and last failed call (time and failure kind), taken from that person's receipts in that workspace. Administrators SHALL see only the actions they may run themselves.

#### Scenario: Another member's activity

- **WHEN** two members used the same company service and one opens the list
- **THEN** the times shown are that member's own and the other member's never appear

### Requirement: Nothing secret in the member projection

The member service projection SHALL NOT contain service addresses, credentials, OAuth configuration, grants or policies, receipt inputs, results or messages, or any other person's activity, and reading it SHALL NOT start any work.

#### Scenario: Shared key and OAuth client

- **WHEN** a service has a shared API key and an OAuth client secret
- **THEN** neither, nor the service's address, appears in the list
