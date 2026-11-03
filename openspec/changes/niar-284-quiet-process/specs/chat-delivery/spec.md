# Spec Delta

## MODIFIED Requirements

### Requirement: Reliable client delivery

A client SHALL persist a command before sending it. A lost response SHALL leave the command uncertain; the lost outcome of a chat message, and of a process start, answer or decision (see `process-execution` "A lost process outcome is checked without the person"), SHALL be checked by the client itself by resending the exact command with its exact ids and payload, and any other command SHALL be resent only by an explicit retry. Rendering history or replaying events SHALL NOT send or approve anything.

#### Scenario: Connection drops while sending

- **WHEN** the network fails after a message was sent but before the response arrived
- **THEN** the message is shown as still being answered, with no error and no retry action
- **AND** the client resends the exact command by itself once it can reach the server

#### Scenario: Connection drops while starting a process

- **WHEN** the network fails after a process start was sent but before the response arrived
- **THEN** the start is shown as starting, with no error and no retry action
- **AND** the client resends the exact start by itself once it can reach the server, and the server answers it from its receipt
