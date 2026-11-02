# Tasks

Each group is a safe stage. After every group, `npm run check` and `npm run test:mcp` must pass. `npm run test:identity` may fail only with titles from the NIAR-233 list in design.md D8 (12 tests in `conversation-delete-native`, `legacy-native-continuity-http`, `mastra-native-fatal` and `native-budget-failure-http`). "Known-failure check" below means: run `npm run test:identity 2>&1 | grep '^✖'` and confirm every failing title is in that list. Spec validation is `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-240-remove-fixture-interpreter --strict`.

## 1. Baseline and preconditions

- [ ] 1.1 Check whether `niar-239-remove-legacy-admin-apis` is merged on the base branch. Once it is, `workspace-ai.ts`, `workspace-calendar.ts`, `connections.ts`, `calendarTarget`/`executeCalendar` and the account `auth/pair` branch are gone. Stages 2–3 may proceed either way. Stage 4 and later start only after 239 is merged (design.md "Boundary"); until then, stop after stage 3 and note the dependency in the PR. Verify with `git log --oneline | grep NIAR-239` and `test ! -e apps/server-identity/workspace-calendar.ts && ! grep -n calendarTarget apps/server-identity/service.ts`.
- [ ] 1.2 Record the baseline: run `npm run check` and the known-failure check on the base branch. Save the failing titles (expected: exactly the 12 of D8) in the PR description as the reference list for every later stage.

## 2. Port product guards off the fixture path (tests only, no production change)

- [ ] 2.1 Port `tests/conversation-directory-client.node.ts` (both tests) and `tests/work-cancel-client.node.ts` from `createFixtureServer` + `/v1/a` + `issuePairingCode` to an account workspace (`coordinatorHttpFixture` or `createReferenceServer` with identity and app login). Drop `crm.contacts/1` from the asserted `results=`. Covers `chat-delivery` "Account workspaces only" and the chat directory and work-cancel behavior. Check: `node --import tsx --test tests/conversation-directory-client.node.ts tests/work-cancel-client.node.ts`.
- [ ] 2.2 Port the seven `ModelService`+`FixtureStorage` tests on `scopeFor("a")` and the HTTP extension test of `tests/request-interruption.node.ts` to `createTrustHarness` and an account workspace. Use `conversation.rename` or `work.cancel` instead of `input.submit` as the non-model command. Check: `node --import tsx --test tests/request-interruption.node.ts`.
- [ ] 2.3 Port `deployment.node.ts` "health probes answer without credentials…" to `createReferenceServer` with identity, and use a UUID workspace in "logged paths keep the route shape". Change the CORS probe path in `server-settings.node.ts`. Check: `node --import tsx --test tests/deployment.node.ts tests/server-settings.node.ts`.
- [ ] 2.4 Port the HTTP jest suites that pair `/v1/a` to an account workspace through a shared jest helper (identity + app login), keeping their product assertions:
  - `http.test.ts`, `card-http.test.ts`, `conversation-history-http.test.ts`, `chat-search-http.test.ts`, `conversation-directory-http.test.ts`, `model-http.test.ts`, `speech-http.test.ts`, `voice-http.test.ts`, `work-cancel-fixture.test.ts`
  - The route-protection part of `auth-http.test.ts`

  Check: `npx jest --runInBand <those files>`.
- [ ] 2.5 Port the engine, storage and session jest suites that build `FixtureEngine`/`FixtureStorage` on a non-account scope, or that use `answerCommand`/`proposalDecision` as sample commands, to account scopes and `message.send` samples:
  - `engine.test.ts` (keep the native, human-task and generic cases), `storage.test.ts`, `storage-crash.test.ts` + `helpers/crash-server.ts`
  - `session.test.ts`, `chat-session.test.ts`, `conversation-session*.test.ts`, `automatic-speech.test.ts`, `native-retry-reload.test.ts`, `card-document.test.ts`, `activity*.test.ts`, `process-answer*.test.ts`, `connection-diagnostic.test.ts`, `reference-server.test.ts`, `server-admin.test.ts`

  Check: `npm test`.
- [ ] 2.6 Port `tests/voice-live.ts` (seed a native question instead of "Choose Peter") and `scripts/chat-history-web-qa.mjs` (account workspace). Check: `npm run test:chat-history-web`; `npm run test:voice` runs where the voice assets are installed, otherwise `npx tsc --noEmit -p .` covers it.
- [ ] 2.7 Stage gate: `npm run check`, `npm run test:mcp` and the known-failure check.

## 3. Remove operator workspaces and pairing

- [ ] 3.1 In `apps/fixture-server/http.ts`, serve `/v1/{workspace}/…` only for account workspace ids with identity. Drop the `["a","b"]` branch, `auth.authenticate`/`auth.pair`/`auth.revoke`, and the non-account fallbacks in `run`, `auth/session` and `commands/interrupt`. Add tests: `GET /v1/a/snapshot` → 404, and an operator token on an account path → 401 (`chat-delivery` "Account workspaces only"). Check: `npx jest --runInBand tests/http.test.ts`.
- [ ] 3.2 Reduce `apps/fixture-server/auth.ts` to the server identity, `rateLimit` and `AuthError`. Delete `issuePairingCode`, sessions and pairing grants. On startup, remove a leftover `sessions.json` and pairing files while keeping `auth/server-id` byte for byte (design D6). In `storage.ts`, accept account scopes only in `validateScope` and delete `importLegacy` (keep `migrate.ts` until 5.1, because `load()` still maps older stored profiles through it). Check: `npm test` and `npm run test:legacy-inventory`.
- [ ] 3.3 Require `administration.identity` in `apps/reference-server/config.ts` and `createReferenceServer`, drop the `pair` mode and the `/v1/a` message from `cli.ts`, and delete `apps/fixture-server/index.ts`, `pair.ts`, `reset.ts` and `servers/*.json`. Remove the npm scripts `fixture*`, `server:pair`, `calendar:*` and `test:calendar`. Delete `tests/radicale-live.ts` and `scripts/*radicale*`. Remove `Connections.pair`, `authRequest("pair")` and `PairingRequestSchema` (keep `AUTH_PROFILE`), and the `/v1/a` pairing parts of `auth-http.test.ts`, `auth-client.test.ts`, `device-session-client.test.ts` and `mobile-identity.node.ts` (design "Boundary"). Add a profile test for a missing identity (`deployment` "Account profile without test adapters"). Check: `npm run server:check -- examples/self-hosted/server.json` and `node --import tsx --test tests/deployment.node.ts`.
- [ ] 3.4 Stage gate: `npm run check`, `npm run test:mcp`, the known-failure check and `npm run admin:build`.

## 4. Remove the interpreter and its effects (server)

- [ ] 4.1 In `apps/fixture-server/model-service.ts`, remove the `router`/`crm` arguments, contact tools, `describeTools`, the `"crm"` activity stage and the whole `router.decide()` path. A `message.send` with any `context` goes to the native runtime. When an account command does not reach Mastra, it gets the settled `integration_unavailable` refusal (design D2). Update `createTrustHarness`, `apps/server-mcp/tasks.ts` and the `http.ts` constructors. Add a test for a context answer without `runtime` going native (`chat-delivery` "Removed fixture commands"). Check: `npm run test:agent`.
- [ ] 4.2 Remove these engine parts:
  - From `engine.ts`: proposals, operations, the calendar, demo phrases, contact choice, `patchMeeting`, `tick`, `remember`/`modelState`, the fixture `DatabaseSchema` fields' writers, and the `choosePeter` import
  - From `storage.ts`: `tick`, `calendarJobs`, `claimCalendar`, `completeCalendar`, `calendarFor` and `modelState`
  - From `http.ts`: `CalendarWorker` and the 250 ms timer

  The four fixture commands now return `rejected` from the engine, and protocol removal comes in stage 6. Check: `npm test` and `npm run test:identity` (known-failure check).
- [ ] 4.3 Make these removals (precondition: 1.1 confirms NIAR-239 is merged):
  - Delete `conversation-memory.ts`, `calendar.ts`, `twenty.ts` and `apps/server-tools/contacts.ts`.
  - Shrink `decision.ts` to `ModelError`, and remove `OpenRouterModel`/`configuredModel`.
  - Delete the `dynamicModel` `model` stub, the `model`/`tools` hand-over in `service.ts` and the `MobileRuntime.model`/`tools` fields in `mobile.ts`.
  - Move any remaining `mobile-identity.node.ts` subtest off a `decide()` stub (design D7, Boundary).

  Check: `npm run typecheck` and `npm run lint` (boundary check).
- [ ] 4.4 In `config.ts`, accept only `adapters.crm: disabled` and `adapters.calendar: simulated` and drop the "CRM requires a model interpreter" rule. In `runtime.ts`, drop the crm/calendar adapters. In the admin overview (`apps/server-admin/http.ts`, `packages/protocol/admin.ts`), drop the `crm`/`calendar` rows and `tools`. Add profile tests for `twenty-test` and `caldav` failing, with the example profiles still loading (`deployment` "Account profile without test adapters", "Private configuration files"). Check: `node --import tsx --test tests/deployment.node.ts` and `npx jest --runInBand tests/server-admin.test.ts tests/reference-server.test.ts`.
- [ ] 4.5 Delete the fixture-only tests and scripts:
  - Jest: `conversation-memory.test.ts`, `crm-meeting.test.ts`, `calendar.test.ts`, `approval.test.ts`, `twenty.test.ts`, `server-tools.test.ts`, `model.test.ts`, `crm-profile-migration.test.ts`
  - The test "a newer legacy contact card…" in `service-catalog.node.ts`
  - Scripts: `scripts/test-openrouter.ts`, `test-twenty.ts`, `test-conversation-memory.ts`
  - npm scripts: `test:crm`, `test:memory`, `test:models`

  Check: `npm run check`.
- [ ] 4.6 Stage gate: `npm run check`, `npm run test:mcp`, the known-failure check and `npm run smoke` (or `SMOKE_SKIP_BROWSER=1 npm run smoke` where no browser is available).

## 5. Workflow storage migration

- [ ] 5.1 Implement the `user_version` 1 → 2 migration in `FixtureStorage` exactly as design D5 describes:
  - Operator-scope rows are removed.
  - Account state is stripped of fixture entities and `crm.contacts` results, in state, chat directory and session archives.
  - Events are reset with `eventFloor` set to the cursor.
  - Receipts of removed commands are removed.
  - The DDL is unchanged and everything runs in one transaction.

  Make `load()` map any stored `agent-client/0.x-fixture` snapshot profile to `PROFILE`, then delete `migrate.ts`. Check: the new migration test below.
- [ ] 5.2 Add a migration test that seeds a version-1 `workflow.sqlite` through the current code. The seed holds an account chat with a `crm.contacts` card, demo work with input, a proposal and an operation, meeting memory, an operator `/v1/a` scope, and receipts of `proposal.decide` and `message.send`. After reopening, check:
  - Chats and message text are kept, and the card is gone.
  - Search still finds the chat.
  - Native work is kept, and the `message.send` receipt still replays.
  - An old events cursor answers `409 snapshot_required`.
  - The operator scope is gone.
  - A second open changes nothing.
  - A simulated crash before commit leaves version 1.

  This covers `chat-delivery` "Fixture state migration" and `tasks` "Paused agent work". Check: `npx jest --runInBand tests/storage-migration.test.ts` (new) and `npm run test:legacy-inventory`.
- [ ] 5.3 Stage gate: `npm run check`, `npm run test:mcp` and the known-failure check.

## 6. Protocol and clients

- [ ] 6.1 In `packages/protocol`:
  - `index.ts`: remove the fixture schemas, the snapshot arrays and events, the work item fields and the four commands, and set `PROFILE = "agent-client/0.9"`. Keep the result codes and the optional `runtime` (design D3).
  - `message-delivery.ts`: drop `crm.contacts/1` from the baseline.
  - `server-info.ts`: move to `agent-server-info/3` and update its route in `http.ts`.

  Update `tests/protocol.test.ts` and `message-delivery.test.ts`. Add tests:
  - The removed commands → `400 invalid_payload` with no receipt.
  - `results=crm.contacts/1` is ignored.
  - The server-info shape.

  These cover `chat-delivery` "Removed fixture commands", "Workflow snapshot contents" and "Result type negotiation", and `app-pairing` "Server information". Check: `npm run typecheck` and `npx jest --runInBand tests/protocol.test.ts tests/message-delivery.test.ts tests/http.test.ts`.
- [ ] 6.2 In `packages/client-core`:
  - Remove the fixture commands, the store maps, the `commandTarget` branches, the `demo` guard and the diagnostic fields.
  - In `packages/client-core/migrate.ts`, map 0.8 credentials to the new profile.
  - Discard a stale cached snapshot or outbox command instead of failing.
  - In `restore()`, drop non-account credentials.

  Add tests: a 0.8 credential survives, a stale snapshot and outbox are cleared, and an `/v1/a` credential is dropped. Check: `npx jest --runInBand tests/session.test.ts tests/storage.test.ts tests/auth-client.test.ts`.
- [ ] 6.3 Update the phone app and ui-catalog (design D4):
  - `apps/mobile/App.tsx` `renderWork` and `MOBILE_MESSAGE_RESULTS`, the `CrmContactResults` branch, `MeetingLibrary` `scheduled`, and the empty dev default address.
  - Delete `ActionApprovalCard`, `MeetingFacts` and `InputRequestForm` (move `FormState` first), and the `CrmContactResults` export.
  - Trim `WorkItemCard` and `WorkItemSummary`, and rewrite their stories without `choosePeter`/`meetingProposal`/`crmContactResult`. Delete those fixtures from `packages/test-fixtures`, and make `scopeFor()` account-shaped.
  - Update the mobile jest tests: `components`, `chat-work-card`, `ui-shell`, `card-document-view`, `voice-draft`, `meeting-library`. `connection-card` is NIAR-239's. Delete `approval-card.test.tsx` and `crm-contact-card.test.tsx`.

  Check: `npm test` and `npm run storybook:generate && npm run typecheck`.
- [ ] 6.4 Update the web chat in `apps/server-admin/web`:
  - `app/chat-work.tsx` without `ContactChoice`/`ProposalReview`/calendar icon/`demoResult`
  - `chat-session.ts` results
  - `chat-next/transport.ts` and `parts.tsx` without `niaro.contacts`
  - App query invalidations

  Keep the `calendar.*` audit labels. Update `web-chat*`, `web-hub*` and `process-commands` test snapshots. Check: `npm run admin:build` and `npx jest --runInBand tests/web-chat*.test.tsx tests/web-hub*.test.tsx`.
- [ ] 6.5 Remove the fixture-only i18n keys from `packages/i18n/index.ts` and `apps/server-admin/web/i18n.ts` in EN and CS together (design D4). Check: `npm run typecheck` (both locales share the key type) and `npm test`.
- [ ] 6.6 Edit `native-task-window.node.ts` and the remaining node tests that build snapshots with fixture fields. Check: `npm run test:identity` (known-failure check).
- [ ] 6.7 UI checks:
  - Web chat at 1440 px and 390 px in EN and CS: a native question, a native approval (approve and decline), a process approval, a service action result with contacts, a migrated message without its contact card, Tasks, and Meetings without the scheduled list.
  - Phone app (Android emulator or `npm run test:process-mobile-web`): home, chat with a question and an approval, Tasks, Meetings.

  Record screenshots in the PR.
- [ ] 6.8 Stage gate: `npm run check`, `npm run test:mcp`, the known-failure check, `npm run smoke`, `npm run test:chat-history-web` and `npm run test:process-mobile-web`.

## 7. Documentation and specs

- [ ] 7.1 Update the guides:
  - `docs/guides/development.md`: drop the CRM/Calendar adapter rows, the "CRM adapter needs a non-fixture model" line and the `FIXTURE_*` mentions, and keep the voice ones.
  - `docs/guides/deployment.md`: adapters rows.
  - README: the "no real CRM or calendar" note, and say what `apps/fixture-server` holds.

  Check: `grep -rnE "server:pair|fixture:pair|/v1/a|crm\.contacts|radicale|twenty-test" docs README.md CONTRIBUTING.md` returns nothing.
- [ ] 7.2 Run spec validation, then `spec openspec --project /home/flamendrin/workspace/niaro -- validate --specs --strict`. Confirm that `chat-delivery`, `app-pairing`, `deployment` and `tasks` read correctly with the deltas applied (no remaining `crm.contacts`, `demo-phrases` or `demo: false` in `openspec/specs`).
- [ ] 7.3 Final verification on the merged branch:
  - `npm run check`, `npm run test:mcp` and the known-failure check (still only the NIAR-233 titles)
  - `npm run smoke`
  - A comment on NIAR-240 in Itsaplan with the outcome, and on NIAR-233 confirming that its 12 tests are unchanged by this change

## Workflow follow-up

- Archive the change after review. Then sync the specs (`openspec archive niar-240-remove-fixture-interpreter`).
- Possible follow-ups: rename `apps/fixture-server` and its classes (design Open question 2), and retire the `agent-1`/`progressive-1` legacy engines (Open question 3).
