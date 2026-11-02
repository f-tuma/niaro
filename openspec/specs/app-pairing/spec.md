# app-pairing Specification

## Purpose

Defines how the mobile app and the web app obtain a workspace-scoped credential for a Niaro server through browser sign-in, and how renewable device sessions are kept, recovered, limited and revoked.

## Requirements

### Requirement: Sign-in with only the server address

The app SHALL ask the person only for the server address and SHALL sign in through the server's browser login. `POST /v1/auth/app/start` with an S256 PKCE `challenge` and a `state` SHALL return an `authorizationUrl` on the same origin with path `/account/login`. A login request SHALL expire after five minutes; at most 512 may be pending server-wide. No pairing code SHALL be shown to or typed by the person.

#### Scenario: Starting sign-in

- **WHEN** the person enters a server address and chooses to continue with the browser
- **THEN** the app starts a login request and opens `/account/login` on that server

#### Scenario: Foreign authorization URL

- **WHEN** the start response names a different origin or path
- **THEN** the app abandons the sign-in with `connection_failed`

### Requirement: Browser consent chooses the workspace

On `/account/login` the person SHALL sign in to the server (password or a linked sign-in method) and choose one of their workspaces. Consent (`POST /admin/api/identity/app/consent`) SHALL require a browser session with access to that workspace and SHALL issue a one-use authorization code valid for one minute, returned with the original `state`. Native apps SHALL receive it through `agentclient://auth`; a web app only on an origin allowed by the server's CORS configuration.

#### Scenario: Consent without workspace access

- **WHEN** a member consents for a workspace they cannot access
- **THEN** the system answers `403 identity_forbidden` and issues no code

#### Scenario: Expired login request

- **WHEN** consent is given after the login request expired or was already consented
- **THEN** the system answers `410 browser_login_expired`

### Requirement: Code exchange issues a device credential

`POST /v1/auth/app/exchange` with `code`, `verifier` and `state` SHALL issue a renewable device credential for the consented account and workspace and its workspace address `<origin>/v1/<workspaceId>`. The exchange SHALL succeed once, only when the verifier matches the challenge, the state matches, and the consenting browser session is still valid; otherwise it SHALL answer `403 app_login_invalid`. Membership and workspace access SHALL be checked again at exchange.

#### Scenario: Replayed code

- **WHEN** an authorization code is exchanged a second time
- **THEN** the system answers `403 app_login_invalid`

#### Scenario: Wrong verifier

- **WHEN** the exchange carries a verifier that does not match the challenge
- **THEN** the system answers `403 app_login_invalid` and issues nothing

#### Scenario: Browser signed out before exchange

- **WHEN** the consenting browser session ended before the app exchanges the code
- **THEN** the system answers `403 app_login_invalid`

### Requirement: Switching keeps the current session until the new one is stored

When a signed-in app signs in again (for example to switch workspace), the current session SHALL keep working until the new credential has been exchanged, validated for its scope and stored; only then SHALL the old credential be revoked. A cancelled or failed attempt SHALL leave the person signed in as before.

#### Scenario: Cancelled switch

- **WHEN** the person cancels the browser sign-in while switching workspace
- **THEN** the app stays connected to the previous workspace

#### Scenario: Credential for another scope

- **WHEN** the exchange returns an address that does not match the issued credential's workspace
- **THEN** the app rejects it with `auth_scope_mismatch`, revokes the issued credential and keeps the previous session

### Requirement: Device slot limit

A person SHALL hold at most 8 app device sessions across all workspaces, and the server at most 512 in total. Web app chat credentials SHALL NOT use a device slot. When the person's slots are full, consent and exchange SHALL answer `409 mobile_device_limit`, which the sign-in page and the apps SHALL present as an instruction to remove a device in the account page.

#### Scenario: Ninth device

- **WHEN** a person with 8 device sessions consents to a new app sign-in
- **THEN** the system answers `409 mobile_device_limit` and the page tells them to remove a device

### Requirement: Renewable device credential

A device credential (`agent-device-session/1`) SHALL contain an access token valid for the configured `sessionSeconds` (30–3600 seconds), a scope of server, connection `account-<workspaceId>`, workspace and user, and a `refresh` part with its own token and idle expiry. Only digests of tokens SHALL be stored. A device session SHALL expire after the configured idle period (1–90 days, default 30) without renewal. A device session never used within five minutes of issue SHALL be discarded.

#### Scenario: Idle device

- **WHEN** a device does not renew for longer than the idle period
- **THEN** its refresh token answers `401 auth_expired` and the person signs in again

#### Scenario: Abandoned enrollment

- **WHEN** an issued credential is never used within five minutes
- **THEN** it stops working and frees its slot

### Requirement: Renewal rotates both secrets

`POST /v1/{workspace}/auth/refresh` with `{ profile, refreshToken, requestId }` SHALL authenticate the refresh token (not the access token), recheck membership and workspace access, and return a credential with new access and refresh tokens and a renewed idle expiry. The previous access token SHALL remain valid for at most one minute after rotation. Renewal SHALL NOT refresh external service tokens.

#### Scenario: Normal renewal

- **WHEN** the app renews with its current refresh token
- **THEN** it receives new access and refresh tokens and the idle deadline moves forward

#### Scenario: Membership removed

- **WHEN** a device renews after its person lost access to the workspace
- **THEN** the system answers `403 auth_scope_mismatch`

### Requirement: Interrupted renewal is recoverable

The app SHALL save the renewal `requestId` together with its old credential before sending the request. Repeating the last consumed refresh token with the same `requestId` SHALL return the same rotated credential without extending either expiry. Any other reuse of a consumed refresh token SHALL answer `401 auth_expired`. Renewal SHALL be single-flight in the app and SHALL never replay business commands.

#### Scenario: Response lost

- **WHEN** the app closes after sending a renewal and reopens with the saved `requestId`
- **THEN** repeating the request returns the credential of that rotation

#### Scenario: Conflicting retry

- **WHEN** a consumed refresh token is sent with a different `requestId`
- **THEN** the system answers `401 auth_expired`

### Requirement: Access is rechecked on every request

Every app request SHALL be authenticated by its bearer token and checked against the device's server, workspace and the person's current membership, role and workspace access. In-flight model, tool and service sign-in checks SHALL use the device's stable identity so that normal token rotation does not change the initiating person. Device sessions SHALL survive browser sign-out and server restarts.

#### Scenario: Browser sign-out

- **WHEN** the person signs out of the browser used to consent
- **THEN** the app's device session keeps working

#### Scenario: Wrong workspace in the path

- **WHEN** a credential is used on another workspace's path
- **THEN** the system answers `403 auth_scope_mismatch`

### Requirement: Device sign-out and revocation

`GET /v1/{workspace}/auth/session` SHALL return the public identity of the current access token. `DELETE /v1/{workspace}/auth/session` SHALL revoke the device by its access token; `DELETE /v1/{workspace}/auth/refresh` with `{ profile, refreshToken }` SHALL revoke it even after access expired, also with the last consumed refresh token. Signing out in the app SHALL hide local data and delete the stored credential. Devices are also revoked from the account page (see `identity-access`).

#### Scenario: Revoking with an expired access token

- **WHEN** the app signs out after its access token expired
- **THEN** revoking through the refresh token ends the device session

### Requirement: App credential handling

The native app SHALL keep its server address and credential in the platform secure store. An authoritative rejection (`401`/`403` on authentication or renewal) SHALL stop the session, clear the stored credential and show the person as signed out or expired; a transport failure SHALL keep the stored credential. Switching accounts SHALL stop the old session and ignore its late results.

#### Scenario: Server unreachable

- **WHEN** a renewal fails because the server cannot be reached
- **THEN** the app keeps its credential and retries later

#### Scenario: Session refused

- **WHEN** the server refuses the refresh token
- **THEN** the app clears the credential and shows that the session expired

### Requirement: Web app chat credential

The web app SHALL obtain its chat credential from the existing browser session (`POST /admin/api/identity/app/session` with organization and workspace) without a separate sign-in. The credential SHALL expire no later than the browser session and SHALL end when that session ends. Each browser session SHALL keep at most 12 such credentials and each person at most 32, the oldest replaced first; they SHALL NOT count toward device slots or the server-wide app limit.

#### Scenario: Browser signed out

- **WHEN** the person signs out of the browser
- **THEN** the web app's chat credentials of that browser stop working

#### Scenario: Many tabs

- **WHEN** a person opens more tabs than the per-browser bound for one workspace
- **THEN** the oldest credentials are replaced and no device slot is used

### Requirement: Server information

`GET /v1/{workspace}/server` SHALL return `agent-server-info/2` for an authenticated session: `profile`, server `name`, the authenticated `scope`, `workflowProfile`, a fixed `componentCatalog` and `configuredServices` (`interpretation` of `model`, `disabled` or `demo-phrases`; `voice`; `contacts`; `calendar`). It SHALL describe configuration only, never credentials, availability, permissions or approval. A workspace without an enabled model SHALL report `interpretation: "disabled"`.

#### Scenario: Model not selected

- **WHEN** the workspace has no enabled chat model
- **THEN** server information reports `interpretation: "disabled"`

#### Scenario: Unauthenticated request

- **WHEN** server information is requested without a valid bearer token
- **THEN** the system answers `401`

### Requirement: Legacy enrollment endpoints

The server SHALL still accept two older enrollment paths that current apps do not offer: a one-use pairing code (`POST /admin/api/identity/mobile/pairing`, redeemed at `POST /v1/{workspace}/auth/pair`, five minutes, a new code replacing the previous one) and device-code browser login (`POST /v1/auth/browser/start|poll|cancel`, five minutes). With `?session=agent-device-session/1` both SHALL issue a renewable device credential, under the same slot limit and membership checks.

#### Scenario: Reused pairing code

- **WHEN** a pairing code is redeemed a second time
- **THEN** the system answers `401 pairing_invalid`

#### Scenario: Device-code login polled too fast

- **WHEN** a device-code login is polled faster than its interval
- **THEN** the system answers `429 browser_login_slow_down`
