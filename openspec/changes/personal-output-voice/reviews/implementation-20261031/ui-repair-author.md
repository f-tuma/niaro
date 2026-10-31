# Personal output voice — UI-01/UI-03 repair and client HTTP test

The authorized repair is implemented and frozen for fresh independent closure. **This is an author verification report, not an independent final review or feature acceptance.** Root retains source acceptance, test registration, combined/full checks, native/visual acceptance and publication.

Current authority: Task `task_07d67a8166dc`, Dispatch `ctx_c066c693e56a`, terminal `term_e632020b-6aac-49ac-a094-fe5b2aee3432`. Actual Orca launch/effective provider metadata confirms `gpt-6.1-sol` / `xhigh`; see `reviewer-author-provenance.json`. No nested agents were used. The version-matched live orchestration guide and injected lifecycle instructions were followed.

All four gate entries in `/tmp/niaro-resume-20261031/ui-repair-gate.json` matched before edits, including the required absence of `tests/output-voice-client-http.node.ts`. Only those four repository paths were written. The three original files are retained under `before/`, and all four final files under `freeze/`. `repair.patch` is a minimal unified diff against those exact before bytes, without Git/index access. All 17 other source/backend pins checked for this lane remained unchanged, and all 25 prior review evidence hashes still matched; see `protected-source-check.json`. Prior review/archive artifacts were not changed.

Changes:

- **UI-01:** after the existing ownership, abort, generation/write and nondecreasing revision checks accept a GET, `VoiceSettings` clears only `outputVoiceLoadFailed`, and only when there is no unresolved pending mutation. Successful passive reads do not erase a conflict message or save uncertainty; the existing pending-mutation reconciliation block still decides whether a write is resolved.
- **UI-03:** `OutputVoiceCard` accepts passive `loading` and interaction `disabled` separately from active mutation `pending`. `VoiceSettings` marks a save active only while its pending mutation is waiting and no passive reconciliation read is running. A held settings GET uses existing localized `outputVoiceLoading` text, polite live-region/busy semantics and disabled choices; it does not announce Saving or use the save/error alert role. The existing initial loading description avoids a duplicate message. Closing still disables interaction, and the DetailSheet ownership callbacks are unchanged.
- **Regression tests:** two new mounted scenarios, each run in EN and CS, exercise actual `VoiceSettings`, `OutputVoiceCard`, `DetailSheet` and `ClientSession`. One proves that explicit recovery replaces the load error with acknowledged Cedar and removes Try again. The other holds the picker GET, checks zero POSTs, retained selected/disabled state, correct loading text and recovery of interaction after the GET. No existing expectation was weakened.
- **Narrow HTTP integration:** one new production Node test exercises actual ClientSession over ephemeral loopback reference HTTP with real synthetic identity authentication, catalogue, queue and SQLite preference store. A genuinely paired mobile grant saves Echo and the same person's browser-issued grant sees it; exact replay keeps revision 1, old CAS is rejected, another workspace remains independent and cannot reuse the catalogue, and browser Reset returns to mobile at revision 2. The test checks real unsupported-profile negotiation, rejection of a mismatched local actor claim and a revoked real synthetic grant. All ClientSession calls stay on settings, workflow snapshots remain structurally identical, provider requestsToday remains zero, and a throwing IntegrationTransport counter remains zero.

The integration test reuses existing `authRequest`, production schemas, reference-server and identity factories. Existing specialized test helpers either bypass identity or add unrelated attachment/process fixtures, so the test keeps a local minimal synthetic setup rather than extending those helpers or copying the broad backend refusal/dispatch matrix. The new test writes no durable report or fixture into the checkout, has cleanup registered before initialization, and uses `tmpdir()`; this task ran it with TMPDIR scoped to `ui-repair`.

Exactly replaced boundaries: the external IntegrationTransport is a throwing counter; config, identities, credentials and client cache are synthetic and isolated; one fetch URL query is rewritten to obtain the real handler's 406; one local credential user claim is deliberately mismatched to exercise the real ClientSession response-scope check. ClientSession methods, HTTP router/handler, authentication, identity queue, catalogue and SQLite preference store are not mocked. No fake editor/controller or external provider/network was used.

Red/green and verification:

| Run | Result and measured wall duration | Evidence |
| --- | --- | --- |
| `ui-red`: new mounted cases before any production repair | Exit 1, 8.178 s; all four EN/CS instances failed behaviorally at the stale-error and false-Saving assertions. Compilation and mounting succeeded. Existing source copies plus `red-tests.tsx` are the captured defective subject, pinned by `red-subject-hashes.json`. | `ui-red.log`, `ui-red.result.json` |
| `ui-green`: complete mobile voice suite after repair | Exit 0, 2.230 s; 27/27 tests pass, including original unknown-save/exact-retry, conflict, stale/corrupt Reset, scrim/back/swipe, session/background/late completion, stop and playback-path cases. | `ui-green.log` |
| `client-http`: new real ClientSession/HTTP/identity/store test | Exit 0, 9.896 s runner; 1 test, 1.617 s test body; all passive-call and cross-surface assertions pass. | `client-http.log` |
| `regressions`: eight affected client/mobile/web/composer/speech suites | Exit 0, 15.678 s; 143/143 tests, 8/8 suites pass. | `regressions.log` |
| `typecheck`: direct `tsc --noEmit --incremental false` | Exit 0, 27.580 s, no diagnostics; avoids source-generating npm prehook. | `typecheck.log` |
| `lint`: ESLint on the exact four authorized files | Exit 0, 1.679 s, no diagnostics. | `lint.log` |
| `boundaries`: existing repository boundary checker | Exit 0, 0.590 s, no diagnostics. | `boundaries.log` |
| `format`: Prettier on those four paths only | Exit 0, 0.300 s. Final regression/static checks followed. | `format.log` |

Every exact argv, UTC start, exit code and measured duration is in `commands.json` and the individual `*.result.json` records. The original production defects themselves supply the meaningful negative-control evidence; no additional temporary production defect was introduced after repair. The old review scratch probes were not rerun or changed.

Final source SHA-256:

| Path | SHA-256 |
| --- | --- |
| `apps/mobile/VoiceSettings.tsx` | `6cb4f154fccf8bca07e51391cc42130839771af7233371ed74e7cd48d6472e88` |
| `packages/ui-catalog/OutputVoiceCard.tsx` | `0e26cf8ac29238fe7ba41dc8fc4f2e2eb2293af789cec2aa2926b793ee77a02f` |
| `tests/output-voice-mobile.test.tsx` | `8785b8da58579e539b3dce27ea80145cfb77c7a32ae2147e17d6ed7b6a5902d4` |
| `tests/output-voice-client-http.node.ts` | `7d46ee90c020922edd25721a306c8852f55d4632bedca18fd7a4e8be09871b0d` |

Scope and remaining work: no App, ScreenChrome, composer, playback, i18n, protocol/backend, web, package/config/lock/dependency, canonical or Git change was made. The new Node test remains outside the current explicit `test:identity` registration at the recorded checkpoint; root owns registering it and the previously identified HTTP/dispatch suites. No build was needed for these mobile presentation/test changes, and no shared dist-admin output or running/shared service was touched. No browser/emulator/native UI, real audio, private data/account, external/paid provider or full combined `npm run check` was used; the only server was the test's own synthetic ephemeral loopback listener. Root/Astra retains the native lease and root will arrange fresh independent closure on these exact hashes. English records and existing EN/CS product text were retained without new copy or dependencies.

`evidence-hashes.json` pins this report, commands/results, before/final/guard manifests, red subject, minimal patch and frozen source copies. A material change to the subject requires new verification and independent review.
