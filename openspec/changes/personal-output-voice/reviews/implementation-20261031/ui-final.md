# Personal output voice — S5.3 bounded visual QA

**Complete within the stated UI scope.** Both reproduced findings, **OVV-01** and **OVV-02**, pass focused checks on the source owner's repaired freeze. This is independent rendered-UI evidence, not product/aesthetic acceptance, backend persistence, audio or provider compatibility certification. The reviewer changed only scratch harnesses, copied source and evidence; no production, canonical, Git/index, dependency or account mutation occurred.

Task `task_6331c4050a00`, Dispatch `ctx_d828e90d1ec2`, 2026-10-31. Detailed original observations, replaced boundaries and commands are in [ORIGINAL-REVIEW.md](ORIGINAL-REVIEW.md).

## Findings and repair verification

| Finding | Original evidence | Repaired result |
|---|---|---|
| **OVV-01**, medium: web passive recovery GET still said Saving beside Save not confirmed | `evidence/web-en-held-recovery-get.png` | **Verified fixed.** EN1280/light and CS320/dark show Loading during held recovery GET, keep uncertainty and acknowledged Cedar, disable changes with aria-busy, and hide Retry until GET completes. Actual held POST and explicit retry POST still show Saving. |
| **OVV-02**, medium: native normal-font summary truncates Cedar, including default-only with no picker | `evidence/native-cs-default-only-normal.png` | **Verified fixed.** Existing value now wraps beneath Output voice. Cedar/Echo and required context remain readable in EN/CS at411.43dp/font1 and320dp/font2. Selectable row has its full accessible name; default-only has no inert picker; independent Reset remains reachable and works. |

The source owner made the repairs. Original source, screenshots and result files remain intact; the separate `repair/` harness contains only the four authorized replacements over the original source freeze. Original evidence hashes were reverified unchanged before packaging.

## Subject binding

Both 15-path subjects matched live source before copying, then remained unchanged in their frozen harnesses:

- Original `subject.json`: SHA256 `84639e2b1eb6bf7200ac927c0b4a21e88fdc825f489f368d50a526fd7ffa8348`.
- Repaired `repair/subject.json`: SHA256 `f1eb22be92eea88a2dda4de4012417a002f2fb15f01b6d99780d52278b727baf`, identical to root's `voice-ui-repaired-subject.json`.

Each phase includes expected/actual pin verification and a complete frozen source/asset hash manifest. Four paths changed; the other eleven supplied pins are identical. Their final hashes follow this report's main sections.

## Actual surfaces and boundaries

Web: actual production AccountPage at `/me`, OutputVoiceSettings editor, Radix Select, console primitives/CSS and Manrope font. Synthetic boundaries are AppContext identity/workspace, credential/storage, settings HTTP responder, and preseeded unrelated account-access/archive query results. Full signed-in shell/navigation/login is outside the mount.

Native: actual VoiceSettings, MobileOutputVoiceEditor, OutputVoiceCard, DetailSheet, ListRow, input/spoken-reply cards, fonts/tokens, SafeArea and MotionProvider in the existing APK. Synthetic boundaries are the mounting shell, session credential/storage, local HTTP responder, locally seeded voice/speech capability Responses, and an off in-memory spoken-replies preference. The scratch config poll remounts scenarios; it is not product behavior. Neither settings controller nor visual primitives were mocked.

The responder validates the real output snapshot/update schemas and follows established HTTP/client fixtures. All identity/catalogue/transport data are synthetic. Logged UI-fixture HTTP: original116 requests (89GET/27POST), repaired40 (28GET/12POST), all on `/v1/a/voice/output-settings?profile=agent-output-voice/1`; **zero observed non-settings product HTTP, provider, inference, recording, preview, synthesis or workflow requests**. This count excludes static assets, harness-control polling/local capability seeds, and root's separately authorized normal-App restoration traffic.

## Coverage and actual actions

| Area | Evidence/result |
|---|---|
| Original web layouts | EN/CS × light/dark ×1280×900,390×844,320×844; twelve actual popup/initial pairs; no horizontal page overflow |
| Real Radix behavior | Cedar plus Alloy/Echo/Shimmer; selected aria state; click and keyboard Space/arrow/Enter selection; Escape returns focus; disabled/busy during POST; no extra Save |
| Original native | Normal EN/CS, OS light/dark,320dp/font2; held GET/POST, acknowledged selection, success close, recovery, explicit retry, Back dismissal/late completion/reopen |
| Unavailable cases | Default-only, stale, speech-disabled plus stale/corrupt intent, both input/speech disabled, reachable Reset, and unsupported404 omission in EN/CS |
| Input/spoken state | Recognition information and off spoken-replies switch remain unchanged through output selection; no audio controls activated |
| Focused repaired web | Twelve recorded states across EN/CS; real POST Saving, recovery GET Loading+uncertainty, exact two-POST explicit retry, Shimmer acknowledged/aria-selected, Escape focus return |
| Focused repaired native | Twenty recorded summary/action states: default, selected Echo, default-only, stale fallback and Reset in EN/CS at normal and320/font2; additional disabled/corrupt CS layout and settled normal EN capture |
| Console/build | Actual isolated web builds passed. Original web layout had no errors; original state matrix only expected injected503/404 resource errors; repaired matrix only two injected503 errors. No JS runtime exception. Native Metro had environment color warnings, no app runtime error. |
| Optical inspection | Representative normal/narrow, light/dark, pending/error, fallback/default-only and repaired views inspected; complete current labels and contextual text wrap. Enlarged native pages scroll normally. |

Browser plugin/skill was absent. Orca browser DOM/navigation worked, but viewport screenshot capture failed with `CDP error (Page.captureScreenshot): Screenshot timed out — the browser page did not draw a frame.` Existing Playwright1.64.0-alpha-1790635538000 and installed Chromium153.0.8010.12 supplied responsive evidence; no browser installation. Native interaction used the exact Orca CLI, with adb for capture/settings/reverses. Browser and device commands are retained in the harness scripts.

One first repaired native screenshot caught Metro's transient “Bundling99%” frame before its later AX read; it is excluded from the screenshot allowlist and replaced by `repair/evidence/native-en-normal-default-settled.png`. Earlier original harness timing/locator errors are documented in ORIGINAL-REVIEW and excluded from product-finding counts. No stable native lifecycle suite was repeated after the presentation-only Card repair.

## Reproduction

All paths are under `/tmp/niaro-resume-20261031/voice-ui-visual`. Existing repository dependencies are scoped symlinks and excluded from the bundle. Run fixture/static services explicitly before the tests; native commands require a fresh root lease. Full exact commands/config are in the scripts.

```sh
node --import /home/flamendrin/workspace/niaro/node_modules/tsx/dist/loader.mjs repair/fixture-server.ts
/home/flamendrin/workspace/niaro/node_modules/.bin/vite build --config repair/vite.config.mjs
python3 repair/web-server.py
TMPDIR=/tmp/niaro-resume-20261031/voice-ui-visual/repair/browser-tmp node repair/web-recheck.cjs
# From repair/native, under exclusive lease:
EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 TMPDIR=/tmp/niaro-resume-20261031/voice-ui-visual/repair/native-tmp node /home/flamendrin/workspace/niaro/node_modules/expo/bin/cli start --port 8894 --localhost
python3 repair/native-recheck.py
```

## Restoration and cleanup

Both native leases were explicitly transferred and returned. Second fresh baseline and final state are **exactly equal**: physical1080×2400, density420, font1.0, rotation0, autorotate1, night=no, reverses8087/38683 only. First baseline had no reverses; root explicitly authorized the normal mappings at that return. Own8894/8896 mappings were removed. Normal8087 actual-App Home is visibly restored using root's RAM-only synthetic preview, verified by screenshot, AX and settings JSON. Installed APK/data/vault/account/permissions were preserved.

Own8894/8895/8896 services, browsers and heartbeat are stopped; own ports are closed. Normal8087/38683 and public8793 were listening at final check. Localhost-only probes did not reach protected8767/8866; this does not establish server downtime. Root independently confirmed both Tailscale-bound URLs returned200, with PIDs17403/22739 bound to100.116.133.7; these services were untouched. See `repair/evidence/native-restored.png`, `native-restored.json`, `cleanup-ports.json`, and `heartbeat-stopped.json`. No native action occurred after the final lease return.

## Limits and root checkpoint

Native source has a fixed graphite palette: OS appearance was tested, but there is no implemented native light palette to certify. Android AX supplies bounds/enabled state but omits selected-state serialization; native selection was inspected optically and source state, not by TalkBack speech. Web selected/focus/disabled state was tested on real Radix. No iOS, real account/session persistence, full account shell, real audio, provider compatibility, backend store/CAS, pet performance, production feature completion or aesthetic approval is claimed.

Root reported independent final four-file source closure with zero findings. Root's next checkpoint is acceptance/canonical updates/publication using that closure, this rendered-UI report and existing integration evidence. Only publish files in `SCREENSHOTS.txt`; the tar bundle contains reports, exact source/harnesses and selected evidence with an explicit allowlist and hashes. Prior Pet/composer delivery and root galleries remain untouched.

## Repaired file hashes

| File | SHA256 |
|---|---|
| `packages/ui-catalog/OutputVoiceCard.tsx` | `29343a69d96d2258be1245bbc61cafc8aecf5b05ff5ffaa9e9e189e49ac73a06` |
| `tests/output-voice-mobile.test.tsx` | `2c7e43031cbede99177be337e8dd2850529d949de7c3f90ec15f2091554fbc7d` |
| `apps/server-admin/web/app/output-voice-settings.tsx` | `333e846689a757716055886a65043b1ce411addda20da8280281cc865bb55780` |
| `tests/output-voice-web.test.tsx` | `76bcc93f8ab7806ee3febd04280111d228f3a9409a9b1a1bb0b67e2f7f7f72be` |
