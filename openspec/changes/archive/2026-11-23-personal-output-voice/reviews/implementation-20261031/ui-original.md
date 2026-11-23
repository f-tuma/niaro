# S5.3 original-subject visual review

Review scope: actual frozen mobile VoiceSettings/OutputVoiceCard/DetailSheet and web AccountPage/OutputVoiceSettings/production Radix Select. This is synthetic UI evidence, not backend persistence, provider compatibility, audio, production completion or aesthetic approval. No production files were edited by this reviewer.

## Findings

**OVV-01 — web recovery GET is still labelled Saving (medium).** On the original web pin, choose Shimmer, return synthetic POST503, and hold the subsequent passive GET. Cedar remains acknowledged and disabled, but both “Saving…” and “Save not confirmed.” appear. `owner.busy` spans save and awaited reconciliation, while the status text does not consider `owner.reading`. Evidence: `evidence/web-en-held-recovery-get.png`, `web-results.json` case `held-recovery-get`. Root accepted and dispatched a source-owner repair; the original finding remains frozen here.

**OVV-02 — native normal-size summary hides the actual default voice (medium).** At physical1080×2400/density420/font1 (411.43dp wide), EN clips the right-side value to “Server default (Ce…” and CS to “Výchozí na serveru…”. The same clipping occurs in default-only mode, which intentionally has no picker to reveal Cedar. Evidence: `native-en-normal.png`, `native-cs-system-dark-normal.png`, `native-cs-default-only-normal.png`. Existing ListRow constrains the normal-font trailing value to one line/45% width. Recommendation accepted by root: change OutputVoiceCard summary only, move existing full value below the title in wrapping description/content, keep contextual detail only when necessary, include the complete value in the actionable accessible label, preserve independent Reset and picker rows, do not change global ListRow or translations.

## Exact subject and boundaries

All 15 entries in `subject.json` matched live bytes before copying. Manifest SHA256: `84639e2b1eb6bf7200ac927c0b4a21e88fdc825f489f368d50a526fd7ffa8348`. `pin-verification.json` records every expected/actual hash; `source-hashes.json` records 1,061 frozen source/assets files. Frozen source still matches all 15 pins after original review. Repository HEAD context was supplied by root; no Git command was run.

Production controllers and controls are unchanged in `source/`. Web mounts actual AccountPage at `/me` with actual AppContext, QueryClient, production CSS/font, actual OutputVoiceSettings editor and Radix components. Replaced boundaries: synthetic signed-in context and credential, in-memory storage, local strict HTTP settings responder, and preseeded account-access/archive query data. The account shell/navigation/login is not mounted. Those cached unrelated account sections avoid account/backend calls; their controls were not activated.

Native mounts actual VoiceSettings, its real MobileOutputVoiceEditor, real DetailSheet/ListRow/cards, TopBar, production tokens/fonts, SafeArea and MotionProvider in an existing installed development APK. Replaced boundaries: small scratch mounting shell, synthetic session credential/storage, local HTTP settings responder, seeded voice/speech capability Responses, and in-memory spoken-replies preference initialized off. No fake settings controller or mocked visual primitive is used. An external harness-config poll remounts scenarios; it is not a production control or product polling behavior. No real App/credential vault/account is used in QA; root's real App with RAM-only synthetic credentials is restored afterward.

The responder parses actual OutputVoiceSnapshotSchema and OutputVoiceUpdateSchema. Fixtures follow the established HTTP integration/client tests and advertise Cedar, Alloy, Echo and Shimmer with synthetic opaque option IDs. Fixture revision behavior is only a means of exercising UI acknowledgements; no server-store/CAS correctness claim is made.

## Checks and evidence

| Check | Result |
|---|---|
| Web page identity/nonblank/overlay | Actual `/me`, Account/Účet, meaningful sections; no runtime/framework overlay |
| Web layout | EN/CS × light/dark ×1280×900,390×844,320×844; 12 initial/popup pairs; no horizontal page overflow |
| Radix popup and keyboard | Four actual options, default aria-selected=true; Escape returns focus to trigger in all12 layouts; Space/ArrowDown/ArrowDown/Enter selects Echo and emits one POST |
| Held initial GET | Skeleton with accessible loading label, no Saving/optimistic choice; native loading text |
| Held POST | Web disabled combobox/aria-busy=true retains Cedar; native sheet remains open, all option actions disabled and Cedar selected; one deliberate POST |
| Acknowledgement | Web updates to Echo; native applies Echo then closes sheet; no extra Save button |
| Failure/recovery | Prior acknowledged value retained, concise unknown-outcome text; passive GET first; explicit Retry reuses identical request body/requestId; no automatic POST replay |
| Recovery GET status | Native correctly says Loading; original web fails OVV-01 |
| Default-only | No inert picker; contextual detail; native normal-font value fails OVV-02 |
| Stale/disabled/corrupt Reset | EN/CS web and native: explicit reachable Reset, one POST, stale intent cleared, action disappears |
| Both native capabilities disabled | Combined unavailable branch remains, supported output Reset remains visible and works |
| Unsupported404 | Output section/card omitted while other account/settings content remains; no misleading unavailable error |
| Native narrow/large text | 320dp via density540, font_scale2.0, EN/CS; picker, fallback detail, Reset and retry are scrollable/readable; native tokens remain graphite under OS light/dark |
| Native dismissal | CS held POST: Android Back dismisses; released late server response does not reopen; opening again reconciles via GET |
| Input/spoken preferences | Recognition text and off spoken-replies switch remain unchanged through output selections; no recording/preview/playback initiated |
| Network side effects | 116 logged original-fixture settings HTTP requests (89GET/27POST, including harness retries), one settings path only; zero observed non-settings product HTTP/provider/audio/workflow requests |
| Console | Web original layout: zero errors; state matrix has only four expected503/404 resource messages from injected failures/unsupported. Native Metro has no app runtime error; repeated NO_COLOR/FORCE_COLOR environment warnings only |

`web-layout-results.json` contains 12 passing layout/popup cases plus an initial GET record. Its final top-level error records an initial harness keyboard-timing failure; no POST occurred on that attempt. `web-results.json` is the corrected completed 15-state run. The keyboard timing and Czech retry locator were corrected in scratch only; no product code was altered. Do not interpret debug screenshots or the earlier partial file as a product regression. The native state results have7 records, responsive results36 records, final checks9 records; screenshots are state evidence, not separate independent test counts.

Browser plugin/skill was not available. Orca browser navigation/DOM and first screenshot worked, but capture after a viewport change failed twice with exact `CDP error (Page.captureScreenshot): Screenshot timed out — the browser page did not draw a frame.` Recorded in `evidence/orca-viewport-screenshot.json`. Fallback used installed Playwright1.64.0-alpha-1790635538000 with existing headless Chromium153.0.8010.12 executable; no installation. Orca page `aa73c9a3-0a28-4af4-b136-6855519e660b` was closed after evidence. Native automation remained actual Orca Android commands plus adb screenshot/settings/reverse operations.

Geometry is recorded in `evidence/control-geometry.json`: normal native option actions are approximately56dp high; exact Android AX pixel bounds are retained. Web normal trigger is32CSSpx high. Native AX reports enabled state and bounds but does not serialize the React Native selected state; selected appearance was inspected optically and source passes accessibilityState.selected. No TalkBack traversal claim is made. One CS error screenshot was recaptured as `native-cs-320-font2-error-settled.png` after scroll settling; prefer that evidence over the earlier in-motion frame.

## Reproduction commands

Run from this scratch directory; dependencies are scoped links to the already-installed repository node_modules. Do not install or rebuild the APK.

```sh
node --import /home/flamendrin/workspace/niaro/node_modules/tsx/dist/loader.mjs fixture-server.ts
/home/flamendrin/workspace/niaro/node_modules/.bin/vite build --config vite.config.mjs
python3 web-server.py
TMPDIR=/tmp/niaro-resume-20261031/voice-ui-visual/browser-tmp node web-qa.cjs
# native only under an explicit exclusive emulator lease:
# from native/: EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 TMPDIR=/tmp/niaro-resume-20261031/voice-ui-visual/native-tmp node /home/flamendrin/workspace/niaro/node_modules/expo/bin/cli start --port 8894 --localhost
python3 native-states.py
python3 native-responsive.py
python3 native-final-checks.py
```

Actual executed native CLI uses `/home/flamendrin/.config/orca/linux-orca-cli-shim/orca emulator ... --device emulator-5554 --json`. Each tap uses current AX bounds; scrolling uses `input swipe 540 2040 540 780 450` with separate argv in the harness command string. Full exact commands are in the scripts. Ports8894 Metro,8896 synthetic HTTP and8895 static web are owned scratch services; normal/protected services were not edited or stopped.

## Original-lease restoration

Root transferred exclusive native lease before access. Fresh inventory showed one booted `emulator-5554` (`droid`). Baseline: physical1080×2400, density420, font1.0, user_rotation0, accelerometer_rotation1, night=no, empty reverses. All device settings were restored exactly. Root explicitly authorized adding normal8087/38683 reverses at return despite the initially empty list; own8894/8896 reverses were removed. Native Metro8894 and fixture8896 processes exited. Root's supplied `exp+agent-client://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8087` reloaded actual-App Home successfully; screenshot `native-restored-original.png`, AX and settings JSON confirm Niaro/Home/composer. No install/reset/clear/signout/permissions/vault/account action occurred. Lease was returned to root; later focused native repair review requires retransfer and a fresh baseline.

## Remaining checkpoint

Root owns source repair, acceptance and publication. Await exact repair pins; preserve this original-subject evidence and test only changed web statuses and Card presentation under a new recorded freeze. Existing backend/audio/provider tests and pet performance work are outside this review and were not repeated. Mobile has no implemented light palette; changing OS appearance leaves graphite tokens. Full normal account shell, real identities, iOS, real audio, provider support and screen-reader spoken output remain unverified here.
