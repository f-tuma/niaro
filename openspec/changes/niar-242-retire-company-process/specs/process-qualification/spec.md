## ADDED Requirements

### Requirement: Decisions on a retired process

Tests, activation and rollback of a retired process SHALL follow the same admission, qualification and freshness rules as for any company process and SHALL NOT restore it. The activation review SHALL report `retired: true` for a retired process so the console can say the decision takes effect only after a restore.

#### Scenario: Activate a fix while retired

- **WHEN** an administrator activates a newly qualified version 4 of a retired process
- **THEN** version 4 becomes the active version, the process stays retired and nobody can start it until it is restored

#### Scenario: Review of a retired process

- **WHEN** a manager reads the activation review of a retired process
- **THEN** the review carries `retired: true` and changes nothing

#### Scenario: Member tests a retired company process

- **WHEN** a member starts a native test of a retired workspace process
- **THEN** the test is refused like for any company process they cannot manage
