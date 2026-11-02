## ADDED Requirements

### Requirement: Instance organization

The system SHALL record exactly one instance organization: the organization created by the owner setup, in the same transaction, whether the setup ran from an account or from a recovery session. A server that has organizations but no record SHALL record its earliest-created organization (ties by identifier) once. No console or API request SHALL change the record, and a backup SHALL carry it.

#### Scenario: Owner setup

- **WHEN** the first person completes the owner setup
- **THEN** the new organization is the instance organization

#### Scenario: Setup from the recovery console

- **WHEN** a recovery session runs the owner setup
- **THEN** the new organization is the instance organization and the recovery session ends as before

#### Scenario: Server from an earlier version with two organizations

- **WHEN** a server without a record starts with an organization created in March and another created in May
- **THEN** the March organization becomes the instance organization and stays so after later restarts

### Requirement: Instance owners

People with the organization role `owner` in the instance organization SHALL be the instance owners and the only people who manage what affects the whole server: server settings and plugin code. Administrators and members of the instance organization and every person of another organization SHALL be refused with 403 `instance_owner_required`; recovery sessions with `identity_account_required`.

#### Scenario: Owner of another organization

- **WHEN** the owner of an organization other than the instance organization requests the server settings
- **THEN** the server answers 403 `instance_owner_required` and returns no settings

#### Scenario: Administrator of the instance organization

- **WHEN** an administrator of the instance organization saves server settings
- **THEN** the server answers 403 `instance_owner_required` and nothing changes

#### Scenario: Ownership follows the role

- **WHEN** an instance owner promotes an administrator of the instance organization to owner
- **THEN** that person's next server settings request is allowed without signing in again

### Requirement: Instance owner in the identity state

`GET /admin/api/identity` SHALL report `instance.owner` (whether the signed-in person is an instance owner) and SHALL include the instance organization's identifier only for instance owners. A recovery session SHALL get `instance.owner: false`.

#### Scenario: Owner of another organization reads the state

- **WHEN** the owner of a non-instance organization reads the identity state
- **THEN** it reports `instance.owner: false` and no instance organization identifier
