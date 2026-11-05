## MODIFIED Requirements

### Requirement: Configuration bundle export

Owners and administrators SHALL export the organization or one workspace as JSON `niaro-config-bundle` v1 (`GET …/config-bundle/export`), one typed section per part: providers, models, search backends, the model policy, connectors, server settings, instructions, roles, services, routing, usage, plugins, skills, knowledge, processes. It SHALL hold no keys, tokens, sign-ins or per-person grants; a provider or search backend that needs a key SHALL say `keyRequired: true`.

#### Scenario: Provider with a key

- **WHEN** an administrator exports a provider with a stored key
- **THEN** the file has its address with `keyRequired: true` and no key

#### Scenario: Search backend with a key

- **WHEN** an administrator exports a Brave search backend
- **THEN** the file has its kind and address with `keyRequired: true` and no key, and an import lists it as needing a key

## ADDED Requirements

### Requirement: Knowledge settings sheet

Owners and administrators SHALL open a workspace's Knowledge sheet from the Workspaces page: the index status, **Rebuild index** (disabled while a pass runs), whether files are indexed, the source candidates to pick and the passage length (300–4,000) and overlap (under half the length). Saves SHALL be revision-checked (409 `knowledge_conflict`); members SHALL get 403.

#### Scenario: Picking a source

- **WHEN** an administrator ticks "List procedures" of the Wiki and saves
- **THEN** the sheet closes, a pass indexes that action and the status shows its passages

#### Scenario: Member asks for the settings

- **WHEN** a member requests the knowledge settings of their workspace
- **THEN** the server answers 403

### Requirement: Knowledge in the configuration bundle

A workspace bundle SHALL carry a `knowledge` section with whether files are indexed, the passage settings and the sources by service and action name, never passages, vectors or status. An import SHALL accept only sources that are candidates on the target server, refuse a missing one as `reference_missing` and update the index after the commit.

#### Scenario: Import to a new server

- **WHEN** an administrator imports a bundle whose knowledge picks "TEST Wiki · List procedures" into a server with that service
- **THEN** the source is picked there and the new server builds its own index
