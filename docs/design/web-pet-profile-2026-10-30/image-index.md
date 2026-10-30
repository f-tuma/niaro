# Concept index and QA limits

**Show the centered exact-asset renders first.** All data is synthetic. These are review candidates, not screenshots of an implemented feature. The latest user direction supersedes the earlier side rail; that prior family is preserved in `history/rail-v1` and is not the current recommendation. Root accepted this bounded research/design delivery after inspecting concepts 07/08/09 and eleven-render QA; implementation and proposed API/pagination/location decisions remain unaccepted pending canonical review.

| Image | Role | Exact scope |
| --- | --- | --- |
| [concept-07-centered-profile.png](concept-07-centered-profile.png) | Current main profile | 1440 × 960; centered actual pet, six named memory sections around it, Observed/Saved/About you distinction. |
| [concept-08-centered-detail.png](concept-08-centered-detail.png) | Expanded Style section | 1440 × 960; smaller centered pet, highlighted section, readable source/correction rows and All sections return. |
| [concept-02-new-chat.png](concept-02-new-chat.png) | First chat | 1440 × 960; existing pet, continuous composer, first-message paperclip menu with file/task choices, @ and microphone. |
| [concept-03-conversation.png](concept-03-conversation.png) | Active conversation | 1440 × 960; compact header pet, full reading/OpenUI width, attachment/task chips in the same composer. |
| [concept-09-centered-narrow.png](concept-09-centered-narrow.png) | Current responsive profile | 390 × 844; true-white theme, centered actual pet, six 48px-high section controls, no tiny ring. |
| [concept-05-settings.png](concept-05-settings.png) | Settings overview | 1440 × 960; no drawer header X, Weather source/value, separate memory/companion/output-voice rows. |
| [concept-06-profile-light.png](concept-06-profile-light.png) | Light desktop parity | 1440 × 960; identical information hierarchy, existing white/cobalt tokens. |
| [qa-conversation-390.png](qa-conversation-390.png), [qa-profile-360.png](qa-profile-360.png), [qa-profile-320.png](qa-profile-320.png), [qa-detail-390.png](qa-detail-390.png) | Supporting constraint checks | Narrow conversation, centered profile and expanded detail. No software keyboard simulation or product accessibility certification. |

`concepts.html?screen=profile|newchat|conversation|settings&theme=dark|light` is the synthetic layout artifact. Profile supports `section=style` and `view=saved|about`. Local section activation/return/focus and Work/Personal sample switching work; save, correction, upload, mention selection, voice and weather controls are illustrative. It uses exact local assets/font, no API/provider/storage calls. `gallery.html` is the review entry point. Neither is an application implementation. Root-level concept-01/04 images and earlier `.snapshot.txt`/`layout-qa.json` are retained historical artifacts; use current filenames and `final-layout-qa.json`.

## Image-generation record

Eight full-screen UI concepts were generated with the built-in `image_gen` tool, each a separate call: the original five and three new centered-profile views. Exact prompts are in [prompts.json](prompts.json); the three new prompts are also in [centered-prompts.json](centered-prompts.json). References include the actual running shell, approved pet stills/logo rasterization, coordinated concept and user's outline nav reference. Tool outputs were copied into this scratch directory; originals remain intact.

| Retained raw draft | Tool output | Limit / correction in final view |
| --- | --- | --- |
| concept-01-profile-dark-ai.png | exec-4bbca6cf-ec0e-42d5-abe5-607fe87bbb57.png | Logo approximated, oversized type, fabricated source excerpt, overbroad “Saved by you”. Final uses exact logo, actual scale, source link/date only, Saved with row trust label. |
| concept-02-new-chat-ai.png | exec-3a0deb79-3a2f-43e9-a32d-c3903ade14bc.png | Pet and chrome larger than requested, approximated logo, subtle generated texture. Final fixes dimensions/tokens and exact identity. |
| concept-03-conversation-ai.png | exec-16c1157a-f9cd-479b-8e79-0b23d7f051e9.png | Two sidebar selections and exaggerated dimensions. Final selects only the current chat and retains real app scale. |
| concept-04-narrow-light-ai.png | exec-43f4ef7d-632b-4646-8066-01305b1e5762.png | Raw output 977 × 1610; requested 390px logical ratio not reproduced exactly; generated mark/type are approximate. Final is actually rendered at 390 × 844 and 360 × 800. |
| concept-05-settings-ai.png | exec-62dbd3fe-9bda-4ca5-a7f8-793f6ef6534b.png | **Superseded**: header X, Weather city-only model, global dirty footer and disabled preview. Final has no X, Weather source/value, independent editor entry rows and clean Done footer. |
| concept-07-centered-profile-ai.png | exec-a3f944a9-3f2b-4e93-97d9-0757ebb73495.png | New centered composition; generated logo/pet, type and scale remain approximate, with duplicate selected sidebar items. Exact render restores existing assets, single selected Pet, true tokens and production-scale type. |
| concept-08-centered-detail-ai.png | exec-b6700b5f-0302-496d-88c8-4a4b0a3cb575.png | New expanded detail; synthetic source links/dates only. Final corrects asset identity, type/spacing, sidebar selection and preserves readable normal-flow rows. |
| concept-09-centered-narrow-ai.png | exec-58981af1-3173-4128-9739-98cd98719202.png | New narrow composition; generated pet is too large and pet-face icon wrongly substitutes for Settings. Final uses actual 220px canvas, normal Settings icon and actual 390/360/320px renders. |

Raw AI outputs are explorations, not production assets or pixel-level authorities. Do not extract the generated logo/pet from them. The concept HTML was built separately with code-native UI and exact existing assets; it does not retouch the generated images.

## Asset identity and copy lock

- Logo: unchanged path geometry from `assets/brand/source/logo.svg`; only foreground colour inherits the light/dark token. `references/logo-source.svg` and `references/logo-source.png` preserve the audit input. The raster was rendered by `rsvg-convert`; a first attempt with unavailable CairoSVG did not produce an image.
- Pet: unchanged existing `dark-cookie.png` / `light-cookie.png` WebGL reference captures. These stills preserve silhouette, face, internal colours, highlights and original contact shadow. No external halo was added. This is not a claim of animated-renderer equivalence or fallback silhouette accuracy.
- Typography: local existing Manrope Variable font, no substitute generated lettering. Icons: existing Lucide React geometry, except the explicitly requested outline Pet navigation icon in `references/pet-nav-icon.svg`, derived from the approved outer silhouette with a restrained face/stroke. User reference is `references/user-pet-nav-icon.png`; no logo master changed. Final screenshot uses live text, not generated UI labels.
- Common copy: Studio, Workspace, Overview, New chat, Search, Tasks, Meetings, Processes, Skills, Connections, Pet, Recent, Project review, Weekly planning, Alex Novak. All are synthetic except real product navigation labels.
- Profile copy: You and Niaro, Settings, Use memory, About you, Job title, Department, Confirmed by you, Saved, Manage memories, You added, Observed, Work observations, Personal observations, Work, Projects, Tools, People, Style, Rhythm, All sections, From chat, Last seen yesterday, Correct, Bublina, Appearance; synthetic fact/position/date strings are examples only.
- Chat copy: What can I help with?, Message the assistant, Add file, Reference task; synthetic conversation/table/file/task contents are in the artifact. No permanent growth/help/warning copy or metrics.
- Settings copy: Settings, Memory, Use memory, Keep personal observations, Manage memories, Companion, Animate pet, Show in chat, Weather, City: Prague, Voice, Output voice, Server default, Done. No drawer close X, fake provider voice or marketing copy.

## Fidelity and verification ledger

| Comparison point | Evidence / decision |
| --- | --- |
| Existing app shell | Compared current-web-chat.png against final profile/new-chat/conversation: same dark palette, left navigation and modest type scale. Intentional proposed additions: Pet nav and approved brand mark in the workspace slot. |
| Asset identity | Final HTML references exact source SVG geometry/pet image files. AI identity drift is corrected in final assets; source checksums are recorded. |
| Container model | Centered pet with named surrounding section controls; expanded details use a readable row document. No dashboard card grid, orbit decoration, mini-games or metrics. Chat result retains the existing table/card idiom. Composer remains one surface. |
| Text and data claims | Removed invented source quote, changed Saved by you to Saved, retained assertion/inference distinction. No unsupported health, growth score or numeric confidence. |
| Palette and type | Real Manrope and explicit existing token values. True-white light surface. No generated background texture/glow in final renders. |
| Composer continuity | Desktop captures show width 850px and identical bottom baseline y=928. Attachment/task chips increase height rather than create a detached toolbar or move controls elsewhere. Static geometry is not React mount/focus proof. |
| Narrow fit | Recorded DOM widths do not exceed viewport at 390, 360 and 320px; images load. Section buttons are 48px high in overview and 44px expanded. Profile flows vertically; conversation keeps pet in header. Production zoom, software keyboard occlusion and long translations remain acceptance work. |
| Local section navigation | At 390px, Style opens with detail-heading focus and aria-expanded true; All sections removes detail and restores opener focus. Personal sample returns empty and Work restores two rows. This validates the scratch interaction only, not production behavior or API ownership. |
| Latest drawer correction | Final Settings has no header X or close-slot reservation. Attachment remove X stays. Done is the clean dismiss action; notes cover scrim/Escape/focus but static HTML does not test them. |
| Weather/voice | Final Weather overview shows a source/value, with Off/City/Phone defined in design notes. Output voice is separate from transcription, uses Server default in sample; no provider calls or fake options. |

Browser-first evidence: own Orca local page rendered the initial exact-asset set successfully and measured it; `layout-qa.json` holds those results. The original local page later disappeared; a replacement produced repeated `CDP error (Page.captureScreenshot): Screenshot timed out — the browser page did not draw a frame`. Final post-review captures therefore use an isolated Playwright headless browser, documented in `final-layout-qa.json`; it opens only the local concept file. The current final set contains eleven renders without page errors or horizontal overflow, plus local section focus/return and scope-switching checks. Both sets are concept checks, not production tests. The temporary browser process is closed by its capture script. No QA web server was started by this worker.

`view_image` inspection covered raw concepts and final renders, including desktop/narrow/light/dark/settings and the actual existing app reference. Changes are deliberate draft refinements, not claimed pixel-fidelity to an accepted AI image. Root/user review remains the acceptance gate. No implementation fidelity, animated performance, functional flow, native gesture, screen-reader certification, deployment or provider integration has been claimed.

The fallback browser binary is retained under `tools/browsers` only. Automatic approval review rejected the attempted temporary-cache cleanup because `rm -f` style commands are not permitted; no deletion was retried. This cache is not part of the design deliverables or artifact hash manifest and need not be hosted. The exact install invocation was `PLAYWRIGHT_BROWSERS_PATH=/tmp/niaro-pet-parity-20261030/web-design/tools/browsers node /home/flamendrin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/cli.js install chromium --only-shell`. The capture script closed its browser process; no QA web server was started.
