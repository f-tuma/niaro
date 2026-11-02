# Spec Delta

## MODIFIED Requirements

### Requirement: Browser consent chooses the workspace

On `/account/login` the person SHALL sign in to the server (password or a linked sign-in method) and choose one of their workspaces. Consent (`POST /admin/api/identity/app/consent`) SHALL require a browser session with access to that workspace and SHALL issue a one-use authorization code valid for one minute, returned with the original `state`. Native apps SHALL receive it through `niaro://auth`; a web app only on an origin allowed by the server's CORS configuration.

#### Scenario: Consent without workspace access

- **WHEN** a member consents for a workspace they cannot access
- **THEN** the system answers `403 identity_forbidden` and issues no code

#### Scenario: Expired login request

- **WHEN** consent is given after the login request expired or was already consented
- **THEN** the system answers `410 browser_login_expired`

#### Scenario: Native app receives the code

- **WHEN** a person consents for a sign-in that the phone app started
- **THEN** the page opens `niaro://auth` with the code and the original `state`, and the app exchanges it

#### Scenario: Old build with the former scheme

- **WHEN** an app build that only handles `agentclient://auth` starts a browser sign-in against an updated server
- **THEN** consent hands the code only to `niaro://auth`, the old build never exchanges it, and no device credential is issued for it
