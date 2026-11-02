# Design: Remove the fixture interpreter (NIAR-240)

## Context

See proposal.md for the motivation. The core problem is structural. `apps/fixture-server` started as a test fixture, but today it is three things in one directory, and only one of them is fixture.

1. **The product host and workflow store.** `http.ts` `createFixtureServer()` is the production HTTP server. `apps/reference-server/runtime.ts` `createReferenceServer()` returns it, and `cli.ts start` listens on it. It serves `/healthz`, MCP, administration, app login, every `/v1/{workspace}/…` route and the command route. `storage.ts` `FixtureStorage` is the transactional workflow store for every account workspace: `workflow.sqlite`, receipts, events, chat directory (`conversation-history.ts`), sessions, search (`chat-search*.ts`) and `legacyQuestionProof`/`syncNativeWork` for the native task window. `engine.ts` `FixtureEngine` applies every command to that state, including the product commands `conversation.*`, `work.cancel`, `task.open`, `service.resolve` and a `message.send` carrying a native interpretation. `model-service.ts` `ModelService` is the bridge from a command to the Mastra runtime (`access.integrations`), and `apps/server-mcp/tasks.ts` and the trust harness use it too. `auth.ts` `FixtureAuth` owns the server identity (`auth/server-id`, `fixture-<24 hex>`). That identity is part of every stored account scope and of every device grant (`grant.server_id`), and `FixtureAuth` also rate-limits sign-in starts. `answer-stream.ts`, `voice*.ts`, `speech-queue.ts`, `operator-log.ts` and `process-event-visibility.ts` are product.
2. **The fixture interpreter.** This is everything that answers without Mastra:
   - The deterministic phrases and contact choice in `engine.ts` `handle()` (`choosePeter`, `unsupported_phrase`).
   - The OpenRouter `DecisionRouter` interpreter (`decision.ts`, `openrouter.ts` `OpenRouterModel`, and the `ModelService.executeInternal` branch after `if (!router)`).
   - The `input.submit`, `proposal.decide`, `proposal.revise` and `operation.reconcile` commands (`engine.ts` `proposalCommand`, `prepareProposal` and `patchMeeting`).
   - The calendar effect: `calendar.ts` `CalDavCalendar`/`CalendarWorker`, `engine.ts` `tick`/`claimCalendar`/`completeCalendar` and the 250 ms timer in `http.ts`.
   - TEST contacts: `twenty.ts`, `apps/server-tools/contacts.ts` and the `crm_contacts` decision.
   - Fixture memory and drafts: `conversation-memory.ts`, plus the `meetingDrafts`, `conversationMemory*`, `recentContacts`, `meetingContacts` and `conversationContacts` fields of the engine `DatabaseSchema`.
3. **Operator workspaces.** These are the scopes `/v1/a` and `/v1/b` (`connectionId: fixture-a|b`). They are paired with `issuePairingCode` (`npm run server:pair`, `fixture:pair`), authenticated by `FixtureAuth.authenticate`/`sessions.json` and imported from the old JSON layout by `storage.ts` `importLegacy`/`migrate.ts`. Their entry points are the dev server `index.ts`, `pair.ts` and `reset.ts`, and their profiles are `servers/personal.json` and `servers/team.json` (no `administration.identity`).

**How an account workspace reaches the interpreter today.** `service.ts` builds the per-request `MobileRuntime` with `integrations: createCatalogRuntime(…, enabled = !!dynamicModel, legacyEnabled = !!services.model, …)`. `ModelService.executeInternal` sends a `message.send` to Mastra only when `access.integrations.enabled || hasTurn(…)` and the context is absent or `runtime: "mastra"`. If a workspace has no catalog model but an AI-profile model (`services.model`, instance sharing or `aiProfiles`), the command falls through to `router.decide()` (`bridge.model`). From there it can produce `crm.contacts` cards (through the `bridge.tools` TEST contact grants from `connections.ts`) and meeting proposals, and write to the workspace CalDAV calendar (`identity.calendarTarget`/`executeCalendar`, `workspace-calendar.ts`). Tests exercise this path: `mobile-identity.node.ts` ("explicit CRM binding…"), `workspace-ai.node.ts`, `workspace-calendar.node.ts` and `connections.node.ts`. Its configuration surface (AI profiles, workspace CalDAV API, TEST contacts connections) is what `niar-239-remove-legacy-admin-apis` removes.

**Legacy engines `agent-1`/`progressive-1` are a different layer.** They are the pre-Mastra catalog runtimes of account workspaces: `apps/server-identity/agent-runtime.ts`, `progressive-runtime.ts`, `catalog-runtime-legacy.ts` (`createDrainCatalogRuntime`), `legacy-question.ts`, `legacy-run-inventory.ts` and `npm run inventory:legacy`. They only drain saved turns, and their questions continue into `mastra-1` (`legacyQuestionProof`). They do not use `decision.ts`, the engine's proposals or the operator scopes. **They are not part of this removal.** Retiring them needs its own stored-data decision (drain proof, inventory) and is left to a follow-up change. This change keeps `FixtureStorage.legacyQuestionProof` and the `legacyEnabled` argument intact.

## Goals / Non-Goals

**Goals:**
- No code path answers, writes a calendar or reads contacts without Mastra. The app API serves account workspaces only.
- The protocol, the clients and stored data carry no fixture entities.
- Every product behavior that tests previously guarded through the fixture path is still guarded, now on an account workspace.
- Each stage leaves `npm run check` and `npm run test:identity` green, except the 12 named NIAR-233 failures.

**Non-Goals:**
- No new user-facing feature and no change to Mastra agent behavior, approvals, receipts or memory.
- No renaming of `apps/fixture-server`, `FixtureStorage`, `FixtureEngine`, the `fixture-…` server id, the `fixture_error` error code or `EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES`. These are names only, and renaming would collide with the parallel changes. See Open questions.
- No removal of the `agent-1`/`progressive-1` legacy engines or the legacy question continuity.
- Nothing from NIAR-239 (below).
- No fix for NIAR-233.

## Boundary with NIAR-239

This section mirrors the boundary table in `openspec/changes/niar-239-remove-legacy-admin-apis/design.md`. NIAR-239 removes the configuration and administration side, plus the account-side seams into the workflow. NIAR-240 removes everything that remains on the fixture side. Nothing is claimed by both changes, and nothing by neither.

| Shared code | Done by NIAR-239 | Done by NIAR-240 (this change) |
| --- | --- | --- |
| `apps/fixture-server/http.ts` | Removes `/v1/auth/browser/*` and the account branch of `auth/pair`. Removes `pairMobile`/`browserLogin`/`calendarTarget`/`executeCalendar` from the identity `Pick`. The storage calendar-target callback returns `undefined` for account scopes, and the identity executor is no longer passed to `CalendarWorker`. Builds `accountModels` with router `undefined`. | Removes `auth/pair` for `a`/`b`, the remaining `FixtureAuth` pairing and sessions, `CalendarWorker` and the tick timer, the `FixtureStorage` calendar targets and the instance `models`. Moves server information to `agent-server-info/3`. Changes `ModelService` (router parameter and decide path deleted). |
| `apps/server-identity/service.ts` | Removes `calendarTarget`/`executeCalendar` with their store, AI-profile `services`, connection tools and the routes. | Removes the `dynamicModel` interpreter stub passed as `model`, and stops passing `model`/`tools`. |
| `apps/server-identity/mobile.ts` | Removes pairing-code and device-code methods and tables. | Deletes the `MobileRuntime.model` and `MobileRuntime.tools` fields and the `DecisionRouter`/`ToolRegistry` type imports. |
| `apps/reference-server/config.ts`, `runtime.ts` | Removes `aiProfiles`, `mobile.model/voice`, `calendarCollections`, `connectionOrigins`, `attachAI` and AI-profile loading. | Owns the `adapters` block: `twenty-test` and `caldav` are refused, and the model and voice adapters stay as they are. Owns the `inspectServerServices` rows and `OpenRouterModel`/`configuredModel`. |
| `apps/server-tools/*`, `apps/fixture-server/twenty.ts`, `calendar.ts`, `decision.ts` | `connections.ts` and `workspace-calendar.ts` are deleted, so these files lose their identity-side importers. | Deletes `server-tools/contacts.ts`, `twenty.ts` and `calendar.ts`. Shrinks `decision.ts` to `ModelError`. Keeps `server-tools/registry.ts` only while `ToolError` is used. |
| `packages/client-core/connections.ts`, `auth.ts`, `ConnectionCard`, `App.tsx` | Removes `signInWithBrowser`, `browserLogin` state, `ConnectionCard` `onPair`/`onOpenBrowser`/`browserLogin` and `App.tsx` `connect`/`openBrowser`. | Removes `Connections.pair`, `authRequest("pair")` and `PairingRequestSchema` with its remaining users. `AUTH_PROFILE` stays, because it is the account session's auth profile. Adds the `restore()` account-scope guard. Updates the `/v1/a` pairing tests `auth-client.test.ts` and `device-session-client.test.ts`. |
| `packages/protocol/mobile-access.ts` | Removes `MobilePairingTarget`, `MobilePairingResult`, `MobileWorkspaceStatus`. | Keeps `isAccountScope`, which the workflow storage still uses. |
| Tests on the account interpreter | Deletes or rewrites `workspace-ai.node.ts`, `workspace-calendar.node.ts`, `connections.node.ts` and the pairing and AI-profile subtests of `mobile-identity.node.ts`. | Moves the remaining `mobile-identity` subtests off any `decide()` stub if 239 left one, and removes the legacy `/v1/a` block. |
| Specs | `app-pairing`: "Legacy enrollment endpoints" removed, "Only browser sign-in enrolls an app" added. `deployment`: "Retired profile fields" added. | `app-pairing` "Server information"; `deployment` "Profile validation", "Private configuration files", "Account profile without test adapters". |

**Ordering: NIAR-240 lands after NIAR-239.** Task 1.1 checks this. Stages 2 and 3 do not touch any NIAR-239 item and may proceed before 239 merges. Stage 4 and later **wait for NIAR-239**: removing the decide path or the calendar files earlier would break 239's still-present account code and tests, and this change does not take over 239's removals. If 239 is still open when stage 4 is due, the work pauses after stage 3 (a valid, green state), and the PR notes the dependency.

## Decisions

### D1. Keep the host and store, delete the interpreter inside them

This change removes code from `http.ts`, `engine.ts`, `storage.ts` and `model-service.ts` instead of rewriting them.

| File | Disposition |
| --- | --- |
| `apps/fixture-server/http.ts` | **Keep, trim.** <br>• Drop: the non-account branch (`["a","b"].includes(workspace)`, `auth.authenticate`, `auth.pair`, `auth.revoke`), the instance `models` ModelService and `options.model`/`crm`/`calendar`/`calendarTransport`, `CalendarWorker` and the 250 ms `storage.tick()`/`worker.tick()` timer. <br>• `bridge` becomes mandatory. A non-account path is a `404` before authentication. |
| `engine.ts` | **Keep, trim.** <br>• Drop: `proposalCommand`, `prepareProposal`, `patchMeeting`, `saveMeetingContacts`, `parameters`, `tick`, `claimCalendar`, `completeCalendar`, `cancelDemoWork`, the `context.runtime !== "mastra"` branch, the `decision.kind === "meeting"`/`new_topic`/`meeting_patch` branches, the demo phrases and `choosePeter` import, `remember`/`currentMemory`/`modelState`, and the fixture fields of `DatabaseSchema` (`pending`, `nextWork`, `meetingDrafts`, `conversationMemory*`, `*Contacts`). <br>• `Interpretation` carries `reply` instead of a `Decision`. <br>• `isOpenWork` loses the fixture-calendar clause. |
| `storage.ts` | **Keep, trim.** <br>• Drop: `calendarFor`, `tick`, `calendarJobs`, `claimCalendar`, `completeCalendar`, `modelState` and `importLegacy`. <br>• `validateScope` accepts account scopes only. <br>• Add the v2 migration (D5). |
| `migrate.ts` | **Delete in stage 5.** Its pre-SQLite JSON layout belongs to operator scopes only, but `load()` still uses it to map older stored snapshot profiles until the v2 migration (D5) takes that over. |
| `model-service.ts` | **Keep, trim.** <br>• Drop: the `router`/`crm` constructor arguments, `createContactTools`, `describeTools`, the `"crm"` activity stage, `historyText` for `crm.contacts`, and everything after `if (command.type !== "message.send")` that calls `router.decide()`. <br>• An account command that does not reach Mastra gets the existing settled refusal: the `!router` branch, `integration_unavailable` with the `model_unavailable` reply. <br>• A `message.send` with any `context` goes to the native runtime. `runtime` stays optional on the wire, so stored receipts stay parseable. |
| `auth.ts` | **Keep `serverId`, `rateLimit` and `AuthError`.** <br>• Drop `issuePairingCode`, `pair`, `authenticate`, `revoke`, `sessions.json`, the pairing grants directory and the profile remapping. <br>• Startup deletes the leftover `sessions.json` and pairing grant files. <br>• `auth/server-id` is read and kept byte for byte (D6). |
| `decision.ts` | **Shrink to `ModelError`** (used by `service.ts`, `voice-openrouter.ts`, `server-mcp/tasks.ts` and `http.ts`). `DecisionRouter` goes together with `MobileRuntime.model` (see Boundary). <br>• Delete `DecisionSchema`, `ContextDecisionSchema`, `MeetingDraftSchema`, `ModelInput` and `localToUtc`. |
| `openrouter.ts` | **Keep** `loadOpenRouterConfig`, `reserveModelRequest` and `limitedJson` (used by `voice-openrouter.ts` and `scripts/test-openrouter-voice.ts`). <br>• Delete `OpenRouterModel`/`configuredModel`. After NIAR-239 removes instance model sharing, nothing calls `decide()`. `adapters.model` `openrouter` stays a valid profile value but loads nothing (see D9 and Open questions). |
| `calendar.ts`, `conversation-memory.ts`, `twenty.ts`, `index.ts`, `pair.ts`, `reset.ts` | **Delete.** `calendar.ts` and `twenty.ts` go in stage 4, after NIAR-239 has removed their identity-side importers. |
| `apps/server-tools/contacts.ts` | **Delete.** <br>• `registry.ts` stays while `service.ts` uses `ToolError` and `mobile.ts` uses `ToolRegistry`. |
| `apps/reference-server/runtime.ts` | **Drop** the `crm`/`calendar` adapters and their rows in `inspectServerServices`. <br>• `createReferenceServer` requires `identity`. |
| `config.ts` | **Require** `administration.identity`. <br>• `adapters.crm` accepts `disabled` only and `adapters.calendar` accepts `simulated` only, so existing profiles keep loading. <br>• Drop the "CRM requires a model interpreter" rule. |
| `cli.ts` | **Drop the `pair` mode** and the `/v1/a` start message. |
| `apps/server-identity/service.ts`, `mobile.ts` | **Drop** the `dynamicModel` `model` stub left by NIAR-239, the `model`/`tools` hand-over and the `MobileRuntime.model`/`tools` fields. `calendarTarget`/`executeCalendar` are already removed by NIAR-239. Drop the leftover `CalendarOutcome` import if it remains. |
| `packages/protocol` | **See D3.** <br>• `admin.ts`: `AdminServiceId` loses `crm`/`calendar`, and `tools` is removed from the overview. |
| `packages/test-fixtures` | **Delete** `choosePeter`, `meetingProposal` and `crmContactResult`. <br>• `scopeFor()` defaults to an account-shaped scope. |

*Alternative considered:* move the product parts into a new `apps/server-workflow` first, then delete the directory. This was rejected for this change. It doubles the diff, collides with the parallel changes (239, 242, 243) on every import, and does not reduce risk. A rename can follow as a mechanical change (Open questions).

### D2. Account path never falls back to an interpreter

NIAR-239 already builds the account `ModelService` with no router, so no account scope can reach `decide()`. This change deletes the router parameter and the decide path. After that, `ModelService` has one outcome for `message.send`, `task.open` and `service.resolve` in an account workspace: the native runtime (`integrations`), or a settled refusal when no catalog model is enabled and no saved turn exists. The refusal is `422`, `integration_unavailable`, with the "model unavailable" reply. This is the same as the existing behavior for a workspace without any model, so smoke step "message.send: 202/422/503" is unchanged. *Alternative:* keep the interpreter for workspaces that only have an AI-profile model. This was rejected because NIAR-239 removes AI profiles, and the interpreter is the thing being removed.

### D3. Protocol: remove fixture entities and bump the profile

- `packages/protocol/index.ts`:
  - Remove `CrmContactSchema`/`CrmContactResultSchema` from `MessageResultSchema`, and remove `InputRequestSchema`, `CalendarTargetSchema`, `CalendarErrorSchema`, `MeetingParametersSchema`, `ActionProposalSchema`, `OperationSchema`, `ProposalContextSchema`.
  - Remove the event variants `input_request.upserted`, `action_proposal.upserted` and `operation.upserted`.
  - Remove the snapshot arrays `inputRequests`, `actionProposals` and `operations`, together with their `superRefine` checks.
  - Remove the work item fields `demo`, `inputRequestIds`, `actionProposalIds` and `operationIds`. The work refine now requires `native`.
  - Remove the commands `input.submit`, `proposal.decide`, `proposal.revise` and `operation.reconcile`.
  - Move `PROFILE` to `agent-client/0.9`.
- `CommandResultSchema.code` keeps `invalid_answer`, `unsupported_phrase` and `invalid_proposal`, so stored receipts stay parseable. No new result produces them. `InputContextSchema.runtime` stays optional for the same reason.
- `MessageSchema` keeps `inputRequestId`, because it is the native question id on the question message.
- `message-delivery.ts`: `BASELINE_MESSAGE_RESULTS` drops `crm.contacts/1`.
- `server-info.ts`: `agent-server-info/3`. `configuredServices` becomes `{ interpretation: "model" | "disabled", voice }`, and `componentCatalog` becomes `{ "workflow.progress": 1, "service.action": 2, "card.document"?: 1 }`. No client reads server info today (searched apps/mobile, client-core, the admin web), so only the server and its tests change.
- `voice.ts`: `VoiceQuestionContextSchema` is unchanged on the wire. The server validates it against `native.question` only.

*Alternatives:*
- (a) Keep the arrays and always send them empty. This keeps old builds parsing, but leaves dead schema and refinements forever.
- (b) Remove the fields but keep the profile string. Old clients would then fail on a strict parse with an unclear error.

The pilot allows breaking old builds (owner rule), so the profile bump is chosen.

### D4. Clients follow the protocol in the same stage

- `packages/client-core`:
  - `commands.ts` loses `answerCommand`, `proposalDecision`, `reviseProposal` and `reconcileOperation`.
  - `store.ts` loses the `inputRequests`/`actionProposals`/`operations` maps. `selectReplyInput` and `selectTasks` use `native.question` only.
  - In `session.ts`, `commandTarget` loses the `input.submit`/`operation.reconcile`/`proposalId` branches.
  - `conversation-directory.ts` drops the `work.demo` guard, `connection-diagnostic.ts` prunes its field allowlist, and `voice.ts` uses the `NativeQuestion` type only.
  - `migrate.ts` maps `agent-client/0.8-fixture` (and the older ones) to the new `PROFILE`, so a stored credential survives. A cached snapshot or pending outbox command that no longer parses is discarded (cleared, not `storage_error`), because the server re-sends the snapshot.
  - `connections.ts` `restore()` drops a stored credential whose scope is not an account scope.
- `apps/mobile/App.tsx`:
  - Remove the fixture command imports and `crm.contacts/1` from `MOBILE_MESSAGE_RESULTS`.
  - Remove the proposal, operation, contact-form, reconcile and revise wiring in `renderWork`, and the `CrmContactResults` branch.
  - Remove the calendar-derived `meetings`/`scheduled` list (also `MeetingLibrary.tsx` `scheduled` and i18n `meetingsScheduled`).
  - The dev default address `http://localhost:8787/v1/a` becomes empty.
  - Keep `quickMeeting`/`meetingStarter`: it is a chat starter that Mastra serves with Microsoft 365.
- `packages/ui-catalog`:
  - Delete `ActionApprovalCard`, `MeetingFacts` and `InputRequestForm` (move its `FormState` type first), the `CrmContactResults` export and their stories.
  - `WorkItemCard` and `WorkItemSummary` lose the fixture props and the `demoResult` line. `CrmContactCard` stays, because `ServiceActionCard` uses it for service action results.
- `apps/server-admin/web`:
  - `app/chat-work.tsx` loses `ContactChoice`, `ProposalReview`, the calendar icon and `demoResult`.
  - `app/chat-session.ts` drops `crm.contacts/1`.
  - `app/chat-next/transport.ts` and `parts.tsx` drop `niaro.contacts`. `chat-cards.tsx` `ContactList` stays (service actions).
  - The dead `["admin","calendar"]` query invalidations go. Audit labels `calendar.*` stay, because historical audit rows must still render.
- `packages/i18n` and `apps/server-admin/web/i18n.ts`: remove the fixture-only keys in EN and CS together (pairing code, contact list, calendar target/approval/operation, proposal, demo).

### D5. One-time workflow storage migration (`user_version` 1 → 2)

The migration runs in `FixtureStorage`'s constructor, inside the existing `BEGIN IMMEDIATE` block and before `history.migrate()`/`search.migrate()` return. It works on raw JSON, so it does not depend on the old schemas.

1. **Operator scopes.** Delete every row whose `scope_key` decodes to a non-account scope (`isAccountScope` false) from `workflows`, `events`, `receipts`, `conversation_sessions`, `process_answer_messages`, `conversation_session_command` and the chat directory tables (`public_conversation*`). Delete the matching search documents through the existing `ChatSearchIndex` delete path, so the FTS index stays consistent.
2. **Account workflow state.** For each `workflows.state`:
   - Remove the fixture entities: `snapshot.inputRequests`, `actionProposals`, `operations`, every work item without `native` (demo work), the fields `demo`, `inputRequestIds`, `actionProposalIds` and `operationIds` on the remaining items, and `pending`, `nextWork`, `meetingDrafts`, `conversationMemory`, `conversationMemories`, `conversationContacts`, `meetingContacts` and `recentContacts`.
   - On messages, clear a `workItemId` or `inputRequestId` that pointed to a removed item, and drop a `result` of type `crm.contacts`. The same `result` rule applies to `public_conversation_message` and `conversation_sessions.messages`.
   - Set `next_due` to `NULL`. The profile is not rewritten here. The migration lands one stage before the protocol bump (tasks 5 and 6), so `load()` maps any stored `agent-client/0.x-fixture` snapshot profile to the current `PROFILE`, the same way the old `migrateDatabase` mapped 0.2–0.7.
3. **Events.** Delete all stored events of each account scope and set `eventFloor` to the scope's cursor. A client holding an old cursor then gets `409 snapshot_required` and reloads (spec "Fixture state migration"). This is simpler and safer than rewriting retained events that embed removed entities.
4. **Receipts.** Delete the receipts whose `command.type` is one of the four removed commands. This follows the `card.respond` precedent already in `storage.ts`.
5. **Commit.** `PRAGMA user_version=2`, in the same transaction. An older server refuses a version-2 file (existing check `version !== 0 && version !== 1`), so rollback means restoring a backup.

The table DDL is left unchanged (`next_due` column and `workflows_due` index stay). `legacy-run-inventory.ts` compares the workflow schema and reads `metadata.server_id` and `workflows`/`receipts`, so changing the DDL would break `inventory:legacy` and its tests.

*Alternative:* tolerate the old shapes at read time instead of migrating. This was rejected because every strict schema would need a legacy variant forever.

### D6. Server identity is untouched

`auth/server-id` keeps its `fixture-<hex>` value and file. It is part of every stored `scope_key`, of device grants, of `metadata.server_id` (checked at open) and of the legacy inventory (`/^fixture-[a-f0-9]{24}$/`). Renaming it would orphan all data.

### D7. Tests: delete what only tests the fixture, port product guards first

Ported product guards land in stage 2, **before** any production code is removed. That way coverage never drops.

**Port to an account workspace** (through `createReferenceServer` with identity, the `coordinatorHttpFixture`, or `tests/agent-trust/harness.ts` `createTrustHarness`):
- Node tests:
  - `conversation-directory-client.node.ts`: both tests. Rename/delete/archive/restore across clients, and message times reaching only the client that asks. The `results=` assertion drops `crm.contacts/1`.
  - `work-cancel-client.node.ts`.
  - `request-interruption.node.ts`: the seven `ModelService`+`FixtureStorage` tests on `scopeFor("a")`, and the HTTP extension test on `/v1/a`. They move to the trust harness, and `input.submit` is replaced as the "non-model command" by `conversation.rename` or `work.cancel`.
  - `deployment.node.ts`: "health probes answer without credentials…" moves to `createReferenceServer`. "logged paths keep the route shape" uses a UUID path.
  - `server-settings.node.ts`: the CORS probe path.
- Jest:
  - `http.test.ts`, `card-http.test.ts`, `conversation-history-http.test.ts`, `chat-search-http.test.ts`, `conversation-directory-http.test.ts`, `model-http.test.ts`, `speech-http.test.ts`, `voice-http.test.ts` and `work-cancel-fixture.test.ts`.
  - `auth-http.test.ts`: only route protection is ported.
  - `chat-session.test.ts`, `conversation-session*.test.ts`, `storage.test.ts`, `storage-crash.test.ts` (and `helpers/crash-server.ts`), `automatic-speech.test.ts`, `native-retry-reload.test.ts`, `card-document.test.ts`, `activity*.test.ts`, `process-answer*.test.ts`, `connection-diagnostic.test.ts`, `reference-server.test.ts`, `server-admin.test.ts`, `session.test.ts` and `engine.test.ts`.
    - `engine.test.ts`: keep the native-guard, native-explanation, human-task and generic idempotency/restart/isolation cases.
  - For outbox tests that use `answerCommand`/`proposalDecision` as sample commands, switch the sample to `message.send`.
- Live scripts: `tests/voice-live.ts` (seed a native question instead of "Choose Peter") and `scripts/chat-history-web-qa.mjs`.

**Delete** (fixture only):
- Jest: `conversation-memory.test.ts`, `crm-meeting.test.ts`, `calendar.test.ts`, `approval.test.ts`, `twenty.test.ts`, `server-tools.test.ts`, `crm-profile-migration.test.ts`, `approval-card.test.tsx`, `crm-contact-card.test.tsx`.
- `model.test.ts`, except "wall times convert in Prague…" if `localToUtc` had another user. It has none, so the whole file goes.
- Live scripts: `tests/radicale-live.ts`, `scripts/test-openrouter.ts`, `scripts/test-twenty.ts`, `scripts/test-conversation-memory.ts`, `scripts/setup-radicale.py`, `scripts/init-radicale.py`, `scripts/radicale-requirements.txt`.
- The pairing parts of `auth-http.test.ts`, `auth-client.test.ts` and `device-session-client.test.ts`.
- `service-catalog.node.ts` "a newer legacy contact card prevents context from an older catalog card".
- The legacy `/v1/a` block in `mobile-identity.node.ts` "one-use codes…".

**Edit** (mechanical, stage 6):
- Snapshots built with `actionProposals: []` (`web-chat*`, `web-hub*`, `process-commands`).
- `components.test.tsx`, `chat-work-card.test.tsx`, `ui-shell.test.tsx`, `card-document-view.test.tsx`, `voice-draft.test.ts` and `meeting-library.test.tsx`: drop the fixture cases and keep the native ones.
- `native-task-window.node.ts`: re-seed without `choosePeter`.
- `conversation-session.test.ts`, `conversation-history.test.ts`, `message-delivery.test.ts` and `protocol.test.ts`: drop the `crm.contacts` payloads.

**Account-path interpreter tests that belong to NIAR-239:** the `mobile-identity.node.ts` subtest "explicit CRM binding, independent grants, cards and idempotency", `workspace-ai.node.ts` "model expiry during CRM I/O…", and `workspace-calendar.node.ts` and `connections.node.ts`. NIAR-239 deletes or rewrites them, and stage 4 waits for that (see Boundary). The other `mobile-identity` subtests use a `decide()` stub only as "a model". They switch to a catalog model with the synthetic provider, as `legacy-native-continuity-http.ts` already does.

### D8. NIAR-233 failures stay with NIAR-233

A baseline run of `test:identity` on the current tree (2026-10-29) gave 1922 tests: 1910 passed and exactly 12 failed. All 12 run on the **account/Mastra path**, through `coordinatorHttpFixture` or `createTrustHarness` with `mastra-1`. None of them touches the fixture interpreter, the operator scopes or `decision.ts`. This change therefore neither removes nor fixes them, and it must not change how they fail:

| File | Tests | Path | Failure |
| --- | --- | --- | --- |
| `conversation-delete-native.node.ts` | "an archived chat keeps its native memory, takes no turns and continues after restore in a fresh thread with its visible history" | Trust harness, Mastra | The archived request text is missing from the next model input |
| `legacy-native-continuity-http.node.ts` | "paired ClientSession continues an authentic restored {agent-1, progressive-1} read/question into one guarded native root ({direct, interleaved})" (4) | Account, legacy engines continuing into `mastra-1` | Call count 22 ≠ 24 |
| `mastra-native-fatal.node.ts` | "an answer prepared before fatal native retirement cannot publish success on restart"; "proven native retirement releases a permanently revoked captured actor through {interrupt, fresh-access}" (3) | Trust harness, Mastra | Count assertions |
| `native-budget-failure-http.node.ts` | "paired HTTP and ClientSession preserve {decision-unpriced, exhausted} budget failure in {en, cs}" (4) | Account, Mastra, catalog **decision model** (Jev checker), not fixture `decision.ts` | A plain reply instead of a budget explanation. This is consistent with NIAR-229 limiting the checker to writes |

"Decision" in the budget tests is the catalog's decision model (`kind: "decision"`, `routing.decision.enabled`). It is unrelated to `apps/fixture-server/decision.ts`. Every stage records the `test:identity` failure list. The stage is green when the list is a subset of these 12 titles (task 1.2).

### D9. Development and test support that stays

- `npm run server`, `server:check`, `server:admin-key`, `admin:build`, `smoke` and the trust evaluation (`eval:trust`) stay. The smoke test does not use the fixture interpreter: it signs up an owner, enrolls the app through account login and sends `message.send` to a Mastra account workspace (`scripts/smoke/api-journey.mjs`).
- `adapters.model: { "provider": "fixture" }` stays valid in profiles, as the way to say "no instance model". The provider name stays for profile compatibility. The `adapters` block belongs to this change (Boundary). `model` and `voice` keep their current values.
- The voice adapters, `voice:install`, `test:voice*`, the voice scripts and `.openrouter/config.json` stay. They serve meeting and voice transcription.
- `packages/test-fixtures` keeps the native, process, human-task and meeting fixtures.
- `scopeFor()` returns an account-shaped scope (`account-<uuid>` connection, UUID workspace), so client tests that only need a scope value keep working.
- Removed scripts:
  - `fixture`, `fixture:reset`, `fixture:pair`, `fixture:calendar`, `fixture:calendar:pair`, `fixture:voice`, `fixture:ai`, `fixture:integrations`, `fixture:gemini`
  - `server:pair`, `calendar:install|setup|start|init`, `test:calendar`, `test:crm`, `test:memory`, `test:models`
  - the files `servers/personal.json` and `servers/team.json`
- `.gitignore`/`.dockerignore`/`eslint.config.js` entries for `.fixture*`, `.radicale` and `.twenty` stay one more release, so stale local directories stay ignored.

## Risks / Trade-offs

- **[Account workspaces break because shared code is deleted]** → Stage 2 ports the product guards first. Each stage runs the full `npm run check` plus `test:identity` and `test:mcp`, and the trust harness and MCP tasks exercise `ModelService` on the account path. `FixtureAuth.serverId` and `rateLimit` are kept explicitly (D1, D6).
- **[The migration corrupts or loses chats]** → It runs in one transaction with the server lock held. It only removes listed fields and rows, and touches no conversation text. A test opens a v1 database seeded through the current code (account chat with a `crm.contacts` card, demo work, proposals, an operator scope, receipts of removed commands). It checks the chats, search hits, native work, other receipts and `409 snapshot_required` after reopening, and that a second open is a no-op. Backup before upgrade is the documented rollback (spec `deployment`, "Backup").
- **[Old phone builds stop working]** → Accepted at the pilot stage. The mobile app is updated in the same stage, and stored credentials survive the profile bump (D4).
- **[NIAR-239 and NIAR-240 diverge on shared seams]** → The Boundary table mirrors 239's table. Stage 4 and later wait for 239, and task 1.1 gates them.
- **[NIAR-233 failures mask a new regression in the same files]** → The failure list is compared by exact title, and a changed failure message in those files is investigated (task 1.2).
- **[Hidden users of the removed modules]** → `scripts/check-boundaries.mjs` and `npm run typecheck` fail on a dangling import. The client and server surveys behind this design listed every importer (Context, D4, D7).

## Migration Plan

1. Operators take a backup (`niaro backup`) before upgrading, as for any upgrade.
2. On first start the server migrates `workflow.sqlite` once (D5). It removes `auth/sessions.json` and any pending operator pairing files, and keeps `auth/server-id`.
3. A profile with `administration.identity` missing, or with the `twenty-test`/`caldav` adapters, fails `check`/`start` with a message naming the key (spec `deployment`). The shipped `examples/self-hosted/server.json` and the automatic profile need no change.
4. People update the phone app. The web app updates with the server.
5. Rollback: stop the server, restore the backup and run the previous image. An older server refuses migrated storage instead of misreading it.

## Verification

- Every stage runs:
  - `npm run check` (lint, typecheck, jest, `test:identity`) and `npm run test:mcp`
  - `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-240-remove-fixture-interpreter --strict`
  - The `test:identity` failure titles, compared with the NIAR-233 list (D8).
- New tests:
  - The storage migration (D5), in jest or `node --test`, with real `FixtureStorage`.
  - App API: `/v1/a/*` → 404; the four removed commands → `400 invalid_payload` with no receipt; `results=crm.contacts/1` ignored; `agent-server-info/3` shape; a `message.send` answer with a `context` that has no `runtime` goes to the native runtime.
  - Profile validation: no identity, `twenty-test`, `caldav`, and example profiles still loading.
  - client-core: the 0.8 credential survives, and a stale cached snapshot and outbox command are discarded.
- Live/QA:
  - `npm run smoke` (container, API and browser journey).
  - `npm run test:chat-history-web` after its port.
  - `npm run test:process-mobile-web` (mobile web harness).
- UI checks: the web chat at 1440 px and 390 px in EN and CS. Check the native question card, native approval card (approve/decline), process approval, service action result with contacts (`CrmContactCard` in `ServiceActionCard`), a migrated message that lost its contact card, Tasks, and Meetings without the "scheduled" list. Run the same on the phone app (Android emulator or `test:process-mobile-web`): home, chat with a question and an approval, Tasks, Meetings.

## Open Questions

These are recorded as decisions. The owner may overrule them without changing the task structure.

1. **Profile string.** Decision: `agent-client/0.9`, dropping the misleading `-fixture` suffix. The alternative is `agent-client/0.9-fixture`, which is purely cosmetic.
2. **Rename `apps/fixture-server` → `apps/server-workflow`** (plus `FixtureStorage`/`FixtureEngine`, the `fixture_error` code and `EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES`). Decision: not in this change. It is proposed as a follow-up mechanical change after 239/242/243 land.
3. **Legacy engines `agent-1`/`progressive-1`.** Decision: out of scope (Context). A follow-up change should decide when saved legacy turns may be dropped, and whether `legacy-native-continuity-http.node.ts` (4 of the NIAR-233 failures) is then deleted rather than fixed.
4. **Home "Prepare a meeting with …" starter.** Decision: keep it as a chat starter, because Mastra with Microsoft 365 can serve it. Removing it is a copy decision for the owner.
5. **`/admin/api/overview` `services`.** Decision: keep `model` and `voice` rows and drop `crm`/`calendar` and `tools`. No admin page renders these fields today, so dropping `services` entirely is also safe.
