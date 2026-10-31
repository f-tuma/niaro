# Centered mobile Pet/profile proposal — 31 October 2026

Reviewable design and interactive prototype, with synthetic RAM-only records. This completes the paused design delivery; it does not implement a production feature, accept appearance/API decisions, or claim user aesthetic approval. Root owns publication, canonical plans, source integration and acceptance.

## Design

Keep the actual Niaro pet central, then reveal useful detail through six named sections: Práce, Projekty, Nástroje, Lidé, Styl, Rytmus. The quiet companion feel comes from its presence and discoverable memory, without XP, streaks, hunger, minigames, progress, invented confidence or growth counters. The implementation reuses unchanged canonical dark/light pet stills, the official logo, the established outline scalloped-face Pet icon and Manrope. No new images or mascot variants were generated on resume.

The existing three ImageGen screens remain the composition references: `concepts/01-overview-dark.png`, `02-memory-dark.png`, `03-appearance-light.png`. Established web-centered concepts07/08/09 and their design document were also read and viewed. Generated identity/type imperfections are corrected by exact assets and current native conventions; see the fidelity ledger.

Proposed entry: Knihovna → Ty a Niaro, also available from the existing drawer. The outline face identifies this entry. It pushes a normal back/title/appearance screen; it adds no fourth root navigation item and does not replace New Chat. The prototype's minimal Library is an entry illustration, not a replacement Library implementation.

Poznatky / Uložené / O tobě remain distinct. The overview presents the scope/memory row, centered pet/name, then the two-column section buttons. Selecting a section retains a smaller centered pet and shows readable rows. Back or Všechny oblasti restores the opener's focus and scroll position. There are no tiny orbit controls, floating overlays, card statistics or repeated explanatory copy.

Appearance uses an ordinary native-style header and Vzhled / Prostředí groups. Jméno, Pohyb peta, Zobrazit v chatu, Motiv and Počasí are proposal controls with local demo state only. Weather source actions explicitly explain their proposal status; they do not request geolocation. Name/theme choices never imply that production appearance storage exists.

## Tokens and responsive rules

Dark uses native background #141518, text #F4F4F6, secondary #A3A7B2, line #35373E and link #9AAFFF. Light proposal uses #FFFFFF, #1C1D21, #656A75, #E1E3E8 and #3659CF. The unchanged dark still's #131416 background has a minimal seam against native tokens; no tint, new halo or raster edit was added.

Manrope header20/28 weight600; statement17/26; control15; metadata13. Controls are code-native, have rounded rectangular12px corners and at least48px targets. Outline icons retain consistent stroke and established meanings. The screen has20px gutters and one document scroller, with a520px maximum shell for wider browser review.

At320 and200% root text, tabs and sections stack, scope controls wrap, labels/values and actions expand, and statements remain fully readable. The static pet scales down rather than competing with large text. Header and actions remain in normal flow. Long names wrap. The query `font=2` doubles root text sizing for the explicit text-resize QA; it does not claim browser pinch-zoom or native font integration.

The canonical C2 engine retains all tap/stroke/hold ownership. This still image has no handlers and no replacement animation/gesture engine. Motion preferences in this proposal must eventually map to the existing reduced-motion, visibility and animation controls; static prototype QA supplies no GPU/performance evidence.

## Truthful capability mapping

| Proposed surface | Current source truth | Prototype / required integration |
| --- | --- | --- |
| Poznatky | `origin=observed`, private, `trust=model_inference`; `source.type=observed`, section/personal/sources, seenAt. | Small synthetic semantic sample. Do not relabel observations as confirmed facts. Scope changes only filtering. |
| Uložené | `origin=explicit` can have different trust/status; not all records are owner-confirmed. | Examples separately label owner assertion Přidáno tebou and verified service result Ze služby. Production must preserve candidate/Not used labels and earlier-version handling. |
| O tobě | Planned NIAR-246 owner-confirmed position/department, distinct from access role. | Local fields only. No invented existing profile API. Microsoft suggestions, if introduced, require explicit acceptance and attribution. |
| Source | Current protocol supplies kind/date/removed/href, plus source identity/digest; no quotation/title/rationale. | Source dialog shows only kind/date. Removed source has no stale link. Production may open the supplied owner-relative href; demo does not simulate a real source route. |
| Opravit / Upravit | Existing revise command takes id, shown revision, content and stable requestId; server establishes user_note/assertion provenance. | Correction removes inferred demo row and focuses its updated Saved row, with status announcement. Production must preserve unsaved edit on409 and reload deliberate current state. |
| Smazat / Smazat vše | Existing forget / forgetAll preserve whole-lineage erasure and idempotency; chats remain. | Explicit native-dialog confirmation changes local demo records only. History/backend erasure is not tested here. |
| Paměť | preference `{optOut}` affects use/learning, not deletion. Plugin disabled and opted-out both refuse revise/remember. Inspect/delete remain possible. | Switch demonstrates optOut semantics; plugin-off query disables switch and shows unavailability. Both states omit correction while retaining source inspection/delete. |
| Complete browsing | Strict MemoryView max200 includes history; MemoryRead has no cursor. | No fabricated paging, total counter or completeness claim. Root must accept a paging amendment or explicit limited-browsing scope before production completion. |
| Appearance / weather | Production pet/profile/appearance backend not delivered by this task; web-centered weather extensions remain proposed decisions. | RAM-only name/theme/motion/chat choices; weather stays Off and explains source proposal. No phone, permission, location, provider or shared-workspace changes. |

Source audit: `packages/protocol/memory.ts` (including current strict read contract), `apps/server-identity/service.ts` memory route and plugin checks, and `apps/server-identity/memory.ts` writable/revise/lineage behavior. Their hashes are recorded in `source-and-asset-hashes.json`. Existing web design's paging and cross-device weather suggestions are not silently promoted to accepted API.

## Implementation and fixes

The preserved prototype remains plain HTML/CSS/JavaScript; React was not introduced. All behavior uses local state. No fetch, storage, credential, geolocation or provider integration is present. There is no new dependency or browser install.

Meaningful scratch fixes made during rendered QA:

- Back/cancel restores the exact action opener even when it has no DOM id; corrected records receive focus in Saved rather than disappearing.
- Dialogs have accessible titles and bounded Tab/Shift-Tab cycling; Escape restores the opener. Nested erase confirmations use their own opener reference.
- Theme radios use a single tab stop and arrow/Home/End selection; Enter also works.
- Large-text source/date spacing and long-name wrapping are explicit; overview stage spacing now keeps the normal390×844 screen within its viewport.
- Browser title is Czech and identifies the interactive proposal.

## Verification and fidelity

`browser/final/results.json`: 27 final renders, no horizontal overflow/clipped text, all local images loaded, all measured controls at least48px, zero page/console errors, zero external requests. Matrix:390×844 and320×800 ×100%/200% text ×dark/light ×overview/detail/appearance; plus contained1280×900, corrected Saved and reduced-motion/large-text states.

Eleven primary paths pass: entry/section/back focus; cancel edit; source modal/Escape; correction-to-Saved; delete/cancel; removed source; optOut/plugin-off; scope empty/recovery; About-you local edit; appearance/theme/weather disclosure; erase-all confirmation. `browser/final/extended-results.json` adds Unicode textarea +320×430 viewport resize, corrected-row focus, dialog Tab containment/Escape, theme arrow navigation and long-name layout. This viewport resize is a browser resilience probe, not physical native keyboard evidence for the new profile.

Browser connector/skill was absent. Orca browser was tried first on page31fff7b5-3e3e-484c-ac4c-2707348a3c10: navigation,390 viewport, meaningful DOM and empty console succeeded. Screenshot failed exactly: `CDP error (Page.captureScreenshot): Screenshot timed out — the browser page did not draw a frame.` A click receipt also left the snapshot unchanged. Authorized fallback used existing Playwright1.64.0-alpha-1790635538000 with existing Chromium headless shell1243. The default expected1247 executable was absent; executablePath selected installed1243 without installation.

Concept/native-size screenshots were captured at logical390×843 with DPR853/390, producing exact853×1844 output. All three concept/render pairs were inspected with view_image. The implementation faithfully preserves the centered direction, hierarchy, section order and exact-asset identity, with explicit native/type/asset deviations in `fidelity-ledger.md`. This is a fidelity review of a proposal, not aesthetic sign-off.

Commands: `python3 -m http.server 8895 --bind 127.0.0.1 --directory .../prototype`; `node --check .../prototype/app.js`; `TMPDIR=.../browser node .../browser/qa.cjs final`; `TMPDIR=.../browser node .../browser/extended.cjs`. The browser executable and package paths are explicit in those scripts. No repository build or production tests are implied by the static prototype pass.

## Root's next checkpoint

Review the three actual renders and interactive prototype beside the preserved concepts, accept or revise this mobile composition, and reconcile the entry, memory completeness, profile ownership and weather decisions in existing NIAR-243/246/254/255 plans. Then implement against production components with real revision/conflict/ownership/accessibility checks. Root alone publishes the allowlisted bundle. Native composer acceptance/restoration is separately documented in `composer-review.md`; no production/profile feature completion is claimed.
