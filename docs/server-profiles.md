> For a new installation use [self-hosting](self-hosting.md) and `examples/self-hosted/server.json`. The console now manages organization providers/models and workspace API/MCP services. The operator profiles below continue to configure built-in adapters.

# Configurable reference server — first foundation

The app renders its local component catalog and sends user commands. Interpretation, short-term memory, workflow transitions, permissions, integrations and credentials remain on the server. Local recording, draft editing, display formatting and transport validation remain client responsibilities.

`apps/reference-server` now assembles the existing tested HTTP/workflow core from an operator-owned JSON profile. This is a configurable reference implementation of the current fixture contract, not a completed general agent framework or web builder. Both example profiles use the same implementation; they are not two independently implemented backends.

## Start an independent instance

```sh
npm run server:check -- servers/personal.json
npm run server -- servers/personal.json
# Another terminal:
npm run server:pair -- servers/personal.json demo-user a
```

In the unchanged app, pair to `http://localhost:8794/v1/a` with the one-use code. Android emulator uses `http://10.0.2.2:8794/v1/a`. The profile permits the existing web previews on localhost 8081/8085. Try the deterministic phrase `Choose Peter` or `Schedule a meeting with Peter next week`; this profile deliberately enables no paid model, voice, external CRM or real calendar writes.

`servers/team.json` starts an independent instance on 8795 with `.servers/team` instead of `.servers/personal`. Each data directory owns its server identity, sessions, workflow, memory and receipts. Changing the display name preserves identity; choosing another data directory creates a separate server. A data directory may have only one running owner. Accounts and workspaces `a`/`b` remain isolated inside each instance.

## Profile format

The schema is `apps/reference-server/config.ts`, version 1. Unknown fields/providers, inline credentials, unsupported versions, malformed origins, invalid session limits and an unused CRM adapter without a model interpreter are rejected.

Optional `plugins: { "enabled": ["datetime"], "timeZone": "Europe/Prague" }` configures [internal tools for account-backed chat](internal-plugins.md). Defaults are `datetime` enabled and UTC; `enabled: []` disables them. Settings take effect on restart. This timezone is independent of legacy adapter model profiles. Operator plugins load from `<administration.identity.directory>/plugins/`; `administration.identity.pluginEditing: false` (or `NIARO_PLUGIN_EDITING=0`) makes them read-only in the console. See [plugins](plugins.md).

```json
{
  "version": 1,
  "name": "Personal assistant",
  "listen": { "host": "127.0.0.1", "port": 8794 },
  "dataDirectory": "../.servers/personal",
  "allowedOrigins": ["http://localhost:8085"],
  "sessionSeconds": 1800,
  "adapters": {
    "model": { "provider": "fixture" },
    "voice": { "provider": "disabled" },
    "crm": { "provider": "disabled" },
    "calendar": { "provider": "simulated" }
  }
}
```

Paths resolve relative to the JSON file, including absolute paths when supplied; they do not depend on the launch directory. Profiles are local operator input, never received from a model/client or fetched from a URL. Secrets belong in separately referenced owner-only files, using the existing [integration formats](adr/010-model-and-test-crm.md) and [calendar format](adr/008-local-caldav-integration.md). `.servers/` is ignored by version control. The checked-in example profiles contain no credentials.

| Adapter  | Supported configuration                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model    | `{ "provider": "fixture" }` or `{ "provider": "openrouter", "configFile": "../private/model.json" }`                                                                                                    |
| Voice    | `{ "provider": "disabled" }`, `{ "provider": "whisper.cpp", "assetsDirectory": "../.voice" }`, or `{ "provider": "openrouter", "assetsDirectory": "../.voice", "configFile": "../private/model.json" }` |
| CRM      | `{ "provider": "disabled" }` or `{ "provider": "twenty-test", "configFile": "../private/twenty.json" }`                                                                                                 |
| Calendar | `{ "provider": "simulated" }` or `{ "provider": "caldav", "configFile": "../private/calendar.json" }`                                                                                                   |

Text-model choice/timezone remain in its private OpenRouter configuration. Cloud voice currently selects the implemented Gemini adapter independently of the text model; it requires the existing local speech-filter assets. Pointing model and voice at the same private configuration preserves their shared budget database. Starting, checking or pairing makes no model request. Expiry, provider policy and request caps remain enforced by each adapter. Checking a profile validates local inputs/dependencies, not remote health, expiry, paid service availability or CalDAV credentials. Calendar identity/scope is checked at startup and again for operations.

The reference launcher binds only to loopback (`127.0.0.1` or `::1`); it is a local development foundation. Operator-owned profile changes take effect on restart. Production hosting/TLS and deployment management remain separate work. The account console can change the supported workspace policies below without restarting.

## Account and workspace identity

Optional `administration.identity` enables Better Auth accounts, organization roles, explicit workspace access and the account-to-app bridge. New workspaces start with no enabled model or speech recognition profile. An organization owner/admin selects them in **Models & voice**; ordinary members use that selection and cannot edit it through either the UI or API. Credentials and execution stay on the server.

The operator publishes named choices through `administration.identity.aiProfiles.models` and `.voices`, each defaulting to an empty list. Optional `mobile.model` / `mobile.voice` values of `instance` publish the existing adapter as another choice; they no longer enable it automatically for every workspace. **Previously opted-in workspaces require an explicit owner/admin selection after upgrade.** Named profiles use server-local private configuration files; selection never renews credentials or resets budgets. See [catalog configuration, migration and API](server-admin.md#workspace-models-and-speech-recognition) and [account setup](server-admin.md).

## Existing development instance

The 0.8 upgrade recognizes stored 0.7 workflow snapshots, legacy sessions and client caches. Migration preserves scope, history, pending jobs and original receipts; it applies to local persistence only and never accepts a mismatched wire profile. Restart the existing backend after updating its source. If sign-in succeeds but workspace data cannot load, the mobile notice identifies the failing phase, HTTP status and safe protocol/schema details. A stored sign-in is distinct from a working data connection. Stop the previous backend owner before starting a second instance against the same directory.

The private local profile `.servers/current.json` starts the existing assistant on 8793 with `.fixture-calendar`, Gemini, OpenRouter, Twenty TEST and Radicale references. Its credentials, expiry, budgets and calendar scope were preserved. The expired Twenty test window was not extended. It is not part of the checked-in examples.

The root `.env` can set `SERVER_PROFILE=.servers/current.json` as the default for starting and checking this profile. With that setting, use `pnpm server` to start it and `pnpm server:check` to validate it. An explicit profile argument overrides the default.

```sh
pnpm server:check
# Stop the previous owner of .fixture-calendar first, then:
pnpm server
npm run server:pair -- .servers/current.json calendar-user a
```

Back up the whole stopped data directory before changing startup ownership. Server tools add optional private contact snapshots and bounded recent-contact memory to database version 2, preserving existing identity/credentials. Backups must be restored before rolling back to an older binary that cannot read these fields. The public workflow profile stays 0.4. The legacy `fixture:*` launchers still work with the same data, but must never run concurrently against that directory.

## Server-side extension points

`loadServerAdapters(config)` constructs the built-in adapters; `createReferenceServer(config, adapters)` accepts trusted server-side implementations of the existing model/transcriber/TEST directory/calendar interfaces. For example, a developer-owned TypeScript bootstrap can replace `adapters.model` with a `DecisionRouter` before constructing the server. HTTP input, interpretation validation, scope checks, proposal revisions and durable storage remain in the shared core.

This API does not load code from JSON, evaluate remote scripts or let the model register tools. Additional workflow kinds or components need explicit server implementation and a compatible protocol/catalog change. The server now registers `crm.contacts.list` and `crm.contacts.search` through a typed allowlist when the TEST directory is configured. TEST contacts with validated email can become meeting participants; ambiguity is resolved by the existing client choice card. See [tool contracts and limitations](server-tools.md). Arbitrary remote tool/MCP registration, production policy editing and a web configuration builder remain future work.

## Discovery and verification

Configured instances provide authenticated `GET /v1/a/server` (or `/v1/b/server`) using the optional `agent-server-info/2` extension. It returns only display name, authenticated scope, current workflow profile, component versions and configured service categories. Calendar mode is projected for the authenticated account/workspace. It exposes no local paths, provider credentials, token, configuration file or executable UI. Configured support is not a grant or a promise that a provider is currently available. Older fixture-only servers may return 404. The mobile app does not need to consume this optional metadata to keep working.

`npm run check` now passes **370 tests / 47 suites**. The tool/contact follow-up adds typed tool permissions, canonical CRM participants, ambiguity, incomplete scans, missing email, late-result rejection and restart tests. EN/CS Chromium checks at 320/393/1001 px verify the unchanged card/command contract. These checks use controlled models/directories, not live CRM or paid inference.

The original foundation tests use two instances: Real HTTP tests use the existing `ClientSession` against two instances with a shared local cache, identical command IDs and different server identities. They cover pairing, token isolation, wrong scope/origin, read-only discovery, independent work, restart/rename, replay without duplication and the single-owner data lock. Additional tests cover private-file permissions, profile validation, dependency failures, custom server-side interpretation and calendar discovery scoped to the authenticated account. No paid provider or external calendar/CRM operation is used.

The running 8793 instance was restarted through its profile after a private stopped-server backup. All 30 stored scope counts/cursors were preserved and SQLite `quick_check` returned `ok`. The existing browser was paired again after its session expired; its latest 15:00 / 45-minute card remained intact. No client UI or native code changed, so native/export/visual regression matrices were not repeated.

For account calendars, `administration.identity.calendarCollections` publishes exact allowed CalDAV collection URLs (default empty). Owner/admin connects one calendar per workspace and explicitly enables role grants in the console. This is separate from the legacy `adapters.calendar` configuration; credentials and pending operations are never migrated into a company. Profile allowlist changes require restart; workspace configuration changes apply immediately. See [calendar setup, API and recovery](server-admin.md#workspace-calendar).
