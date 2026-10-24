# Niaro as an MCP server

Niaro exposes one `/mcp` endpoint with two modes. The access token or OAuth
grant decides which tools a client sees:

| Mode                               | Scope                       | Tools                                                      | Who plans and executes |
| ---------------------------------- | --------------------------- | ---------------------------------------------------------- | ---------------------- |
| **Processor** (_Hands over tasks_) | `native.view`, `native.run` | `task_submit`, `task_get`, `task_respond`, `task_cancel`   | Niaro's server agent   |
| **Connector** (_Runs actions_)     | `services.call`             | one tool per permitted service action, `niaro_call_status` | the connected client   |

A grant may hold both scopes; it then lists both tool families.

## Connector mode

Connector mode hands the workspace's connected services (MCP and OpenAPI) to an
external agent such as Claude. `tools/list` returns every enabled action the
person may use, named `<service>__<action>` (for example
`example_crm__search_people`), with the action's input schema and
`readOnlyHint`/`destructiveHint` from its effect. The list is computed per
request from the current catalog and the person's permissions.

Each `tools/call` runs through the same catalog path as the console and chat:
fresh grant and membership checks, the person's own service sign-in where the
service requires it, input validation, the dispatch guard, a durable receipt
and an audit entry with source `mcp`. Results from MCP-backed services are
unwrapped, so the client receives the service's data rather than nested JSON.

Actions configured to require approval never run on the client's say-so. The
call returns `status: "awaiting_approval"` with an `approvalUrl`
(`/admin/mcp?approval=…`). The person who owns the access opens it, reviews the
input and approves or declines. The client then reads the outcome with
`niaro_call_status` and the returned `requestId`. Failed validation names the
offending fields; a missing personal service connection says so explicitly.

## Processor mode

Processor mode makes `/mcp` another client of Niaro's server agent.
Mastra continues to own planning, memory, checkpoints and execution. The MCP
adapter admits and delivers commands; it does not provide another agent loop.

## Task contract

The endpoint uses the official MCP SDK's Streamable HTTP transport. It is
stateless at the transport layer; application `taskId` handles survive client
disconnects and server restarts independently of MCP sessions.

| Tool           | Required input                                               | Behavior                                                                                                          |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `task_submit`  | `requestId`, `text`                                          | Accept a task durably and return its handle. Optional `language` (`cs` default, `en`) and IANA `timeZone`.        |
| `task_get`     | `taskId`                                                     | Read current status, result or next required input. Optional `waitMs` from 0 to 10000 waits for current delivery. |
| `task_respond` | `taskId`, `requestId`, `inputId`, `expectedRevision`, `text` | Answer that exact current clarification. It cannot approve an action.                                             |
| `task_cancel`  | `taskId`, `requestId`                                        | Request cancellation, retaining previously committed or unconfirmed effects.                                      |

Text is limited to 4000 characters. IDs use 1–160 ASCII letters, digits,
periods, underscores, colons or hyphens. Unknown input properties are rejected.
Use the same `requestId` when retrying an identical request after a lost
acknowledgement. Reusing an ID with different input is a conflict; do not generate
a new ID merely because the network timed out. New deliberate requests use new
IDs. Native command identities and conversation IDs are assigned by the server.

Responses include `taskId`, `conversationId`, `revision`, `status` and `reply`,
with a structured public `result`, `nextInput` or `error` when relevant. Both MCP
text content and structured content describe the same response. A successful
MCP call acknowledges transport/delivery, not necessarily completion of work.
After submitting, call `task_get` with bounded waiting until the task completes,
fails or needs input. If it is still running, retain its handle for later checks.

`nextInput.kind:"question"` provides `inputId`, `expectedRevision` and the
question. Answer through `task_respond`; never substitute the latest chat or
infer a different input target. `nextInput.kind:"human_approval"` provides a
Niaro review URL and canonical action identity. A person signs in there to review
the operation and explicitly approve or reject it. MCP has no approval tool or
approval grant, and its credentials do not authenticate the mobile REST API.

States distinguish `queued`, `running`, `waiting_input`, `waiting_approval`,
`waiting_system`, `succeeded`, `failed`, `cancelled`, `expired`, `superseded` and
`unknown`. An unknown action is unconfirmed; do not resubmit a write to resolve
it. Cancellation does not undo completed actions. Source, memory, permission
and context expiry can remove a previously actionable question or result.

## Access and connection

Sign in to Niaro with a personal account, select a workspace and open
**External AI apps** in the sidebar (`/admin/mcp`). Choose **Connect an app**, pick
**Runs actions** (Connector) or **Hands over tasks** (Processor), copy the token once into your own MCP client and use the
displayed endpoint:

```json
{
  "url": "https://YOUR-NIARO-SERVER/mcp",
  "headers": { "Authorization": "Bearer YOUR-DEDICATED-MCP-TOKEN" }
}
```

This is an illustrative client configuration; the configuration format depends
on the client. The endpoint requires the dedicated MCP bearer credential on
every request. Mobile, browser and recovery credentials are not substitutes.
The grant binds the original account membership, user, server and workspace.
`native.view` permits reads; `native.run` includes reading results and permits
task submission, clarification and cancellation. `services.call` permits
connector calls. None of them grants independent action approval.
Tokens expire after at most 30 days and can be revoked from the same page.

For an OAuth client, open **External AI apps → OAuth client registration**. Copy the
exact HTTPS callback address from that client's connection settings, register it
and copy the returned client ID into the client's supplied-client configuration.
Use the same `/mcp` endpoint. Niaro publishes protected-resource and authorization
server discovery and uses authorization code with required PKCE. During linking,
the person explicitly selects their workspace and permissions; neither is
selected automatically. Email and configured company sign-in continue through
the signed consent request.

OAuth access lasts at most one hour and ends on browser logout, revocation or
loss of the original membership. Link again after expiry. Dynamic client
registration, client metadata fetching, refresh tokens and machine grants are
disabled. A client requiring one of those unsupported modes cannot be assumed
compatible. Manual tokens are independent of browser logout, but a password
reset, a password change or **Sign out everywhere** revokes every MCP token of the
person, manual and OAuth. The person's **Account** page (`/me`) lists their active
MCP tokens in every workspace and can revoke each.

See [the authentication design and verified primary references](mcp-auth-design.md).
The official SDK's HTTP client, real server routes and browser UI have been
tested with synthetic accounts. Live linking in Claude and ChatGPT remains the
acceptance gate; a bearer/SDK test does not prove their custom connector
UI supports the available authentication mode.

## Persistence and verification

Admission records retain normalized commands and exact idempotency mappings in
the private identity database. Accepted work uses the same account runtime,
native request owner and canonical action receipts as mobile/web. Reconnect and
GET are passive. Startup delivery uses original command identities; unconfirmed
effects never create a replacement run. The existing server/identity lock is
the sole owner boundary.

Cancelling a pending task requires proof of the exact settled suspension or
native retirement, rejects an outstanding canonical approval and closes its
input. A suspended checkpoint stays dormant; the terminal domain record prevents
authorized resume. This does not claim that a suspended checkpoint was physically
deleted. Lost cancellation acknowledgements are reconciled after restart without
inference or business dispatch. If the delivery grant was revoked, the response
explains that closure is unconfirmed. A current grant and a new explicit cancel
request can recheck it; revoked authority never counts as proof of closure.

Run `pnpm test:mcp` for dedicated grant, real HTTP SDK, connector, native
read/cancel and OAuth checks. Fixtures use temporary databases and deterministic model/service
transports. They never run business operations against the user's live CRM.

For the development server, configure `SERVER_PROFILE` in the local `.env` and
run `pnpm server` from the repository root. The CLI owns the profile lock: use
one process per profile. Build the admin assets with `pnpm admin:build` and restart
the server after changing server code. Expo remains a separate client process.
Acceptance with a live external client is still open.
