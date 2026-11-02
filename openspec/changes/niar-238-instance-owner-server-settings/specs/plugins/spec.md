## MODIFIED Requirements

### Requirement: Plugin files in the console

The system SHALL let only an instance owner read a plugin's `plugin.json` and `index.ts` in administration and, while editing is enabled, check, save, reset an override to the built-in, delete an operator plugin and create one from a template. A save SHALL be staged and loaded first and take effect without restart only when it loads; a refused save SHALL change nothing and say why. Every save, refused save, reset, delete and creation SHALL be audited as `server.plugin_changed`.

#### Scenario: Administrator opens files

- **WHEN** an organization admin who is not an instance owner requests a plugin's files
- **THEN** the server answers 403 `instance_owner_required`

#### Scenario: Owner of another organization

- **WHEN** the owner of an organization other than the instance organization saves a plugin's `index.ts`
- **THEN** the server answers 403 `instance_owner_required`, the plugin keeps its code and the refusal is audited as denied in that organization

#### Scenario: Files offered only to instance owners

- **WHEN** an owner of a non-instance organization opens Built-in tools
- **THEN** no plugin offers its files for reading or editing
