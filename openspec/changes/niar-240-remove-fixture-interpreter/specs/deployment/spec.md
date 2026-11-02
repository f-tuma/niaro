## ADDED Requirements

### Requirement: Account profile without test adapters

A profile SHALL enable `administration.identity`, because the app API serves only account workspaces. The CRM adapter SHALL only be `disabled` and the calendar adapter only `simulated`; the TEST Twenty directory and CalDAV calendar adapters SHALL be rejected like any unsupported adapter.

#### Scenario: Profile without accounts

- **WHEN** a profile has no `administration.identity`
- **THEN** `start` and `check` fail and name `administration.identity` as what to add

#### Scenario: TEST CRM or CalDAV adapter

- **WHEN** a profile sets `adapters.crm.provider` to `twenty-test` or `adapters.calendar.provider` to `caldav`
- **THEN** `start` and `check` fail and name the adapter to set back to `disabled` or `simulated`

#### Scenario: Example profile still loads

- **WHEN** a profile keeps `adapters.crm` `disabled` and `adapters.calendar` `simulated`
- **THEN** it loads unchanged

## MODIFIED Requirements

### Requirement: Profile validation

The system SHALL accept only a strict version-1 profile of at most 64 KiB: unknown fields, unsupported adapters, inline credentials and malformed origins SHALL be rejected, paths SHALL resolve relative to the profile file, the identity and workflow directories SHALL differ, and the profile's `listen.host` SHALL be loopback (`127.0.0.1` or `::1`). The server SHALL refuse to start on an invalid profile with a message that names what to check and no secret values.

#### Scenario: Unknown field

- **WHEN** a profile contains a field the schema does not define
- **THEN** `start` and `check` fail with "Invalid server profile" and exit non-zero

#### Scenario: Shared data directory

- **WHEN** the identity directory equals the workflow data directory
- **THEN** the server refuses to start with "Identity and workflow directories must be separate."

### Requirement: Private configuration files

The system SHALL refuse to load private credential files referenced by a profile (model and voice adapter configurations) or the recovery key file when they are readable by group or others.

#### Scenario: World-readable credential file

- **WHEN** a profile references a credential file with mode `0644`
- **THEN** the server refuses to start
