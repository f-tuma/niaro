# Proposal

Itsaplan: NIAR-239.

## Why

The server still serves five administration and enrollment surfaces that no screen uses any more. Each was replaced by a product feature: the service catalog, model choice ("routing"), personal sign-in and PKCE browser sign-in. They still accept requests, keep credentials, hold their own tables and profile fields, and add branches to the account runtime. The account runtime even consults them on every chat request. They widen the attack surface (CRM keys and CalDAV passwords that nobody can see or rotate any more, a second app enrollment path with its own consent page), and they confuse anyone who reads the code or the specs. The pilot allows breaking changes, so now is the cheapest time to remove them.

## What Changes

- **BREAKING** The AI profile catalog is removed: `GET/POST /admin/api/identity/ai` (`agent-workspace-ai/1`), the profile fields `administration.identity.aiProfiles`, `administration.identity.mobile.model` and `administration.identity.mobile.voice`, and the account runtime's legacy model and transcriber that came from them. Account workspaces get chat and voice only from the catalog model choice. They never use the operator's instance adapters.
- **BREAKING** The routing voice option "server profile" (`voiceMode: "legacy"`) goes with it, because only the AI profile catalog fed it. A stored `legacy` choice reads as Off. The catalog no longer reports `legacyVoiceAvailable`.
- **BREAKING** The workspace CalDAV calendar API is removed: `/admin/api/identity/calendar` (`agent-workspace-calendar/1`), the profile field `administration.identity.calendarCollections`, and the account workspace calendar target and executor.
- **BREAKING** The "TEST contacts" workspace connections API is removed: `GET /admin/api/identity/connections`, `POST …/connections/command`, `POST …/connections/invoke`, the profile field `administration.identity.connectionOrigins`, the chat connection binding, and the workspace `connectionCount`/`toolCount` in the organization detail. The organization policy epoch currently lives in the same store. It is kept as it is.
- **BREAKING** The routing field `planner` (`jev` | `model`) is removed from the model choice. A saved routing that still carries it reads without it. Only historical pre-Mastra turns still finish in the drain runtime, and that runtime no longer starts a new turn on its own.
- **BREAKING** The legacy app enrollment paths are removed: pairing codes for account workspaces (`POST /admin/api/identity/mobile/pairing`, `POST /v1/{accountWorkspace}/auth/pair`), the device-code browser login (`POST /v1/auth/browser/start|poll|cancel`, `/admin/api/identity/device/*` and the `/admin/device` page), and the unused console status routes `GET /admin/api/identity/mobile` and `POST /admin/api/identity/mobile/revoke`. They now answer `404 not_found`. PKCE browser sign-in becomes the only way to enroll an app.
- Dead client code goes with them: `signInWithBrowser` and `browser-login.ts` in client-core, the browser-code and pairing-code props of the connection card, the mobile app's unused pairing and "open browser" handlers, the console device page and unused console copy (EN and CS).
- A server profile that still carries one of the retired fields refuses to start, and `check` fails. The message names the field to delete and shows no values.
- The tables that held the retired data (`agent_workspace_ai`, `agent_workspace_calendar`, `agent_connection`, `agent_workspace_runtime`, `agent_mobile_pairing`, `agent_browser_login`) are dropped at startup. Their encrypted CRM keys and CalDAV passwords are deleted with them. Activity log entries already written for these features stay readable.
- Tests that used account pairing codes as a shortcut enroll through PKCE browser sign-in instead, using one shared test helper. Tests that covered only the removed features are deleted.

## Non-goals

- The operator-paired fixture interpreter is out of scope: `/v1/a` and `/v1/b`, operator pairing codes, the fixture calendar and proposals, `crm.contacts`, the instance `adapters` block, `apps/server-tools`, the TEST Twenty directory and the client's `Connections.pair`. NIAR-240 removes them. `design.md` draws the boundary.
- Server information (`agent-server-info/2`) is unchanged here. NIAR-240 changes it.
- No new administration screen or replacement feature. The service catalog, model choice, personal sign-in and the account page already cover what was removed.
- The drain runtime for saved pre-Mastra turns, legacy inventory and continuity stay. Only their dependency on `planner` goes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `app-pairing`: the "Legacy enrollment endpoints" requirement is removed. A new requirement says that only the PKCE code exchange enrolls an app, and that the retired paths answer 404.
- `administration`: the personal pages under `/admin` no longer include the device confirmation page.
- `models-and-providers`: speech recognition no longer offers the server profile's voice. A stored choice of it reads as Off.
- `deployment`: a new requirement covers retired profile fields. They are refused with a message that names them.
- `identity-access`: a new requirement keeps retired activity log entries readable, and no new entries of those kinds are written.

## Impact

- Server: `apps/server-identity` (`service.ts`, `mobile.ts`, `catalog-controller.ts`, `service-catalog.ts`, `catalog-runtime-legacy.ts`, `process-native-testing.ts`. Deleted: `workspace-ai.ts`, `workspace-calendar.ts`, `connections.ts`, which leaves a small policy-epoch store), `apps/reference-server` (`config.ts`, `runtime.ts`), `apps/fixture-server/http.ts` (the account branches only), `apps/server-admin/http.ts` and the console (`App.tsx`, `router.tsx`, `device-login.tsx` deleted, `catalog-providers.tsx`, `overview-page.tsx`, `identity-pages.tsx`, `audit-page.tsx`, `i18n.ts`).
- Protocol: `packages/protocol` (`workspace-ai.ts`, `workspace-calendar.ts`, `browser-login.ts` deleted; `connections.ts` reduced to `WorkspaceTarget`, or `WorkspaceTarget` moved; `mobile-access.ts`, `service-catalog.ts`, `identity.ts`, `audit.ts`).
- Clients: `packages/client-core` (`connections.ts`, `browser-login.ts` deleted), `packages/ui-catalog/ConnectionCard.tsx` and its stories, `apps/mobile/App.tsx`, `packages/i18n` (unused keys only).
- Tests and scripts: 6 test files deleted, about 20 test files and helpers migrated to the enrollment helper, the `test:identity` list in `package.json`, and the QA bootstraps `scripts/mobile-emulator-qa.mjs`, `scripts/process-mobile-web-qa.mjs` and `scripts/process-pipeline-web-qa.mjs`.
- Data: six tables are dropped at startup, together with their credentials. The policy epoch (`agent_org_policy`) is kept unchanged. Stored routing is normalized when read.
- Operators: a hand-written profile with a retired field must be edited before the upgrade (`niaro check` reports it). The automatic profile and the example profiles never contain these fields.
- Clients in the field: none of the removed paths is used by a current build. Old builds that still offer the backup pairing code fail at that step and must sign in through the browser.
- Coordination: NIAR-240 lands after this change and removes the fixture parts named in Non-goals. NIAR-244 (upgrade test) must list the six dropped tables as intended removals.
