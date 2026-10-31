I reviewed D6b and D6c as the codebase-details Goldfish against the implementation-readiness standard and current relevant source. I found one contradiction in the documented renderer contract and seven readiness gaps, including an existing transport that rejects the required HTTP 304 response. The review is complete, the design needs the corrections below before this slice is ready for implementation, and I changed no files or ran any builds, tests, native actions or live provider calls.

Official EGM Goldfish report: C3-codebase_details, Mode REVIEW, Step 9 implementation-readiness slice.

Scope and binding

Target: /home/flamendrin/workspace/niaro/openspec/changes/niar-246-work-pet/design.md. I resolved the headers from the current file: D6b “Expressions, touch and weather” is lines 230–244; D6c “Personal weather sidecar and native gates” is lines 245–281. I used surrounding renderer, migration and verification text and the complete supplied proposal, tasks and both spec deltas as context. This is neither a five-stage EGM review nor a review of the whole NIAR-246 change.

Target SHA-256: 81c2cd46fecd3363fa6e64f75738a0e4e653d83071dc9fc63f40058f71b2966c. All five canonical files matched /tmp/niaro-resume-20261031/weather-review-subject.json at the initial and final checks. No discrepancy in those bound inputs was observed.

Findings

C3-codebase_details-01 — Blocker — The stated nine-number face contract contradicts the accepted renderer.

Affected scope: design.md D6b line 235, read with its preservation requirement at lines 239–242 and D6c line 278.

Discrepancy and evidence: D6b describes an exhaustive nine-number face model. The current accepted PetFace in packages/ui/pet-interaction.ts lines 2–15 has twelve numeric channels: open, lid, low, tilt, love, wink, smile, mouth, blush, wave, asym and roll. These extra channels carry behavior, not unused metadata: worried uses wave=1 at lines 92–99; shy/moment/curious use asym; stir uses wave and roll. pet-motion.ts publishes the extra facial channels and pet-shader.ts draws the wavy mouth. Nine core controls could be described as a subset, but the current statement does not say that.

Impact: an engineer following the stated contract can narrow the model and erase parts of the storm face and original interaction family while believing the preservation requirement is satisfied. The Blocker classification follows this persona’s rule for a current-state statement contradicted by code.

Next action: correct the description to preserve the complete existing PetFace contract, explicitly distinguishing the nine core controls from wave/asym/roll if that distinction is intended. Do not redesign the current channel model to make it fit the prose.

C3-codebase_details-02 — Major — The weather slice still defers its executable file/action map and check integration.

Affected scope: design.md line 280; tasks.md lines 43–46, 59–60 and 75.

Discrepancy and evidence: line 280 explicitly leaves exact future file allocation to root after review. Tasks 4.4 through 4.4c name categories and proposed tests but do not allocate the production store, crypto, dispatcher/cache, adapters, native port, clock, opt-in/controller or Settings modules. Current integration requires changes to the route matcher and Identity service interface in apps/fixture-server/http.ts, the strict server-profile schema in apps/reference-server/config.ts, identity startup/shutdown and removal hooks in service.ts, ClientSession, and the shared renderer. The plan does not provide one Create/Modify/Delete map for that slice or stable intermediate checkpoints for those edits. Also, package.json’s check command reaches an explicit test:identity file list; task 6.2 registers only the four profile suites, leaving the new weather .node.ts suites without a stated registration step or exact alternative check command.

Impact: a fresh implementer must choose module boundaries, ownership and sequencing, and can finish the proposed tests without adding them to the normal check path. Listing new proposed files is not itself a defect; the defect is that their allocation and integration are deliberately undecided at a Step 9 readiness review.

Next action: provide one bounded Create/Modify/Delete action map, the startup/route/removal/close wiring for each module, incremental buildable phases, and exact commands or script registration covering every proposed weather suite. Keep the existing C1/voice shared-file freeze as an explicit dependency.

C3-codebase_details-03 — Major — The strict public sidecar is described but is not yet a complete wire contract.

Affected scope: design.md D6c lines 247–262; tasks.md line 43.

Discrepancy and evidence: the text selects paths, profile, limits and several invariants, but does not define the literal capabilities success object, exact city-search response envelope, complete command discriminants and fields, the none/reason enum, registered attribution representation, or the types/nullability of every timestamp and generation. There is an especially material ambiguity in preference.city: lines 258 and 272 allow a saved City while Device is active, but the current response lists only one city field without saying whether it represents the saved City or active City. That determines whether another installation can offer selectSavedCity without exposing coordinates. Current packages/protocol/index.ts lines 29–40 and ClientSession’s existing scoped readers use exact strict schemas and sameScope; no existing weather contract supplies the missing definitions.

Impact: server and client engineers can implement incompatible “strict pet-weather/1” messages. The specified Settings unavailable/conflict/unknown-outcome states also lack a complete stable error/status mapping.

Next action: finish the canonical request, success and error schemas for all four method/path pairs, including exact capability fields, saved-versus-active City meaning, all union branches, timestamp encodings, attribution IDs/limits and command payloads. Add representative valid and invalid synthetic message fixtures to the planned protocol verification. These decisions belong in the reviewed plan, before creating the proposed protocol file.

C3-codebase_details-04 — Major — Storage and restart guarantees lack the schema and algorithms that would enforce them.

Affected scope: design.md D6c lines 264 and 268–270; migration line 307.

Discrepancy and evidence: agent_pet_weather_preference is named but has no complete SQL schema, member foreign-key binding, checks, null rules, revision/generation representation or City envelope binding. The anonymous cache/attempt tables are not named or specified. The prose promises a 2,000-entry bound while eviction cannot remove live gates, durable per-provider/cell attempts, Expires/Retry-After handling and fail-closed clock behavior, but does not choose admission/eviction behavior when all entries contain live gates, the cache key/config namespace, invalid-header behavior or the persisted clock-validation rule. Existing memory-payload-crypto.ts demonstrates that AES-GCM reuse needs an exact domain and authenticated binding; “distinct-domain AES-GCM” does not specify the new City envelope. Current service.ts separately removes workspace access and revokes credentials at lines 4558–4586, so workspace-only purge needs explicit wiring in addition to member/user cascades.

Impact: the implementer must design both a privacy-sensitive persistent format and the algorithms that justify the provider/restart guarantees. A row can be correctly encrypted yet bound to the wrong owner, or a seemingly reasonable eviction can remove the only durable attempt gate.

Next action: specify the additive schemas, indexes/checks/cascades, City key derivation/domain/AAD, canonical receipt digest input, cache key namespace, gate-preserving admission/eviction, header parsing and clock/restart rules. Name the workspace-removal purge and final-publication transaction paths and their rollback/error behavior. Preserve the existing single-owner SQLite boundary.

C3-codebase_details-05 — Major — The existing IntegrationTransport cannot perform the planned conditional revalidation, and the MET transport policy needs reconciliation.

Affected scope: design.md D6c lines 268–270; tasks.md line 44; apps/server-integrations/transport.ts lines 197–204.

Discrepancy and evidence: the production transport rejects every 300–399 response as integration_response_invalid. A normal 304 has no Location and cannot reach the weather adapter as a TransportResponse, so the planned Last-Modified/304 flow cannot be implemented only inside the adapter. TransportRequest has no option to admit that status. A synthetic IntegrationTransport that directly returns 304 would bypass this production behavior. MET documents the conditional 304 flow in its [Getting Started guide](https://api.met.no/doc/GettingStarted). Separately, its [Terms of Service](https://api.met.no/doc/TermsOfService) require redirect and gzip support, whereas the design says “no redirects” and the reused transport explicitly uses identity encoding and rejects compressed responses. The adapters are disabled today; this is an unresolved design requirement for later activation, not a claim that live traffic has already violated policy.

Impact: successful unchanged forecasts become refresh failures in the production path, and the planned transport/setup cannot yet be represented as satisfying the chosen provider’s documented requirements.

Next action: explicitly allocate and design the narrow production transport change needed to return 304 headers without weakening unrelated callers or redirect protections. Reconcile MET’s redirect/compression requirements with the adapter’s security and byte limits, including bounded decoded size if compression is supported. Plan a verification case through the actual production HTTP transport, rather than only an injected response function.

C3-codebase_details-06 — Major — The provider-to-semantic decoder and City result contract still require design choices.

Affected scope: design.md D6c lines 256, 262 and 270.

Discrepancy and evidence: the design names six weather conditions but does not define the MET symbol-to-condition table, precedence for mixed precipitation/thunder symbols, which 1/6/12-hour aggregation to use, interval construction, malformed/duplicate ordering rules, or whether forecastAt means forecast issue time or interval start. MET’s [data model](https://api.met.no/doc/locationforecast/datamodel) distinguishes instantaneous values from optional period aggregates; it does not provide this application’s six-value classification. For Nominatim, the prescribed JSONv2 request does not mention addressdetails=1 even though the public result requires countryCode. The official [output contract](https://nominatim.org/release-docs/latest/api/Output/) puts country_code in the optional address data and uses category, rather than class, in JSONv2. “Retain settlement results” does not select the accepted category/type/rank combinations, bounded label construction, missing-country behavior or duplicate treatment. The [Search contract](https://nominatim.org/release-docs/latest/api/Search/) makes addressdetails optional and defaults it off.

Impact: different implementations produce different moods and check/forecast timestamps from identical provider data, or omit legitimate City choices because the requested response lacks required metadata. A permissive result filter also undermines the intended city-only boundary.

Next action: define the exact request parameters and bounded provider schemas, settlement allowlist/label/country handling, symbol mapping, interval-selection order and timestamp meanings. Specify reject-versus-none behavior for unknown symbols, missing aggregates and invalid intervals, and provide synthetic boundary fixtures for the 200 and 304 paths.

C3-codebase_details-07 — Major — “Installation UUID” does not yet define an installation-lifetime consent boundary.

Affected scope: design.md D6c line 272; tasks.md line 46; work-pet spec “Stored Device without local opt-in”.

Discrepancy and evidence: the proposal requires a new installation to remain inactive, but only says to persist an installation UUID and opt-in through existing device-only secure storage. apps/mobile/credential-vault.ts lines 6–21 uses Expo SecureStore with WHEN_UNLOCKED_THIS_DEVICE_ONLY. The installed SDK’s SecureStore.ts lines 54–59 defines that flag in terms of preventing migration to another device, not erasure on uninstall. Expo’s [SecureStore persistence documentation](https://docs.expo.dev/versions/latest/sdk/securestore/) warns that iOS Keychain values can survive uninstall/reinstall with the same bundle ID. There is no selected fresh-install marker, rotation/check order or storage-failure rule in the proposed plan.

Impact: the straightforward implementation can restore the old UUID and opt-in after an iOS reinstall and, if OS access exists, silently activate Device for what the spec calls a new installation. This is an implementation-readiness gap; no weather opt-in implementation currently exists to accuse of doing this.

Next action: define how the installation marker is created, stored and invalidated independently of retained Keychain entries; specify the complete server/actor/workspace/generation binding and fail-closed storage behavior. Require synthetic retained-Keychain/new-install tests. Any later real-device check stays behind the stated native gate; this review requests no uninstall or native operation.

C3-codebase_details-08 — Major — The renderer extension is not specified at the existing base-face and idle boundaries.

Affected scope: design.md D6c lines 276–280; tasks.md line 59.

Discrepancy and evidence: line 278 supplies period dim values and preset names but delegates condition-specific light targets to “original weather warm/dim targets”, without a pinned accessible source location or complete numeric table. It also names a 120-second touch-comfort blend without its trigger and interpolation/reset rule. Those missing rules do not exist in the current shared renderer: PetViewProps at lines 51–67 has no environment input; pet-shader.ts lines 781–782 initializes uMood/uWx to zero; pet-motion.ts’s PetFrame has no environment fields; PetFallback has no mood input. More importantly, pet-interaction.ts lines 1689–1697 restores expired reactions to neutral/sleepy, while stepIdle at lines 724–726 suppresses any live non-neutral/non-sleepy face. Simply setting glum/cozy/worried as a persistent face and enabling the three weather idle cards can therefore prevent those idle cards from running. The code has the reusable engine, but not an existing weather base-face restoration mechanism.

Impact: a new engineer must decide the environment API, blend curves, fallback representation and ownership changes. An apparent minimal integration can either reset rain to neutral after touch or suppress the original idle behavior the design promises to preserve.

Next action: specify the semantic environment input and its module ownership, exact condition/period light and base-face table, comfort trigger/decay/cancellation, base-face restoration and idle eligibility rules, reduced-motion semantic invalidation, and fallback mapping. Reference a fixed source artifact for any inherited constants that are not reproduced. Include planned regression cases for rainy base face → local touch → restored weather face, weather-conditioned idle while that base face is active, work/rest preemption, source invalidation and static fallback, using the existing engine.

Verified reuse and boundaries

The existing owner-lock claim is supported: openIdentity takes acquireServerLock at service.ts line 361 and releases it after DB close at lines 4171–4172; storage.ts lines 79–92 holds a separate SQLite BEGIN EXCLUSIVE lock. The deployment guide says one container per data volume and no replicas. I found no basis to demand a new owner registry, distributed worker system or recovery service for the declared topology.

appActor at service.ts lines 2356–2372 authenticates the scoped mobile account without constructing chat/model runtime. MobileSessionStore checks current parent session, organization/workspace membership and server scope. ClientSession’s private open/json path already supplies bearer authentication, renewal, timeout, cancellation and no automatic write replay; the selected smaller weather response caps would be new. Its native text body is allocated before size checks, matching the design’s stated limitation.

The accepted touch code inspected agrees with the preservation rules for release classification, quiet/cadence precedence, three-item BAG, movement-preserving hug, meaningful stroke, projected signs and lifecycle ownership. I did not infer completed weather integration from those existing features or the latent shader uniforms.

The current root package selects Expo 57.0.24, RN 0.86.3 and pnpm 12.4.2. The [SDK 57 Location documentation](https://docs.expo.dev/versions/v57.0.0/sdk/location/) recommends the 57.0.22 family, and [SDK 57 Localization](https://docs.expo.dev/versions/v57.0.0/sdk/localization/) the 57.0.2 family. Those proposed dependencies are not already installed by this plan, and their absence is not a finding. Current app.config.ts includes the meeting audio/background and microphone configuration that later isolated generation must preserve.

The design’s informed public-Nominatim setup and one-owner application-wide admission are consistent with the [public policy’s per-application scope](https://operations.osmfoundation.org/policies/nominatim/); this does not make independent owners coordinated. Its restriction on generic commercial-free Open-Meteo use agrees with [Open-Meteo’s free-service terms](https://open-meteo.com/en/terms). I made no geocoding or forecast request.

Exact reading inventory and limits

Fully read review/control inputs: /home/flamendrin/.codex/plugins/cache/egm/egm/0.1.0/agents/codebase_details.md; /home/flamendrin/.codex/plugins/cache/egm/egm/0.1.0/resources/document_standards/implementation-readiness-standard.md; that plugin’s skills/egm_review/SKILL.md and docs/codex.md; /home/flamendrin/.agents/skills/orchestration/SKILL.md; /home/flamendrin/.agents/skills/orca-cli/SKILL.md; /tmp/niaro-resume-20261031/weather-review-subject.json; CONTRIBUTING.md; openspec/changes/niar-246-work-pet/proposal.md; tasks.md; specs/work-pet/spec.md; specs/memory/spec.md; docs/design/mobile-pet-parity-2026-10-30/prototype-parity-ledger.md. The ledger was read because the target explicitly incorporates it; I did not open its linked review reports.

Read target/context portions: openspec/changes/niar-246-work-pet/design.md headings, lines 1–45 and 159–313, including all of D6b/D6c; docs/guides/deployment.md deployment/owner/backup portions.

Read production source/interfaces, fully for the small files and relevant scoped portions for the large ones: apps/server-integrations/transport.ts; apps/server-identity/service.ts; apps/server-identity/mobile.ts; apps/server-identity/memory-payload-crypto.ts; apps/reference-server/config.ts; apps/fixture-server/storage.ts; apps/fixture-server/http.ts; packages/protocol/index.ts; packages/client-core/session.ts; packages/client-core/preferences.ts; packages/client-core/connections.ts; apps/mobile/credential-vault.ts; apps/mobile/App.tsx; apps/mobile/ScreenChrome.tsx; app.config.ts; package.json; packages/ui/PetView.tsx; packages/ui/pet-motion.ts; packages/ui/pet-interaction.ts; packages/ui/pet-shader.ts; packages/ui/PetFallback.tsx. Read jest.config.js and tests/meeting-device-mock.ts as shared test infrastructure.

Read dependency metadata/source only: node_modules/expo/bundledNativeModules.json entries for location/localization; node_modules/expo-secure-store/src/SecureStore.ts accessibility declarations. pnpm-lock.yaml was searched for the proposed packages and hashed, not installed or rewritten. Mock-declaration searches also printed scoped excerpts from tests/pet-view.test.tsx, tests/pet-touch.test.tsx, tests/pet-lifecycle.test.tsx, tests/web-owner-setup.test.tsx, tests/helpers/process-pipeline-http.ts, tests/helpers/mastra-crash-worker.ts, tests/helpers/mastra-domain-crash.ts, tests/helpers/process-coordinator-http.ts and tests/helpers/process-design-http.ts; those unit suites were not substantively reviewed or executed.

Additional source searches printed symbol/line hits only, without substantive file review, from: apps/server-mcp/admission.ts; apps/server-integrations/speech.ts; decisions.ts; mastra-model.ts; favicon.ts; models.ts; service-oauth.ts; transcription.ts; discovery.ts; apps/mobile/HumanTaskLibrary.tsx; apps/server-agent/runtime.ts; apps/server-identity/profile-learner.ts; profile-inference.ts; web-access.ts; catalog-controller.ts; legacy-run-inventory.ts; process-resolve-store.ts; process-start-store.ts; process-question-store.ts; meeting-process-origin.ts; process-native-test-admission.ts; service-oauth-controller.ts; inference-budget.ts; process-native-testing.ts; mastra-domain.ts; server-settings.ts; packages/client-core/attachments.ts; store.ts; auth.ts; process-commands.ts; process-answers.ts; process-answer-attempts.ts; process-command-notice.ts; process-execution-reader.ts; process-output-reader.ts; packages/protocol/request-interruption.ts; apps/server-admin/web/lib/process-design-client.ts; apps/server-admin/web/app/tasks-page.tsx. Unprefixed names in each semicolon group share the last stated directory. These incidental hits are not review coverage.

Primary online references inspected: the linked Nominatim policy, Search and Output docs; MET TermsOfService, GettingStarted, locationforecast/datamodel and License; Open-Meteo terms; Expo Location and Localization latest and SDK 57 pages, plus latest SecureStore storage/persistence documentation. Attempts to open the SDK 57 SecureStore page failed; the retained-Keychain point is supported by the accessible current official documentation and the installed flag’s source description, not by a claimed device experiment.

I took filesystem SHA-256 fingerprints during source inspection and compared all eighteen selected source/config files again at the end; no change occurred between those two snapshots. This does not establish an immutable Git revision or exclude changes before the first source fingerprint. In particular, concurrent voice work remains separately owned; I did not use HEAD as a proxy for dirty filesystem contents. Key inspected hashes: transport.ts daae07327c1f3cfaae0e2662156b34c8dd699caebd55cea2d13ed9475b51901d; service.ts a6df3dd37732759af52231a42977858d97da6381db71319c818b7fd56f7ccedf; session.ts e1c20b5d38cf247fb52ceca785c7f88e858c6bce1873de72f997c1abaff9f530; pet-interaction.ts 271ff918ad4430f6b3199e4a2a3d269665b36f3eecdd0393c081d8f4743ae77f; PetView.tsx 0741bfb5ec2038455945fdc3713dd71101d73975d2da3efb6ab0e512be302dad.

Unassessed: execution correctness of future weather code, real native permission/timezone behavior, performance and final visual budget, live provider suitability/activation, the original remote niaro-pet.html artifact’s complete weather constants, and all unrelated profile/page/memory/Graph or voice implementation. I did not read author conversations, root handoff, scratch delivery narratives or separate prior review reports. No files or checkboxes were changed, no nested reviewer was launched, and no build, test, Git, dependency installation, native, service or private-data operation was performed. Root must persist this complete received message if a durable report is required.
