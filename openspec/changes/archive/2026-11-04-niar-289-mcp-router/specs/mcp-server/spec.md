# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Task tools contract

**Reason**: MCP no longer hands tasks to Niaro's own agent (owner decision 2026-11-04): the person's own AI app does the thinking and Niaro supplies data and actions.

**Migration**: Connect the app again with `data.read`, `memory.write` and `services.call`; use the Niaro data tools and the service action tools directly.

### Requirement: Tasks run in Niaro's agent

**Reason**: Running each MCP request in Niaro's agent cost server model tokens and nested one agent inside another.

**Migration**: The app's own model plans the work with `niaro_search`, `niaro_meeting_get`, `niaro_tasks_list` and the service action tools.

### Requirement: Idempotent requests

**Reason**: It covered `task_submit` and `task_respond`, which are removed.

**Migration**: Write tools take an optional `requestId` instead (Idempotent connector calls).

### Requirement: Task status and next input

**Reason**: There are no MCP tasks, questions or task approval links any more.

**Migration**: Service writes that need approval return `awaiting_approval` with an `approvalUrl`; `niaro_call_status` returns the outcome.

### Requirement: Durable tasks and cancellation

**Reason**: There are no MCP task handles to keep or cancel.

**Migration**: None; a started service call keeps its durable receipt as before.
