# Spec Delta

## ADDED Requirements

### Requirement: Retired profile fields

The system SHALL refuse a profile that contains a retired field: `administration.identity.aiProfiles`, `administration.identity.mobile.model`, `administration.identity.mobile.voice`, `administration.identity.calendarCollections` or `administration.identity.connectionOrigins`. `start` and `check` SHALL fail with a message that names each retired field present and says to remove it, and SHALL NOT print values. `administration.identity.mobile.sessionIdleDays` SHALL stay valid.

#### Scenario: Profile with an AI profile catalog

- **WHEN** `check` runs on a profile containing `administration.identity.aiProfiles`
- **THEN** it exits non-zero with a message naming `administration.identity.aiProfiles` as retired, and shows none of its values

#### Scenario: Several retired fields

- **WHEN** a profile contains `mobile.model` and `connectionOrigins` under `administration.identity`
- **THEN** `start` refuses to start and the message names both fields

#### Scenario: Remaining device setting

- **WHEN** a profile sets only `administration.identity.mobile.sessionIdleDays`
- **THEN** the profile is valid and device sessions use that idle period
