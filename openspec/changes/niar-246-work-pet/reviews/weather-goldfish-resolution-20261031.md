Status: resolved — all22 proposed textual fixes explicitly accepted and applied on2026-10-31.

Acceptance: user replied “přijmout vše” to the four complete candidate revisions. All22 original IDs and severities below are retained; accepted22, contested0, escalated0, declined0. This resolves the text-change decision, not independent implementation-readiness closure. No new review round, source implementation, native dependency/install or provider activation was performed.

# Goldfish Annotated Review Report

**Target:** `openspec/changes/niar-246-work-pet/design.md`, original D6b/D6c lines 230–281; necessary proposal/tasks/work-pet coherence only.

**Status:** AUTHOR proposal; pending root review and explicit user confirmation through openspec-update-change. No canonical changes, reviewer closure, acceptance or checkbox decision. All 22 original IDs and severities are preserved.

## Deduplicated group mapping

| Group | Proposed resolution | Original finding IDs |
| --- | --- | --- |
| G1 | Complete existing face contract | C3-codebase_details-01, C3-style-006 |
| G2 | Assigned files, signatures, stable phases and actual CI registration | C3-implementation_readiness-07, C3-codebase_details-02, C3-style-001 |
| G3 | Exact strict public unions and saved/active City transitions | C3-implementation_readiness-02, C3-codebase_details-03, C3-style-002 |
| G4 | SQL/crypto/revocation, anonymous gates, cache-full refusal and clock/header rules | C3-implementation_readiness-04, C3-codebase_details-04, C3-style-002 |
| G5 | Deterministic MET/JSONv2 normalization and freshness | C3-implementation_readiness-03, C3-codebase_details-06, C3-style-004 |
| G6 | Installation lifetime, storage failure and native controller gates | C3-implementation_readiness-05, C3-codebase_details-07 |
| G7 | Semantic renderer path, inherited constants and explicit adaptations | C3-implementation_readiness-06, C3-codebase_details-08, C3-style-005 |
| G8 | Newly exposed MET-only transport correction | C3-implementation_readiness-01, C3-codebase_details-05, C3-style-003 |
| G9 | Readable terms, units and removal of session shorthand | C3-style-007 |

The complete replacement text lives in the four candidates; unified patches contain the exact proposed edits. This report does not create a second implementation contract. The original transport recommendations to retain universal redirect/encoding rejection are copied below unchanged as reviewer evidence, but the proposed resolution explicitly revises only the MET path because the verified MET terms require redirect/compression support. This is a disclosed author refinement, not a change to any reviewer severity.

## Prioritized findings and author suggestions

### C3-codebase_details-01 [codebase-details] — Severity: Blocker

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-01 — Blocker — The stated nine-number face contract contradicts the accepted renderer.
>
> Affected scope: design.md D6b line 235, read with its preservation requirement at lines 239–242 and D6c line 278.
>
> Discrepancy and evidence: D6b describes an exhaustive nine-number face model. The current accepted PetFace in packages/ui/pet-interaction.ts lines 2–15 has twelve numeric channels: open, lid, low, tilt, love, wink, smile, mouth, blush, wave, asym and roll. These extra channels carry behavior, not unused metadata: worried uses wave=1 at lines 92–99; shy/moment/curious use asym; stir uses wave and roll. pet-motion.ts publishes the extra facial channels and pet-shader.ts draws the wavy mouth. Nine core controls could be described as a subset, but the current statement does not say that.
>
> Impact: an engineer following the stated contract can narrow the model and erase parts of the storm face and original interaction family while believing the preservation requirement is satisfied. The Blocker classification follows this persona’s rule for a current-state statement contradicted by code.
>
> Next action: correct the description to preserve the complete existing PetFace contract, explicitly distinguishing the nine core controls from wave/asym/roll if that distinction is intended. Do not redesign the current channel model to make it fit the prose.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G1.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:230–240 (D6b. Expressions, touch and weather)
- candidates/openspec/changes/niar-246-work-pet/design.md:434–462 (C3.7. Shared renderer contract and numeric adaptation)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-codebase_details-02 [codebase-details] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-02 — Major — The weather slice still defers its executable file/action map and check integration.
>
> Affected scope: design.md line 280; tasks.md lines 43–46, 59–60 and 75.
>
> Discrepancy and evidence: line 280 explicitly leaves exact future file allocation to root after review. Tasks 4.4 through 4.4c name categories and proposed tests but do not allocate the production store, crypto, dispatcher/cache, adapters, native port, clock, opt-in/controller or Settings modules. Current integration requires changes to the route matcher and Identity service interface in apps/fixture-server/http.ts, the strict server-profile schema in apps/reference-server/config.ts, identity startup/shutdown and removal hooks in service.ts, ClientSession, and the shared renderer. The plan does not provide one Create/Modify/Delete map for that slice or stable intermediate checkpoints for those edits. Also, package.json’s check command reaches an explicit test:identity file list; task 6.2 registers only the four profile suites, leaving the new weather .node.ts suites without a stated registration step or exact alternative check command.
>
> Impact: a fresh implementer must choose module boundaries, ownership and sequencing, and can finish the proposed tests without adding them to the normal check path. Listing new proposed files is not itself a defect; the defect is that their allocation and integration are deliberately undecided at a Step 9 readiness review.
>
> Next action: provide one bounded Create/Modify/Delete action map, the startup/route/removal/close wiring for each module, incremental buildable phases, and exact commands or script registration covering every proposed weather suite. Keep the existing C1/voice shared-file freeze as an explicit dependency.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G2.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:463–511 (C3.8. Exact file actions, signatures and buildable phases)
- candidates/openspec/changes/niar-246-work-pet/design.md:512–521 (C3.9. Later verification and evidence limits)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-codebase_details-03 [codebase-details] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-03 — Major — The strict public sidecar is described but is not yet a complete wire contract.
>
> Affected scope: design.md D6c lines 247–262; tasks.md line 43.
>
> Discrepancy and evidence: the text selects paths, profile, limits and several invariants, but does not define the literal capabilities success object, exact city-search response envelope, complete command discriminants and fields, the none/reason enum, registered attribution representation, or the types/nullability of every timestamp and generation. There is an especially material ambiguity in preference.city: lines 258 and 272 allow a saved City while Device is active, but the current response lists only one city field without saying whether it represents the saved City or active City. That determines whether another installation can offer selectSavedCity without exposing coordinates. Current packages/protocol/index.ts lines 29–40 and ClientSession’s existing scoped readers use exact strict schemas and sameScope; no existing weather contract supplies the missing definitions.
>
> Impact: server and client engineers can implement incompatible “strict pet-weather/1” messages. The specified Settings unavailable/conflict/unknown-outcome states also lack a complete stable error/status mapping.
>
> Next action: finish the canonical request, success and error schemas for all four method/path pairs, including exact capability fields, saved-versus-active City meaning, all union branches, timestamp encodings, attribution IDs/limits and command payloads. Add representative valid and invalid synthetic message fixtures to the planned protocol verification. These decisions belong in the reviewed plan, before creating the proposed protocol file.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G3.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:245–310 (C3.1. Strict public contract)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-codebase_details-04 [codebase-details] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-04 — Major — Storage and restart guarantees lack the schema and algorithms that would enforce them.
>
> Affected scope: design.md D6c lines 264 and 268–270; migration line 307.
>
> Discrepancy and evidence: agent_pet_weather_preference is named but has no complete SQL schema, member foreign-key binding, checks, null rules, revision/generation representation or City envelope binding. The anonymous cache/attempt tables are not named or specified. The prose promises a 2,000-entry bound while eviction cannot remove live gates, durable per-provider/cell attempts, Expires/Retry-After handling and fail-closed clock behavior, but does not choose admission/eviction behavior when all entries contain live gates, the cache key/config namespace, invalid-header behavior or the persisted clock-validation rule. Existing memory-payload-crypto.ts demonstrates that AES-GCM reuse needs an exact domain and authenticated binding; “distinct-domain AES-GCM” does not specify the new City envelope. Current service.ts separately removes workspace access and revokes credentials at lines 4558–4586, so workspace-only purge needs explicit wiring in addition to member/user cascades.
>
> Impact: the implementer must design both a privacy-sensitive persistent format and the algorithms that justify the provider/restart guarantees. A row can be correctly encrypted yet bound to the wrong owner, or a seemingly reasonable eviction can remove the only durable attempt gate.
>
> Next action: specify the additive schemas, indexes/checks/cascades, City key derivation/domain/AAD, canonical receipt digest input, cache key namespace, gate-preserving admission/eviction, header parsing and clock/restart rules. Name the workspace-removal purge and final-publication transaction paths and their rollback/error behavior. Preserve the existing single-owner SQLite boundary.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G4.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:311–366 (C3.2. Identity storage, encryption and lifecycle)
- candidates/openspec/changes/niar-246-work-pet/design.md:367–384 (C3.3. Disabled configuration, admission, headers and clock)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-codebase_details-05 [codebase-details] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-05 — Major — The existing IntegrationTransport cannot perform the planned conditional revalidation, and the MET transport policy needs reconciliation.
>
> Affected scope: design.md D6c lines 268–270; tasks.md line 44; apps/server-integrations/transport.ts lines 197–204.
>
> Discrepancy and evidence: the production transport rejects every 300–399 response as integration_response_invalid. A normal 304 has no Location and cannot reach the weather adapter as a TransportResponse, so the planned Last-Modified/304 flow cannot be implemented only inside the adapter. TransportRequest has no option to admit that status. A synthetic IntegrationTransport that directly returns 304 would bypass this production behavior. MET documents the conditional 304 flow in its [Getting Started guide](https://api.met.no/doc/GettingStarted). Separately, its [Terms of Service](https://api.met.no/doc/TermsOfService) require redirect and gzip support, whereas the design says “no redirects” and the reused transport explicitly uses identity encoding and rejects compressed responses. The adapters are disabled today; this is an unresolved design requirement for later activation, not a claim that live traffic has already violated policy.
>
> Impact: successful unchanged forecasts become refresh failures in the production path, and the planned transport/setup cannot yet be represented as satisfying the chosen provider’s documented requirements.
>
> Next action: explicitly allocate and design the narrow production transport change needed to return 304 headers without weakening unrelated callers or redirect protections. Reconcile MET’s redirect/compression requirements with the adapter’s security and byte limits, including bounded decoded size if compression is supported. Plan a verification case through the actual production HTTP transport, rather than only an injected response function.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G8.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:385–394 (C3.4. Narrow MET transport correction)
- candidates/openspec/changes/niar-246-work-pet/design.md:512–521 (C3.9. Later verification and evidence limits)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-codebase_details-06 [codebase-details] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-06 — Major — The provider-to-semantic decoder and City result contract still require design choices.
>
> Affected scope: design.md D6c lines 256, 262 and 270.
>
> Discrepancy and evidence: the design names six weather conditions but does not define the MET symbol-to-condition table, precedence for mixed precipitation/thunder symbols, which 1/6/12-hour aggregation to use, interval construction, malformed/duplicate ordering rules, or whether forecastAt means forecast issue time or interval start. MET’s [data model](https://api.met.no/doc/locationforecast/datamodel) distinguishes instantaneous values from optional period aggregates; it does not provide this application’s six-value classification. For Nominatim, the prescribed JSONv2 request does not mention addressdetails=1 even though the public result requires countryCode. The official [output contract](https://nominatim.org/release-docs/latest/api/Output/) puts country_code in the optional address data and uses category, rather than class, in JSONv2. “Retain settlement results” does not select the accepted category/type/rank combinations, bounded label construction, missing-country behavior or duplicate treatment. The [Search contract](https://nominatim.org/release-docs/latest/api/Search/) makes addressdetails optional and defaults it off.
>
> Impact: different implementations produce different moods and check/forecast timestamps from identical provider data, or omit legitimate City choices because the requested response lacks required metadata. A permissive result filter also undermines the intended city-only boundary.
>
> Next action: define the exact request parameters and bounded provider schemas, settlement allowlist/label/country handling, symbol mapping, interval-selection order and timestamp meanings. Specify reject-versus-none behavior for unknown symbols, missing aggregates and invalid intervals, and provide synthetic boundary fixtures for the 200 and 304 paths.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G5.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:395–419 (C3.5. Deterministic providers and freshness)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-codebase_details-07 [codebase-details] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-07 — Major — “Installation UUID” does not yet define an installation-lifetime consent boundary.
>
> Affected scope: design.md D6c line 272; tasks.md line 46; work-pet spec “Stored Device without local opt-in”.
>
> Discrepancy and evidence: the proposal requires a new installation to remain inactive, but only says to persist an installation UUID and opt-in through existing device-only secure storage. apps/mobile/credential-vault.ts lines 6–21 uses Expo SecureStore with WHEN_UNLOCKED_THIS_DEVICE_ONLY. The installed SDK’s SecureStore.ts lines 54–59 defines that flag in terms of preventing migration to another device, not erasure on uninstall. Expo’s [SecureStore persistence documentation](https://docs.expo.dev/versions/latest/sdk/securestore/) warns that iOS Keychain values can survive uninstall/reinstall with the same bundle ID. There is no selected fresh-install marker, rotation/check order or storage-failure rule in the proposed plan.
>
> Impact: the straightforward implementation can restore the old UUID and opt-in after an iOS reinstall and, if OS access exists, silently activate Device for what the spec calls a new installation. This is an implementation-readiness gap; no weather opt-in implementation currently exists to accuse of doing this.
>
> Next action: define how the installation marker is created, stored and invalidated independently of retained Keychain entries; specify the complete server/actor/workspace/generation binding and fail-closed storage behavior. Require synthetic retained-Keychain/new-install tests. Any later real-device check stays behind the stated native gate; this review requests no uninstall or native operation.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G6.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:420–433 (C3.6. Local installation, clock and native controller)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-codebase_details-08 [codebase-details] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-codebase_details-08 — Major — The renderer extension is not specified at the existing base-face and idle boundaries.
>
> Affected scope: design.md D6c lines 276–280; tasks.md line 59.
>
> Discrepancy and evidence: line 278 supplies period dim values and preset names but delegates condition-specific light targets to “original weather warm/dim targets”, without a pinned accessible source location or complete numeric table. It also names a 120-second touch-comfort blend without its trigger and interpolation/reset rule. Those missing rules do not exist in the current shared renderer: PetViewProps at lines 51–67 has no environment input; pet-shader.ts lines 781–782 initializes uMood/uWx to zero; pet-motion.ts’s PetFrame has no environment fields; PetFallback has no mood input. More importantly, pet-interaction.ts lines 1689–1697 restores expired reactions to neutral/sleepy, while stepIdle at lines 724–726 suppresses any live non-neutral/non-sleepy face. Simply setting glum/cozy/worried as a persistent face and enabling the three weather idle cards can therefore prevent those idle cards from running. The code has the reusable engine, but not an existing weather base-face restoration mechanism.
>
> Impact: a new engineer must decide the environment API, blend curves, fallback representation and ownership changes. An apparent minimal integration can either reset rain to neutral after touch or suppress the original idle behavior the design promises to preserve.
>
> Next action: specify the semantic environment input and its module ownership, exact condition/period light and base-face table, comfort trigger/decay/cancellation, base-face restoration and idle eligibility rules, reduced-motion semantic invalidation, and fallback mapping. Reference a fixed source artifact for any inherited constants that are not reproduced. Include planned regression cases for rainy base face → local touch → restored weather face, weather-conditioned idle while that base face is active, work/rest preemption, source invalidation and static fallback, using the existing engine.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G7.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:434–462 (C3.7. Shared renderer contract and numeric adaptation)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-implementation_readiness-01 [implementation-readiness] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-implementation_readiness-01 — Major — The required 304 path cannot use the current bounded transport unchanged.
> Affected scope: design.md lines 264 and 268–270; tasks.md task 4.4a, line 44; apps/server-integrations/transport.ts lines 182–204.
> Evidence: D6c requires IntegrationTransport, conditional Last-Modified requests and accepted 304 revalidation. createTransport currently destroys and rejects every status from 300 through 399 at lines 197–204, so a normal 304 never reaches the proposed adapter. jsonResponse also accepts only 2xx and parses a JSON body, which is unsuitable for a bodyless 304. The plan names reuse of the existing transport but contains no transport change or alternate bounded 304-capable path.
> Impact: an implementation that follows the stated reuse loses conditional revalidation, cannot renew an accepted unchanged forecast, and can become neutral after two hours despite the provider supplying valid 304 responses. A test using only an injected IntegrationTransport that returns 304 would miss the production failure.
> Next action: specify the narrow transport capability/change that returns 304 status and relevant headers while continuing to reject redirects, and require the adapter to handle 304 before JSON parsing. Add a production-createTransport test with a synthetic local response proving 304 delivery, alongside rejection of 301/302/307/308, encoded responses and oversized bodies. Keep the existing default callers’ behavior explicit.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G8.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:385–394 (C3.4. Narrow MET transport correction)
- candidates/openspec/changes/niar-246-work-pet/design.md:512–521 (C3.9. Later verification and evidence limits)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-implementation_readiness-02 [implementation-readiness] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-implementation_readiness-02 — Major — “Strict pet-weather/1” is not yet an exact implementable wire contract.
> Affected scope: design.md lines 247–262; tasks.md task 4.4, line 43.
> Evidence: paths, query rejection, several bounds and the current envelope are specified, but the capabilities response has no exact keys or readiness/limit types; the city response has no complete envelope/discriminator; the weather none/reason union has no discriminator or reason enumeration. Generation, sample/search/candidate identifiers and the registered attribution structure are not fully typed. The command descriptions name operations without providing the complete strict discriminated request shapes and each operation’s required/forbidden fields. It is also unclear whether preference.city represents saved City while source is Device/Off, which matters for selectSavedCity and clearing an inactive saved City. No packages/protocol/pet-weather.ts or other current pet-weather schema exists to fill these gaps.
> Impact: independently implemented server, client and Settings code can all satisfy the prose while disagreeing about strict parsing, saved-City visibility, unavailable states, conflict errors and retries. That is an API design decision, not a mechanical implementation detail.
> Next action: add the complete request/success/error schemas, including capability/current/city envelopes, discriminators, identifier types, source-dependent fields, saved-versus-active City representation, attribution registry entries and error/status mapping. Provide exact valid and invalid fixtures for each route/command and 404/406 negotiation. Preserve the already specified 8/16 KiB response caps, scope checks and no automatic POST replay.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G3.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:245–310 (C3.1. Strict public contract)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-implementation_readiness-03 [implementation-readiness] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-implementation_readiness-03 — Major — Forecast normalization and the meaning of “fresh/stale” still need decisions.
> Affected scope: design.md lines 256 and 268–270; tasks.md task 4.4a, line 44.
> Evidence: D6c defines six normalized conditions and bounded “intervals covering now,” but never defines how MET compact timeseries become those intervals or conditions. MET has instant values and overlapping next_1_hours/next_6_hours/next_12_hours summaries, changing time resolution, and a final time instant with no period summary. Its symbol_code combines conditions such as precipitation and thunder; the plan gives no precedence/mapping, suffix handling or unknown-symbol rule. The relationship of forecastAt to model updated_at versus interval start, and the calculation of staleAt, are also absent. The two-hour display limit and earliest-refresh gates alone do not decide these values. These format properties were checked against [MET Forecast JSON documentation](https://api.met.no/doc/ForecastJSON); I made no forecast request.
> Impact: engineers must choose whether a thunder-and-snow symbol becomes storm or snow, how to handle an unavailable hourly summary, what counts as the end of an interval, and when Settings labels a sample stale. Different choices can select future weather, extend an uncovered interval, or present misleading forecast/check times while still obeying the hard two-hour bound.
> Next action: document the accepted normalized cache record, exact MET field/period selection, half-open interval rules, sorting/duplicate/gap handling, condition mapping and unknown/malformed-data behavior. Define forecastAt, staleAt and refreshNotBefore calculations separately from displayUntil. Add synthetic fixtures for combined conditions, day/night/polar suffixes, missing next_1_hours, final-instant-only data, exact interval endpoints, gaps and 304 reselection across an interval boundary. Provider Expires/If-Modified-Since behavior remains required by [MET terms](https://api.met.no/doc/TermsOfService), independently of the product’s two-hour display policy.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G5.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:395–419 (C3.5. Deterministic providers and freshness)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-implementation_readiness-04 [implementation-readiness] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-implementation_readiness-04 — Major — The new persistent preference, encryption and durable cache contracts are not specified enough to migrate and recover without choosing a design.
> Affected scope: design.md lines 258 and 264–270; tasks.md tasks 4.4/4.4a, lines 43–44.
> Evidence: agent_pet_weather_preference is named and its broad contents are listed, but there is no exact column/constraint definition, member binding, City plaintext schema, envelope version, HKDF domain or authenticated associated-data contract. The anonymous cache/attempt-gate tables have no names/schema/key representation or durable eviction/admission algorithm. “Eviction cannot discard live attempt gates” does not specify what admission does when all 2,000 entries have live gates. Existing crypto is not a generic City store: MemoryPayloadCrypto has memory-specific payload validation and associated data binding item/actor/native identifiers and expiry. Existing identity membership is split between member and agent_workspace_member; deleting a workspace grant does not delete member, so an ordinary member FK alone cannot implement the required workspace-only purge. Current setWorkspaceMember removal is in service.ts around lines 4558–4584 and will need an identified purge integration.
> Impact: the implementer must choose durable schemas, ciphertext bindings and cache-full behavior. Incorrect choices can accept swapped City envelopes, lose restart admission gates, or retain private City data after workspace access removal.
> Next action: specify the table definitions and migrations, City payload/envelope and actor-bound encryption inputs, receipt digest canonicalization, cache/query/cell keys and provider/config identity, gate retention/eviction rules and full-capacity refusal behavior. Name the exact membership-removal and close/startup integration points. Add reopen/migration, ciphertext swap/corruption, workspace-only revoke/regrant, receipt replay, and full-cache-with-live-gates tests. This asks for concrete contracts within the chosen SQLite owner; it does not call for a new provider-owner registry or distributed infrastructure.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G4.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:311–366 (C3.2. Identity storage, encryption and lifecycle)
- candidates/openspec/changes/niar-246-work-pet/design.md:367–384 (C3.3. Disabled configuration, admission, headers and clock)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-implementation_readiness-05 [implementation-readiness] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-implementation_readiness-05 — Major — An installation UUID needs a storage/lifecycle rule that distinguishes reinstall from cold launch.
> Affected scope: design.md line 272; tasks.md task 4.4c, line 46; apps/mobile/credential-vault.ts lines 6–21.
> Evidence: the design requires matching opt-in to survive cold launch but requires a new installation to remain inactive, while naming existing device-only secure storage plus an installation UUID without saying where/how that UUID is created or reset. The existing vault uses SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY. That option prevents migration to another device; it is not an uninstall marker. Expo documents that iOS Keychain-backed SecureStore entries can survive reinstall with the same bundle identifier. See [Expo SecureStore platform storage and persistence](https://docs.expo.dev/versions/latest/sdk/securestore/).
> Impact: putting both the UUID and opt-in in the existing vault can make a reinstalled app load the old UUID/opt-in and treat the new installation as a consented cold launch. A normal cold-launch unit test will not expose this.
> Next action: choose and document an installation marker whose lifetime is distinct from Keychain persistence, its relationship to secure opt-in records, and fail-closed handling of missing/corrupt/restored markers. Define when a new installation invalidates old records before eligibility is evaluated. Add synthetic cold-launch versus reinstall-with-surviving-vault tests, and retain the separately gated native verification. No uninstall/reset operation was performed in this review.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G6.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:420–433 (C3.6. Local installation, clock and native controller)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-implementation_readiness-06 [implementation-readiness] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-implementation_readiness-06 — Major — The renderer input and clock/weather composition are still an unbound design.
> Affected scope: design.md lines 242–243 and 272–278; tasks.md task 5.2b, line 59.
> Evidence: line 276 says to use existing C1-owned props after freeze, but the current PetViewProps at packages/ui/PetView.tsx lines 51–67 contain no period/condition/environment prop. PetMotion/petFrame have no semantic environment either. pet-shader.ts initializes uMood and uWx to zero at lines 781–782 and does not update them from the draw arguments; pet-interaction.ts explicitly excludes sky/yawn/hum at lines 739–743 and returns expired reactions to neutral/resting sleepy at lines 1689–1697. These are proposed extension points, not an already available contract. The design gives period dim/warmth values but not the rule combining them with weather values: for example rain’s original dim and evening dim could be added, maximized or blended. It also calls for the original 120-second comfort blend and a same-shader particle adaptation without fixing their complete formulas/input contract or naming an available exact source for that adaptation.
> Impact: the implementer must design a public renderer interface, mood composition and reset behavior, including how environment changes redraw static/reduced fallback while preserving touch priority and the 1,400 ms acknowledgement. Different implementations can darken weather differently, reset ink/interaction when a minute ticks, or keep the existing neutral face after a touch expires.
> Next action: bind the semantic environment type/defaults and its path through every existing PetView placement, motion/interaction, shader and fallback. Specify clock/weather combination, base-face/comfort restoration and environment-change/cancellation rules, plus the accepted particle algorithm and static exclusions before its native/visual gate. Add actual-renderer tests for day+none exact neutrality, rain/evening and rain/night composition, returning from touch to the weather base, a period change during a reduced acknowledgement, fallback redraw without repeating RAF, and preservation of ink time and authoritative work/rest priority.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G7.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:434–462 (C3.7. Shared renderer contract and numeric adaptation)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-implementation_readiness-07 [implementation-readiness] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-implementation_readiness-07 — Major — The slice explicitly defers the required file action map and stable execution phases.
> Affected scope: design.md lines 276–280, especially “Exact future file allocation is decided by root after review”; tasks.md tasks 4.4–4.4c and 5.2b–5.2c, lines 43–60.
> Evidence: the standard requires an explicit created/modified/deleted file list and precise per-file changes. This slice names the proposed protocol file and tests but leaves server store/provider/dispatcher modules, native port/controller/clock/opt-in modules, client methods and Settings integration allocation undecided. Actual wiring also crosses apps/fixture-server/http.ts’s route allowlist and IdentityService Pick/Partial interface, apps/reference-server/config.ts’s strict identity profile schema, IdentityService construction/close/revocation, and ClientSession’s private json/open transport. These are real existing boundaries, not a generic “add HTTP/client methods” step. The listed dependency/prebuild/binary/lease gates protect native work, but there is no complete sequence saying which contracts and isolated modules land and remain buildable before shared C1 files are released and before native-only imports may execute.
> Impact: a fresh engineer cannot execute this plan immediately without allocating ownership, choosing module/API boundaries and deciding how to keep intermediate states usable. The last sentence accurately acknowledges unfinished planning; it does not satisfy Step 9 readiness.
> Next action: have the root settle and record the Create/Modify/Delete map and method/port signatures before source work. Partition the slice into stable protocol/store/HTTP-client, disabled provider/cache, pure clock/controller/native-port, renderer, shared Settings integration and explicitly gated native phases, with each phase’s concrete verification command and expected assertions. Identify any still-blocked shared-file release as a dependency instead of implying the semantic props already exist. Keep full profile/page/memory/Graph/growth work outside this map.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G2.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:463–511 (C3.8. Exact file actions, signatures and buildable phases)
- candidates/openspec/changes/niar-246-work-pet/design.md:512–521 (C3.9. Later verification and evidence limits)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-style-001 [style] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-style-001 — Major — The implementation plan explicitly postpones its file and interface decisions.
>
> Affected scope: D6c lines 264, 266, 272–280; tasks.md tasks 4.4–4.4c and 5.2b–5.2c.
>
> Discrepancy evidence: line 280 says that exact future file allocation is decided by root after review. The tasks name tests and packages, but do not allocate the new store, provider dispatcher, provider parsers, native port, clock/controller and Settings components to concrete production files or define their interfaces. Current integration points are concrete: IdentityService.appActor is private at apps/server-identity/service.ts:2356, identity configuration is a strict object at apps/reference-server/config.ts:80–81, ClientSession transport helpers are private, and PetViewProps at packages/ui/PetView.tsx:51–67 has no environment input. “Through existing C1-owned props after freeze” at line 276 cannot serve as an API declaration: the inspected props provide state, level, visibility and occupation, but no period/condition input.
>
> Style/readiness rationale: “root,” “C1-owned” and “after freeze” describe session coordination, not an executable engineering contract for a fresh reader. The standard explicitly requires target files, per-file actions and stable incremental phases, and forbids leaving architectural choices to the implementer.
>
> Impact: an engineer must choose module ownership, dependency directions, public method signatures and the sequence in which the new strict protocol, storage, routes and mobile integration remain buildable.
>
> Next action: add a bounded create/modify file map, exact entry-point signatures and dependency order for this slice. Define the shared renderer environment prop and the identity/client integration methods, and state each phase’s usable behavior and specific checks. Preserve the separate native/dependency authorization gates; documenting the intended changes does not execute those gates.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G2.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:463–511 (C3.8. Exact file actions, signatures and buildable phases)
- candidates/openspec/changes/niar-246-work-pet/design.md:512–521 (C3.9. Later verification and evidence limits)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-style-002 [style] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-style-002 — Major — The claimed strict contract leaves state names and observable boundaries undefined.
>
> Affected scope: D6c lines 251, 256–262, 264 and 272.
>
> Discrepancy evidence: the current response skeleton contains preference.city, while nearby rules alternate among City, activeCity, savedCity, chosenCity and selectedCity. A clear of inactive savedCity must preserve Device generation, but the view does not define whether city represents a saved choice, an active choice, or both. The proposed weather union is described as “none/reason” or “fresh/stale” without its discriminant keys, reason values, stale transition or staleAt definition. The capability response promises separate readiness and fixed limits without its actual fields. Command names are listed, but complete strict envelopes and errors are not given. Line 272 also requires invalidation on wall/monotonic “divergence” without a tolerance or comparison rule. There is no current pet-weather protocol or controller implementation in the searched production directories to supply these definitions.
>
> Style/readiness rationale: a strict schema cannot be reconstructed from interchangeable terms and abbreviated field lists. “Fresh,” “stale,” “saved,” “active” and “divergence” need one measurable meaning each.
>
> Impact: independently written server, client and Settings code can disagree about whether a City survives Off/Device, when a sample becomes stale, how unknown outcomes are shown, or when ordinary clock measurement noise clears position and weather. The named boundary tests would have to invent their own expected results.
>
> Next action: specify the complete capability, current, command, refresh, search and error unions, including discriminator names, bounds and nullability. Add a small source/saved-City transition table and exact freshness/clock-invalidity predicates. Define the weather encryption domain and authenticated binding rather than leaving “distinct-domain AES-GCM” as the whole encryption contract; the current saved-memory crypto binds a specific domain and identity tuple and cannot be reused by implication.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G3, G4.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:245–310 (C3.1. Strict public contract)
- candidates/openspec/changes/niar-246-work-pet/design.md:311–366 (C3.2. Identity storage, encryption and lifecycle)
- candidates/openspec/changes/niar-246-work-pet/design.md:367–384 (C3.3. Disabled configuration, admission, headers and clock)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-style-003 [style] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-style-003 — Major — “Existing bounded IntegrationTransport” does not currently support the required conditional-success path.
>
> Affected scope: D6c lines 264 and 268–270; tasks.md task 4.4a.
>
> Discrepancy evidence: apps/server-integrations/transport.ts:197–204 rejects every HTTP status from 300 through 399 with integration_response_invalid. TransportRequest at lines 14–39 has no option to accept a bodyless 304. Its publicWeb branch is not a solution: it is for explicitly handled redirects and returns only a Location response. The design requires a valid 304 to reuse the accepted forecast and renew validation, while continuing to forbid redirects.
>
> Style/readiness rationale: the phrase “existing bounded IntegrationTransport” implies the existing interface is sufficient and obscures a required shared-interface change. The design and task list never specify that change.
>
> Impact: a weather adapter using the current transport cannot reach its valid-304 branch. A stub-only provider test could appear to prove behavior that the real production transport always rejects.
>
> Next action: prescribe the narrow transport API change that permits the weather caller to receive a bodyless 304 and its needed cache headers, while retaining the current redirect/content-encoding restrictions and default behavior for other callers. Include tests through createTransport itself for accepted 304, refused redirects and unchanged default callers, then test cache interval re-selection through the actual dispatcher.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G8.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:385–394 (C3.4. Narrow MET transport correction)
- candidates/openspec/changes/niar-246-work-pet/design.md:512–521 (C3.9. Later verification and evidence limits)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-style-004 [style] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-style-004 — Major — Provider-to-domain projection is described by outcomes rather than a deterministic rule.
>
> Affected scope: D6c lines 256, 260, 262 and 270.
>
> Discrepancy evidence: the design fixes six pet conditions, but does not map MET symbol codes or forecast periods to those conditions. MET’s documented format exposes instant values and multiple next_1_hours/next_6_hours/next_12_hours summaries; the design does not define which summary wins, interval endpoints, unsupported symbols or forecastAt. “Retain settlement results only” likewise supplies no accepted Nominatim jsonv2 class/type/addresstype rule or bounded label construction. “Reject … address-like input” does not specify an executable predicate, especially beside required digit-containing city names.
>
> Primary-source check: the MET format confirms the multiple period summaries, and Nominatim documents featureType and notes that jsonv2 classifications follow varied OSM tagging. This is an inference about missing design decisions, not a claim that either provider’s documented API is broken. Sources: [MET forecast JSON](https://docs.api.met.no/doc/ForecastJSON) and [Nominatim Search](https://nominatim.org/release-docs/latest/api/Search/).
>
> Style/readiness rationale: “covering now,” “settlement,” “address-like” and “condition” hide distinct parsing and classification decisions. They are requirements for outcomes, not enough detail for a zero-decision implementation.
>
> Impact: two implementations can classify the same forecast differently or accept different city results, producing inconsistent visuals, freshness and privacy behavior. A test author cannot derive a single authoritative synthetic oracle.
>
> Next action: add fixed forecast-summary selection and symbol mapping tables, interval and unknown/malformed rules, and exact settlement/label/query normalization rules with representative accepted/rejected EN/CS fixtures. Retain the already chosen bounds, explicit submission and server-held selection. No additional quota is proposed by this finding.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G5.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:395–419 (C3.5. Deterministic providers and freshness)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-style-005 [style] — Severity: Major

**Original discrepancy, rationale and requested action (verbatim):**

> C3-style-005 — Major — “Original weather” is not bound to an available reference, and combined clock/weather mood remains ambiguous.
>
> Affected scope: D6b line 232 and D6c lines 276–278, with the D6 reference at line 190.
>
> Discrepancy evidence: the text refers to version 9 of a prototype artifact and “original weather warm/dim targets,” but supplies no retrievable path or link for those bytes. The explicitly linked parity ledger identifies niaro-pet.html with SHA-256 8c8319dd645aa26e408c9106597e233d6c0d7e7b1fa4ab1ee312e5af55e6f01e. Repository file discovery found the local candidate docs/design/mobile-assistant-2026-10-30/motion/pet.html, whose hash is cebef826788c6ce35f50e9ddc805baddc99c02fa7b99b4d4ec3366bfeca62291; it cannot be silently substituted for the named reference. Its weather model also treats night as a weather key, whereas this design separates period from condition. Line 278 supplies period dim targets but does not say how they combine with weather dim or whether the stated night warmth replaces or modifies weather warmth. The current production shader initializes uMood/uWx to zero at pet-shader.ts:781–782 and draw has no environment argument; it does not provide an active composition rule to inherit.
>
> Style/readiness rationale: “original” and a version nickname are not stable source references. Reuse needs both identifiable source bytes and an explicit account of the adaptation.
>
> Impact: an engineer must choose an unverified prototype, infer mood composition for cases such as night+storm, and define the same-shader particle adaptation beyond its maximum counts. That can change the accepted look despite satisfying the broad prose.
>
> Next action: bind the exact authorized reference to a durable path/link and digest, or copy the necessary weather equations and fixtures into the canonical design. Specify the period/condition composition and the limited particle adaptation, including its transition/fallback behavior, before implementation; leave its native visual acceptance as the already stated later gate.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G7.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:434–462 (C3.7. Shared renderer contract and numeric adaptation)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-style-006 [style] — Severity: Nit

**Original discrepancy, rationale and requested action (verbatim):**

> C3-style-006 — Nit — The face parameter count contradicts the preserved interface.
>
> Affected scope: D6b line 235.
>
> Discrepancy evidence: the paragraph states that the face is driven by nine numbers. Current PetFace at packages/ui/pet-interaction.ts:2–14 has twelve numeric fields: open, lid, low, tilt, love, wink, smile, mouth, blush, wave, asym and roll. The preservation requirement and parity ledger retain those original channels.
>
> Style rationale and impact: a precise count presents an incomplete enumeration as exhaustive and makes it unclear whether three existing channels should be removed.
>
> Next action: describe the nine listed features as a subset, or document all twelve existing channels and their names without changing the renderer contract.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G1.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:230–240 (D6b. Expressions, touch and weather)
- candidates/openspec/changes/niar-246-work-pet/design.md:434–462 (C3.7. Shared renderer contract and numeric adaptation)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.

### C3-style-007 [style] — Severity: Nit

**Original discrepancy, rationale and requested action (verbatim):**

> C3-style-007 — Nit — Compressed units and local shorthand reduce scanability.
>
> Affected scope: D6b lines 239–243 and D6c lines 247, 256–278.
>
> Discrepancy evidence: examples include “accepted8KiB,” “unknown/duplicate keys400,” “on the0.01 grid,” “query2–80,” “new48h,” “caps2,000,” “hard2h,” “day0/evening.35/night1” and “expo-location57.0.22.” C1, C3, MAIN and root are also used as local shorthand without definitions in this slice.
>
> Style rationale and impact: missing word/number separators and dense slash chains make limits harder to compare and can make package names resemble different literal identifiers. These are editorial issues rather than a request to alter the chosen limits.
>
> Next action: restore ordinary spacing and units, use package@version notation, state the period values in a small table or sentence, and replace session labels with concrete ownership/module references where the meaning matters.

**AI Suggestion: PROPOSE FIX.**

**Justification:** The reported gap is supported by the inspected current interfaces or missing canonical definitions. The candidate supplies the complete proposed definition; it does not claim implementation or independent closure. Consolidated group(s): G9.

**Proposed Edit:** Replace the original D6b/D6c span with the candidate replacement, using these precise sublocations:

- candidates/openspec/changes/niar-246-work-pet/design.md:230–240 (D6b. Expressions, touch and weather)
- candidates/openspec/changes/niar-246-work-pet/design.md:241–244 (D6c. Personal weather sidecar and implementation contract)

Coherence edits: `candidates/openspec/changes/niar-246-work-pet/proposal.md` weather planning-refinement bullet; `tasks.md` 4.4–4.4c / 5.2b–5.2c; `specs/work-pet/spec.md` corresponding weather/expression scenarios. Read exact edits in `patches/`.
