# service-sign-in Specification

## Purpose

Defines how Niaro calls a company service either with a shared credential set by administrators or under each person's own account through OAuth, how those personal sign-ins are made, kept alive and invalidated, and who decides what the assistant may do under them.

## Requirements

### Requirement: Sign-in requirement per service

Administrators SHALL set for each service when it needs the person's own account: never (shared credential), for changes (`writes`) or for every action (`all`). An action needing personal sign-in SHALL run only with that person's own connection and SHALL never fall back to the shared credential. Without a usable connection the request SHALL answer with a sign-in prompt (`service_oauth_connection_required`, or `service_oauth_reconnect_required` when expired) instead of running.

#### Scenario: Read on a service that needs sign-in for changes

- **WHEN** a person runs a read action of a service set to `writes`
- **THEN** the action runs with the shared credential

#### Scenario: Change without a connection

- **WHEN** a person without a connection runs a change on a service set to `writes`
- **THEN** the action does not run and the person is asked to sign in to the service

### Requirement: Shared credential use

An action that does not need personal sign-in SHALL run with the service's shared credential under the administrator's access gate and action grants (see `service-catalog`). The service SHALL see the shared service identity, while the activity log SHALL keep the person who started the action.

#### Scenario: Shared change

- **WHEN** a member runs a granted change on a service set to never
- **THEN** the service receives the shared credential and the activity log names that member

### Requirement: Sign-in sources

A service needing personal sign-in SHALL take OAuth endpoints and client from either an organization sign-in method of kind Microsoft or Google (its app registration reused; `openid`, `profile` and for Microsoft `offline_access` added to the configured permissions) or the service's own OAuth (issuer on the service origin or named by its RFC 9728 metadata). GitHub methods SHALL be refused as a source. The service SHALL receive only the person's access token.

#### Scenario: GitHub method chosen

- **WHEN** an administrator selects a GitHub sign-in method as a service's sign-in source
- **THEN** the system refuses with `service_oauth_provider_unsupported`

#### Scenario: Loopback MCP server behind Microsoft

- **WHEN** a hosted MCP server signs in through the organization's Microsoft method
- **THEN** each request to it carries only the person's Microsoft access token

### Requirement: Service OAuth configuration

Owners and administrators SHALL configure a service's own OAuth (`…/catalog/oauth/discover`, `register`, `save`, revision-checked). The service, its authorization server and its endpoints SHALL use HTTPS, and the authorization, token and registration endpoints SHALL share the issuer's origin. Registration SHALL ask for a confidential client; a server issuing no secret SHALL be kept as a public client using PKCE alone. Client secrets SHALL never be returned.

#### Scenario: Plain HTTP service

- **WHEN** OAuth discovery is run for a service address that is not HTTPS
- **THEN** the system refuses with `service_oauth_https_required`

#### Scenario: Member tries to configure

- **WHEN** a member calls `save`, `discover` or `register`
- **THEN** the system answers `403 identity_forbidden`

### Requirement: Automatic OAuth detection for MCP services

When an MCP service is added or its address changes, the system SHALL look for its OAuth in the background (protected-resource metadata, then the named authorization server or the service origin; HTTPS only; time-bounded). If metadata is found and personal sign-in is not set up yet, the service SHALL be set to sign-in for every action through its own OAuth with the advertised permissions, and the system SHALL register itself as a client when the metadata has a registration endpoint.

#### Scenario: OAuth found on add

- **WHEN** an administrator adds an MCP service whose address publishes OAuth metadata with a registration endpoint
- **THEN** the service needs personal sign-in for every action, Niaro is registered as its client, and the add result says so

#### Scenario: No OAuth

- **WHEN** the service publishes no OAuth metadata
- **THEN** the service keeps its settings and the last probe records `none`

### Requirement: Limits of automatic OAuth detection

Detection SHALL keep existing clients, metadata and administrator settings, SHALL register at no origin other than the service's or the one its metadata names, and SHALL leave services using a sign-in method and OpenAPI services alone. Failures SHALL be silent but recorded as the last probe (`configured`, `metadata` or `none` with a reason) and audited as `catalog.service_changed`. `POST …/catalog/oauth/auto` SHALL re-run it for administrators, joining a probe already running.

#### Scenario: Administrator settings exist

- **WHEN** an administrator already set up a client for the service and its address is probed again
- **THEN** the client and settings stay as they were

#### Scenario: Member re-runs the probe

- **WHEN** a member calls `…/catalog/oauth/auto`
- **THEN** the system answers `403 identity_forbidden`

### Requirement: Access gate under personal sign-in

When detection switches a service to personal sign-in and its access gate was never set, the gate SHALL become an explicit gate for owners, administrators and members. A gate an administrator narrowed SHALL stay as set, and the console SHALL say whom it lets in.

#### Scenario: Gate never set

- **WHEN** detection enables personal sign-in on a service without an access gate
- **THEN** owners, administrators and members may connect to it

### Requirement: Personal sign-in from the app

The mobile app SHALL start a personal sign-in with `POST /v1/{workspace}/services/start`, follow it with `status` and `cancel`, and open `/admin/service-connect#…` in the system browser. The browser SHALL sign in to the server as the same person (linking the sign-in method first when needed) before redirecting to the provider. After consent the page SHALL exchange the code once and return through `agentclient://service-connected`. Only the owner SHALL sign in to an own service.

#### Scenario: Different person in the browser

- **WHEN** the browser is signed in to the server as someone other than the app's person
- **THEN** the sign-in attempt is refused and no connection is stored

#### Scenario: Someone else's own service

- **WHEN** a person starts a sign-in for a service another person added for themselves
- **THEN** the system answers `404 catalog_not_found`

### Requirement: Sign-in attempts

Each sign-in attempt SHALL use PKCE (S256) and a single-use state, SHALL expire after ten minutes and SHALL be bound to the starting person, session, service configuration revision and connection revision. A person SHALL have at most 10 pending attempts. A callback whose state, issuer, person, configuration or connection no longer matches SHALL be refused.

#### Scenario: Configuration changed during sign-in

- **WHEN** an administrator changes the service's sign-in settings while a person is at the provider's consent screen
- **THEN** finishing that sign-in is refused with `service_oauth_conflict`

#### Scenario: Too many attempts

- **WHEN** a person starts an eleventh pending attempt
- **THEN** the system answers `429 service_oauth_pending_limit`

### Requirement: Account binding

For a sign-in method source the system SHALL request `openid` and SHALL store tokens only when the ID token from the token endpoint matches issuer, tenant, audience, expiry and nonce and names the account the person linked to that sign-in method (`oid` for Microsoft, `sub` for Google). For a service's own OAuth whose tokens carry no account claims, the connection itself SHALL be the account, with its own subject kept across refreshes. A refresh SHALL return the same account.

#### Scenario: Forwarded consent link

- **WHEN** a consent link is completed with a Microsoft account other than the one the person linked
- **THEN** the system refuses with `403 service_oauth_account_mismatch` and stores nothing

### Requirement: Own services that sign in

An own MCP service added without a key (see `service-catalog`) SHALL sign in through OAuth metadata found per RFC 9728 and RFC 8414 (with their defaults for omitted fields) and a dynamically registered public client, requesting no scope so the service grants its default. Only the owner SHALL sign in, and the service's tools SHALL be read with the owner's token right after.

#### Scenario: Owner signs in

- **WHEN** the owner of a keyless own service finishes signing in
- **THEN** the authorization request carried no scope and the service's tools are read with the owner's token

#### Scenario: Server without dynamic registration

- **WHEN** a person adds an own service whose OAuth metadata has no registration endpoint
- **THEN** the system answers `422 catalog_personal_unreachable` and keeps nothing

### Requirement: Token custody

Personal tokens SHALL be encrypted per workspace, service and person and SHALL never be returned by any API or leave the server except in requests to that service. Server sign-in to Niaro (see `identity-access`) SHALL NOT yield service access; service access SHALL come only from this separate consent.

#### Scenario: Status request

- **WHEN** a person reads the status of their connection
- **THEN** the response contains the account and expiry but no token

### Requirement: Invalidation on configuration change

Changing a service's address, its sign-in source, the sign-in method or the requested permissions SHALL disconnect existing personal connections and end pending sign-ins. An operation approved under one account SHALL be pinned to that account and connection revision and SHALL never run under another account or the shared credential.

#### Scenario: Service address changed

- **WHEN** an administrator changes the service URL
- **THEN** every person's connection to it shows as not connected and must be made again

#### Scenario: Reconnected as another account

- **WHEN** a person reconnects with a different account after approving a change
- **THEN** the pinned operation is refused instead of running under the new account

### Requirement: Token renewal before use

The system SHALL renew a personal access token that lapses within five minutes before dispatching a request that needs it. Renewal SHALL keep the connection revision so pinned approvals stay valid, and SHALL run once per connection at a time; concurrent requests SHALL wait for it. A stale renewal SHALL never overwrite a newer grant.

#### Scenario: Two requests at once

- **WHEN** two requests need the same lapsing connection at the same time
- **THEN** one refresh is sent to the provider and both requests use its result

### Requirement: Background renewal

The system SHALL renew, in the background, personal tokens that lapse within 30 minutes and have a refresh token, each connection at most once every 6 hours, checking every 15 minutes and once a minute after the server starts.

#### Scenario: Unused connection

- **WHEN** a person does not use a Microsoft connection for several days
- **THEN** its tokens are still renewed in the background so the refresh token does not run out

### Requirement: Connection state and lifetime

A connection whose access token lapsed but which holds a refresh token SHALL be shown as connected. A connection without a refresh token SHALL be shown as expired once its token lapses. A token without a stated lifetime SHALL be used for at most 30 days. Only the provider's explicit refusal of a refresh (`invalid_grant`) SHALL disconnect the person; an outage SHALL leave the connection for the next attempt.

#### Scenario: Refresh revoked by the provider

- **WHEN** the provider answers a refresh with `invalid_grant`
- **THEN** the connection is disconnected and the next request asks the person to sign in

#### Scenario: Provider outage

- **WHEN** a refresh fails because the provider cannot be reached
- **THEN** the connection is kept

### Requirement: Disconnecting

A person SHALL disconnect their own connection (`…/catalog/oauth/disconnect` with the current `connectionRevision`). Disconnecting SHALL drop the stored tokens and pending attempts and SHALL keep the person's action choices, so reconnecting restores them.

#### Scenario: Stale disconnect

- **WHEN** a disconnect carries an outdated connection revision
- **THEN** the system answers `409 service_oauth_conflict`

### Requirement: Who manages the assistant's permissions

Actions run under the person's own account SHALL be managed by that person, others by administrators: never: administrators manage every action; `writes`: administrators manage reads, the person changes; `all`: the person manages reads (on/off) and changes (on/off, approval). Administrators SHALL still decide who may connect through the access gate, and an action they switch off SHALL be unavailable to everyone. Their per-action roles, overrides and approval do not apply there.

#### Scenario: Administrator switches an action off

- **WHEN** an administrator disables an action of a personal sign-in service
- **THEN** it disappears from every person's list regardless of their own choices

#### Scenario: Person outside the gate

- **WHEN** a person's roles do not pass the service's access gate
- **THEN** they cannot connect to the service or use its actions

### Requirement: Person's own choices

A person SHALL read and save their choices for a service they may connect to through `POST /admin/api/identity/catalog/oauth/permissions` and `…/oauth/permissions/save`. Until they choose, reads SHALL be on and changes on but confirmed one by one; reads SHALL never wait for approval. Saving SHALL be audited as `catalog.personal_policy_changed` without advancing the organization's policy epoch; waiting approvals and running work SHALL check the current choice before dispatch.

#### Scenario: Defaults

- **WHEN** a person has made no choices for a service
- **THEN** its reads run without asking and each change waits for their approval

### Requirement: Saving personal choices

Saving choices SHALL be revision-checked per person and service. A repeated save already in place SHALL succeed; a different change from a stale revision SHALL answer `409 personal_policy_conflict`. Disconnecting SHALL keep the choices; removing an action or the service SHALL forget everyone's choices for it.

#### Scenario: Stale save

- **WHEN** a person saves a different change with an outdated revision
- **THEN** the system answers `409 personal_policy_conflict`

#### Scenario: Service the person may not connect to

- **WHEN** a person requests choices for a service outside their access gate
- **THEN** the system answers `404`

#### Scenario: Action switched off after approval

- **WHEN** a person switches off an action while one of its changes waits for dispatch
- **THEN** that change is refused at dispatch

### Requirement: Don't ask next time

For the person's own waiting change on a person-managed action set to always ask, `…/oauth/approval` SHALL report it as rememberable and `…/oauth/approval/remember` SHALL set that action to don't ask for this person only, audited as `catalog.personal_policy_changed`.

#### Scenario: Remembering a rejected change

- **WHEN** a person asks to remember a change that was already rejected
- **THEN** the system answers `409 personal_policy_unavailable`

### Requirement: Where personal choices apply

The person's choices SHALL limit the actions offered to their chat, `@` mentions and the MCP connector to those left on, and SHALL set the approval a new operation waits for. Process design, personal and workspace process runs and unattended Overview refreshes SHALL honor the same choices (see `process-design`, `process-execution` and `hub`).

#### Scenario: Action switched off

- **WHEN** a person switches an action off
- **THEN** their chat and MCP connector no longer offer it

### Requirement: Connections screen

The web app's Connections screen SHALL list the services acting under the person's own account in the current workspace (`…/catalog/oauth/list`), each with state (connected, expired, not connected, not set up), account, what signing in unlocks and sign-in method, with connect and disconnect. A service's page SHALL list reads and changes apart, each with a switch, and changes with Always ask or Don't ask. A sign-in opens the provider in another tab; the list waits up to ten minutes.

#### Scenario: Connected service

- **WHEN** a person opens Connections after signing in to a service
- **THEN** the service shows as connected with the account name

#### Scenario: Service not set up

- **WHEN** a service needs personal sign-in but its OAuth is not complete
- **THEN** the service shows as not set up and cannot be connected
