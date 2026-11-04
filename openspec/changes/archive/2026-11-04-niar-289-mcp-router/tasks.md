# Tasks

## 1. Remove processor mode

- [x] 1.1 Delete the task tools, MCP task admission and delivery, the browser task approval API and the `?taskId=` view; keep connector approval.
- [x] 1.2 Delete the task tests and update `test:mcp`; check that chat, processes and the phone app use none of the removed code.

## 2. Scopes

- [x] 2.1 `data.read`, `memory.write`, `services.call` in the grant store, OAuth resource and registered clients, 401 challenge and resource metadata.
- [x] 2.2 Delete stored grants with retired scopes and drop the task tables at upgrade.
- [x] 2.3 External AI apps page offers the three permissions with hints (cs and en); consent shows the same labels.

## 3. Niaro data and memory tools

- [x] 3.1 Router with scope-filtered tools, annotations, 64,000-character results, per-kind search cursor and audit of reads.
- [x] 3.2 `niaro_search`, `niaro_meeting_get`, `niaro_tasks_list`, `niaro_memory_list` over the existing stores, revalidating the grant on every call.
- [x] 3.3 `niaro_memory_save` through the profile save path with the `external_app` source, duplicate skip, secret refusal and a quiet profile refresh; profile and memory panel show the app's name.
- [x] 3.4 Server instructions and version.

## 4. Connector

- [x] 4.1 Optional `requestId` on write tools, stripped before validation; same key and input return the first receipt, other input conflicts; `niaro_call_status` accepts the key.
- [x] 4.2 Validation errors name the fields and what they expect.

## 5. Verification

- [x] 5.1 Transport tests for generic tools, validation messages and the challenge.
- [x] 5.2 End-to-end test with the MCP SDK client: tools per scope, search, meeting transcript page, memory save visible in the profile, keyed write retried once, no model call.
- [x] 5.3 Administration guide section on External AI apps.
