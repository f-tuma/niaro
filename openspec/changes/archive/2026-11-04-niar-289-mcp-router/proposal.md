# Proposal

Tracker: **NIAR-289**

## Why

Processor mode (`task_submit`, `task_get`, `task_respond`, `task_cancel`, scopes `native.view`/`native.run`) handed each request to Niaro's own agent. That costs the server model tokens for work the person's own AI app (their Claude or ChatGPT subscription) is already doing, and puts an agent inside an agent: two models plan the same request, the outer one only sees a summary, and every question or approval takes a round trip through task polling. The owner decided on 2026-11-04 that MCP stops handing tasks to Niaro's agent and becomes a router. The pilot allows breaking changes; old grants need no compatibility.

## What Changes

- **Processor mode is removed.** The task tools, their durable admission and cancellation delivery, the MCP task approval page (`/admin/mcp?taskId=…`) and its browser API are gone. Connector approval (`/admin/mcp?approval=…`, `niaro_call_status`) stays.
- **Scopes are `data.read`, `memory.write`, `services.call`.** Grant issuance, the External AI apps page, OAuth consent, the 401 challenge and the protected-resource metadata use them. Stored grants with the retired scopes are deleted at upgrade (their OAuth links go with them); the person connects the app again. Registered OAuth clients and the OAuth resource get the new scope list.
- **Niaro data tools** (`data.read`): `niaro_search` (meetings, tasks, chats and memory in one paged search), `niaro_meeting_get` (summary, decisions, action items, open questions and the transcript with speakers, paged), `niaro_tasks_list` (open or done tasks, paged) and `niaro_memory_list` (what Niaro remembers about the person, paged). They read through the same stores and with the same visibility as the person's app session, for the grant's workspace only, and never call a model.
- **Memory save** (`memory.write`): `niaro_memory_save` saves 1–10 facts about the person at once through the profile's own save path, attributed to the app (its access label) as a new memory source `external_app`, shown in the person's profile and deletable there. Exact repeats are skipped; anything that looks like a password, key, token, account or card number is refused.
- **Server instructions** (MCP `instructions`, under 4,000 characters) tell the app's model to search Niaro before asking the person, to save durable facts about the person proactively, to show approval links and to narrow truncated results. `serverInfo.version` follows `package.json`.
- **Idempotent connector writes.** Every write tool's schema carries an optional `requestId`; the same grant, key and input return the first receipt, other input with the same key is a conflict. Without a key every call is new.
- **Actionable validation errors** for Niaro tools and service actions name each wrong field and what it expects; Niaro tools also show a correct example call.
- Results of Niaro tools are cut to 64,000 characters and say so. Reads are audited as `mcp.data_read`, saves as `memory.changed`, both with source `mcp`.

## Non-goals

- OAuth flows, client metadata documents, refresh tokens and loopback redirects (NIAR-288).
- Writing tasks, meetings or chats from MCP, and a separate tool to open one chat.
- Near-duplicate detection of memories beyond exact (case, spacing and punctuation insensitive) repeats; the instructions ask the app to check first.

## Impact

- `apps/server-mcp` (transport, new router), `apps/server-identity` (grant scopes and upgrade, data tools, connector keys, memory source), `apps/fixture-server/http.ts` (wiring, chat search), administration web (External AI apps page, consent labels, memory source labels), phone profile (memory source label), `packages/protocol` (memory source, audit action).
- Breaking: processor grants and any app using the task tools stop working; the app must be connected again with the new permissions.
