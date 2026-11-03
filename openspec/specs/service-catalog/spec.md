# service-catalog Specification

## Purpose

The service catalog is each workspace's list of connected company services (MCP and OpenAPI) and the actions the assistant may run in them. Administrators connect services, discover and govern actions; members may connect their own services where the workspace allows it; every caller (chat agent, hub, processes, external AI apps) runs actions through the same authorization and dispatch path.

## Requirements

### Requirement: Workspace services

The system SHALL keep a per-workspace catalog of services, each with a name, an optional purpose (at most 500 characters, used by the assistant to choose it), a URL, a protocol (`mcp` or `openapi`), an icon, authentication and an enabled flag. A workspace SHALL hold at most 100 services and a service at most 1000 actions. A new workspace SHALL start with an empty catalog; no built-in connector is added automatically.

#### Scenario: Administrator adds a service

- **WHEN** an owner or admin saves a new service with an HTTPS MCP URL
- **THEN** the service appears in the workspace catalog with no actions

#### Scenario: Member cannot change the shared catalog

- **WHEN** a member sends a catalog command such as `saveService` or `saveAction`
- **THEN** the server refuses it with `identity_forbidden`

#### Scenario: Catalog full

- **WHEN** an administrator adds a 101st service to a workspace
- **THEN** the server refuses it with `identity_limit` and nothing is saved

### Requirement: Service addresses

The system SHALL accept only HTTP(S) service URLs without credentials, query or fragment, and SHALL reach a non-HTTPS or private address only when the operator lists its origin in the server profile's allowed service addresses (`administration.identity.integrationOrigins`). Workspace administrators SHALL NOT be able to widen that list.

#### Scenario: Plain-HTTP address not allowed

- **WHEN** an administrator saves a service at `http://tracker-mcp:8080/mcp` whose origin the operator has not listed
- **THEN** requests to it are refused with `integration_origin_denied`

### Requirement: Outbound request safety

Every outbound service request SHALL resolve DNS once, validate every answer, pin the connection to the checked address, verify TLS, refuse redirects and compressed bodies, and be bounded in time and size.

#### Scenario: Redirect refused

- **WHEN** a service answers a request with a redirect
- **THEN** the request fails and the redirect is not followed

### Requirement: Service credentials

The system SHALL support service authentication `none`, `bearer` or a custom `X-…` header, and SHALL store keys write-only, encrypted with AES-256-GCM bound to their scope and record. Keys SHALL never appear in catalog responses, model prompts, audit details or logs; responses only state whether a credential is present. Personal sign-in to a service is governed by `service-sign-in`.

#### Scenario: Key not returned

- **WHEN** an administrator reads the catalog after saving a service with a bearer key
- **THEN** the service shows `hasCredential: true` and no key value

### Requirement: Address probe

The system SHALL let an administrator check whether a service's address answers with its shared credential: an MCP `initialize`, or any HTTP answer below 500 for OpenAPI. The result SHALL be `ok`, `sign_in` (the service answered 401/403 and wants an account) or `failed` with one error code; a service that needs a key it does not have SHALL report `catalog_key_required` without contacting it.

#### Scenario: Service wants a personal account

- **WHEN** the probe of an MCP service receives HTTP 401
- **THEN** the result is `sign_in`

### Requirement: MCP action discovery

The system SHALL discover actions of a remote MCP server over Streamable HTTP with protocol version `2025-06-18`: initialize, paginated `tools/list`, JSON or bounded SSE responses. It SHALL NOT run stdio MCP servers inside the Niaro process and SHALL NOT support sampling; packaged servers run as `hosted-mcp-servers`. Each tool becomes an action with an MCP binding and the tool's relaxed input schema.

#### Scenario: Tools imported

- **WHEN** an administrator discovers actions of an MCP service offering three tools
- **THEN** three actions are saved, each bound to its tool name

### Requirement: OpenAPI action discovery

The system SHALL discover actions from an OpenAPI 3.0/3.1 JSON document at `openapi.json` or `swagger.json` under the service URL, or at an explicit document URL under the same origin and base path. It SHALL support relative paths, GET/POST/PUT/PATCH/DELETE, scalar path and query parameters, JSON bodies and bounded local `$ref` expansion, and SHALL report and skip unsupported operations. GET SHALL arrive as a read, other methods as writes, and a non-GET action SHALL NOT be saved as a read.

#### Scenario: Unsupported operation skipped

- **WHEN** an OpenAPI document contains a multipart upload operation
- **THEN** discovery skips it and reports it as an issue while importing the others

#### Scenario: POST marked as read refused

- **WHEN** an administrator saves a POST action with effect `read`
- **THEN** the server refuses it with `catalog_effect_invalid`

### Requirement: Imported actions start as drafts

Actions an administrator imports SHALL arrive disabled, granted to nobody and requiring approval, so an import never adds anything anyone can run. Rediscovery SHALL add only actions whose source is not yet in the catalog and SHALL never overwrite existing actions.

#### Scenario: Rediscovery keeps edits

- **WHEN** an administrator renamed an action and runs discovery again
- **THEN** the renamed action is unchanged and only new tools are added

### Requirement: Read-only hints need an administrator's decision

The system SHALL import MCP tools as writes even when they carry `readOnlyHint` and SHALL import Twenty record reads (`find_many_*`, `find_one_*`, `group_by_*`) as writes. It SHALL report such actions to the administrator as read-only candidates; only an explicit administrator choice ("Mark as reads") SHALL turn them into reads that run without approval. Tool annotations SHALL never grant permission or bypass approval.

#### Scenario: Mark as reads

- **WHEN** an administrator chooses "Mark as reads" for hinted actions none of which was granted yet
- **THEN** they become enabled reads without approval, granted to the service's audience (everyone when the service has no access gate)

### Requirement: Discovery in slices with continuation

The system SHALL let the console import large tool sets in bounded requests: a request imports at most the requested number of new MCP tools and returns the rest as a continuation carrying the service and policy revisions. Each slice SHALL commit atomically; earlier slices stay saved when a later one fails, and a stale service or policy revision SHALL refuse the continuation with `catalog_conflict`.

#### Scenario: Continuation after a change

- **WHEN** the service's revision changes between two slices of one import
- **THEN** the next slice is refused with `catalog_conflict` and the already imported actions remain

### Requirement: Twenty MCP catalogue

The system SHALL recognize a Twenty MCP server by its catalogue tools (`get_tool_catalog`, `learn_tools`, `execute_tool`), list its catalogue as searchable choices with categories, and learn at most 20 selected operations per request (schemas in groups of four) before returning a continuation. A saved Twenty action SHALL pin its concrete catalogue tool within `execute_tool`; user or model arguments SHALL NOT replace that target.

#### Scenario: Choosing from the catalogue

- **WHEN** an administrator discovers actions of a Twenty MCP service without selecting tools
- **THEN** the response lists the catalogue choices, marks those already saved and imports nothing

#### Scenario: Pinned target

- **WHEN** the model calls a saved Twenty action with arguments naming another catalogue tool
- **THEN** the call still runs only the pinned catalogue tool

### Requirement: AI naming of discovered actions

The system SHALL optionally have the service's assigned model (else the workspace chat model) write names and descriptions for new actions, five per model request, charged to the inference budget. AI naming SHALL change presentation only: bindings, schemas and policy come from the discovered definition and the administrator. A malformed model answer SHALL leave that batch unimported. Without an available model the request SHALL fail with `catalog_model_required`.

#### Scenario: No model for naming

- **WHEN** an administrator discovers with AI naming on and the workspace has no chat model
- **THEN** discovery fails with `catalog_model_required` and imports nothing

### Requirement: Supported input schemas

The system SHALL accept action input schemas that are JSON Schema objects, including root `anyOf`/`oneOf` alternatives that each describe objects and local `$defs`/`definitions` references with recursion, within 32 KiB serialized, 1,000 nodes and depth 12. Remote references, recursion that consumes no input and unsupported keywords SHALL be rejected. `format` SHALL be descriptive only.

#### Scenario: Remote reference

- **WHEN** a tool's input schema contains a `$ref` to another URL
- **THEN** the tool is not imported and the discovery issues list it with `reference_unsupported`

### Requirement: Unusable tools are reported

The system SHALL report every tool or operation it cannot import with a typed reason (`schema_invalid`, `object_required`, `schema_limit`, `keyword_unsupported`, `reference_unsupported`, `pattern_unsupported`, `metadata_missing`, `operation_unsupported`) and, where it applies, a bounded schema path and keyword, never raw schema values or compiler errors.

#### Scenario: Oversized schema

- **WHEN** a tool's input schema exceeds 32 KiB after relaxation
- **THEN** discovery lists it with `schema_limit` and imports the other tools

### Requirement: MCP tool schema relaxation

Before validating an MCP tool's input schema the system SHALL drop annotations (`$schema` of any draft, `$id`, `$comment`, `examples`, `readOnly`, `writeOnly`, `deprecated`, content media/encoding and vendor `x-` words) and narrowing-only constraints (`uniqueItems`, min/max properties, `multipleOf`, `not`, `if`/`then`/`else`, `contains` family, dependencies). Anything still unsupported SHALL keep failing with its reason; the service itself refuses what it does not take.

#### Scenario: Draft 2020-12 tool becomes usable

- **WHEN** an MCP tool declares `$schema` 2020-12, `examples` and `uniqueItems` in its input schema
- **THEN** discovery imports it with those words removed

#### Scenario: Still unsupported

- **WHEN** a tool's schema uses a keyword outside the supported subset that is not an annotation or narrowing-only constraint
- **THEN** the tool is listed as unusable with `keyword_unsupported` and that keyword

### Requirement: Long tool schemas are shortened

When a relaxed MCP tool schema would exceed 32 KiB, the system SHALL shorten nested descriptions to 1000, then 300, then 100 characters until it fits, keeping the tool's own description unchanged.

#### Scenario: Verbose nested descriptions

- **WHEN** a tool's schema is 40 KiB because its properties carry long descriptions
- **THEN** discovery imports it with those descriptions shortened

### Requirement: Pattern constraints

The system SHALL enforce `pattern` with a linear-time RE2 engine, never a backtracking fallback, supporting ASCII literals, classes, ranges, anchors, groups, non-capturing groups, alternatives, quantifiers, escaped punctuation and `\d`/`\D`/`\w`/`\W`. Lookarounds, backreferences, inline flags, POSIX classes and other escapes SHALL be rejected with `pattern_unsupported`. Each pattern SHALL be at most 512 characters and 4,096 compiled instructions, at most 16,384 instructions per schema.

#### Scenario: Lookahead rejected

- **WHEN** a tool's schema contains the pattern `^(?=.*\d).+$`
- **THEN** the tool is listed as unusable with `pattern_unsupported`

### Requirement: Argument validation

The system SHALL validate every action call's arguments against the action's input schema before dispatch, with inputs bounded to 64 KiB, 10,000 nodes and depth 32 and a bounded validation-work budget. A rejection SHALL name up to eight offending fields with a generic issue and SHALL NOT copy the submitted values.

#### Scenario: Missing required field

- **WHEN** the agent calls an action without a required `email` argument
- **THEN** the call is not dispatched and the failure names `/email` as "Required field is missing."

### Requirement: Action editing

The system SHALL let owners and admins edit an action's name, description, binding, input schema, effect, approval policy (`always` or `never`), enabled state and grants, revision-checked. A batch edit of selected actions SHALL change only the fields explicitly chosen (enabled, approval, effect, roles, workspace roles), SHALL check the service and every action revision and SHALL apply all changes in one transaction or none.

#### Scenario: Stale batch

- **WHEN** an administrator submits a batch edit and one selected action changed since it was loaded
- **THEN** nothing in the batch is applied and the server answers `catalog_conflict`

### Requirement: Action authorization

The system SHALL allow a person to run an action only when the service and action are enabled, the person passes the service's access gate (organization or workspace roles), and the action grants them by organization role, workspace role or an individual allow; an individual deny SHALL override any grant. Owners and admins SHALL NOT bypass grants or approval policy. Authorization SHALL be checked again at dispatch. Members SHALL see only the enabled actions they may run, without policy details.

#### Scenario: Individual deny wins

- **WHEN** an action is granted to the member role and a specific member has an individual deny
- **THEN** that member cannot run the action and does not see it

#### Scenario: Disabled before dispatch

- **WHEN** an administrator disables an action while a call to it is waiting for approval
- **THEN** approving the call does not dispatch it

### Requirement: Actions under a person's own account

For an action that runs under the person's own account (every action of a member-owned service or of a service requiring personal sign-in for everything, and the writes of one requiring it for changes), the system SHALL apply the service's access gate, the administrator's enabled flag and the person's own on/off and approval choices instead of the action's grants and approval. Personal sign-in itself is specified in `service-sign-in`.

#### Scenario: Person turns approval off

- **WHEN** a person sets their own approval for a write of a personal-sign-in service to "never"
- **THEN** that write runs for them without approval while it stays enabled by the administrator

### Requirement: Authority changes retire running work

The system SHALL advance the organization's policy epoch whenever a catalog change could take authority away: an existing service, action, provider, model or routing entry is removed or changes anything other than its name, description or icon. Additions, imports (which arrive disabled) and renames SHALL NOT advance it. Work admitted under the previous epoch (chats, pending approvals, connector and test runs) is then rechecked or retired by `agent-runtime`.

#### Scenario: Rename keeps running work

- **WHEN** an administrator renames a service while a chat turn uses it
- **THEN** the turn continues

#### Scenario: Grant removal retires approval

- **WHEN** an administrator removes a role from an action's grants while a call waits for approval
- **THEN** that pending approval can no longer dispatch

### Requirement: Service removal

The system SHALL refuse to remove a service that a process owns or calls (`catalog_service_in_use`). Removing a service SHALL remove its actions, the people's personal choices for it and its per-service model assignment.

#### Scenario: Service used by a process

- **WHEN** an administrator removes a service that an active process calls
- **THEN** the server answers `catalog_service_in_use` and the service remains

### Requirement: Member-owned services policy

The system SHALL let owners and admins choose per workspace whether members may connect their own services (`off`, `review` default, `free`) and who manages the actions of members' own services (`owner` default, `administrators`). A person SHALL have at most 5 own services per workspace.

#### Scenario: Turned off

- **WHEN** the workspace policy is `off` and a member adds an own service
- **THEN** the server refuses it with `catalog_personal_services_off`

#### Scenario: Limit reached

- **WHEN** a member who already has 5 own services adds another
- **THEN** the server refuses it with `identity_limit`

### Requirement: Adding an own service

The system SHALL let a member add an own service by public HTTPS URL (the operator's private allowlist does not apply) with an optional key and name. The server SHALL detect MCP or OpenAPI and import what the service offers, enabled, reads without approval and writes with approval, marking the service `active` under policy `free` or `pending` under `review`. A service that cannot be read SHALL be refused with `catalog_personal_unreachable` and nothing kept.

#### Scenario: Added under review

- **WHEN** a member adds a reachable MCP service with a key while the policy is `review`
- **THEN** the service is saved as `pending` with its tools imported

#### Scenario: Unreachable

- **WHEN** a member adds an address that answers neither MCP nor OpenAPI and offers no OAuth
- **THEN** the server answers `catalog_personal_unreachable` and no service is kept

### Requirement: Own OAuth MCP services

When a member adds an MCP server without a key and it cannot be read anonymously, the system SHALL look up the server's OAuth metadata and register a client; if that succeeds the service SHALL be saved with personal sign-in and no tools, which are read after the owner signs in (`service-sign-in`); otherwise nothing SHALL be kept.

#### Scenario: OAuth MCP server

- **WHEN** a member adds `https://mcp.notion.com/mcp` without a key and the server advertises OAuth with client registration
- **THEN** the service is saved with personal sign-in required and its tools are read after the owner signs in

### Requirement: Own services serve only their owner

An own service SHALL be usable only by its owner and only while `active`. Members SHALL see only their own active services in the catalog; owners and admins see every service. A person's list of own services SHALL show each one's status, rejection reason, read and write counts and sign-in state (`none`, `needed`, `connected`).

#### Scenario: Pending service unusable

- **WHEN** a member's own service is `pending` review
- **THEN** the assistant cannot run its actions

#### Scenario: Another person's service

- **WHEN** an admin tries to run an action of a member's own service
- **THEN** the action is not allowed for the admin

### Requirement: Reviewing own services

The system SHALL let owners and admins approve or reject a member's pending own service, with an optional reason shown to its owner; the decision SHALL be audited as `catalog.personal_service_reviewed`.

#### Scenario: Rejected with reason

- **WHEN** an admin rejects a member's service with the reason "Use the shared CRM"
- **THEN** the member's list shows the service as `rejected` with that reason and it stays unusable

### Requirement: Owner manages own service actions

While the workspace leaves management to owners and the service is `active`, the system SHALL let the owner find everything the service offers (already added ones marked, unusable ones listed with their reason), add chosen tools as actions, rename and describe an action, say whether it only reads or changes something, and remove it. Changing an action to a write SHALL make it ask before each run again. Otherwise action management SHALL be refused with `catalog_personal_managed`.

#### Scenario: Unusable tools listed

- **WHEN** an owner opens Find actions on a service with one tool whose schema exceeds the limits
- **THEN** the choices omit that tool and the unusable list names it with `schema_limit`

#### Scenario: Administrators manage

- **WHEN** the workspace sets management to `administrators` and the owner tries to add actions
- **THEN** the server answers `catalog_personal_managed`

#### Scenario: Read turned into write

- **WHEN** the owner changes an action from "Only reads" to "Changes something"
- **THEN** the next run of that action waits for the owner's approval

### Requirement: Owner controls own service

The system SHALL always let the owner rename, re-read (adding newly offered tools) and remove their own service; nobody else SHALL see it in their own-services list. Removing an own service or one of its actions SHALL retire running work that relied on it.

#### Scenario: Removal stops pending work

- **WHEN** the owner removes their own service while a call to it waits for approval
- **THEN** the pending call can no longer dispatch

### Requirement: Service icons

The system SHALL show each service with its website's icon by default (`iconSource: favicon`) or a chosen symbol (`plug`, `database`, `users`, `calendar`, `mail`, `code`, `folder`, `search`). It SHALL fetch `/favicon.ico` and up to three same-origin icon links without the service key, cookies, referrer or a third-party lookup, accept only PNG, ICO and GIF up to 128 KiB and 1024×1024, and fall back to the symbol otherwise. Previewing an unsaved URL SHALL require owner or admin.

#### Scenario: SVG icon

- **WHEN** a service's site offers only an SVG icon
- **THEN** the card shows the service's symbol

### Requirement: Action failure diagnostics

The system SHALL record with each failed call a bounded diagnostic: code, kind (`validation`, `permission`, `connection`, `rate_limit`, `provider`, `response`, `cancelled`, `unknown`), stage, next step (`correct_input`, `reconnect`, `later`, `verify_first`, `none`), optional HTTP status and message (at most 600 characters) and up to eight field issues. It SHALL prefer a concrete provider `error`/`cause` over a generic wrapper and exclude credentials, headers, cookies, HTML, raw bodies and media.

#### Scenario: Credentials never in diagnostics

- **WHEN** a provider error body echoes the request's Authorization header
- **THEN** the stored diagnostic does not contain it

#### Scenario: Sort without direction

- **WHEN** Twenty answers `Scalar field "name" requires a direction value (AscNullsFirst, …)`
- **THEN** the failed read's next step is `correct_input` and the model receives that message

#### Scenario: Graph rejection relayed by MCP

- **WHEN** an MCP tool fails with `Microsoft Graph API error: 400 Bad Request - …`
- **THEN** the next step is `correct_input` with Graph's message

#### Scenario: Provider outage relayed by MCP

- **WHEN** an MCP tool fails with `… 503 Service Unavailable …`
- **THEN** the next step is `later`

#### Scenario: Provider output schema violation

- **WHEN** an MCP tool answers `MCP error -32602: Output validation error: Invalid structured content …`
- **THEN** the code is `integration_provider_output_invalid`, kind `response`, next step `none`

### Requirement: Provider input errors are correctable

A provider answer that rejects the request's shape SHALL be `validation` with next step `correct_input`, its sanitized message reaching the model: an HTTP 400, 409 or 422, a `400`/`422` status relayed in an MCP error's text, MCP `-32602` invalid params, and messages naming a wrong, missing or unknown field, value, operator or format.

#### Scenario: Sort without direction

- **WHEN** the CRM rejects a sort field without a direction
- **THEN** the failure is validation with next step correct_input and the provider's message reaches the model

### Requirement: Provider outages and broken outputs

An HTTP 5xx (also when relayed in text) and timeouts SHALL stay `later`, and a relayed 429 SHALL be a rate limit. An MCP output validation error (the provider's tool broke its own output schema) SHALL be `integration_provider_output_invalid` with kind `response` and next step `none`.

#### Scenario: Provider breaks its own schema

- **WHEN** an MCP tool's answer fails the provider's own output validation
- **THEN** the failure is integration_provider_output_invalid with next step none

### Requirement: Failure after dispatch

A failed MCP handshake before a call is sent SHALL be recorded as a failure. Any error after a write was dispatched SHALL carry the next step `verify_first` and never trigger an automatic retry; its outcome is handled as unknown by `agent-runtime`.

#### Scenario: Error after a dispatched write

- **WHEN** a write's MCP call returns an input-rejection error after it was sent
- **THEN** the diagnostic's next step is `verify_first`, not an automatic retry

#### Scenario: Handshake failure

- **WHEN** an MCP service fails `initialize` before an approved write is sent
- **THEN** the call is recorded as failed

### Requirement: Catalog operating limits

The system SHALL run at most eight concurrent console integration requests (discovery, probe, invocation) per server and answer `catalog_busy` beyond that, and SHALL allow at most ten pending action approvals per person and workspace (`catalog_pending_limit`).

#### Scenario: Too many pending approvals

- **WHEN** a person already has ten actions waiting for approval in a workspace and another write is requested
- **THEN** the new call is refused with `catalog_pending_limit`

### Requirement: Service setup checklist

The system SHALL show administrators, on a service's overview, a setup checklist with the steps Address, Sign-in, Actions, Access, Your account (personal sign-in only) and Test, each `done`, needing action, `failed`, running or waiting, with a one-line reason and the control that fixes it. Access SHALL be done only when some read granted to someone runs without approval; Test SHALL run one enabled read without required inputs and show its result or the provider's reason.

#### Scenario: Missing sign-in method

- **WHEN** a hosted server's definition asks for Microsoft sign-in and the organization has no Microsoft sign-in method
- **THEN** the Sign-in step needs action and names the missing method

### Requirement: Catalog audit

The system SHALL audit every catalog change with its actor and scope: service and action changes as `catalog.service_changed`, provider and model changes as `catalog.ai_changed`, routing as `catalog.routing_changed`, discovery as `catalog.actions_discovered`, and own-service changes as `catalog.personal_service_added`, `catalog.personal_service_changed`, `catalog.personal_service_removed` and `catalog.personal_service_reviewed`.

#### Scenario: Own service removed

- **WHEN** a member removes their own service
- **THEN** the audit log records `catalog.personal_service_removed` with the member as actor

### Requirement: Member service projection

The system SHALL give each authenticated person, on the web and in the app, a read-only list of every enabled service they may use in the workspace: their own active services, services with a personal sign-in for them and services with an enabled action they may run. Each entry SHALL say whose account its reads and its changes run under (`own` or `company`), which reads and changes the person may run now, and their sign-in state.

#### Scenario: Switched-off actions

- **WHEN** a person switched off every action of a sign-in service for themselves
- **THEN** the service stays listed with nothing to run

#### Scenario: Other people's own services

- **WHEN** a member has an own service and a colleague opens the list
- **THEN** the colleague does not see it

### Requirement: Own activity in the member projection

Each entry of the member service projection SHALL carry only the person's own last successful read (time) and last failed call (time and failure kind), taken from that person's receipts in that workspace. Administrators SHALL see only the actions they may run themselves.

#### Scenario: Another member's activity

- **WHEN** two members used the same company service and one opens the list
- **THEN** the times shown are that member's own and the other member's never appear

### Requirement: Nothing secret in the member projection

The member service projection SHALL NOT contain service addresses, credentials, OAuth configuration, grants or policies, receipt inputs, results or messages, or any other person's activity, and reading it SHALL NOT start any work.

#### Scenario: Shared key and OAuth client

- **WHEN** a service has a shared API key and an OAuth client secret
- **THEN** neither, nor the service's address, appears in the list
