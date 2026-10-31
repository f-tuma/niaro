# Independent final source review — personal output voice and composer

**Verdict: ready for root's functional source acceptance within this review's scope; zero concrete findings.** This is not final product acceptance, visual/native approval, provider compatibility certification, full CI execution, or release authorization. No implementation fixes were made.

## Subject, independence and authority

Reviewed on 2026-10-31 in a fresh dispatched Orca worker context, Task `task_8df6455f554d`, Dispatch `ctx_4d1c0e38c7d8`, terminal `term_b76ce00a-8355-4df4-b804-9e1e9d58a7c7`. `orca-provenance.json` records requested **and effective** Codex model `gpt-6.1-sol`, effort `xhigh`. No nested agents, author conversation, prior review reports, repair narratives or root handoff were consulted. The explicitly required owner decision was read as authority; its linked review narratives were not opened.

The exact subject is the 22-path SHA-256 map in `/tmp/niaro-resume-20261031/final-voice-subject.json`, patch `/tmp/niaro-resume-20261031/final-voice.patch`, and frozen copies under `final-voice-source/`. Base is `4e117be13dce08cb1f040d90f699d0b02bab9757`. Every current subject file matched its expected hash and frozen copy before checks and again at closure. The independent patch probe reconstructed all 22 expected files from that base with `patch --fuzz=0`; the seven accepted S1 protocol/catalogue/store/source-test files match their base blobs. Exact hashes are in `hashes-before.json`, `hashes-after.json`, `s1-context-hashes.json` and `source-and-context-manifest.json`; the patch hash is recorded in both before/after files. Review artifacts alone were written below this review directory.

Canonical requirements read: `openspec/changes/personal-output-voice/{proposal,design,tasks}.md`, `specs/voice/spec.md`, `specs/models-and-providers/spec.md`, and `reviews/implementation-readiness-20261030/owner-decision.md`. There is no change-root `owner-decision.md`; the actual decision path is the one linked by the canonical documents. Also read `CONTRIBUTING.md`, the requested spec-review skill/template, Orca worker instructions, and React review guidance. No applicable `AGENTS.md` was found in the workspace or searched ancestors. The composer requirements are those stated directly in this dispatch. Separate weather planning documents were outside the subject.

## Intended behavior in my own words

A person may keep following the current workspace voice or save one of the server's narrow, reviewed alternatives. That preference belongs to the authenticated organization/workspace/person tuple and is shared by the person's mobile and browser-issued sessions. Reading and saving it are passive local settings operations. A strict negotiated sidecar keeps all legacy speech envelopes unchanged; clients never choose a raw provider, model or voice ID.

The store distinguishes saved intent from today's effective voice. An incompatible or unreadable custom preference falls back visibly to the current default, while Reset can clear that intent even when the default is already displayed or speech is disabled. Saves use personal and catalogue revisions. An exact last committed mutation receipt can resolve a lost response without another write; stale or changed requests cannot overwrite newer state.

A separately requested synthesis resolves today's voice once and retains that pin through the existing reader retry. Current access, assistant text, route, compatibility epoch and allowed voice are checked at dispatch and before audio return. A later preference save affects a later synthesis and leaves playing audio alone. Settings do not preview, record, discover providers, change routing, toggle spoken replies, or send workflow commands.

Mobile keeps its picker open and acknowledged selection disabled until success, fences dismissal and late responses, and reconciles on reopening/foreground. Web uses its normal Select change lifecycle and a conditional Reset for stale intent. The composer removes the separate reference action and its width, offers References through paperclip context, and places typed filtered suggestions immediately above the input while retaining draft/caret/metadata ownership.

## Source assessment and evidence

| Boundary | Actual source inspected | Assessment and exercised evidence |
| --- | --- | --- |
| Strict settings HTTP | `packages/protocol/output-voice.ts`; `apps/fixture-server/output-voice-http.ts:14`; `apps/fixture-server/http.ts:1289`; `apps/server-identity/service.ts:3334` and `:3701` | Profile/extra-query/method validation, raw-byte 2 KiB POST limit, strict bounded response/update schemas and 32 KiB response bound; auth precedes delegation and callbacks reauthenticate current identity after body arrival. Node HTTP cases exercised missing/duplicate/unknown profiles, malformed/oversized/injected bodies, unadvertised choices, own-only mobile/browser access, held-body revocation and zero provider/workflow changes. |
| Catalogue, persistence and receipts | `apps/server-integrations/speech-voices.ts:26`; `apps/server-identity/output-voice.ts:102`, `:152`, `:238`; `apps/server-identity/service-catalog.ts:491`, `:1194` | Exact mini-reader PCM16 pin only; actor-scoped opaque IDs; compatible default edits preserve custom intent; successful relevant catalogue commands observe both sides atomically so A→B→A/disable→enable cannot revive it. Actual SQLite tests cover isolation/FKs, corruption, stale Reset, CAS/replay/collision, restart and rollback. The independently authored store probe additionally ran changed-catalogue receipt replay, stale-token refusal, 30 no-ops retaining the receipt, disk reopen, another actor and disabled-route Reset. |
| Synthesis pin and existing guards | `apps/server-identity/service.ts:3538`, `:3567`; `apps/fixture-server/http.ts:1520`; `apps/server-integrations/speech.ts:216` | Admission re-resolves current selection and freezes the effective voice. Each actual attempt uses HTTP text/auth guarding plus current route/catalogue/epoch/allowed-choice validation, then existing provider usage charging; return reuses the guard. Preference-only updates do not alter the pin. Held synthetic transport tests cover before/after route, provider/model/default/privacy/epoch/auth/text invalidation, registry removal, pinned one-retry behavior, refusal without fallback, quota, per-scope/global-eight concurrency, abort/disconnect/deadline and release. Deadline testing shortens the production timer synthetically; it is not a 65-second wall-clock run. |
| Passive ClientSession methods | `packages/client-core/session.ts:2051`, `:2097`, and private `open/readJson/json` | Uses only the authorized negotiated endpoint, strict parsing/UTF-8 bounds and current scope/session checks. 404 and exact profile 406 are unsupported; auth/network/malformed responses stay failures. Existing credential renewal never automatically repeats the POST. Tests exercise ignored abort, late body after stop, scope mismatch and refused-write renewal. |
| Real mobile controller and sheet | `apps/mobile/VoiceSettings.tsx:100`, `:106`, `:163`; `packages/ui-catalog/OutputVoiceCard.tsx:47`; `apps/mobile/ScreenChrome.tsx:1269` | Editor mounts outside the combined disabled-capabilities branch; presentation card owns no effects. Actual mounted VoiceSettings tests exercise immediate one-POST selection, acknowledged display, no-op intent, stale/corrupt Reset with both services disabled, EN/CS loading/error states, conflict/unknown reconciliation, exact explicit retry, earlier GET fences, same/foreign Session replacement, background and unauthorized stop. Actual DetailSheet scrim/back/swipe callbacks invalidate ownership at dismissal start before exit. Tests also retain an already-playing ReplySpeech through output-only ACK with no preview. |
| Web `/me` | `apps/server-admin/web/app/router.tsx:113`; `account-page.tsx:286`; `output-voice-settings.tsx:31`, `:91`, `:184`; actual shared Select wrapper | The production route mounts the account controller and its output section. Source uses the ordinary controlled-value Select without replacing its popup lifecycle, and adds Reset only for stale/unreadable intent. Mounted controller tests verify immediate save, disabled acknowledged value, Reset removal, failures, unknown GET then explicit exact retry, conflict without reapply, old reads and session/user/workspace/background ownership. Tests substitute shared UI host primitives; they do not execute Radix's DOM popup or prove browser layout. |
| Cross-surface production boundary | `tests/output-voice-client-http.node.ts:26`, plus HTTP/store tests | The narrow integration uses real ClientSession → reference HTTP → identity/store with mobile and browser-issued credentials, compares shared acknowledged snapshots, resets, exercises conflict/unsupported/foreign-scope/revoked access, checks another workspace and unchanged workflow snapshot, and asserts zero provider calls/usage. Separate actual HTTP/store cases cover other users/organizations and roles. It does not mount both UI surfaces in one browser/native end-to-end test. |
| Composer and changed expectations | `apps/mobile/ScreenChrome.tsx:185`, `:1003`, `:1015`, `:1135`; `apps/mobile/App.tsx:2749`, `:2847`; `packages/ui-catalog/AttachmentPicker.tsx:26` | Separate `onMention` action and width accounting are removed; only paperclip occupies the left action position. References is an explicit context entry; typed suggestions follow attachment draft and precede Composer. Centering adds no footer height/padding. Changed expectations correctly reduce four actions to three and open References through paperclip; negative stale-draft/no-send assertions remain. Actual Workspace/Composer regressions cover captured caret, equal-text revisions, reference metadata removal, draft/session ownership, Android focus-return fences and stable input across widths/font scaling. Native IME operation and visual centering remain separate evidence. |

Opening/selecting/saving settings is covered by synthetic call counts, actual HTTP/provider usage checks, source call-graph inspection and playback tests. This supports passive behavior and next-synthesis-only semantics within the tested boundaries. It does not certify that a live routed provider accepts every advertised voice.

## Changed tests and actual discovery

All six output-voice Node files are explicitly present exactly once in `package.json`'s real `test:identity` script: protocol, catalogue, store, HTTP, dispatch and client-HTTP integration. CI's server matrix invokes `scripts/ci-node-tests.mjs test:identity` across six shards; that helper extracts the script's `.node.ts` list. The three new Jest suites match the actual core `.test.ts` / UI `.test.tsx` projects and were both discovered and executed. CI runs Jest in three shards. This verifies registration/source discovery, not execution of every CI job. Details are in `discovery-evidence.json` and `jest-discovery.log`.

The voice/client/UI tests are new files, not weakened replacements of existing speech contracts. Composer expectation changes track the intentionally removed action, while preserving stable input, stale ownership and no-autosend assertions. Existing speech, automatic speech, playback and reference regressions were run unchanged.

## Findings and disposition

**No concrete findings.** No blocker, unresolved product decision, implementation defect or requested fix was established for the frozen functional source. Consequently there are no finding IDs or finding rows to manufacture. Root should combine this source review with the separately owned visual/native evidence and its canonical integration checks before final acceptance. Any material source change requires a new hash-bound review of that change.

## Limits and observations

- No browser, emulator, native binary, running user service, private database, provider credential, external provider call or paid/live audio probe was used. Only synthetic local HTTP/store/provider transports were exercised. No dependency install, source edit, commit/index staging, publication or deployment occurred.
- Actual light/dark, phone/desktop, keyboard/screen-reader rendering, native caret/IME behavior, sheet animation quality, real audio and provider acceptance remain unassessed here. Separately owned Astra evidence is not inferred from these tests.
- `npm run check`, the full identity/storage/Jest repository suites, strict OpenSpec validation and actual CI jobs were not run by this bounded reviewer. Root owns those final integration/canonical gates. Full TypeScript checking, targeted suites, focused lint, boundary checking and an isolated production admin build were run.
- The admin build used the committed Vite configuration with only a `/tmp` output/cache location and runner config loader, plus the normal font-license step; shared `dist-admin` was not written. Existing bundle-size warning was observed; this review does not infer a new voice-related performance regression from the aggregate bundle size.
- Initial Jest execution emitted an environment Haste module-name collision from a backup tree but all 13 requested suites passed. Discovery was separately run with that private backup tree ignored. No private backup contents were inspected or used as fixtures. Node emitted its SQLite experimental warning. There were no test fixture setup failures or failing production checks.
- The accepted three-voice pin remains the owner's explicitly bounded upstream-contract inference; this reviewer did not re-certify provider alternatives or browse new provider claims. Unknown/unreviewed routes remain default-only.
- Existing daily provider quota and concurrency guards remain. Settings CAS/last-mutation receipts do not provide durable synthesis request deduplication. Speech request IDs remain correlation, repeated explicit synthesis POSTs may call again, and no new speech spend ledger/budget promise is made. Dedicated TTS privacy forwarding remains an inherited limitation outside activation of this reader-only catalogue.

## Exact command execution

All commands below ran from `/home/flamendrin/workspace/niaro`. Test/probe temporary directories were directed into this review directory using `TMPDIR`. `commands.jsonl` is the machine-readable record of complete argv, UTC start, exit code, elapsed wall time and log path. Runner instrumentation lives in `run.py`; independent probes and isolated build source are retained beside their logs.

### node-output-voice

```sh
node --import tsx --test tests/output-voice-protocol.node.ts tests/output-voice-catalogue.node.ts tests/output-voice-store.node.ts tests/output-voice-http.node.ts tests/output-voice-dispatch.node.ts tests/output-voice-client-http.node.ts tests/catalog-speech.node.ts
```

Exit **0**; **14.411 s**; started `2026-10-31T09:44:31.828683+00:00`; log `node-output-voice.log`.
Result: 93 passed, 0 failed/skipped/cancelled.

### jest-voice-composer

```sh
node_modules/.bin/jest --runInBand --cacheDirectory /tmp/niaro-resume-20261031/final-voice-review/jest-cache tests/output-voice-client.test.ts tests/output-voice-mobile.test.tsx tests/output-voice-web.test.tsx tests/conversation-history-mobile.test.tsx tests/voice-composer.test.tsx tests/mobile-mentions.test.tsx tests/mention-selection.test.ts tests/speech.test.ts tests/speech-http.test.ts tests/speech-client.test.ts tests/automatic-speech.test.ts tests/native-speech-playback.test.ts tests/speech-playback.test.ts
```

Exit **0**; **27.856 s**; started `2026-10-31T09:44:31.830930+00:00`; log `jest-voice-composer.log`.
Result: 13 suites and 200 tests passed, 0 snapshots.

### eslint

```sh
node_modules/.bin/eslint packages/client-core/session.ts apps/mobile/VoiceSettings.tsx packages/ui-catalog/OutputVoiceCard.tsx packages/ui-catalog/OutputVoiceCard.stories.tsx packages/i18n/index.ts apps/server-admin/web/app/account-page.tsx apps/server-admin/web/app/output-voice-settings.tsx apps/mobile/ScreenChrome.tsx apps/mobile/App.tsx packages/ui-catalog/AttachmentPicker.tsx apps/server-identity/service.ts apps/server-identity/mobile.ts apps/fixture-server/output-voice-http.ts apps/fixture-server/http.ts tests/output-voice-client.test.ts tests/output-voice-mobile.test.tsx tests/output-voice-web.test.tsx tests/conversation-history-mobile.test.tsx tests/output-voice-http.node.ts tests/output-voice-dispatch.node.ts tests/output-voice-client-http.node.ts
```

Exit **0**; **8.376 s**; started `2026-10-31T09:45:42.607728+00:00`; log `eslint.log`.

### admin-isolated-build

```sh
node /tmp/niaro-resume-20261031/final-voice-review/build-admin.mjs
```

Exit **0**; **1.466 s**; started `2026-10-31T09:45:59.367932+00:00`; log `admin-isolated-build.log`.

### types

```sh
node_modules/.bin/tsc --noEmit --incremental false
```

Exit **0**; **30.952 s**; started `2026-10-31T09:45:42.619436+00:00`; log `types.log`.

### jest-discovery

```sh
node_modules/.bin/jest --listTests --runInBand --cacheDirectory /tmp/niaro-resume-20261031/final-voice-review/jest-cache --modulePathIgnorePatterns '<rootDir>/.servers/'
```

Exit **0**; **1.101 s**; started `2026-10-31T09:46:49.550522+00:00`; log `jest-discovery.log`.

### probe-store

```sh
node --import tsx /tmp/niaro-resume-20261031/final-voice-review/probe-store.ts
```

Exit **0**; **0.227 s**; started `2026-10-31T09:47:53.364394+00:00`; log `probe-store.log`.

### probe-subject

```sh
python3 /tmp/niaro-resume-20261031/final-voice-review/probe-subject.py
```

Exit **0**; **0.059 s**; started `2026-10-31T09:47:53.613729+00:00`; log `probe-subject.log`.

### boundaries

```sh
node scripts/check-boundaries.mjs
```

Exit **0**; **0.707 s**; started `2026-10-31T09:48:29.339639+00:00`; log `boundaries.log`.

## Closure

Reviewer work is complete for the exact manifest subject. Functional verdict: **ready, zero findings** within the stated limits; root retains final acceptance, canonical task/evidence updates, visual/native gates, tests/commits and publication authority. Before/after subject verification and the final evidence manifest accompany this report.
