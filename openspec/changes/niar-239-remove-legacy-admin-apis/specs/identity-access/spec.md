# Spec Delta

## ADDED Requirements

### Requirement: Retired activity records stay readable

The activity log SHALL keep listing and labeling entries written by retired features: `workspace.ai_changed`, `calendar.*`, `connection.*` and `tool.invoked`. `category=tools` SHALL still include the retired call records. The system SHALL NOT write new entries of these kinds, and their stored details SHALL be shown as they were recorded.

#### Scenario: Log with an old connection change

- **WHEN** an administrator opens the activity log of an organization that changed a TEST contacts connection before the upgrade
- **THEN** that entry is listed with its label, actor, time and outcome

#### Scenario: No new retired entries

- **WHEN** any request is made after the upgrade
- **THEN** no new entry with a retired action is recorded

#### Scenario: Member reads retired entries

- **WHEN** a member requests the activity log
- **THEN** the system still answers `403 identity_forbidden`
