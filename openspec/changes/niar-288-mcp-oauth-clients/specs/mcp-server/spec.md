## MODIFIED Requirements

### Requirement: OAuth discovery

The system SHALL publish protected-resource metadata for `/mcp` at `/.well-known/oauth-protected-resource/mcp`, listing only MCP permissions as its scopes, and authorization-server metadata for the issuer `/admin/auth`. It SHALL issue opaque access tokens (prefix `agent_mcp_oauth_`, stored as hashes) only for the configured resource with exact audience. Dynamic client registration and machine grants SHALL be disabled.

#### Scenario: Dynamic registration refused

- **WHEN** a client tries to register itself through dynamic client registration
- **THEN** registration is refused

#### Scenario: Refresh is not a resource permission

- **WHEN** a client reads the protected-resource metadata of `/mcp`
- **THEN** its scopes list the MCP permissions and not `offline_access`

### Requirement: OAuth client registration

The system SHALL let a signed-in organization member register a public OAuth client (token endpoint authentication `none`) with a name and 1–5 callbacks, each HTTPS or plain HTTP on `localhost`, `127.0.0.1` or `[::1]`, on every server, and return its client ID. A loopback callback SHALL match any port at authorization; every other callback SHALL match exactly.

#### Scenario: Plain-HTTP callback

- **WHEN** a member registers a client with an `http://` callback on a host other than `localhost`, `127.0.0.1` or `[::1]`
- **THEN** registration fails with `mcp_oauth_redirect_invalid`

#### Scenario: Local app on a free port

- **WHEN** a production server has a client registered with `http://localhost/callback` and the client authorizes with `http://localhost:49152/callback`
- **THEN** the callback is accepted

### Requirement: OAuth authorization and consent

The system SHALL use the authorization-code grant with required PKCE `S256` and a signed authorization request. After sign-in, the person SHALL see the client's verified name, where it comes from (its `client_id` host, or registered manually on this server), their account, the requested permissions and how long the connection lasts, and SHALL explicitly choose the workspace and a subset of the requested permissions; nothing SHALL be selected automatically.

#### Scenario: Scope escalation

- **WHEN** a consent submission asks for a scope the client did not request
- **THEN** it is refused

#### Scenario: Plain code challenge

- **WHEN** an authorization request uses `code_challenge_method=plain`
- **THEN** it is refused

#### Scenario: Client known by its metadata document

- **WHEN** ChatGPT asks for access with the client ID `https://chatgpt.com/oauth/client.json`
- **THEN** the consent page shows the name from that document and `chatgpt.com`

#### Scenario: Client registered by an administrator

- **WHEN** a client registered on this server asks for access
- **THEN** the consent page shows its registered name and that it was registered manually

### Requirement: OAuth access lifetime

OAuth access tokens SHALL last at most one hour. A client that requested `offline_access` SHALL also receive a refresh token, stored only as a hash and replaced on every use; a refresh token used a second time SHALL end the whole chain with `invalid_grant`. No token SHALL outlive its grant, which lasts at most 30 days from consent; after that the client must link again.

#### Scenario: Refresh

- **WHEN** a client uses its refresh token before the grant ends
- **THEN** it receives a new access token for at most one hour and a new refresh token, and the used refresh token stops working

#### Scenario: Reused refresh token

- **WHEN** a refresh token that was already used is presented again
- **THEN** the request fails with `invalid_grant` and the newest refresh and access tokens of that chain stop working too

#### Scenario: Grant cap

- **WHEN** a client keeps refreshing for more than 30 days after consent
- **THEN** its tokens expire with the grant and the person must approve the client again

#### Scenario: Browser logout

- **WHEN** the person signs out of the browser session used to grant OAuth access
- **THEN** the client's access and refresh tokens keep working and admitted work continues

### Requirement: Grant revocation

The system SHALL let a person revoke each of their grants (idempotently) and list their active grants across workspaces on their account page. A password reset, a password change and signing out everywhere SHALL revoke every MCP grant of the person, manual and OAuth. Manual and OAuth grants SHALL otherwise be independent of browser logout.

#### Scenario: Password change

- **WHEN** a person changes their password
- **THEN** all their MCP tokens stop working

## ADDED Requirements

### Requirement: OAuth server capabilities

The authorization-server metadata SHALL advertise `client_id_metadata_document_supported: true`, the `authorization_code` and `refresh_token` grants, the token endpoint authentication methods `none` and `private_key_jwt`, PKCE `S256`, the `iss` authorization response parameter and `offline_access` among its scopes, so that Claude, Claude Code and ChatGPT can connect without a manually registered client.

#### Scenario: Claude discovers the server

- **WHEN** an MCP client reads the authorization-server metadata
- **THEN** it finds client metadata document support, the refresh grant and `offline_access`, and no registration endpoint

### Requirement: OAuth client metadata documents

A client MAY use an HTTPS URL as its `client_id`. The system SHALL then fetch that client metadata document from a public host (DNS resolved once and pinned, no redirects, at most 5 KB, within fetch budgets), require that it names the same `client_id`, a client name and its callbacks, and accept only those callbacks. A document SHALL be reused for at most 6 hours. Such a client SHALL authenticate with `none` or `private_key_jwt`.

#### Scenario: Private address

- **WHEN** a `client_id` URL points to a loopback or private address
- **THEN** the authorization is refused without fetching it

#### Scenario: Undeclared callback

- **WHEN** a metadata-document client authorizes with a callback its document does not list
- **THEN** no consent page is shown

#### Scenario: Signed token requests

- **WHEN** a client whose document declares `private_key_jwt` and a key set on its own origin exchanges a code or refreshes
- **THEN** the request succeeds only with an assertion signed by one of those keys

### Requirement: OAuth consent acceptance

Accepting consent SHALL require the real browser origin, a current session and an accessible workspace, and SHALL create a grant of at most 30 days that is not bound to that browser session. `offline_access` SHALL never be a permission the person ticks; it is granted only when the client asked for it, and the consent page then says the connection lasts up to 30 days.

#### Scenario: Staying connected

- **WHEN** a client asks for `services.call offline_access`
- **THEN** the person chooses only between the MCP permissions and sees that the connection lasts up to 30 days

### Requirement: OAuth refresh revalidation

Every refresh SHALL revalidate the grant as an MCP request does (unexpired and unrevoked, server, original membership, workspace access) together with its client and resource, and SHALL answer `invalid_grant` when any check fails. Work admitted through an OAuth grant SHALL continue while the grant holds a live access or refresh token.

#### Scenario: Removed member refreshes

- **WHEN** a member is removed after linking a client and the client refreshes
- **THEN** the refresh fails with `invalid_grant`

#### Scenario: Client disabled

- **WHEN** an administrator disables an OAuth client and the client refreshes
- **THEN** the refresh fails with `invalid_grant`
