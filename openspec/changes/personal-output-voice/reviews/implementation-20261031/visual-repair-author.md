# Author repair: output voice loading and current-value presentation

**Implementation complete for OVV-01 and OVV-02; independent closure and Astra's visual/native retest remain pending.** This is an author report, not a replacement independent review or acceptance of my own changes.

Task `task_ada6e331206b`, Dispatch `ctx_870046ba7147`, terminal `term_b76ce00a-8355-4df4-b804-9e1e9d58a7c7`, 2026-10-31. The initial web two-file gate was extended by coordinator delivery `delivery_16234a29b7b9` to the card/mobile test paths; delivery `delivery_9840e9c9be35` confirmed the exact wrapping-summary direction. Both deliveries were processed and acknowledged. Only these four authorized repository paths changed:

- `apps/server-admin/web/app/output-voice-settings.tsx`
- `tests/output-voice-web.test.tsx`
- `packages/ui-catalog/OutputVoiceCard.tsx`
- `tests/output-voice-mobile.test.tsx`

## Behavior and minimal changes

**OVV-01:** an unresolved POST 503 now transitions from localized Saving to localized Loading while its passive recovery GET is outstanding. The existing uncertainty error remains visible; acknowledged Cedar remains selected, choices stay disabled and no POST is automatically repeated. If GET still shows the old revision, uncertainty and the exact pending request remain until deliberate Retry. A real active POST still reports Saving. The controller now records its actual POST wait separately from `busy`, which continues to fence the entire save/reconciliation lifecycle. Passive reads participate in disabled/ARIA-busy state. The existing localized `outputVoiceLoading`/`outputVoiceSaving` keys and FieldDescription primitive are reused; no new copy, Save control or permanent helper was added. Session generation, revision, pending request body and explicit retry logic are unchanged.

**OVV-02:** the card summary keeps Output voice as its title and places the full acknowledged current/default voice in ListRow's naturally wrapping description below it. Existing fallback/unavailable/default-only context remains a separate Text line in the same row when needed. The duplicated/clamped right-hand `value` is removed only from this card summary. An actionable summary's accessible name includes title, full value and context. Picker option rows, selected-state semantics, onOpen/disabled/chevron behavior and the separate Reset remain intact. Shared ListRow, its styles, mobile controller, Sheet, translations and other production files are untouched.

## Regression-first evidence

The web regression was added before editing web production code. Real mounted OutputVoiceSettings uses real ClientSession with synthetic held POST/GET responses. Both EN and CS failed at the behavioral assertion: expected `Loading voice…` / `Načítání hlasu…`, received `Saving…` / `Ukládání…`. This was an assertion failure, not fixture/setup failure. `red-pins.json` binds that run and confirms the web production file still matched the starting gate. After the fix, both cases passed.

The web test checks active-POST Saving first, then POST503 → held GET with unchanged Cedar, disabled control and ARIA busy, retained uncertainty, no premature Retry or automatic second POST, unchanged GET completion, and deliberate byte-identical retry through acknowledged Shimmer. Existing web/client tests also retain account/session/workspace and late-response fences.

The native mounted VoiceSettings regression was added before editing the card. EN and CS each cover selectable default, default-only, and a long acknowledged custom label at synthetic fontScale 1 and width 390. All six first failed because the actual current-voice NativeText had `numberOfLines=1`. `red-mobile-pins.json` confirms the card still matched its starting gate. All six passed after repair. They verify one complete current-value Text, no one-line/45%-width clamp, full actionable accessible name, retained contextual detail, no inert default-only picker and no settings writes/toggle side effect. Existing test queries were adapted to the richer accessible summary name; picker assertions and lifecycle expectations remain.

The native test verifies production rendering props and accessibility, not measured device line wrapping, pixels, font metrics or an actual screen reader. The previous Astra screenshot and `evidence/web-results.json` held-recovery-get case were read as the reported web failure; no revised browser/native screenshot was created by this worker.

## Final validation and frozen subject

Final frozen bytes passed **73 tests across three affected suites**, direct full TypeScript checking, scoped ESLint, boundary checks, formatting and an isolated admin production build. All six final check records have exit 0. No backend or unrelated suite was rerun. The initial formatting check found the new web status expression needed wrapping; scoped Prettier formatting corrected it and the final four-file check passed.

`before-pins.json` contains the four gate-matching starting hashes, and `before/` retains their exact bytes. `final-pins.json` and `verified-final-pins.json` match after all final checks, and `final-source/` contains the frozen delivery. `repair.patch` is the unified four-file patch against those starting bytes. Eighteen other files from the prior 22-file voice/composer subject remain unchanged, verified in `untouched-voice-after.json`. Prior final-review and Astra artifacts were preserved.

The final hashes are:

| File | SHA-256 |
| --- | --- |
| `apps/server-admin/web/app/output-voice-settings.tsx` | `333e846689a757716055886a65043b1ce411addda20da8280281cc865bb55780` |
| `tests/output-voice-web.test.tsx` | `76bcc93f8ab7806ee3febd04280111d228f3a9409a9b1a1bb0b67e2f7f7f72be` |
| `packages/ui-catalog/OutputVoiceCard.tsx` | `29343a69d96d2258be1245bbc61cafc8aecf5b05ff5ffaa9e9e189e49ac73a06` |
| `tests/output-voice-mobile.test.tsx` | `2c7e43031cbede99177be337e8dd2850529d949de7c3f90ec15f2091554fbc7d` |

## Limits and handoff

All transports and data were synthetic. No browser, native device/binary, running user service, private/provider/audio action, dependency change, canonical change, Git/index action or shared `dist-admin` write occurred. Browser validation was expressly assigned to Astra, so the frontend debugging skill's usual browser loop was not executed. The isolated build uses the committed Vite config with runner config loading and only scratch output/cache paths, then the normal font-license step; its existing large-chunk warning is recorded.

Root must arrange fresh review of these **four exact final paths**, and Astra must retest revised web/native bytes. I cannot supply independent closure for this author repair. Root retains canonical evidence/task updates, acceptance, full integration, commit and publication authority. Nothing here certifies live provider voice support, real audio, or a new speech budget/durable-synthesis-deduplication guarantee.

## Commands, results and durations

All commands ran from `/home/flamendrin/workspace/niaro`; test/build scratch was directed to this directory with `TMPDIR`. Complete argv, UTC starts, elapsed wall time, exit codes and log paths are in `commands.jsonl`. Expected behavioral red runs and the resolved formatting failure are retained. `build-admin.mjs` contains the isolated build wrapper; shared primitives and final source were not modified during validation.

### red-held-get

```sh
node_modules/.bin/jest --runInBand --cacheDirectory /tmp/niaro-resume-20261031/web-visual-repair/jest-cache --modulePathIgnorePatterns '<rootDir>/.servers/' --runTestsByPath tests/output-voice-web.test.tsx --testNamePattern 'held recovery GET'
```

Exit **1**; **3.910 s**; started `2026-10-31T09:56:10.487076+00:00`; log `red-held-get.log`.

### green-held-get

```sh
node_modules/.bin/jest --runInBand --cacheDirectory /tmp/niaro-resume-20261031/web-visual-repair/jest-cache --modulePathIgnorePatterns '<rootDir>/.servers/' --runTestsByPath tests/output-voice-web.test.tsx --testNamePattern 'held recovery GET'
```

Exit **0**; **1.744 s**; started `2026-10-31T09:57:50.375530+00:00`; log `green-held-get.log`.

### boundaries

```sh
node scripts/check-boundaries.mjs
```

Exit **0**; **0.560 s**; started `2026-10-31T09:58:20.011571+00:00`; log `boundaries.log`.

### formatting

```sh
node_modules/.bin/prettier --check apps/server-admin/web/app/output-voice-settings.tsx tests/output-voice-web.test.tsx
```

Exit **1**; **0.226 s**; started `2026-10-31T09:58:20.589144+00:00`; log `formatting.log`.

### scoped-eslint

```sh
node_modules/.bin/eslint apps/server-admin/web/app/output-voice-settings.tsx tests/output-voice-web.test.tsx
```

Exit **0**; **1.787 s**; started `2026-10-31T09:58:20.011070+00:00`; log `scoped-eslint.log`.

### affected-web-client

```sh
node_modules/.bin/jest --runInBand --cacheDirectory /tmp/niaro-resume-20261031/web-visual-repair/jest-cache --modulePathIgnorePatterns '<rootDir>/.servers/' --runTestsByPath tests/output-voice-web.test.tsx tests/output-voice-client.test.ts
```

Exit **0**; **4.059 s**; started `2026-10-31T09:58:20.013959+00:00`; log `affected-web-client.log`.

### isolated-admin-build

```sh
node /tmp/niaro-resume-20261031/web-visual-repair/build-admin.mjs
```

Exit **0**; **1.059 s**; started `2026-10-31T09:58:26.796768+00:00`; log `isolated-admin-build.log`.

### types

```sh
node_modules/.bin/tsc --noEmit --incremental false
```

Exit **0**; **27.873 s**; started `2026-10-31T09:58:20.013963+00:00`; log `types.log`.

### red-mobile-summary

```sh
node_modules/.bin/jest --runInBand --cacheDirectory /tmp/niaro-resume-20261031/web-visual-repair/jest-cache --modulePathIgnorePatterns '<rootDir>/.servers/' --runTestsByPath tests/output-voice-mobile.test.tsx --testNamePattern 'acknowledged voice summary'
```

Exit **1**; **5.297 s**; started `2026-10-31T10:00:26.060657+00:00`; log `red-mobile-summary.log`.

### green-mobile-summary

```sh
node_modules/.bin/jest --runInBand --cacheDirectory /tmp/niaro-resume-20261031/web-visual-repair/jest-cache --modulePathIgnorePatterns '<rootDir>/.servers/' --runTestsByPath tests/output-voice-mobile.test.tsx --testNamePattern 'acknowledged voice summary'
```

Exit **0**; **1.980 s**; started `2026-10-31T10:00:57.793633+00:00`; log `green-mobile-summary.log`.

### final-boundaries

```sh
node scripts/check-boundaries.mjs
```

Exit **0**; **0.678 s**; started `2026-10-31T10:02:13.405267+00:00`; log `final-boundaries.log`.

### final-formatting

```sh
node_modules/.bin/prettier --check apps/server-admin/web/app/output-voice-settings.tsx tests/output-voice-web.test.tsx packages/ui-catalog/OutputVoiceCard.tsx tests/output-voice-mobile.test.tsx
```

Exit **0**; **0.305 s**; started `2026-10-31T10:02:14.102108+00:00`; log `final-formatting.log`.

### final-scoped-eslint

```sh
node_modules/.bin/eslint apps/server-admin/web/app/output-voice-settings.tsx tests/output-voice-web.test.tsx packages/ui-catalog/OutputVoiceCard.tsx tests/output-voice-mobile.test.tsx
```

Exit **0**; **1.690 s**; started `2026-10-31T10:02:13.405258+00:00`; log `final-scoped-eslint.log`.

### final-isolated-admin-build

```sh
node /tmp/niaro-resume-20261031/web-visual-repair/build-admin.mjs
```

Exit **0**; **1.057 s**; started `2026-10-31T10:02:14.424495+00:00`; log `final-isolated-admin-build.log`.

### final-affected-tests

```sh
node_modules/.bin/jest --runInBand --cacheDirectory /tmp/niaro-resume-20261031/web-visual-repair/jest-cache --modulePathIgnorePatterns '<rootDir>/.servers/' --runTestsByPath tests/output-voice-web.test.tsx tests/output-voice-mobile.test.tsx tests/output-voice-client.test.ts
```

Exit **0**; **4.316 s**; started `2026-10-31T10:02:13.405752+00:00`; log `final-affected-tests.log`.

### final-types

```sh
node_modules/.bin/tsc --noEmit --incremental false
```

Exit **0**; **28.136 s**; started `2026-10-31T10:02:13.408340+00:00`; log `final-types.log`.

### verify-patch

```sh
python3 /tmp/niaro-resume-20261031/web-visual-repair/verify-patch.py
```

Exit **0**; **0.028 s**; log `verify-patch.log`. Reconstructed all four final hashes from exact starting bytes with zero fuzz.
