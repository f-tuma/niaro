# Proposal: Remove the fixture interpreter (NIAR-240)

## Why

Every account workspace answers through the Mastra agent, but the server still carries the old fixture interpreter. This was an early test path. It accepts operator-paired workspaces `/v1/a` and `/v1/b`, schedules meetings with "Peter" through proposals and a CalDAV calendar, lists TEST contacts from Twenty as `crm.contacts` cards and keeps its own meeting memory. None of this is product, yet it shapes the wire protocol (snapshot arrays, commands and a baseline result type), the mobile and web clients, the server host and about thirty test files. It also keeps a second, non-Mastra answer path reachable from account workspaces. Removing it shrinks the attack and maintenance surface. After the removal, "what the app talks to" means one thing: an account workspace on Mastra.

## What Changes

- **BREAKING** The app API serves only account workspaces. The fixed workspaces `/v1/a` and `/v1/b` are removed, together with operator pairing codes (`npm run server:pair`, `npm run fixture:pair`), their session file and the profile without `administration.identity`. Unknown workspace paths answer `404 not_found` as today.
- **BREAKING** These commands are removed: `input.submit`, `proposal.decide`, `proposal.revise` and `operation.reconcile`. Any of them is now an unknown command type and is refused as invalid (`400 invalid_payload`) with no receipt. A `message.send` answer to a question always goes to the agent (Mastra). The server never interprets it as a contact choice.
- **BREAKING** The workflow snapshot loses `inputRequests`, `actionProposals` and `operations`, and the event types for them. A work item loses `demo`, `inputRequestIds`, `actionProposalIds` and `operationIds`. The workflow profile moves from `agent-client/0.8-fixture` to `agent-client/0.9`.
- **BREAKING** The `crm.contacts/1` result type is removed from the protocol and from the baseline result set, and the web `niaro.contacts` card and the mobile contact card go with it. A `crm.contacts` result already stored in a message is dropped when storage is opened, and the message keeps its text.
- **BREAKING** Server information moves to `agent-server-info/3`. It no longer reports `contacts`, `calendar` or the `demo-phrases` interpretation. Its component catalog drops `input.choice`, `action.approval` and `crm.contacts`.
- The engine no longer runs the calendar effect and its worker, the deterministic demo phrases, the OpenRouter decision interpreter, the fixture conversation memory or the meeting drafts. The background 250 ms worker tick is removed.
- A one-time storage migration removes the stored state of the old operator workspaces and any proposal, operation, demo work and fixture memory left in account workspaces. It also removes the receipts of the removed commands. Chats, messages, native work, receipts of current commands, search and the server identity stay unchanged.
- The server profile no longer accepts the `twenty-test` CRM adapter or the `caldav` calendar adapter. The inert values `disabled` and `simulated` still load, so existing profiles keep working.
- Removed: the npm scripts `fixture*`, `calendar:*`, `server:pair`, `test:calendar`, `test:crm`, `test:memory` and `test:models`, the Radicale setup (`scripts/*radicale*`, `.radicale`) and the example profiles in `servers/`. The development server (`npm run server`) and the smoke test (`npm run smoke`) remain the way to run Niaro locally.
- Tests that covered only the fixture interpreter are deleted. Tests that guard product behavior through the fixture path (delivery, receipts, chat directory, search, speech, interruption, health probes) are moved to an account workspace.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-delivery`: the API serves only account workspaces, the command set no longer has the fixture commands, `crm.contacts/1` leaves the baseline results, and the snapshot no longer carries fixture entities. Stored fixture state is migrated.
- `app-pairing`: server information (`agent-server-info/3`) no longer reports contacts, calendar or demo interpretation, and operator pairing of fixed workspaces is gone.
- `deployment`: profile validation requires account administration and refuses the TEST CRM and CalDAV adapters. Private configuration files no longer cover those adapters.
- `tasks`: a native work item is no longer marked with `demo`.

## Impact

- Code: `apps/fixture-server` (`engine.ts`, `http.ts`, `storage.ts`, `migrate.ts`, `model-service.ts`, `auth.ts`, `index.ts`, `pair.ts`, `reset.ts`; deleted: `calendar.ts`, `decision.ts` (except `ModelError`), `conversation-memory.ts`, `openrouter.ts` decision parts, `twenty.ts`), `apps/server-tools/contacts.ts`, `apps/reference-server` (`runtime.ts`, `config.ts`, `cli.ts`), `apps/server-identity` (`service.ts` `model` stub and `model`/`tools` hand-over, `mobile.ts` `MobileRuntime.model`/`tools`; `calendarTarget`/`executeCalendar` are removed by NIAR-239), `apps/server-mcp/tasks.ts` (imports only), `packages/protocol` (`index.ts`, `server-info.ts`, `admin.ts`, `message-delivery.ts`), `packages/client-core`, `apps/mobile`, `packages/ui`/`ui-catalog`, the admin web chat (`niaro.contacts`), `packages/test-fixtures`.
- APIs: the app API (`/v1/{workspace}/…`) loses scopes, commands, snapshot fields, a result type and server-information fields. The admin overview drops the `crm` and `calendar` adapter rows and the TEST contact tool list.
- Data: a one-time, idempotent migration of `workflow.sqlite` (`PRAGMA user_version` 1 → 2). The server identity (`auth/server-id`) is kept as it is, because every stored scope is keyed by it.
- Clients: old mobile builds stop working against the new server because the workflow profile no longer matches. This is allowed at the pilot stage. The phone app ships with the change.
- Coordination: this change lands after `niar-239-remove-legacy-admin-apis` (AI profiles, workspace CalDAV admin API, TEST contacts connections, routing planner, legacy enrollment, `calendarTarget`/`executeCalendar`). Stages 2–3 can land before it, and stage 4 onward waits for it. See design.md, "Boundary with NIAR-239".
- Risk: `apps/fixture-server` also hosts the product workflow store and app API. A careless deletion breaks every account workspace. The staged plan keeps `npm run check` and `npm run test:identity` green after each stage. The known failures are the 12 NIAR-233 tests, and they stay tracked by name.
