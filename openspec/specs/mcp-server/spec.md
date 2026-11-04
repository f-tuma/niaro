# mcp-server Specification

## Purpose

Niaro exposes one MCP endpoint so a person can use their workspace from their own AI app (for example Claude or ChatGPT). MCP is a router: the app's model does the thinking, while Niaro supplies the person's own data (meetings, tasks, chats, memory), saves memory about them and runs the workspace's permitted service actions with approval and audit. Niaro's own agent takes no work over MCP. Access is a personal grant bound to one account membership and workspace.

## Requirements

### Requirement: One MCP endpoint

The system SHALL serve MCP at `/mcp` over Streamable HTTP, stateless at the transport layer, with request bodies of at most 64 KiB. The tools listed SHALL depend on the grant's scopes: `data.read` gives `niaro_search`, `niaro_meeting_get`, `niaro_tasks_list` and `niaro_memory_list`; `memory.write` gives `niaro_memory_save`; `services.call` gives one tool per permitted service action plus `niaro_call_status`. A tool outside the grant's scopes SHALL be refused.

#### Scenario: Connector grant

- **WHEN** a client with a `services.call`-only grant calls `tools/list`
- **THEN** it receives the permitted action tools and `niaro_call_status` and no Niaro data tools

#### Scenario: Data grant

- **WHEN** a client with a `data.read`-only grant calls `niaro_memory_save`
- **THEN** the call fails with `insufficient_scope` and nothing is saved

### Requirement: Dedicated bearer credential

The system SHALL require a dedicated MCP credential in the `Authorization: Bearer` header on every request. Browser sessions, mobile device credentials and recovery keys SHALL NOT be accepted, and MCP credentials SHALL NOT authenticate any other API. An unauthenticated request SHALL be answered with 401 and a challenge pointing to the protected-resource metadata and naming the scopes `data.read memory.write services.call`.

#### Scenario: Mobile token on MCP

- **WHEN** a request to `/mcp` carries a mobile device token
- **THEN** it is refused with 401

### Requirement: Manual access grants

The system SHALL let a person issue, from a live browser session only, a grant for one of their workspaces with a label, scopes from `data.read`, `memory.write`, `services.call`, and an expiry of at most 30 days; the user SHALL come from the session, never from input. The token (prefix `agent_mcp_`, 256 random bits) SHALL be shown once and only its digest stored. A person SHALL hold at most 50 active grants per server. No scope SHALL permit approving an action.

#### Scenario: Token shown once

- **WHEN** a person issues a grant and later lists their grants
- **THEN** the listing shows label, scopes and expiry but no token

#### Scenario: Grant limit

- **WHEN** a person with 50 active grants on the server issues another
- **THEN** issuance is refused

#### Scenario: Retired scope

- **WHEN** a person issues a grant with the scope `native.run`
- **THEN** issuance is refused as invalid

### Requirement: Grant revalidation

The system SHALL check on every MCP call, and again inside every write or save it starts, that the grant is unexpired and unrevoked, bound to this server and workspace, that the original organization membership still exists and that the person still has access to the workspace with their current role. Removing a member SHALL delete their grants; rejoining SHALL NOT restore them.

#### Scenario: Removed from the workspace

- **WHEN** a person loses access to the workspace after issuing a grant
- **THEN** further MCP requests with that grant are refused and nothing more is read or saved for it

### Requirement: Grant revocation

The system SHALL let a person revoke each of their grants (idempotently) and list their active grants across workspaces on their account page. A password reset, a password change and signing out everywhere SHALL revoke every MCP grant of the person, manual and OAuth. Manual and OAuth grants SHALL otherwise be independent of browser logout.

#### Scenario: Password change

- **WHEN** a person changes their password
- **THEN** all their MCP tokens stop working

### Requirement: Connector tools

The system SHALL compute the connector tools per request from the current catalog and the person's permissions: every enabled action of every enabled service the person may run, named `<service>__<action>`, with the action's input schema, a description saying whether it reads or changes data and whether a person must approve it, and `readOnlyHint`/`destructiveHint` from its effect. A write's schema SHALL add an optional `requestId` unless the service names a field so.

#### Scenario: Revoked action disappears

- **WHEN** an administrator removes a person's grant on an action
- **THEN** the next `tools/list` for that person no longer lists it

#### Scenario: Idempotency key offered on writes only

- **WHEN** a connector client lists tools with one read and one write action
- **THEN** only the write's schema has an optional `requestId` described as the value to reuse when retrying after a lost response

### Requirement: Connector calls use the catalog path

Each connector `tools/call` SHALL run through the same path as console and chat calls in the `service-catalog`: fresh grant and membership checks, the person's own service sign-in where required, argument validation, the dispatch guard, a durable receipt and an audit entry with source `mcp`. Results of MCP-backed services SHALL be returned unwrapped. A validation failure SHALL name each wrong field and what it expects; a missing personal service connection SHALL say so.

#### Scenario: Personal sign-in missing

- **WHEN** a client calls an action of a service that requires the person's own account and the person has not connected it
- **THEN** the call fails stating that the person's service connection is required

#### Scenario: Missing field

- **WHEN** a client calls an action without its required field `name`
- **THEN** the call fails with `integration_input_invalid` naming `/name` as missing and nothing is dispatched

### Requirement: Connector approvals

An action configured to require approval SHALL NOT run on the client's request alone: the call SHALL return `status: "awaiting_approval"`, a `requestId` and an `approvalUrl` in Niaro (`/admin/mcp?approval=…`), where only the person who owns the grant approves or declines it. `niaro_call_status` with the `requestId` SHALL return `awaiting_approval`, `running`, `succeeded` with the result, `rejected`, `unknown` (check the data before retrying) or a failure.

#### Scenario: Write waits for the person

- **WHEN** a client calls a write action whose approval is `always`
- **THEN** the response is `awaiting_approval` with an approval URL and nothing is sent to the service

#### Scenario: Declined

- **WHEN** the person declines the call in Niaro
- **THEN** `niaro_call_status` returns `rejected`

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
- **THEN** the client's access and refresh tokens keep working

### Requirement: Idempotent connector calls

A write's `requestId` SHALL be removed before validation against the action's schema. The same grant, key and input SHALL return the first call's receipt and never dispatch again; the same key with another tool or input SHALL fail with `mcp_request_id_conflict`. Results SHALL carry the client's key as `requestId`, and `niaro_call_status` SHALL accept it. A call without a key SHALL get a new receipt.

#### Scenario: Retry after a lost response

- **WHEN** a client repeats a write with the same `requestId` and input after its response was lost
- **THEN** it receives the same receipt and the service runs the action at most once

#### Scenario: Key reused for other input

- **WHEN** a client sends the same `requestId` with different input
- **THEN** the call fails with `mcp_request_id_conflict` and no receipt is created

### Requirement: Niaro data tools

With `data.read`, `niaro_search` SHALL search the person's meetings, tasks, chats and memory (optional `kinds`, `limit` 1–25, `cursor`) and return short hits with kind, title, date, snippet and id. `niaro_meeting_get`, `niaro_tasks_list` and `niaro_memory_list` SHALL return one meeting, tasks by status and memories, each paged. They SHALL show what the person's app shows in the grant's workspace, never another person's private data.

#### Scenario: Meeting found and opened

- **WHEN** a client searches for words from a meeting the person recorded and opens the hit with `niaro_meeting_get`
- **THEN** it receives the summary, decisions, action items with owners and the first transcript page with speakers and a `nextCursor`

#### Scenario: Another person's meeting

- **WHEN** a client calls `niaro_meeting_get` with the id of a colleague's meeting
- **THEN** the call fails with `not_found`

### Requirement: Data tool results

Niaro data tools SHALL make no model or inference call on the Niaro server. Their output SHALL be concise by default with `detail: "full"` adding every field, and SHALL be at most 64,000 characters: a longer result SHALL be cut, say `truncated: true` and tell the client to narrow the query or page. Each read SHALL be audited as `mcp.data_read` with source `mcp`. Annotations SHALL mark them read-only and `openWorldHint: false`.

#### Scenario: No model call

- **WHEN** a client searches, opens a meeting, lists tasks and saves memory
- **THEN** the server sends no request to any model provider

### Requirement: Memory save

With `memory.write`, `niaro_memory_save` SHALL save 1–10 facts (each 1–500 characters, kind `fact`, `preference` or `note`) at once into the person's private memory through the same path as their profile, with the source `external_app` naming the grant's label. A fact equal to an active memory (ignoring case, spacing and punctuation) SHALL be reported `already_saved`; the person's profile SHALL refresh quietly.

#### Scenario: Saved fact in the profile

- **WHEN** a client saves "Prefers short answers in Czech." and the person opens their profile
- **THEN** the memory is listed with the app's name as its source and can be deleted there

#### Scenario: Memory off

- **WHEN** the workspace has memory turned off or the person opted out
- **THEN** the call fails with `memory_off` and nothing is saved

### Requirement: Memory save refuses secrets

`niaro_memory_save` SHALL refuse the whole call with `secret_refused`, naming the fact, when any fact looks like a password, API key, access token, account, card or personal ID number, and SHALL save none of its facts.

#### Scenario: Password in a fact

- **WHEN** a client saves "My password is hunter2"
- **THEN** the call fails with `secret_refused` naming `facts[0].text` and nothing is saved

### Requirement: Server instructions

The server SHALL send MCP `instructions` in English, at most 4,000 characters, saying that Niaro is the person's work assistant and memory; to search Niaro before asking the person about their work; to save durable facts about the person proactively (one concise fact each, in their language, no chit-chat, secrets or others' sensitive data, checking memory first); to show approval links and check them with `niaro_call_status`; and to narrow truncated results.

#### Scenario: Client initializes

- **WHEN** a client initializes an MCP session
- **THEN** the result carries the instructions and `serverInfo` with name `niaro` and the server's package version

### Requirement: Actionable tool errors

A Niaro tool called with invalid input SHALL fail with `invalid_input` naming each wrong or unknown field with what it expects and showing a correct example call. Other failures SHALL carry a short code and a message that says what to do next.

#### Scenario: Too long fact

- **WHEN** a client saves a fact of 501 characters
- **THEN** the call fails with `invalid_input` naming `facts[0].text` and showing a correct example

### Requirement: Retired processor grants

At upgrade the system SHALL delete stored grants that hold a scope other than `data.read`, `memory.write` or `services.call`, together with their OAuth links, and SHALL give the OAuth resource and registered OAuth clients the current scope list.

#### Scenario: Processor grant after upgrade

- **WHEN** a server with a grant holding `native.run` starts after the upgrade
- **THEN** the grant is gone and its token is refused with 401

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
