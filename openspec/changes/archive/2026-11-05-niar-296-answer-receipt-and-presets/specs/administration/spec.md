## ADDED Requirements

### Requirement: Presets in the configuration bundle

The model policy and routing sections of a configuration bundle SHALL carry member presets as they are, since they name tiers and no models. A bundle without them SHALL leave presets off for the organization and inherited for a workspace.

#### Scenario: Workspace with presets

- **WHEN** an administrator exports a workspace that offers the preset Quick and imports it into a fresh server
- **THEN** the imported workspace offers Quick on the same tier
