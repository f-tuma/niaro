EGM Stage 9 — Codebase Details; Mode REVIEW; fresh isolated Orca reviewer, no nested agents.

Subject: openspec/changes/personal-output-voice/design.md, resolved semantic target “## Detailed Implementation Plan”, lines 175–239. Full feature contract lines 1–174, proposal, tasks and both supplied delta specs were read as context. Target SHA-256 before and after review: 6a56cdd2a9671fea319e95edc5d4df213f157752a22fd2f242afb19ab1b69811, matching the dispatch. HEAD before and after review: 3cbe09fdaff6d07b0c1b7c14e8d71e67b2ddb530; the source byte hashes below govern this shared dirty checkout.

Behavior understood: the server keeps workspace speech routing/default authority, adds a separately negotiated own-person preference resource and actor-scoped SQLite preference, and resolves an opaque advertised choice only in the existing synthesis closure. Mobile and web share that preference; passive settings operations cannot synthesize/probe, unsupported servers preserve existing speech, and a frozen invocation retains its voice and existing quota/cancellation/retry boundaries. The proposal explicitly does not introduce a speech spend ledger or durable synthesis deduplication. Catalogue activation and the playback exception remain visible owner decisions; this review neither accepts them nor authorizes implementation.

Verdict against the supplied implementation-readiness standard: one Major unresolved UI design choice and one Nit about an existing mobile branch. No concrete backend code/interface contradiction or Blocker was established in the inspected paths. The new proposed files are deliberately absent and are not findings.

Flat findings:

C9-01 | Major | design.md:206–217 (S4 ownership/checkpoint), governed by design.md:144 and tasks.md:4.2.
Evidence: D5 leaves saving as “on an explicit selection/confirm as existing control convention dictates.” The actual reusable ListRow exposes only onPress/selected (packages/ui/index.tsx:772–807, 881–889); DetailSheet offers optional actions without prescribing selection or commit behavior (apps/mobile/ScreenChrome.tsx:1022–1043); the existing LanguageMenu commits immediately on an option tap and closes (apps/mobile/LanguageMenu.tsx:112–126). Thus the cited existing controls do not choose whether this new editor saves on an option tap or holds a draft until confirmation. The S4 file list/checkpoint and UI verification row do not settle that choice either.
Consequence: two implementers can produce different preference mutation triggers and different close/back behavior while each follows this plan. That is an actual remaining UI design choice under the standard’s Zero-Decision Rule, rather than a missing implementation file.
Next step: choose one precise interaction before implementation and record it in S4/D5: which event starts POST, whether selection is merely draft state, what dismiss/back does, when the picker closes, and how saving/failure affects that state. Name the reuse boundary, e.g. a presentation-only card/rows with VoiceSettings owning DetailSheet and effects, so the catalog component does not need to reach back into the mobile app. Bind the new mobile test to that exact event sequence; no ScreenChrome edit is inherently required.

C9-02 | Nit | design.md:206, 217 and 231; affected current code apps/mobile/VoiceSettings.tsx:53–67.
Evidence: current VoiceSettings returns a single unavailable-services Group before reaching SpokenRepliesCard when input and speech are unavailable. D5 says to add the output card below spoken replies, while the governing contract (design.md:100; voice delta “Speech unavailable”) requires clearing a stale choice to Server default even with speech disabled.
Consequence: a literal insertion only below SpokenRepliesCard leaves that required reset editor inaccessible on the existing early-return branch. The plan already owns this file and requires unavailable-state coverage, so this is a small missing implementation detail, not a claim that unimplemented code is broken.
Next step: explicitly retain/mount the output-settings editor independently of the combined input/output availability shortcut, and include an actual VoiceSettings test with both capabilities disabled and a stale saved choice that can be reset without a provider call.

Read coverage:
- Persona read first and implementation-readiness standard read in full; CONTRIBUTING.md and spec-review skill read. Full target design (all 239 lines), proposal.md, tasks.md and both supplied delta specs read. Main voice specification’s relevant phone-only, synthesis, retry and cancellation clauses inspected.
- packages/protocol/speech.ts and apps/server-integrations/speech.ts read in full. Checked strict speech shapes, SpeechSelection/DispatchGuard integration, reader PCM16 versus dedicated MP3 path, existing one retry and the existing dedicated-branch privacy omission. Checked Routing.speech and Scope/sameScope definitions.
- Identity source: initialization/FKs, accountRuntimeAccess authentication/run/check and complete speech closure, membership revocation/deletion, serial/transaction helpers; ServiceCatalogStore model/resolveSpeech/provider/useProvider/routing, authorityShape and provider/model/routing mutations; MobileRuntime and mobile/browser grant/membership checks. Existing PersonalActionPolicyStore inspected for reuse: it is action/service-specific and has different replay semantics, so a dedicated bounded output store is justified.
- HTTP source: route recognizer, account/demo selection, authenticated bridge/run, bounded body helper and complete speech GET/POST/concurrency/timeout/return guards. Existing transport and guard can carry a different internal voice without changing speech.ts’s public envelopes or adding a second provider path.
- ClientSession: identityKey, credential renewal and no-write-replay path, private open/json/readJson transport, strict synthesis parsing/sameScope, stop/invalidation. Mobile VoiceSettings and ReplySpeech, shared playback controller, ListRow, SpokenRepliesCard, LanguageMenu and DetailSheet inspected. App.tsx mounting/cancellation call sites inspected only; no edits.
- Web account-page imports/mounting structure, context.ts and chat-session.ts; actual React test host helper/mocks, Jest matching, Storybook glob and package test registration checked. Inspected test infrastructure in catalog-speech.node.ts and speech-http.test.ts, not a broad audit of simple unit assertions. Existing Node tests are explicitly enumerated, so root’s package registration step is necessary and correctly identified.
- Local public-model-metadata.json and selected official-source SDK/audio-guide passages inspected as supporting context. The method-level three-voice inference remains expressly limited; no independent runtime support certification was inferred.

Access limitations / unassessed:
Static read-only review only: no workspace/report writes, implementation, compile/test commands, browser/emulator/native interaction, server restart, credentials, private databases/account data, live provider discovery or paid synthesis. Did not read other reviewers/reports or retrieve parent/author conversation/history. Did not independently re-fetch every D1 URL or audit the provider’s private adapters; sampled supplied official snapshots do not establish live voice/backend support. No claim of runtime test pass, UI accessibility pass, real-audio quality, completed migration or production readiness is made. Unrelated pet/composer work and the rest of the large identity/client modules outside the listed paths are unassessed. Root owns finding disposition, repairs, acceptance and any later source-bound verification.

Exact SHA-256 inventory of reviewed target/context and inspected source bytes (hashing a file does not claim every line was read; coverage is specified above):
8546a8187adffa9324860e130d0c1cc2340b5e77a96a8f8021427cbc79812bb4  CONTRIBUTING.md
6a56cdd2a9671fea319e95edc5d4df213f157752a22fd2f242afb19ab1b69811  openspec/changes/personal-output-voice/design.md
f102162b6aa2a405589a572f4f1e7569ca96e9f97a907551d598e80b60b40aa1  openspec/changes/personal-output-voice/proposal.md
38c7caa83e841957a41cbefcb6f815547190cd04f95f00b3c21d3e44150f5b7d  openspec/changes/personal-output-voice/tasks.md
e63a05bf6c98bcf1d4b3152d278716235b5cb86953d4e29cef5305b7f315deb0  openspec/changes/personal-output-voice/specs/voice/spec.md
6ed15874d6b5cfc17bf6d3e3312c7d3f46a51d59ff52657f580e70e7169990fb  openspec/changes/personal-output-voice/specs/models-and-providers/spec.md
210e76e66b75a58263070191bcae2c8c5f366dcaf652c6f7811d8b4d8df03da3  packages/protocol/speech.ts
75278ef8d09633588494f48b2f510a57fd1321ebc280d0d348bf47fe2ede42bb  packages/protocol/service-catalog.ts
0e7b8daec73161615a4c2856ed357784419ea497d989c4f8b9399ccdf42d3652  packages/protocol/index.ts
054e4626e9378ff3571711512404c81a7800a5d6dee26bc56861897221d3f56b  apps/server-integrations/speech.ts
cc5c3750348d67cd2debe9d2aabb72b5b88ad91142d7d3e4f797c4de3668d1e2  apps/server-identity/service.ts
d18addb953110924e3e8265348db9f08c28832a9e6d636e39d11c6b0742cf7c7  apps/server-identity/service-catalog.ts
354ef72c28d6c5a21c83e5018c8122d64588634009280d9a9fee9fdd4467389e  apps/server-identity/mobile.ts
3a4df7f0a105272c500b490c55e8de6c13c0746474cb9506408194c59cc6b215  apps/fixture-server/http.ts
32ddcd2cbb85ac77548e6b5e46e2dcb58a33b50a5b776f8301c9b74603e2cf18  packages/client-core/session.ts
af1cc085f38d582e1c81fa8af6ec7fcb791ae247f2e333fc6265ef9ceb394236  apps/mobile/VoiceSettings.tsx
5ef49a388c5175a029be10ede8d4b356db0ca33fd0c01d85163194bf0fbe415a  apps/server-admin/web/app/account-page.tsx
bd04e9260808bca73ce2ca45548887f3833fa0ec6821940986c76c801fb474bd  apps/server-admin/web/app/context.ts
5f2a403875c8731c6f7077a158f293718bd3dfd286fca71ca8fa075c85d90e49  apps/server-admin/web/app/chat-session.ts
45ad62c6f8810fcb84882fa872bff694b6dde82def6cab4bb29a697a6377c57c  apps/mobile/ReplySpeech.tsx
5f029d59e2d77c4663d09e32c8eea5918f7fc6328d436ec77662ae29ad1744bb  packages/client-core/speech.ts
56d770c00c0beaf03c4a0e04f3b0ded4944cd98dceda631bdd8717d516e558ba  apps/server-identity/personal-action-policy.ts
ba4179aaf86536e5cea3695fe039ec64c0c65acd0c0f46f6a72b4656474f473d  apps/server-identity/catalog-controller.ts
1359d82351c95d2cdb39509b43dfe012964c610efe7bca7ff5bc5474e44a84ed  apps/mobile/ScreenChrome.tsx
e7625a9a3d7ad594b11ab171c6876ded3ea6e391cdc3dea1bf36c56e69f71d49  apps/mobile/LanguageMenu.tsx
5a26f9c27da84a923e45b8172fc517079742f4342a0910d19a336a574e703895  packages/ui/index.tsx
e7b26f8be55723821ada5095e0f062432c44f9ffcc66fec310ac4a37d8e7b2dc  packages/ui-catalog/SpokenRepliesCard.tsx
1d7b7c989fac34a66f5019312550545246f60956af68423a362ddefa73e2486c  scripts/check-boundaries.mjs
6f6061cd812b0bf109204fbe7dcfa807d9379e69f074d729f01800981da21522  tests/helpers/web-hosts.ts
2dae5c73c0d687dd5a99573ba71d900507cdf247bff05e702ba570750f821a72  tests/web-meetings.test.tsx
a68ca9025a6f4533e0813056f30fdd9105d504cc421bcdbc0f7ee8af2d4079a3  tests/web-personal-permissions.test.tsx
63b1dd479bb2b94ed34f0cda2fe5e74dca7df08b45250c8652919e15fb5b92b5  tests/meeting-device-mock.ts
99a299faf8ae09264d4f301e9372fec37ecf5d29f8ab54c528d0ae23f5689f8b  tests/catalog-speech.node.ts
8570db1bb1415e4e04a5421b21af7859a7397f8a268cc21b8f98f92ee1b6c914  tests/speech-http.test.ts
d963670c164b6b8606f2b69413c4e1802bc72b2e947344a3cf7fd5ab7524af65  package.json
506dc26c7a912324a7172b5ecf4299f7c93868dc21f817f748bfab07b8231830  jest.config.js
416da9111c8a918579ae9bce48448f4d65f08cecd6555f58ac4578169ff9baaf  .rnstorybook/main.ts
b290cc6a6cadc1562428f5f62d5cdfc2524688da4fba44431b7f83a0f362c48e  openspec/specs/voice/spec.md
d80db07e449b57b3b3776d1401cca72a54b6b65a0ab218b86f9064ee4b8167bc  /home/flamendrin/.codex/plugins/cache/egm/egm/0.1.0/agents/codebase_details.md
ed0d2a085eac0fd9581d504a2ec0df2a92d6b2538636a22b16e0b1370fba6dbb  /home/flamendrin/.codex/plugins/cache/egm/egm/0.1.0/resources/document_standards/implementation-readiness-standard.md
4bbf60c1b241eadb9a9fa2446082785cd333623cb53ed50a67cc7667a620550e  .agents/skills/spec-review/SKILL.md
e89fbcbd0a51f09a9f1737af3fe0cebbe66c385ec60d548bf467496d7fcccc1c  /tmp/niaro-pet-parity-20261030/output-voice/public-model-metadata.json
c42d4f538cef710809b2eea7bf1193f8093207aefc7a4d3ba3754324f3d85f91  /tmp/niaro-pet-parity-20261030/output-voice/official-source/openai-completions.ts
b0da4dc921abcc5aef4afcb0531dad010b91953a3bd9bb1805e131dc95c021c5  /tmp/niaro-pet-parity-20261030/output-voice/official-source/openrouter-audio.md
a3f7a3ae4fa8079a3ad7055430f74a133c8e1fb24d1156be38508d03d9062c13  /tmp/niaro-pet-parity-20261030/output-voice/official-source/openai-audio-chat.md

Additional source search/mounting context:
99f64bf1a7f19e276fa733206c72c6bdf640f6c057d5d640c6fc0508bec5eb89  apps/mobile/App.tsx
047f2a6f8d3ce85ebb0de1266ba396cbb099deddf75d42515f56a791a4512aac  apps/mobile/MobileMentions.tsx
13333aa4b1f6fcaeca5cecf23f321137237f905e5e8b16f2053bc2fd617ea53c  apps/mobile/MeetingLibrary.tsx
98891eb7ffb6dfa3ef5c91865091a71b3e313b6b9a402a8cd0aed432c59b621d  packages/ui-catalog/VoiceServiceCard.tsx

Delivery is this exact orchestration payload; no report file was written. Root may persist it under openspec/changes/personal-output-voice/reviews/implementation-readiness-20261030.