## MODIFIED Requirements

### Requirement: Server information

`GET /v1/{workspace}/server` SHALL return `agent-server-info/3` for an authenticated session: `profile`, server `name`, the authenticated `scope`, `workflowProfile`, a fixed `componentCatalog` and `configuredServices` (`interpretation` of `model` or `disabled`; `voice`). It SHALL describe configuration only, never credentials, availability, permissions or approval. A workspace without an enabled model SHALL report `interpretation: "disabled"`.

#### Scenario: Model not selected

- **WHEN** the workspace has no enabled chat model
- **THEN** server information reports `interpretation: "disabled"`

#### Scenario: Unauthenticated request

- **WHEN** server information is requested without a valid bearer token
- **THEN** the system answers `401`

#### Scenario: No fixture services listed

- **WHEN** a member reads server information of any account workspace
- **THEN** `configuredServices` has no `contacts` or `calendar` entry and `componentCatalog` has no `input.choice`, `action.approval` or `crm.contacts`
