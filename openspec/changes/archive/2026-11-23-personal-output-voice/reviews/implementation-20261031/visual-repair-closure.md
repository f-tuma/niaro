# Independent closure review: OVV-01 / OVV-02

Review date: 2026-10-31. Task `task_9d005253bc52`, Dispatch `ctx_fce250224482`.

**Result: zero concrete findings in the exact four-file repair.** Source and production-component tests support closure of the two scoped source defects. This review does not accept rendered mobile wrapping, web pixels, native accessibility behavior, live provider compatibility, or the overall feature; those remain with their designated reviewers and root.

## Subject and authority

This was a new independent reviewer context, not the repair author. I read the current canonical `openspec/changes/personal-output-voice/proposal.md`, `design.md`, `tasks.md`, the existing `specs/voice/spec.md` and `specs/models-and-providers/spec.md`, and the referenced owner decision. There is no `specs/output-voice/spec.md`. The accepted behavioral requirements are acknowledged-state immediate saving, passive GET before explicit exact retry after an unknown outcome, session/identity/generation isolation, EN/CS accessible settings, and preserved default-only/unavailable Reset behavior. I did not read or rely on the repair author's report, test logs, or acceptance claims.

Live source hashes exactly match `/tmp/niaro-resume-20261031/web-visual-repair/final-pins.json`:

| Path | SHA-256 |
| --- | --- |
| `apps/server-admin/web/app/output-voice-settings.tsx` | `333e846689a757716055886a65043b1ce411addda20da8280281cc865bb55780` |
| `tests/output-voice-web.test.tsx` | `76bcc93f8ab7806ee3febd04280111d228f3a9409a9b1a1bb0b67e2f7f7f72be` |
| `packages/ui-catalog/OutputVoiceCard.tsx` | `29343a69d96d2258be1245bbc61cafc8aecf5b05ff5ffaa9e9e189e49ac73a06` |
| `tests/output-voice-mobile.test.tsx` | `2c7e43031cbede99177be337e8dd2850529d949de7c3f90ec15f2091554fbc7d` |

`final-pins.json` SHA-256: `ecc06373b2f17b46741d17abf43563020d9457a248a6dd1d6b5c531046f3d7ee`.
`repair.patch` SHA-256: `0b67ec0b21d24240756a680cdb5a4a078f18779169889a99925e5c5ed91fe9aa`.

I independently checked all four starting files against `before-pins.json`, copied `before/` only into my own scratch directory, applied `repair.patch` with `patch --batch --fuzz=0 -p1`, and verified that each result exactly matches both its final pin and the live source. The patch has exactly four destination paths. `verified-subject.json` records starting, final, canonical and underlying-context hashes; `pins.log` records the application result. A final recheck in `closing-pins.log` / `closing-pins.json` records stability across validation.

## Findings and closure evidence

No blocker, major, or minor defect found within the assigned subject. No repair was made.

### OVV-01: web recovery must report Loading rather than Saving

`OutputVoiceSettings` at `apps/server-admin/web/app/output-voice-settings.tsx:76`, `:106`, and `:137` now derives disabled state from busy/read/pending, exposes active POST/read through `aria-busy`, and displays the localized status from `saving` versus `reading`. Initial loading still has its skeleton/status at `:130` without an extra mutation message.

`WebOutputVoiceEditor` at `:201`, `:285`, `:356`, `:377`, and `:414` sets `saving` only for the POST wait and clears it before any error-driven passive `refresh`, on abandonment, and on owned completion. `busy` still covers the entire save/reconciliation operation. Thus a held recovery GET reports Loading while retained pending intent and uncertainty block editing. There is no new POST dispatch, optimistic label assignment, or automatic retry in this patch.

The new EN/CS test at `tests/output-voice-web.test.tsx:275` uses the actual editor and actual ClientSession with a synthetic transport. It holds the original POST, asserts Saving, releases it with a 503 unknown outcome, then holds recovery GET and asserts: one POST; the full acknowledged localized Server default (Cedar); disabled Select; busy accessibility prop; uncertainty; exactly Loading and no Saving; and no retry action. It also attempts another handler invocation and observes no extra POST. After GET returns the unchanged acknowledged snapshot, the field stays disabled with uncertainty and an explicit retry. Only invoking that action sends the second POST with byte-identical original body/requestId and applies the returned Shimmer acknowledgment, clearing status and uncertainty.

The existing actual-component tests also passed for immediate save/retained selection, stale and corrupt Reset, same-intent no-op, refusal, lost ACK resolved by GET, all three conflicts, unsupported/malformed reads, session/user/workspace replacement, ignored-abort earlier GET versus later ACK, hidden-page behavior, and stopped sessions. Inspection confirms `save` generation/write increments and aborted-read ownership, `refresh` generation/write/revision guards, owner identity keys, and exact retry update reuse are preserved (`:35`, `:223`, `:248`, `:333`). ClientSession's scoped strict parsing, abort/stop checks and non-replayed POST transport remain unchanged.

### OVV-02: acknowledged native summary gets the full wrapping text lane

`OutputVoiceCard` at `packages/ui-catalog/OutputVoiceCard.tsx:102` now puts the current acknowledged label in `ListRow.description`, omits the trailing `value`, preserves contextual detail as child Text, and supplies the interactive row's full setting/current/detail accessibility label. This is a card-local composition change. It changes neither `packages/ui/index.tsx` nor shared typography/Select/Field primitives.

The actual shared `ListRow` uses a flexible `flex: 1, minWidth: 0` main column, an unconstrained description Text, and a minimum rather than fixed row height (`packages/ui/index.tsx:154`, `:836`). Its former trailing value path specifically imposed `numberOfLines={1}` and `maxWidth: "45%"` at `:855`. The repair removes this summary from that path. Shared Text and `useCompanionTypography` do not add a line clamp. Interactive ListRow consumes the composed accessibility label at `:884`; noninteractive default-only/unavailable rows retain the full title/current/detail Text children rather than an inert button. This is evidence of source structure and props, not a measurement of native layout or screen-reader output.

The six new cases at `tests/output-voice-mobile.test.tsx:101` mount actual VoiceSettings, ClientSession, OutputVoiceCard and shared primitives for EN/CS, selectable/default-only/long explicit choices, and normal font scale at 390 logical pixels. They assert the exact full current label, no line cap or old 45% style on it, one visible current-label occurrence, the complete interactive accessible name, and absence of an inert default-only picker or settings POST/spoken-replies change. The renamed queries elsewhere align with the richer accessible name; they do not remove lifecycle assertions.

The options branch, selected/disabled choice props, callbacks, conditional Reset, status, retry and refresh rendering are unchanged (`OutputVoiceCard.tsx:76`, `:123`, `:130`). Actual VoiceSettings still owns sheet and request lifecycle (`apps/mobile/VoiceSettings.tsx:113`). The affected mobile suite passed option-tap single POST/disabled acknowledged state/ACK close, known failure, exact explicit retry, conflicts, stale/corrupt/default-only/unavailable Reset, both capabilities disabled, real sheet dismissal hooks, session replacement, backgrounding and stop handling. These are scoped regressions, not a new review of unaffected native/provider suites.

## Independently executed validation

Every command ran from `/home/flamendrin/workspace/niaro` using existing installed dependencies. `run.py` records exact argv, UTC start, exit code, duration and scratch `NODE_COMPILE_CACHE` in `commands.jsonl`. All requested writes and generated outputs are under `/tmp/niaro-resume-20261031/visual-repair-closure/`.

| Check | Exact command | Result | Wall time |
| --- | --- | --- | --- |
| Pins/patch | `python /tmp/niaro-resume-20261031/visual-repair-closure/verify_subject.py` | Pass; exact before/final/patch match | 0.031 s |
| Affected production tests | `node_modules/.bin/jest --runInBand --cacheDirectory=/tmp/niaro-resume-20261031/visual-repair-closure/jest-cache --runTestsByPath tests/output-voice-web.test.tsx tests/output-voice-mobile.test.tsx tests/output-voice-client.test.ts` | Exit 0; 3 suites / 73 tests passed | 12.196 s (Jest reports 10.895 s) |
| Types | `node_modules/.bin/tsc --noEmit --incremental false` | Exit 0; no diagnostics | 29.748 s |
| Four-file lint | `node_modules/.bin/eslint --no-cache apps/server-admin/web/app/output-voice-settings.tsx tests/output-voice-web.test.tsx packages/ui-catalog/OutputVoiceCard.tsx tests/output-voice-mobile.test.tsx` | Exit 0; no diagnostics | 2.077 s |
| Isolated admin build | `node /tmp/niaro-resume-20261031/visual-repair-closure/build-admin.mjs` | Exit 0; 3960 modules; production bundle generated only in assigned scratch | 1.040 s |
| Closing pins | `python /tmp/niaro-resume-20261031/visual-repair-closure/verify_closing.py` | Exit 0; all subject/context hashes and patch/pin manifests stable | 0.022 s |

The build script uses the actual existing Vite config with the `runner` config loader, scratch `cacheDir`, and scratch absolute `build.outDir`; it never uses shared `dist-admin`. Build logs contain the application-wide large-chunk warning (existing single-bundle configuration). Jest reports an existing duplicate package-name/haste warning from its checkout scan, but all three requested suites ran and passed. Neither warning is evidence of a four-file repair defect.

## Limits and remaining ownership

- Web tests replace Select/Field/Button/etc. with prop-preserving hosts; they exercise the real editor and ClientSession, not Radix popup/keyboard/focus/DOM or screen-reader behavior. I read the real Select/Field implementations to check prop forwarding and composition, and built the actual admin app.
- React Native tests verify production component text/props and actual sheet lifecycle logic in Jest; they do not execute Yoga/native line breaking, hardware fonts, TalkBack/VoiceOver, or light/dark pixels. The long-label case is not a substitute for native rendering at all widths/font scales. Astra owns native QA; I used no browser/native control.
- No live server, private session, provider, audio, synthesis, preview, recording or network product action was performed. The test transport is synthetic. No provider support, real audio, cross-surface live persistence, backend security/dispatch, full feature acceptance or release readiness is certified.
- The prior full22-source/backend review and unaffected provider/backend/native suites were not repeated. Full `npm run check`, broad lint/tests, canonical validation, additional controlled-defect runs, publication and Git/index actions were not part of this narrow closure review. No author red/green claim is used as independent proof.
- No repository product, test, canonical, package, dependency or Git/index changes were made. Only the assigned scratch directory was written. Root retains acceptance, evidence integration, any next repair, commits and publication.
