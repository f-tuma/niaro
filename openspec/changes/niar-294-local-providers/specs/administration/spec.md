# Spec Delta

## MODIFIED Requirements

### Requirement: Configuration bundle export

Owners and administrators SHALL export the organization or one workspace as JSON `niaro-config-bundle` v1 (`GET …/config-bundle/export`), one typed section per part: providers, models, search backends, the model policy, connectors, server settings, instructions, roles, services, routing, usage, plugins, skills, processes. It SHALL hold no keys, tokens, sign-ins or per-person grants; a provider or search backend that needs a key SHALL say `keyRequired: true`.

#### Scenario: Provider with a key

- **WHEN** an administrator exports a provider with a stored key
- **THEN** the file has its address with `keyRequired: true` and no key

#### Scenario: Search backend with a key

- **WHEN** an administrator exports a Brave search backend
- **THEN** the file has its kind and address with `keyRequired: true` and no key, and an import lists it as needing a key
