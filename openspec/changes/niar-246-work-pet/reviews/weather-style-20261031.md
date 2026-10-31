I reviewed D6b and D6c against the Style Goldfish rubric, the implementation-readiness standard, the canonical change context and current source interfaces. I found five Major readiness issues and two editorial Nits, including an existing transport behavior that prevents the required 304 path. The design needs the concrete definitions and references described below before this slice meets the zero-decision rule; no implementation or verification work was performed.

Review identity and result

This is the Step 9 implementation-readiness slice for D6b “Expressions, touch and weather” and D6c “Personal weather sidecar and native gates,” resolved again at design.md lines 230–244 and 245–280. It is not a five-stage EGM review or a whole NIAR-246 review. Result: needs work under the supplied standard. I found no separate Blocker-level issue within this style-focused assessment; the Major findings still prevent an implementation-ready result.

Target: openspec/changes/niar-246-work-pet/design.md.
Target SHA-256: 81c2cd46fecd3363fa6e64f75738a0e4e653d83071dc9fc63f40058f71b2966c.
All five files in /tmp/niaro-resume-20261031/weather-review-subject.json matched their recorded hashes at initial verification and final verification. The manifest was not modified.

C3-style-001 — Major — The implementation plan explicitly postpones its file and interface decisions.

Affected scope: D6c lines 264, 266, 272–280; tasks.md tasks 4.4–4.4c and 5.2b–5.2c.

Discrepancy evidence: line 280 says that exact future file allocation is decided by root after review. The tasks name tests and packages, but do not allocate the new store, provider dispatcher, provider parsers, native port, clock/controller and Settings components to concrete production files or define their interfaces. Current integration points are concrete: IdentityService.appActor is private at apps/server-identity/service.ts:2356, identity configuration is a strict object at apps/reference-server/config.ts:80–81, ClientSession transport helpers are private, and PetViewProps at packages/ui/PetView.tsx:51–67 has no environment input. “Through existing C1-owned props after freeze” at line 276 cannot serve as an API declaration: the inspected props provide state, level, visibility and occupation, but no period/condition input.

Style/readiness rationale: “root,” “C1-owned” and “after freeze” describe session coordination, not an executable engineering contract for a fresh reader. The standard explicitly requires target files, per-file actions and stable incremental phases, and forbids leaving architectural choices to the implementer.

Impact: an engineer must choose module ownership, dependency directions, public method signatures and the sequence in which the new strict protocol, storage, routes and mobile integration remain buildable.

Next action: add a bounded create/modify file map, exact entry-point signatures and dependency order for this slice. Define the shared renderer environment prop and the identity/client integration methods, and state each phase’s usable behavior and specific checks. Preserve the separate native/dependency authorization gates; documenting the intended changes does not execute those gates.

C3-style-002 — Major — The claimed strict contract leaves state names and observable boundaries undefined.

Affected scope: D6c lines 251, 256–262, 264 and 272.

Discrepancy evidence: the current response skeleton contains preference.city, while nearby rules alternate among City, activeCity, savedCity, chosenCity and selectedCity. A clear of inactive savedCity must preserve Device generation, but the view does not define whether city represents a saved choice, an active choice, or both. The proposed weather union is described as “none/reason” or “fresh/stale” without its discriminant keys, reason values, stale transition or staleAt definition. The capability response promises separate readiness and fixed limits without its actual fields. Command names are listed, but complete strict envelopes and errors are not given. Line 272 also requires invalidation on wall/monotonic “divergence” without a tolerance or comparison rule. There is no current pet-weather protocol or controller implementation in the searched production directories to supply these definitions.

Style/readiness rationale: a strict schema cannot be reconstructed from interchangeable terms and abbreviated field lists. “Fresh,” “stale,” “saved,” “active” and “divergence” need one measurable meaning each.

Impact: independently written server, client and Settings code can disagree about whether a City survives Off/Device, when a sample becomes stale, how unknown outcomes are shown, or when ordinary clock measurement noise clears position and weather. The named boundary tests would have to invent their own expected results.

Next action: specify the complete capability, current, command, refresh, search and error unions, including discriminator names, bounds and nullability. Add a small source/saved-City transition table and exact freshness/clock-invalidity predicates. Define the weather encryption domain and authenticated binding rather than leaving “distinct-domain AES-GCM” as the whole encryption contract; the current saved-memory crypto binds a specific domain and identity tuple and cannot be reused by implication.

C3-style-003 — Major — “Existing bounded IntegrationTransport” does not currently support the required conditional-success path.

Affected scope: D6c lines 264 and 268–270; tasks.md task 4.4a.

Discrepancy evidence: apps/server-integrations/transport.ts:197–204 rejects every HTTP status from 300 through 399 with integration_response_invalid. TransportRequest at lines 14–39 has no option to accept a bodyless 304. Its publicWeb branch is not a solution: it is for explicitly handled redirects and returns only a Location response. The design requires a valid 304 to reuse the accepted forecast and renew validation, while continuing to forbid redirects.

Style/readiness rationale: the phrase “existing bounded IntegrationTransport” implies the existing interface is sufficient and obscures a required shared-interface change. The design and task list never specify that change.

Impact: a weather adapter using the current transport cannot reach its valid-304 branch. A stub-only provider test could appear to prove behavior that the real production transport always rejects.

Next action: prescribe the narrow transport API change that permits the weather caller to receive a bodyless 304 and its needed cache headers, while retaining the current redirect/content-encoding restrictions and default behavior for other callers. Include tests through createTransport itself for accepted 304, refused redirects and unchanged default callers, then test cache interval re-selection through the actual dispatcher.

C3-style-004 — Major — Provider-to-domain projection is described by outcomes rather than a deterministic rule.

Affected scope: D6c lines 256, 260, 262 and 270.

Discrepancy evidence: the design fixes six pet conditions, but does not map MET symbol codes or forecast periods to those conditions. MET’s documented format exposes instant values and multiple next_1_hours/next_6_hours/next_12_hours summaries; the design does not define which summary wins, interval endpoints, unsupported symbols or forecastAt. “Retain settlement results only” likewise supplies no accepted Nominatim jsonv2 class/type/addresstype rule or bounded label construction. “Reject … address-like input” does not specify an executable predicate, especially beside required digit-containing city names.

Primary-source check: the MET format confirms the multiple period summaries, and Nominatim documents featureType and notes that jsonv2 classifications follow varied OSM tagging. This is an inference about missing design decisions, not a claim that either provider’s documented API is broken. Sources: [MET forecast JSON](https://docs.api.met.no/doc/ForecastJSON) and [Nominatim Search](https://nominatim.org/release-docs/latest/api/Search/).

Style/readiness rationale: “covering now,” “settlement,” “address-like” and “condition” hide distinct parsing and classification decisions. They are requirements for outcomes, not enough detail for a zero-decision implementation.

Impact: two implementations can classify the same forecast differently or accept different city results, producing inconsistent visuals, freshness and privacy behavior. A test author cannot derive a single authoritative synthetic oracle.

Next action: add fixed forecast-summary selection and symbol mapping tables, interval and unknown/malformed rules, and exact settlement/label/query normalization rules with representative accepted/rejected EN/CS fixtures. Retain the already chosen bounds, explicit submission and server-held selection. No additional quota is proposed by this finding.

C3-style-005 — Major — “Original weather” is not bound to an available reference, and combined clock/weather mood remains ambiguous.

Affected scope: D6b line 232 and D6c lines 276–278, with the D6 reference at line 190.

Discrepancy evidence: the text refers to version 9 of a prototype artifact and “original weather warm/dim targets,” but supplies no retrievable path or link for those bytes. The explicitly linked parity ledger identifies niaro-pet.html with SHA-256 8c8319dd645aa26e408c9106597e233d6c0d7e7b1fa4ab1ee312e5af55e6f01e. Repository file discovery found the local candidate docs/design/mobile-assistant-2026-10-30/motion/pet.html, whose hash is cebef826788c6ce35f50e9ddc805baddc99c02fa7b99b4d4ec3366bfeca62291; it cannot be silently substituted for the named reference. Its weather model also treats night as a weather key, whereas this design separates period from condition. Line 278 supplies period dim targets but does not say how they combine with weather dim or whether the stated night warmth replaces or modifies weather warmth. The current production shader initializes uMood/uWx to zero at pet-shader.ts:781–782 and draw has no environment argument; it does not provide an active composition rule to inherit.

Style/readiness rationale: “original” and a version nickname are not stable source references. Reuse needs both identifiable source bytes and an explicit account of the adaptation.

Impact: an engineer must choose an unverified prototype, infer mood composition for cases such as night+storm, and define the same-shader particle adaptation beyond its maximum counts. That can change the accepted look despite satisfying the broad prose.

Next action: bind the exact authorized reference to a durable path/link and digest, or copy the necessary weather equations and fixtures into the canonical design. Specify the period/condition composition and the limited particle adaptation, including its transition/fallback behavior, before implementation; leave its native visual acceptance as the already stated later gate.

C3-style-006 — Nit — The face parameter count contradicts the preserved interface.

Affected scope: D6b line 235.

Discrepancy evidence: the paragraph states that the face is driven by nine numbers. Current PetFace at packages/ui/pet-interaction.ts:2–14 has twelve numeric fields: open, lid, low, tilt, love, wink, smile, mouth, blush, wave, asym and roll. The preservation requirement and parity ledger retain those original channels.

Style rationale and impact: a precise count presents an incomplete enumeration as exhaustive and makes it unclear whether three existing channels should be removed.

Next action: describe the nine listed features as a subset, or document all twelve existing channels and their names without changing the renderer contract.

C3-style-007 — Nit — Compressed units and local shorthand reduce scanability.

Affected scope: D6b lines 239–243 and D6c lines 247, 256–278.

Discrepancy evidence: examples include “accepted8KiB,” “unknown/duplicate keys400,” “on the0.01 grid,” “query2–80,” “new48h,” “caps2,000,” “hard2h,” “day0/evening.35/night1” and “expo-location57.0.22.” C1, C3, MAIN and root are also used as local shorthand without definitions in this slice.

Style rationale and impact: missing word/number separators and dense slash chains make limits harder to compare and can make package names resemble different literal identifiers. These are editorial issues rather than a request to alter the chosen limits.

Next action: restore ordinary spacing and units, use package@version notation, state the period values in a small table or sentence, and replace session labels with concrete ownership/module references where the meaning matters.

Inspected context and source

Full canonical reads: CONTRIBUTING.md; openspec/changes/niar-246-work-pet/design.md, proposal.md, tasks.md, specs/work-pet/spec.md and specs/memory/spec.md; the supplied hash manifest.

Review instruction reads: /home/flamendrin/.codex/plugins/cache/egm/egm/0.1.0/agents/style.md; resources/document_standards/implementation-readiness-standard.md; skills/egm_review/SKILL.md and docs/codex.md under that same EGM plugin; /home/flamendrin/.agents/skills/orchestration/SKILL.md and /home/flamendrin/.agents/skills/orca-cli/SKILL.md. The user’s read-only and report-via-coordinator instructions govern this worker delivery.

Direct source/document reads, full or relevant excerpts: apps/server-integrations/transport.ts; apps/fixture-server/storage.ts, http.ts and output-voice-http.ts; apps/server-identity/service.ts, mobile.ts, memory-payload-crypto.ts and output-voice.ts; apps/reference-server/config.ts; packages/client-core/session.ts; packages/protocol/index.ts; packages/ui/PetView.tsx, PetFallback.tsx, pet-interaction.ts, pet-motion.ts and pet-shader.ts; apps/mobile/App.tsx, ScreenChrome.tsx and credential-vault.ts; app.config.ts; package.json; node_modules/expo/bundledNativeModules.json; docs/guides/deployment.md; docs/design/mobile-pet-parity-2026-10-30/prototype-parity-ledger.md and README.md; docs/design/mobile-assistant-2026-10-30/motion/pet.html. pnpm-lock.yaml was searched/hashed, not audited in full. Repository-wide rg path/symbol discovery also returned incidental matches; those were not substantive audits of the matched modules. Missing guessed paths yielded no source content.

The inspected owner lock is the existing exclusive SQLite lock, and service close releases it after draining its current owners. appActor authenticates account scope without creating a model runtime. ClientSession’s current private JSON path renews credentials without automatic write replay and checks text size after allocation. Those are current code observations; the weather protocol, weather preference/cache/dispatcher, native modules and environment integration remain proposed.

Primary pages read on 2026-10-31: [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), [Nominatim Search](https://nominatim.org/release-docs/latest/api/Search/), [MET terms](https://docs.api.met.no/doc/TermsOfService), [MET forecast format](https://docs.api.met.no/doc/ForecastJSON), [MET data model](https://docs.api.met.no/doc/locationforecast/datamodel), [Expo SDK 57 Location](https://docs.expo.dev/versions/v57.0.0/sdk/location/) and [Expo SDK 57 Localization](https://docs.expo.dev/versions/v57.0.0/sdk/localization/). One attempted MET HOWTO URL was unavailable. No live geocoding or forecast request was made. The design’s public Nominatim opt-in, single-owner limitation, explicit searches and caching are consistent with the cited policy’s stated boundaries; this is not provider activation or deployment validation.

Source drift and limitations

I rehashed the following sixteen source/config files after inspection and again before delivery: apps/server-identity/service.ts, mobile.ts and output-voice.ts; apps/server-integrations/transport.ts; apps/fixture-server/http.ts; packages/client-core/session.ts; apps/mobile/App.tsx and ScreenChrome.tsx; app.config.ts; package.json; pnpm-lock.yaml; packages/ui/PetView.tsx, pet-interaction.ts, pet-motion.ts, pet-shader.ts and PetFallback.tsx. No hash changed between those captures. This does not claim that a Git HEAD identifies every dirty file or that concurrent voice work is complete. Key inspected hashes are transport.ts daae07327c1f3cfaae0e2662156b34c8dd699caebd55cea2d13ed9475b51901d, session.ts e1c20b5d38cf247fb52ceca785c7f88e858c6bce1873de72f997c1abaff9f530, PetView.tsx 0741bfb5ec2038455945fdc3713dd71101d73975d2da3efb6ab0e512be302dad and App.tsx adc9b50e4c7e6ed9784b96513e0dff90dbf8ede84e1eb1f0b1431365f7f1a5f1.

This review assesses clarity, precision, source truthfulness and the supplied zero-decision standard. It does not certify all security, concurrency, native permission, visual or performance behavior. The exact original prototype bytes were not available through the design’s reference. No builds, tests, dependency changes, Git operations, native/service operations, private data reads, source edits, canonical edits or report files were performed. Prior review reports, author conversations and handoff/scratch narratives were not read. Full profile/page/memory/Graph/growth work and implementation acceptance remain unassessed.
