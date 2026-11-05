## ADDED Requirements

### Requirement: Configuration bundle export

Owners and administrators SHALL export the organization or one workspace as JSON `niaro-config-bundle` v1 (`GET …/config-bundle/export`), one typed section per part: providers, models, the model policy, connectors, server settings, instructions, roles, services, routing, usage, plugins, skills, processes. It SHALL hold no keys, tokens, sign-ins or per-person grants.

#### Scenario: Provider with a key

- **WHEN** an administrator exports a provider with a stored key
- **THEN** the file has its address with `keyRequired: true` and no key

### Requirement: Bundle references by name

A bundle SHALL name models by provider and model, services and actions by name and workspace roles by name, never by this server's ids. A section from a newer server SHALL be reported as `section_unknown` and skipped.

#### Scenario: Unknown section

- **WHEN** a bundle has a section this server does not know
- **THEN** the preview lists it as not imported and the rest still applies

### Requirement: Configuration import preview

`POST …/config-bundle/preview` SHALL apply the bundle in a rolled back transaction and return per section the added, changed, unchanged, not imported (with reason) and needs-key items and a `revision` digest of the current configuration. A preview SHALL change nothing.

#### Scenario: Fresh server

- **WHEN** an administrator previews a bundle on a server without providers
- **THEN** the providers are listed as added and as needing a key

### Requirement: Confirmed configuration import

`POST …/config-bundle/import` SHALL require the preview's `revision` (else 409 `config_bundle_conflict`), apply sections in one transaction, writing only what differs, and audit `config.bundle_imported` with counts. It SHALL never remove, overwrite a key, or send a stored key to a new address.

#### Scenario: Same bundle twice

- **WHEN** an administrator imports a bundle that was already imported
- **THEN** every item is unchanged and nothing is written

### Requirement: What an import creates

An import SHALL add missing roles without members, save processes only as drafts, add missing installed connectors after the commit and leave members' own services, personal skills and personal processes untouched. A one-workspace bundle SHALL go into the selected workspace; otherwise workspaces match by name.

#### Scenario: Process from a bundle

- **WHEN** a bundle with an active process is imported
- **THEN** the process arrives as a draft that must be tested and activated here

### Requirement: Configuration page

The console SHALL offer Configuration at `/admin/settings/configuration`, linked from Settings, with Export (organization or workspace), Import of a file, the preview per section and an import confirmation, in English and Czech.

#### Scenario: Import from the page

- **WHEN** an administrator chooses a bundle file
- **THEN** the page shows what changes and imports only after confirmation
