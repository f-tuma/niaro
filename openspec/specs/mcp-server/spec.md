# mcp-server Specification

## Purpose

Niaro exposes one MCP endpoint so a person can use their workspace from an external AI app (for example Claude or ChatGPT): in connector mode the app calls the workspace's permitted service actions itself; in processor mode it hands tasks to Niaro's own agent. Access is a personal grant bound to one account membership and workspace.

## Requirements

### Requirement: One MCP endpoint

The system SHALL serve MCP at `/mcp` over Streamable HTTP, stateless at the transport layer, with request bodies of at most 64 KiB. The tools listed SHALL depend on the grant's scopes: `native.view`/`native.run` give the task tools `task_submit`, `task_get`, `task_respond`, `task_cancel`; `services.call` gives one tool per permitted service action plus `niaro_call_status`. A grant holding both families SHALL list both.

#### Scenario: Connector grant

- **WHEN** a client with a `services.call`-only grant calls `tools/list`
- **THEN** it receives the permitted action tools and `niaro_call_status` and no task tools

### Requirement: Dedicated bearer credential

The system SHALL require a dedicated MCP credential in the `Authorization: Bearer` header on every request. Browser sessions, mobile device credentials and recovery keys SHALL NOT be accepted, and MCP credentials SHALL NOT authenticate any other API. An unauthenticated request SHALL be answered with 401 and a challenge pointing to the protected-resource metadata and naming the scopes `native.view native.run services.call`.

#### Scenario: Mobile token on MCP

- **WHEN** a request to `/mcp` carries a mobile device token
- **THEN** it is refused with 401

### Requirement: Manual access grants

The system SHALL let a person issue, from a live browser session only, a grant for one of their workspaces with a label, scopes from `native.view`, `native.run`, `services.call`, and an expiry of at most 30 days; the user SHALL come from the session, never from input. The token (prefix `agent_mcp_`, 256 random bits) SHALL be shown once and only its digest stored. A person SHALL hold at most 50 active grants per server. No scope SHALL permit approving an action.

#### Scenario: Token shown once

- **WHEN** a person issues a grant and later lists their grants
- **THEN** the listing shows label, scopes and expiry but no token

#### Scenario: Grant limit

- **WHEN** a person with 50 active grants on the server issues another
- **THEN** issuance is refused

### Requirement: Grant revalidation

The system SHALL check on every use, and before every durable dispatch or commit of work admitted through MCP, that the grant is unexpired and unrevoked, bound to this server and workspace, that the original organization membership still exists and that the person still has access to the workspace with their current role. Removing a member SHALL delete their grants; rejoining SHALL NOT restore them.

#### Scenario: Removed from the workspace

- **WHEN** a person loses access to the workspace after issuing a grant
- **THEN** further MCP requests with that grant are refused and admitted work stops before its next dispatch

### Requirement: Grant revocation

The system SHALL let a person revoke each of their grants (idempotently) and list their active grants across workspaces on their account page. A password reset, a password change and signing out everywhere SHALL revoke every MCP grant of the person, manual and OAuth. Manual grants SHALL otherwise be independent of browser logout.

#### Scenario: Password change

- **WHEN** a person changes their password
- **THEN** all their MCP tokens stop working

### Requirement: Connector tools

In connector mode the system SHALL compute the tool list per request from the current catalog and the person's permissions: every enabled action of every enabled service the person may run, named `<service>__<action>` (unique within the listing), with the action's input schema, a description noting whether it reads or changes data and whether a person must approve it, and annotations `readOnlyHint`/`destructiveHint` from its effect.

#### Scenario: Revoked action disappears

- **WHEN** an administrator removes a person's grant on an action
- **THEN** the next `tools/list` for that person no longer lists it

### Requirement: Connector calls use the catalog path

Each connector `tools/call` SHALL run through the same path as console and chat calls in the `service-catalog`: fresh grant and membership checks, the person's own service sign-in where required, argument validation, the dispatch guard, a durable receipt and an audit entry with source `mcp`. Results of MCP-backed services SHALL be returned unwrapped as the service's data. A validation failure SHALL name the offending fields and a missing personal service connection SHALL say so.

#### Scenario: Personal sign-in missing

- **WHEN** a client calls an action of a service that requires the person's own account and the person has not connected it
- **THEN** the call fails stating that the person's service connection is required

### Requirement: Connector approvals

An action configured to require approval SHALL NOT run on the client's request alone: the call SHALL return `status: "awaiting_approval"`, a `requestId` and an `approvalUrl` in Niaro (`/admin/mcp?approval=…`), where only the person who owns the grant approves or declines it. `niaro_call_status` with the `requestId` SHALL return `awaiting_approval`, `running`, `succeeded` with the result, `rejected`, `unknown` (check the data before retrying) or a failure.

#### Scenario: Write waits for the person

- **WHEN** a client calls a write action whose approval is `always`
- **THEN** the response is `awaiting_approval` with an approval URL and nothing is sent to the service

#### Scenario: Declined

- **WHEN** the person declines the call in Niaro
- **THEN** `niaro_call_status` returns `rejected`

### Requirement: Task tools contract

In processor mode the system SHALL accept `task_submit` (`requestId`, `text`, optional `language` `cs` default or `en`, optional IANA `timeZone`), `task_get` (`taskId`, optional `waitMs` 0–10,000), `task_respond` (`taskId`, `requestId`, `inputId`, `expectedRevision`, `text`) and `task_cancel` (`taskId`, `requestId`). Text SHALL be 1–4,000 characters with non-space content, identifiers 1–160 characters of `[A-Za-z0-9._:-]`, and unknown properties SHALL be rejected.

#### Scenario: Unknown property

- **WHEN** a client calls `task_submit` with an extra `model` property
- **THEN** the call is rejected as invalid input

### Requirement: Tasks run in Niaro's agent

Work accepted through `task_submit` SHALL be planned and executed by Niaro's own agent (`agent-runtime`) under the grant's person and workspace, with the same approvals, receipts and limits as chat; the MCP adapter SHALL only admit and deliver.

#### Scenario: Waiting for the result

- **WHEN** a client submits a task and calls `task_get` with `waitMs` 10000
- **THEN** the call waits up to ten seconds for the running task and returns its current status

### Requirement: Idempotent requests

The system SHALL treat a repeated `requestId` with identical input as the same request and return the same task, and SHALL reject reuse of a `requestId` with different input as a conflict. Task and conversation identities SHALL be assigned by the server.

#### Scenario: Retry after lost acknowledgement

- **WHEN** a client resends `task_submit` with the same `requestId` and text after a network timeout
- **THEN** no second task is created and the original `taskId` is returned

### Requirement: Task status and next input

Task responses SHALL include `taskId`, `conversationId`, `revision`, `status` (`queued`, `running`, `waiting_input`, `waiting_approval`, `waiting_system`, `succeeded`, `failed`, `cancelled`, `expired`, `superseded`, `unknown`) and `reply`, plus `result`, `nextInput` or `error`. A question SHALL carry `inputId`, `expectedRevision` and its text and be answered only through `task_respond`; an approval SHALL carry a Niaro review URL. `task_respond` SHALL NOT approve an action.

#### Scenario: Approval needed

- **WHEN** a submitted task reaches a write that requires approval
- **THEN** `task_get` returns `waiting_approval` with a review URL for a person to approve in Niaro

#### Scenario: Stale answer

- **WHEN** a client answers a question with an `expectedRevision` that is no longer current
- **THEN** the answer is refused and the client is told to read `task_get` for the latest question

### Requirement: Durable tasks and cancellation

Task handles SHALL survive client disconnects and server restarts; reconnecting and `task_get` SHALL be passive, and unconfirmed effects SHALL never create a replacement run. `task_cancel` SHALL request cancellation, reject an outstanding approval and close the pending input, and SHALL NOT undo completed or unconfirmed effects. When the grant was revoked, the response SHALL say that closure is unconfirmed.

#### Scenario: Cancel after a write

- **WHEN** a client cancels a task whose write already succeeded
- **THEN** the task becomes `cancelled` and the write is not reverted

### Requirement: OAuth discovery

The system SHALL publish protected-resource metadata for `/mcp` at `/.well-known/oauth-protected-resource/mcp` and authorization-server metadata for the issuer `/admin/auth`, issuing opaque access tokens (prefix `agent_mcp_oauth_`, stored as hashes) only for the configured resource with exact audience. Dynamic client registration, client metadata fetching, refresh tokens and machine grants SHALL be disabled.

#### Scenario: Dynamic registration refused

- **WHEN** a client tries to register itself through dynamic client registration
- **THEN** registration is refused

### Requirement: OAuth client registration

The system SHALL let a signed-in organization member register a public OAuth client (token endpoint authentication `none`) with a name and 1–5 exact redirect URIs, which SHALL be HTTPS outside development, and return its client ID.

#### Scenario: Plain-HTTP callback

- **WHEN** a member registers a client with an `http://` callback on a production server
- **THEN** registration fails with `mcp_oauth_redirect_invalid`

### Requirement: OAuth authorization and consent

The system SHALL use the authorization-code grant with required PKCE `S256` and a signed authorization request. After sign-in, the person SHALL see the verified client, their account and the requested permissions and SHALL explicitly choose the workspace and a subset of the requested scopes; nothing SHALL be selected automatically. Acceptance SHALL require the real browser origin, a current session and an accessible workspace, and SHALL create a grant bound to that browser session.

#### Scenario: Scope escalation

- **WHEN** a consent submission asks for a scope the client did not request
- **THEN** it is refused

#### Scenario: Plain code challenge

- **WHEN** an authorization request uses `code_challenge_method=plain`
- **THEN** it is refused

### Requirement: OAuth access lifetime

OAuth access SHALL last at most one hour and never beyond the browser session it was granted from; it SHALL end on browser logout, revocation, client disable or loss of the original membership, after which the client must link again.

#### Scenario: Browser logout

- **WHEN** the person signs out of the browser session used to grant OAuth access
- **THEN** the OAuth token stops working and admitted work stops before its next dispatch
