# Design

## Context

See proposal.md for the motivation. Every removed surface is still wired into `IdentityService` (`apps/server-identity/service.ts`), so most of the work is cutting it out of that class without breaking the live account runtime. The current wiring:

| Surface | Server code | Wired into the live path at |
| --- | --- | --- |
| AI profile catalog | `workspace-ai.ts` (`WorkspaceAIStore`, table `agent_workspace_ai`), route `/admin/api/identity/ai` in `service.ts`, `attachAI` called from `apps/reference-server/runtime.ts` (`createReferenceServer` builds the "instance" profiles from `mobile.model`/`mobile.voice` and `loadServerAdapters` loads `aiProfiles`) | `accountRuntimeAccess` (`this.ai.read/resolve` → `services.model`, `services.transcriber`, `validateAI`, `runModel`), `GET /admin/api/identity/mobile` (`modelEnabled`/`voiceEnabled`), and `CatalogController`'s `legacyVoiceAvailable` callback |
| Legacy voice option | `Routing.voiceMode: "legacy"` (default!) in `packages/protocol/service-catalog.ts`, `CatalogSchema.legacyVoiceAvailable`, console `catalog-providers.tsx` (`ModelSelect legacy`), `overview-page.tsx` ("server default") | `accountRuntimeAccess` `voiceEnabled`/`transcriber` |
| Workspace CalDAV | `workspace-calendar.ts` (`WorkspaceCalendarStore`, `agent_workspace_calendar`, HKDF `workspace-calendar-credentials/v1`), route `/admin/api/identity/calendar`, `packages/protocol/workspace-calendar.ts`, profile `calendarCollections` | `IdentityService.calendarTarget` / `executeCalendar`. `apps/fixture-server/http.ts` calls them for account scopes (the `FixtureStorage` target callback, `CalendarWorker`, server info `calendar`). Also the revision check in `accountRuntimeAccess`, and `connectionCount`/`toolCount` in `organization()` |
| TEST contacts connections | `connections.ts` (`WorkspaceConnectionStore`, tables `agent_connection`, `agent_workspace_runtime`, **and `agent_org_policy`**), routes `/admin/api/identity/connections`, `/connections/command`, `/connections/invoke` (`IdentityService.invoke`), `packages/protocol/connections.ts`, profile `connectionOrigins` | `accountRuntimeAccess` (`binding`, `list`, `row`, `authorize`, `registry` → `MobileRuntime.tools`), server info `contacts` via `bridge.tools.has(...)`, `organization()` counts |
| Routing `planner` | `Routing.planner` in `packages/protocol/service-catalog.ts`, stored by `ServiceCatalogStore` `saveRouting`, always set to `"model"` by `catalog-providers.tsx` and `process-native-testing.ts` | read only in `createDrainCatalogRuntime` (`catalog-runtime-legacy.ts`) to choose agent / progressive / legacy for a turn that is not yet saved. In production the drain runtime is only reached for an already saved pre-Mastra turn (`createCatalogRuntime` → `drain()`), so this branch is dead outside tests |
| Legacy enrollment | `mobile.ts` (`issue`/`pair`, `startBrowser`/`pollBrowser`/`cancelBrowser`/`inspectBrowser`/`releaseBrowser`/`denyBrowser`/`consentBrowser`, tables `agent_mobile_pairing`, `agent_browser_login`), `IdentityService.pairMobile`/`browserLogin`, routes `/admin/api/identity/mobile[/pairing|/revoke]`, `/admin/api/identity/device/*`, `apps/fixture-server/http.ts` (`/v1/auth/browser/*`, the account branch of `auth/pair`), `packages/protocol/browser-login.ts`, `mobile-access.ts` (`MobilePairingResult`, `MobileWorkspaceStatus`), console `device-login.tsx` and the `/device` route | nothing in current UIs. client-core `signInWithBrowser` + `browser-login.ts`, the `ConnectionCard` props `browserLogin`/`onOpenBrowser`/`onPair` and `App.tsx` `connect`/`openBrowser` are dead |

Two pieces of these stores are live product and must survive:

- `agent_org_policy` (`policyVersion`/`changePolicy`) is the organization **policy epoch** from `identity-access` ("Authority is checked on every request"). Twenty-three call sites in `service.ts` use it, and so do the test helpers (`identity["connections"].policyVersion/changePolicy` in `tests/helpers/*.ts`, `tests/app-login.node.ts`, `tests/process-*-http.node.ts`).
- `agent_mobile_session` with `web=1` holds the web app chat credentials (`issueWebSession`), and `DeviceSessions` (`device-sessions.ts`) holds app devices. `redeem`, `authenticateDigest`, `revoke*`, `ownAccess`, `count`/`availableSlots` and `refresh` remain.

## Goals / Non-Goals

**Goals:**

- No route, profile field, protocol schema, table or client branch of the five surfaces is left, except the readable audit history and the boundary pieces listed under "Boundary with NIAR-240".
- Account workspaces get model and voice only from the catalog. In particular they never fall back to the operator's instance adapter.
- Policy epoch, web chat credentials, device sessions, PKCE app login and the drain runtime for saved pre-Mastra turns behave exactly as before.
- Tests that only used pairing codes to get an account credential keep their coverage through PKCE enrollment.

**Non-Goals:**

- Removing the fixture interpreter or anything listed under "Boundary with NIAR-240".
- Renaming identifiers such as `MobileSessionStore` or `agent_mobile_session`.
- Retiring the drain runtime, the legacy inventory or the continuity suites.

## Decisions

### D1. Retired profile fields are rejected with a named message, not ignored

`ServerConfigSchema` drops `aiProfiles`, `calendarCollections`, `connectionOrigins` and `mobile.model`/`mobile.voice`. `mobile` keeps `sessionIdleDays`. Strict parsing would already reject them, but only with the generic "Invalid server profile". `loadServerConfig` therefore inspects the raw JSON before `ServerConfigSchema.parse` and throws `ServerConfigError("The server profile uses retired fields: administration.identity.aiProfiles, …. Remove them; models, voice and services are set in administration.")`. The message lists paths only, never values. `check` goes through the same loader.

Why reject:

- The deployment spec makes the profile strict ("unknown fields … SHALL be rejected"). An exception for a few names would leave a field that parses but does nothing.
- Silently dropping `mobile.model: "instance"` or `aiProfiles` would silently turn off chat or voice in a workspace that used them. A refusal at start is an honest failure, and `niaro check` finds it before the switch.
- The blast radius is small. The automatic profile (`automaticServerProfile`), the example profiles (`examples/self-hosted/*.json`) and `servers/*.json` never contain these fields. Compose and Dokploy use the automatic profile unless `NIARO_CONFIG` mounts a hand-written one.

Alternative: ignore the fields and log a warning for one release. This was rejected because it adds code that must be removed again, and a warning in a container log is easy to miss while the lost capability is not.

### D2. Stored data: drop the retired tables, normalize routing when it is read

- At startup, after the stores are constructed, `IdentityService.create` runs one transaction: `DROP TABLE IF EXISTS agent_workspace_runtime, agent_connection, agent_workspace_calendar, agent_workspace_ai, agent_mobile_pairing, agent_browser_login`. `agent_workspace_runtime` goes first because of its foreign key. This is deliberate data removal. `agent_connection` and `agent_workspace_calendar` hold sealed Twenty API keys and CalDAV passwords, and after this change nothing can show, rotate or delete them. Keeping unmanageable credentials is worse than removing them. The other tables hold selections and five-minute codes. Running the drop again is a no-op.
- `agent_org_policy` keeps its name and rows. Its `CREATE TABLE` and the two methods move to a new `apps/server-identity/policy-epoch.ts` (`PolicyEpochStore`), injected as `this.policy`. Test helpers switch from `identity["connections"]` to `identity["policy"]`.
- `ServiceCatalogStore.routing()` (and every other reader of `agent_catalog_routing.data`) parses through one `readRouting` that deletes a stored `planner` key and maps `voiceMode: "legacy"` to `"disabled"` before `Routing.parse`. The next save writes clean JSON. A one-time rewrite was rejected: normalizing on read covers rows restored from an old backup too, and `authorityShape` compares a before and an after that both pass through the same normalization, so no policy epoch is advanced by mistake.
- Saves stay strict. `Routing` is a `strictObject`, so a `saveRouting` command that still carries `planner` or `voiceMode: "legacy"` fails as invalid input. The console that sends it is served by the same server, so no other client exists.
- Audit history stays. `AuditAction` keeps `workspace.ai_changed`, `calendar.*`, `connection.*` and `tool.invoked`. `AuditDetails` keeps their detail fields, and `AIProfileId` and `ConnectionToolId` move into `audit.ts` as historical shapes. The console activity log keeps their labels. `audit.ts`'s `category=tools` filter keeps `tool.invoked` and `calendar.executed`. Nothing writes these actions any more (see `identity-access` delta).
- `agent_mobile_session` rows with `web=0`, which only the old pairing and device-code paths issued, are left alone. They expire with their browser session and still count toward device slots until then.

### D3. Account runtime after the cut (`accountRuntimeAccess`)

- `ai`, `services`, `validateAI`, the `calendarRevision` check and the connections binding and row checks are removed from `check()`. The remaining staleness inputs are the policy epoch, the plugin revision and the catalog's own revision checks.
- `modelEnabled = !!dynamicModel`, `voiceEnabled = !!catalogTranscriber`, `transcriber = catalogTranscriber`.
- `runModel` refuses when `!dynamicModel`, as before for the catalog case.
- `model` keeps only the existing `dynamicModel` stub (`decide` throws `model_unavailable`). NIAR-240 removes it together with the interpreter path.
- `tools` becomes an empty registry (`has: () => false`, `invoke` throws `ToolError("tool_forbidden")`). `MobileRuntime.tools` stays in the type because `apps/fixture-server/model-service.ts` and server info read it. NIAR-240 deletes the field.
- In `apps/fixture-server/http.ts`, `accountModels` is constructed with `router: undefined`, so an account scope can never fall back to the operator's `options.model`. Without a catalog model, the result is the existing settled "no model" refusal.

### D4. Planner removal keeps historical drain behavior

`createDrainCatalogRuntime` stops reading `routing.planner`. For a command with a saved turn it continues by `cached.kind`, unchanged. For a command without a saved turn (which production never sends to the drain runtime) it now uses an explicit trusted parameter `newTurnKind?: "agent" | "progressive" | "legacy"`. Without that parameter it refuses with `409 catalog_runtime_unsupported`. Only test fixtures that create historical turns pass it (`tests/helpers/legacy-catalog-http.ts`, `legacy-native-continuity-http.ts`, `native-budget-failure-http.ts`, `tests/legacy-inventory-snapshot.node.ts`, `tests/legacy-catalog-migration.node.ts`), mapping their old `planner` choice. Alternative: keep `planner` as a hidden stored field for tests. This was rejected because it keeps the field alive in the schema and storage.

### D5. Enrollment: one path, one test helper

- Server: the routes and store methods listed in Context are removed. `IdentityService.pairMobile`, `browserLogin` and the `/v1/auth/browser/*` block in `apps/fixture-server/http.ts` (with its `browserAttempts` limiter) go. In `auth/pair`, the account branch goes. The fixture branch (`auth.pair` for `a`/`b`) stays for NIAR-240, and an account workspace path now answers `404 not_found`. The `/admin/api/identity/mobile*` and `/admin/api/identity/device/*` routes fall through to the existing 404. `apps/server-admin/http.ts` removes `device` from the UI route pattern, and the console removes `device-login.tsx`, the `/device` route, the `devicePage` branch in `App.tsx` and the `DeviceLogin` mock in `tests/web-owner-setup.test.tsx`.
- New `tests/helpers/app-enrollment.ts`:
  - `enrollApp({ origin, browser, organizationId, workspaceId })` runs `POST /v1/auth/app/start` with a fresh S256 challenge, then `POST /admin/api/identity/app/consent` with the browser cookie and same-origin `Origin`, then `POST /v1/auth/app/exchange`. It returns `{ address, credential }`, a renewable `agent-device-session/1` credential that is exactly what the old pairing gave with `?session=agent-device-session/1`.
  - `webCredential(...)` wraps `POST /admin/api/identity/app/session` for tests that used session-bound, non-renewable pairing.
  - Tests that asserted the 8-slot limit through pairing use `enrollApp`.
- QA bootstraps (`scripts/mobile-emulator-qa.mjs`, `scripts/process-mobile-web-qa.mjs`, `scripts/process-pipeline-web-qa.mjs` via `tests/helpers/process-pipeline-http.ts`/`process-mobile-integrated-http.ts` `issuePairing`, `tests/helpers/process-mobile-web-app.tsx`, `tests/helpers/mobile-emulator-entry.tsx`) drive the real `Connections.signInWithApp`. The `authorize` callback posts the authorization URL's id to a loopback bootstrap endpoint. That endpoint performs the consent with the seeded browser session and returns `{ code, state }`. This exercises the shipping sign-in instead of the backdoor.
- Client: `packages/client-core/browser-login.ts` and `Connections.signInWithBrowser`, the `browserLogin` state, and the `browserLoginRequest` import are deleted, together with `ConnectionCard`'s `onPair`, `onOpenBrowser` and `browserLogin` props, its `BrowserConfirmation` story, `App.tsx` `connect`/`openBrowser`, and i18n keys used only by them (`pairingCode`, `browser_login_denied`; check each with grep). `browser_login_expired` stays because app consent uses it. `Connections.pair` and `authRequest(..., "pair")` stay for NIAR-240 (see the boundary).

### D6. Protocol and console leftovers

- Deleted: `packages/protocol/workspace-ai.ts`, `workspace-calendar.ts`, `browser-login.ts`.
- `connections.ts` shrinks to `WorkspaceTarget`, which is moved to `packages/protocol/identity.ts` with re-exports updated in `memory.ts` and `workspace-plugins.ts`. The file is then deleted.
- `mobile-access.ts` keeps `AccountWorkspaceId` and `isAccountScope`.
- `OrganizationDetailSchema` (`packages/protocol/identity.ts`) loses `connectionCount`/`toolCount`. The workspace row in `identity-pages.tsx` shows the member count only, and `tests/loops-admin-fixtures.ts` is updated.
- `CatalogSchema` loses `legacyVoiceAvailable`, and `CatalogController` loses its constructor callback.
- In the console, `ModelSelect` loses `legacy`, `overview-page.tsx` loses the "server default" voice row branch, and `apps/server-admin/web/i18n.ts` loses the copy used only by connections, AI profiles, calendars, mobile pairing and the legacy voice option (`connection*`, `originsMissing`, `mobile*`, `legacyVoice`, …). Audit labels stay.

## Boundary with NIAR-240

NIAR-240 (remove the fixture interpreter) is written in parallel and lands after this change. Shared files and who does what:

| Shared code | NIAR-239 (this change) | Left for NIAR-240 |
| --- | --- | --- |
| `apps/fixture-server/http.ts` | removes `/v1/auth/browser/*`, the account branch of `auth/pair`, `pairMobile`/`browserLogin`/`calendarTarget`/`executeCalendar` from the identity `Pick`, the account branch of the storage calendar-target callback (account scopes get `undefined`), the identity executor passed to `CalendarWorker`. Sets `accountModels`' router to `undefined` | `auth/pair` for `a`/`b`, `FixtureAuth`, `CalendarWorker`, `FixtureStorage` calendar targets, server info `contacts`/`calendar`/`demo-phrases` (`agent-server-info/3`), `ModelService` |
| `apps/server-identity/service.ts` | removes `calendarTarget`/`executeCalendar` (their store is deleted here), AI-profile `services`, connection tools, the routes | the `dynamicModel` interpreter stub in `model`, `MobileRuntime.model`/`tools` fields |
| `apps/server-identity/mobile.ts` | pairing-code and device-code methods and tables | `MobileRuntime` type members used by `ModelService` |
| `apps/reference-server/config.ts`, `runtime.ts` | `aiProfiles`, `mobile.model/voice`, `calendarCollections`, `connectionOrigins`, `attachAI`, the AI profile loading | the `adapters` block (`twenty-test`, `caldav`, model/voice adapters), `inspectServerServices` rows |
| `apps/server-tools/*`, `apps/fixture-server/twenty.ts` | stop being imported by `connections.ts` (deleted) | deleted by NIAR-240 (still used by `ModelService` and `engine.ts`) |
| `packages/client-core/connections.ts`, `auth.ts` | `signInWithBrowser`, `browserLogin` state | `pair`, `authRequest("pair")`, `PairingRequestSchema`/pairing `AUTH_PROFILE` users, client tests `auth-client.test.ts` and `device-session-client.test.ts` that pair with `/v1/a` |
| `packages/protocol/mobile-access.ts` | `MobilePairingTarget`, `MobilePairingResult`, `MobileWorkspaceStatus` | `isAccountScope` (fixture storage and calendar import it) |
| specs | `app-pairing`: removes "Legacy enrollment endpoints", adds "Only browser sign-in enrolls an app". `deployment`: adds "Retired profile fields" (a new requirement, so it does not collide with NIAR-240's edit of "Profile validation") | `app-pairing` "Server information", `deployment` "Profile validation" |

NIAR-240's proposal names `calendarTarget`/`executeCalendar` among its own edits. After this change they no longer exist, so NIAR-240 only removes the remaining fixture side.

## Risks / Trade-offs

- [A hand-written production profile carries a retired field, and the upgraded container refuses to start] → The named message, the upgrade note in `docs/guides/deployment.md` asking operators to run `docker compose run --rm --no-deps niaro check` with the new image first, and the existing rollback (previous image on the same volume works because the dropped tables are only read by the old image's removed features).
- [A workspace that really used AI profile chat or the server profile voice loses it] → Expected. The model choice page shows the speech choice as Off and chat as "no model", and an administrator picks catalog models. For the pilot, check the production identity database for rows in `agent_workspace_ai` with a non-null selection before the upgrade (one SQL query, listed in tasks).
- [Rollback after the drop] → The previous image recreates the dropped tables empty (`CREATE TABLE IF NOT EXISTS`). Lost data: AI selections, TEST connections and CalDAV links, none of which the current UI shows. A full rollback restores the pre-upgrade backup, as the deployment guide says.
- [Migrating about 20 test files to a new enrollment helper hides a behavior change] → The helper goes through the production routes. The old pairing-specific assertions are deleted with their feature, and slot-limit and refresh behavior stay covered by `tests/app-login.node.ts` and `tests/device-sessions.node.ts`.
- [Moving the policy epoch store changes a private field that tests reach into] → One mechanical rename (`identity["connections"]` → `identity["policy"]`). Table and SQL are unchanged.
- [The empty `tools` registry and the `dynamicModel` stub remain as temporary seams] → They are documented here, and NIAR-240 removes them.

## Migration Plan

1. Deploy as usual. At first start, the server drops the six tables and reads routing in normalized form. No operator action is needed unless `check` reports retired profile fields.
2. Before the upgrade, run `niaro check` with the new image against the mounted profile. Optionally list workspaces that used AI profiles: `SELECT workspace_id, model_id, voice_id FROM agent_workspace_ai WHERE model_id IS NOT NULL OR voice_id IS NOT NULL;`.
3. Rollback: start the previous image on the same volume. Removed features come back empty. Or restore the pre-upgrade backup.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` (Jest: client-core, `ConnectionCard`, console pages), `npm run test:identity` (the trimmed list), `npm run test:deployment`, `npm run test:legacy-inventory`, `npm run test:legacy-continuity`, `npm run test:process-restore`, `npm run test:mcp`, `pnpm admin:build`, `npm run smoke`.
- New and changed tests:
  - `tests/server-config.test.ts`: each retired field is refused with its path named and no value printed, several fields are listed together, and `mobile.sessionIdleDays` alone stays valid.
  - `tests/retired-legacy-apis.node.ts` (new, added to `test:identity`):
    - every retired route (`/admin/api/identity/ai`, `/calendar`, `/connections`, `/connections/command`, `/connections/invoke`, `/mobile`, `/mobile/pairing`, `/mobile/revoke`, `/device/inspect|release|consent`, `/v1/auth/browser/start|poll|cancel`, `/v1/{accountWorkspace}/auth/pair`, `/admin/device`) answers 404 for an owner, and no table row is created;
    - startup drops the six tables from a seeded old database and keeps `agent_org_policy` and its revision;
    - an old activity log entry (`connection.created`, `workspace.ai_changed`, `tool.invoked`) is still listed and labeled, and `category=tools` still includes it;
    - a stored routing row with `planner` and `voiceMode: "legacy"` reads as `voiceMode: "disabled"`, and a new chat command still runs on Mastra (this replaces `tests/mastra-integration.node.ts`'s planner case);
    - a `saveRouting` with `planner` fails as invalid input.
  - `tests/service-catalog.node.ts` and `tests/catalog-voice.node.ts`: the legacy voice mode cases are removed or rewritten to the Off reading.
  - An account workspace without a catalog model, on a server whose instance `adapters.model` is configured, refuses chat with the settled "no model" result. Add this to `tests/answer-stream-http.node.ts` or the new file.
- UI check (console, EN and CS, 1440 px and 390 px): the Model choice page has no "Server profile" voice option and shows Off for a migrated workspace, the Overview voice row says Off, the Workspaces list shows member counts without connection or tool counts, and `/admin/device` is 404. Mobile and web app: the sign-in card shows only "Continue with browser", in its normal and expired states.

## Open questions for the owner

- Production check: does the pilot instance (aa.f-tuma.dev) run with a mounted profile or the automatic one, and does any workspace have a stored AI profile selection? Default assumption: automatic profile and no selections, so nobody loses a working feature. The task list includes the SQL check before rollout.
- Dropping credentials: this design deletes the sealed TEST Twenty keys and CalDAV passwords at upgrade instead of keeping them unreadable. Default: delete them, because they can no longer be managed. Revoke them at the provider too if they were real.
