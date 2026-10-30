# Web profile, pet and composer — concrete amendment proposal

**Status:** coordinator accepted the bounded centered research/design delivery on 30 October 2026 after inspecting concepts 07/08/09 and eleven-render QA. This accepts review artifacts only, not all proposed pagination/API/location decisions or production implementation. **Mode:** spec-guide and frontend-app-builder research/concepts. This worker changed only `/tmp/niaro-pet-parity-20261030/web-design`; canonical amendment and production work remain with Root/Sol.

Canonical ownership stays with NIAR-243 (`niar-243-member-memory-page`), NIAR-246 (`niar-246-work-pet`), NIAR-254 (composer/drawer refinement) and NIAR-255 (personal output voice). Root/Sol alone incorporate approved amendments into existing proposal/design/tasks/delta specs. This document is a review artifact, not a replacement framework or new source of product truth.

## Proposed product decision

Use one family of surfaces: the pet centered in the active `/pet` view, with six memory-section controls arranged around it; the same pet above the initial chat; a small still pet in the conversation header. Keep the existing sidebar/active-screen split, typography/tokens and continuous composer. This incorporates the user's latest centered-pet direction and supersedes the earlier side-rail candidate, preserved under `history/rail-v1`. The mini-Tamagotchi feel comes from presence and exploring what the companion has learned; it introduces no minigames, scores, coins, streaks, affection meters, fake health or unearned stages.

`/pet` has the visible title **You and Niaro** and three compact views: **Observed**, **Saved**, **About you**. Observed opens on the centered pet and the Work, Projects, Tools, People, Style and Rhythm controls. Selecting one reveals its readable records below a smaller centered pet. Saved and About you preserve explicit-record and confirmed-position semantics. **Pet** remains the NIAR-246 sidebar entry after Connections, using the user's outline pet-face navigation icon. `/me/memory` remains **Memory**, linked from Account and **Manage memories**, with complete private record management and erasure controls. Neither route depends on a chat session; they reuse record/actions/query behavior, not separate stores.

The `concept-*.png` files without `-ai` are the exact-asset presentation candidates. The AI drafts establish composition; final renders intentionally correct identity, type scale and unsupported details. See `image-index.md` before showing a draft as authoritative.

## Layout and visual contract

| Surface | Layout | Concrete behavior |
| --- | --- | --- |
| Profile desktop | Existing 232px sidebar and 48px page gutters. Observed/Saved/About you across the top; observation scope and Use memory aligned right. A 950px-wide, 670px-high stage centers the actual 320px pet canvas, with three section controls on each side in a near-radial arrangement. | Six 164 × 48px named buttons, not content cards or icon-only satellites. Pet name and Appearance beneath it. Title 24px, body 13–14px, meta 11–12px. No connecting orbit lines, count bar, growth line, alert strip or background halo. |
| Expanded section | The same stage contracts to 355px with a 210px pet canvas. Selected section uses the existing accent border. Below it is an 800px readable column with **All sections**, section title, rows and source disclosures. | Selecting a section moves focus to its detail heading. All sections collapses details and returns focus to the opening section button. Other sections remain available. No overlay, close X, hover-only content or circular text. |
| Profile narrow | At 760px and below, sidebar collapses. Tabs wrap above the scope/memory control row. The actual pet stays centered (220px canvas), with six 48px-high named controls in two columns below. 20px gutters and one vertical scroller. | Expanded state keeps a smaller 140px central pet and 44px-high section controls, followed by the readable detail. It deliberately becomes a normal document, not a tiny ring. Long statements wrap; source/actions remain reachable; full-width sheet. No invented native bottom navigation. |
| New chat | Same shell. Centered 230px pet canvas (the actual silhouette occupies less), one short prompt, persistent bottom composer up to 850px. | Existing prompt **What can I help with?**. No personal remembered fact is displayed uninvited. Suggested prompts may be omitted in this concept family; preserve existing functionality elsewhere, not filler buttons. |
| Conversation | 42px still pet canvas in header, alongside chat title. Same 850px message/composer width. | Clicking the pet opens `/pet`, with accessible name **Open your pet and memory**. No pet per message, floating pet, sidebar animation or overlap with text/results. OpenUI can use the full result column and its existing expanded view. |
| Settings | 440px right sheet on desktop, full width on narrow view. Memory, Companion and Voice groups are separate. | No top-right close X or reserved close slot. Clean overview ends with **Done**; a dedicated editor uses existing Cancel/Save changes. Scrim/Escape/system-back dismissal and opener focus restoration are requirements; this static concept does not claim swipe implementation. |

Palette and typography remain owned by `apps/server-admin/web/style.css` and `font.css`. Dark background `#141518`, sidebar `#0b0c0e`, text `#ececef`, primary `#7d98f0`; light background `#ffffff`, text `#1c1d21`, primary `#3659cf`. Use Manrope Variable and existing semantic variants. Lucide outline icons, existing 6–8px control shapes and hairline separators. The composer retains a single 12px rounded surface. The final illustrations have no new ambient halo, no tinted overlay and no background texture.

The exact `assets/brand/source/logo.svg` geometry is used for the brand mark, with inherited foreground fill; no image-generated logo enters production. The Pet navigation icon is a separate outline scalloped face following the user's supplied reference (`references/user-pet-nav-icon.png`); the scratch SVG derives the approved outer silhouette, with restrained stroke and face. This explicitly amends NIAR-246 D7's PawPrint choice; it does not change logo masters. The pet image is an unchanged current WebGL reference still, not a new mascot. Production uses approved `PetView`/fallback. Proposed cat/heart/frog choices remain a later owned shape-selector extension and must not redraw the logo or change this default identity.

## Information model and controls

### Confirmed position, saved records and inferred observations

**About you** holds owner-confirmed job title and department from the future NIAR-246 pet/position API. Their edit sheet is separate from access roles, memory permission and pet appearance. An optional Microsoft suggestion is labelled **From Microsoft 365** and does nothing until accepted/edited; do not imply it is already confirmed. Empty position uses **Add position** instead of two empty value rows.

**Saved** is a preview of the newest three current explicit records, with **Manage memories** always available. It is not labelled “everything known”. Use row-level source/trust labels: **You added**, **From chat**, **From a service**, or **Not used** for a candidate. Do not label the entire explicit origin “Confirmed by you”: explicit records can have other trust states. User correction of an inference becomes an explicit assertion and therefore moves here; keep a transient status **Saved to your memories** and a link/focus to the changed record. Do not make the corrected item apparently vanish.

**Observed** holds inferred records, grouped by section. **Work observations / Personal observations** changes the read scope; it does not change storage or opt-out. Personal is derived only from `source.type=observed` and `personal`. All six category affordances remain in stable locations: Work, Projects, Tools, People, Style, Rhythm. Opening an empty category shows only **Nothing observed here yet.**; no permanent explanation is placed around the pet. This replaces both the earlier Other sections disclosure and NIAR-246's one-explanation-per-empty-section rendering. No percentage, confidence score, progress bar, affection meter or streak is added.

Use ordinary DOM buttons in logical Work, Projects, Tools, People, Style, Rhythm order, independent of visual placement. Expose selected/expanded state and its detail relationship; no custom radial keyboard mode. Section activation and return are immediate with reduced motion, and may remain immediate by default. Do not rotate, bounce or chase the pointer. Saved and About you are ordinary readable views with a smaller central pet, not categories mixed into the inference ring. The current local prototype demonstrates section focus/return and synthetic scope switching; it does not implement API reads or mutations.

Each observation's row shows its statement, section and source chevron; `…` contains Correct, Mark personal/Mark work and Delete. The opened detail exposes server-supplied source kind/date and owner-relative link(s), last-seen time, and optional **Earlier versions** / **Details** disclosures for creation/expiry/kind. **Correct** is directly available in that opened detail. Render no fabricated source title, source quotation or rationale: the current view supplies none. A future source preview would need its own authenticated read contract and authorization review; it is not required for this proposal.

Sources marked removed show **Source removed** with no link or stale title/excerpt. Stable links remain owner-scoped after archive/restore. An observation is not a verified fact merely because it has a source link. All source detail is text accessible; section colours inside the pet never carry the only meaning.

**Correct** opens a small editor seeded with exact current text. Cancel does not write; Save changes sends existing `revise` with shown id/revision and a stable requestId. The server, not the browser, establishes new explicit source/trust. `409 memory_conflict` reloads the row and preserves the unsaved edit for deliberate review. No silent overwrite.

**Delete** stays in `…`, with ConfirmAction. Suggested modal: **Delete this memory?** / **Its earlier versions will also be deleted.** / Cancel / Delete. **Erase all** lives only in the Memory page's `…`: **Erase all memories?** / **Saved memories and observations will be erased. Chats stay.** / Cancel / Erase all. No permanent warning copy. Do not display a misleading “memory count” that actually counts history rows. Both actions retain existing whole-lineage/idempotent semantics.

### Memory is off, personal filter and deletion

Use memory maps only to `preference {optOut}`. Turning it off stops memory use/learning and puts the pet to sleep; it does not silently erase stored rows. Stored private records remain inspectable and erasable. The setting does not activate the workspace plugin and cannot change operator policy. If the plugin is disabled, show one compact **Memory unavailable** state adjacent to the switch and keep the stored list. Do not hide prior observations.

Actual server behavior currently rejects revise/remember with plugin off or owner opted out. In these states, omit Correct/Edit-memory actions and offer the existing switch only when it can restore availability. Keep Delete, Erase all, source inspection and available privacy controls. Confirmed position and pet appearance remain separately manageable as NIAR-246 requires. No off-state mock should show a working Correct button.

Settings label **Keep personal observations** maps to `personalThings keep|drop`, not to explicit saved facts. Switching to drop opens a confirmation: **Delete personal observations?** / **Saved memories stay. New personal observations won't be kept.** / Cancel / Delete and stop keeping. This action erases personal observed history under existing origin-filtered semantics; it is not a harmless view filter. When already dropping, Mark personal opens the same consequence confirmation before `classify` because that item will be erased. Mark work is non-destructive. A corrected explicit head remains after drop; ordinary Delete/Erase all still remove the complete lineage.

### Complete browsing: required amendment to the 200-item limit

The current `agent-memory/1` read has exact total but at most 200 readable records, including superseded rows. It has no cursor. A client cannot recover missing records by filtering those 200, and a high displayed total is not a substitute for the ability to inspect/correct them.

**Proposed owner decision:** amend NIAR-243's no-paging non-goal and deliver server paging before calling either page complete. Keep GET and POST routes and existing memory store ownership. Extend the strict private GET query with optional `cursor` plus explicit/observed view selection; if personal selection is exposed, it is valid only for observed records. Extend the view with optional `nextCursor`, preserving legacy no-cursor callers. Do not add a profile-content store.

Each page is at most 200 records in deterministic updatedAt-desc/id-asc order, owner/workspace/private scoped. Filter before pagination, never after the limited slice. The opaque cursor binds the filter, actor, workspace, order position and memory version; changing the version refuses continuation with a reloadable conflict. Client clears all pages on a version/context change and never merges generations or shows another workspace's cached rows. `total` refers to that readable filtered record set; it is not a growth score. No persistent count bar is needed. A **Load earlier memories** row appears only when nextCursor exists, and an incomplete filtered read must not show a false empty state.

Earlier versions may cross page boundaries. The manager must visibly retain/reach them when loaded; a history disclosure may load continuation using the same generation. An orphan superseded row remains visible until its head can be resolved, as NIAR-243 already requires. Test a history chain crossing the page boundary. The pet's shape/stage/weights must still be computed server-side from all eligible work observations, never the client page. NIAR-246's existing up-to-300 observation Pet API is not a reason to call a 200-row memory sample complete.

If the owner defers paging, the only honest interim release is explicitly labelled limited browsing with a non-count-bar truncation message and no claim of complete inspectability; the full-profile checkpoint remains incomplete. This proposal recommends paging, not that reduced interim scope.

### Appearance, motion and weather

Appearance opens the existing planned name/colour/shape editor with revision conflict handling. No inner-colour controls or fake growth controls. Growth information, if retained from the canonical requirement, is available under Appearance → Details rather than permanently asking the person to “help it grow”. A deterministic greeting may appear on request in the profile; the default page and chat do not repeat observations merely to greet the user.

**Animate pet** provides a persistent pause mechanism independent of system preferences. **Show in chat** hides both chat placements without hiding `/pet`. The profile/new-chat pet respects both controls, hidden-tab/offscreen stop, reduced motion and the existing 30fps / 480-device-pixel cap. The conversation pet is still by default. Reduced motion shows one still frame and no touch/morph/pointer/weather animation. Do not flash lightning in this bounded product UI; static weather mood is enough. Touch reactions are local and cannot mutate memory or fire a provider call. Animation controls must not imply learning controls.

The coordinator relayed user approval for optional foreground coarse phone location plus manual city, superseding NIAR-246's workspace-only location assumption. **Acceptance qualification:** the approved current mobile plan uses local coarse coordinates. Reverse geocoding, resolved-city confirmation, cross-device city persistence and web Phone synchronization below remain proposed API decisions, not implicitly approved scope; reconcile them with the sole writer's plan at W0. No public Nominatim service was requested or selected. Keep location separate from memory:

- Web **Weather** shows the current source/value: **Off**, **City: Prague** (synthetic example), or **Phone**. It opens a source picker with Off / City / Phone. City opens manual search/selection, Clear, Cancel and Save changes; a city must be selected from a resolvable place result, not an arbitrary unvalidated coordinate string.
- Native phone editor offers **Use phone location** for the Phone source. Request only after that deliberate action, foreground/coarse. The current approved plan retains coarse coordinates locally; a resolved-city confirmation would require a separately accepted API/provider decision. While Phone remains selected, later refreshes are limited to the explicit foreground policy, never background tracking. Permission refused/unavailable retains the manual path and does not block the pet. No continuous tracking or background permission.
- A future synchronized web Phone state could show the selected source and last resolved city, and permit Off or City; that sync/persistence is a proposal, not current authorization. Web never remotely triggers the phone's permission prompt. Without a supported cross-device contract, do not imply web has received phone location. Manual and phone values never become learned facts or change a shared workspace location.
- Off or no usable personal location means day/night by the explicit device/user timezone, with weather absent; no automatic inference from IP, chats or job title. If workspace fallback is retained, it must be explicitly selected as **Workspace city**, not silently substituted after personal removal.
- Server-owned coarse location/query/refresh/privacy contracts need a NIAR-246 amendment before implementation. Preserve no person identifiers in weather requests and no raw GPS/route history. Weather failure is neutral mood, not a page-level alarm. Cache age and stale cutoff remain the canonical server responsibility.

### Output voice and account settings

NIAR-255 owns a personal **Output voice** row, shared with `/me` so it is not discoverable only through the pet. The profile settings sheet is an additional entry to the same preference editor. Position, role, transcription model and memory preference are not used as voice options.

The editor lists only server/provider-permitted output voices plus **Server default**; no arbitrary voice id field, fake popular choices or automatic provider switch. It saves through the NIAR-255 owner API and uses current server voice as fallback if the selected voice disappears. Show the effective fallback truthfully, preserve the saved preference only according to that API's policy, and offer a new selection. Loading, error/retry and no permitted alternatives have distinct states. No extra explanatory paragraph on the clean settings overview. A future explicit Preview action may synthesize only through the supported authorized path; no automatic preview on opening/selecting. The delivered concepts include no preview provider call.

### First-message composer and references

NIAR-254 owns this independently of the pet/profile. Reuse the current `InputGroup`, attachment runtime, mention directory and task-reference logic. Keep the same composer instance/mount/focus, draft, file selections and references when `/chat` becomes `/chat/$conversationId`. The empty-state content yields to messages; the input never jumps into another shell or loses a typed draft. At reduced motion this is an immediate layout change.

Paperclip remains visible on first render. Menu entries are **Add file** and **Reference task**; file availability is a per-entry capability state, not a reason to hide the whole menu or the task path. Preserve supported photo/camera functionality through the existing platform picker/options, not a silent regression. While capability discovery is pending, expose a local loading state. If uploads are unavailable, disable only Add file with concise contextual explanation when opened. Files have upload/progress/ready/error/uncertain states, their real names and remove controls. Never pretend an upload succeeded.

@ is a separate button and typed trigger for the current directory: skills/processes/services/meetings according to returned access. Native mobile must include skills/processes (the user requirement). Keep accessible combobox keyboard semantics, caret placement, IME behavior, Escape dismissal, no premature send while choosing, and server revalidation. An empty directory has a concise empty result instead of inventing entries.

Reference task uses the existing single `attachedTask` path and owner-visible task selection; it must not become a fake `kind=task` in the current mention schema. Existing process/question reply context and attached task are distinct: preserve current mutual-exclusion/replacement rules and require deliberate choice if a different context must be cleared. The screenshot shows an ordinary task reference, not a permission to execute or an approval response. A removable chip is context only. Attachment-remove X and search-clear X remain; the user's no-X correction concerns drawer close controls.

Microphone stays visibly inside the same continuous composer on the right, beside send/stop. The selected output voice affects speech output, not microphone permission or transcription configuration. Voice-unavailable and permission-denied states must not destroy text/file drafts. During a run, retain the existing Stop semantics; companion animation never substitutes for actual progress state.

## State/action map

| State / transition | Visible behavior | Data/action constraint |
| --- | --- | --- |
| First open, no memories | Neutral current pet and stable section controls. Selected empty category says **Nothing observed here yet.**; Saved **Nothing saved yet**; About you **Add position**. Optional Start a chat only in the selected empty detail. | No invented facts, inferred job or fake growth. Empty is shown only after complete applicable reads. |
| Loading profile | Stable central pet slot and section labels; compact pending state in the requested detail, row-shaped skeletons if needed. | Do not flash another workspace's cached pet/facts or render false empty. New-chat submission does not wait for profile. |
| Memory read fails | **Couldn't load memories. Try again.** in that region. | No misleading stale list after scope change. Pet/appearance can remain if independently known and current. |
| Pet read fails | Quiet placeholder + Retry in pet region; memory remains accessible. | No fabricated pet state and no blocking the whole memory manager. |
| Workspace plugin off | Sleeping/still pet; compact **Memory unavailable**; stored rows visible, erasure/source controls retained. | No learn/use, no revise; user cannot enable operator plugin. |
| User opted out | Switch off; sleeping/still pet; stored rows visible. | No learn/use, no revise until enabled. Erasure still works. Turning on is explicit. |
| Personal drop | Work view available; Personal observations scope shows **Personal observations are off** and a settings link in its requested detail. | No display of already-erased content. Explicit saved records stay. |
| Source deleted | **Source removed** in detail. | No link, quote, title or fall-through to another person's source. Observation remains erasable. |
| Correct succeeds | Updated explicit record is shown in Saved/Memory, transient status and stable focus. | Source/trust established by server; full lineage retained. |
| Revise/delete conflict | **This memory changed. Review it and try again.**; fresh record loaded, edit draft retained separately. | Never retry against a fresh revision silently. |
| Unknown mutation outcome | Inline **Couldn't confirm. Try again.** | Explicit retry only, same requestId/signature. Do not show success, issue a new write or erase newer data. |
| Erase confirmation cancelled | Return to same row/page position. | No command sent. Focus returns to opener. |
| Page continuation conflict | Keep deliberate loading/retry state, reload current generation. | Never merge pages from different versions/workspaces. |
| No WebGL / reduced motion / paused | Same identity in still fallback; controls and text intact. | Not a visual “error”; no new rendering identity. |
| Section open / return | Center stage contracts, selected button remains visible, details enter normal flow; All sections restores central overview and opener focus. | Keep selected category and scope across read retry; do not silently show a different category. Use ordinary buttons, not custom circular navigation. |
| 320/360/390px, zoom, keyboard open | Central pet then readable two-column section controls; expanded details below, one scroller. Composer stays above keyboard; max input height then internal text scroll; chips wrap. | Reserve bottom space for all focusable message controls; do not cover results with pet/composer. Static 320px fit is checked; production zoom/keyboard still need verification. |
| Sheet clean / editing | Clean overview Done; editor Cancel + Save changes; no header X. | Scrim/Escape dismissal, dirty-change behavior and focus restoration. Do not claim native swipe without a tested gesture. |
| Voice option removed | Server default effective; editor permits a valid replacement. | No arbitrary voice/provider, no transcription profile substitution. |
| Location denied / cleared | Manual choice remains / Off, neutral weather. | No repeated unsolicited permission request or hidden shared-location mutation. |
| Chat first send / send refused | Same composer/draft mechanism. Submitted content restores when existing transport refuses. | No lost attachments, references or duplicate send; retain known/unknown-outcome rules. |

## Draft changes to canonical artifacts

These are concrete replacement/addition blocks for the source owner to review. They are not edits performed by this worker.

### NIAR-243

Update `proposal.md` Non-goals: remove page editing and “paging beyond newest 200” exclusions. Add owner correction, complete paged private browsing and reuse by `/pet`; preserve no shared notes and no native-screen claim.

Amend `design.md` D2/D4 and `specs/memory/spec.md` **Memory management API**, **Memory page in the web app**, **Memory page states** and **Deleting on the memory page**:

> The private read SHALL expose bounded, version-consistent continuation so every readable private record can be reached. View filtering SHALL precede the page limit. A page SHALL NOT present an incomplete filtered result as empty or complete. A changed memory generation SHALL invalidate continuation. Earlier versions SHALL remain discoverable across page boundaries.
>
> The member manager SHALL distinguish owner assertions, verified results and inferred observations using server source/trust; correcting an observation SHALL create the existing explicit owner assertion and keep it visible in the manager. Correction SHALL be unavailable where current server policy refuses it. Stored rows and erasure SHALL remain available with memory disabled or opted out.
>
> Erase all SHALL remain in the page menu and require a concise confirmation naming what is erased and what stays; no permanent count bar or misleading count of history rows SHALL be required.

Add scenarios: 250 records can all be reached; all first 200 are observed but an older explicit fact is still reachable; personal filter does not return a false empty due to another origin; history crosses page boundary; mutation between pages refuses/reloads; correction appears as explicit; lost erase-all replay preserves later memory.

### NIAR-246

Amend `design.md` D4/D6/D6b/D7, `specs/work-pet/spec.md` **Pet area**, **Profile sections**, **Pet states**, **Greeting**, **Growth stages**, **Rendering budget**, **Weather mood** and `tasks.md` 4.x/5.x:

> The Pet area SHALL keep the existing sidebar/active-view split and center the current pet within the active Observed view. Six named section controls (Work, Projects, Tools, People, Style, Rhythm) SHALL surround it on wide views and become readable controls below a centered pet on narrow views. A selected section SHALL expand to normal-flow readable records and source/actions, with a return action and restored opener focus. No minigame, score, streak, affection economy, fake health or unearned stage SHALL be introduced.
>
> Confirmed position, saved-memory preview and inferred observations SHALL retain their distinct source/control semantics in About you, Saved and Observed views. Full private record management remains at `/me/memory`; both routes work without chat. Correction SHALL remain visible after its origin becomes explicit. The Pet navigation entry SHALL use the user-approved outline scalloped pet-face icon instead of PawPrint without changing approved logo masters.
>
> When memory is unavailable or opted out, the pet SHALL sleep and stored private records SHALL stay inspectable and erasable. Learning and context use SHALL stop; unavailable correction SHALL not be offered. This replaces the prior plugin-off scenario that hid observations.
>
> New chat SHALL show the current pet above its composer. Active conversation SHALL show a compact still pet linking to the profile, outside the reading/results area. The same composer SHALL retain its identity and draft through first send.
>
> The person SHALL be able to pause pet animation independently of system reduced motion and hide chat placements. Reduced motion SHALL draw one still frame. No stage adds an exterior halo; no storm flash is needed. Growth/greeting detail SHALL be available on demand rather than mandatory permanent copy.
>
> Optional personal weather location SHALL be explicitly selected manually or from a foreground coarse phone request and owner-confirmed. Clearing it SHALL stop personal-location weather use. No background tracking, memory inference, shared-location mutation or permission/role implication is allowed. Web SHALL not trigger phone permission remotely.

Update canonical tasks with supported cat/heart/frog optional shape work only after the already owned prototype review; default identity/logo are unchanged. Keep existing stage, source, erasure, rendering-budget and billing fences. No pet/page completion can be inferred from a passing renderer test.

### NIAR-254 and NIAR-255

NIAR-254 composer/drawer tasks: first-render paperclip with per-action capability gating, task references through the current attachedTask path, mobile @ skills/processes, visible in-composer microphone, continuous composer state across route transition, and remove redundant drawer X without removing chip/search-clear controls. Match latest immediate corrections by the sole writer; do not reimplement them from this design artifact.

NIAR-255 settings tasks: one personal output-voice editor reached from Account and profile Settings; only server-permitted choices; explicit Server default and reliable fallback; revision/idempotent failure behavior according to the owned API; no automatic paid preview. Distinguish it explicitly from workspace transcription `voiceId`.

## Proposed checkpoints and review evidence

| Checkpoint / owner | Bounded result | Required evidence before acceptance |
| --- | --- | --- |
| W0 — Root/Sol planning, NIAR-243/246/254/255 | Review these owner decisions and amend existing canonical artifacts coherently; no parallel spec. | Fresh-context canonical design review required by repository workflow, resolved paging/off-state/location/voice semantics. Current writer's task maps remain authoritative. |
| W1 — NIAR-243 | Complete owner-only paged private record API + memory manager, correct/delete/erase-all/off states. | Real store/HTTP tests for ownership, filtered pagination, history boundary, context/version conflict, opt-out, plugin-off, correction lineage and same-request replay. UI tests exercise actual mutation/recovery logic, not implementation-shaped snapshots. |
| W2 — NIAR-246 pet API/page | Owner-only pet/position state, full derived look, centered section overview, readable expanded detail, Saved/About you and appearance. | Existing planned pet HTTP/pure-function oracles plus source privacy, corrected record visibility and no-chat routes. Section activation/return/focus, 44px narrow controls, all empty/error/off states, outline Pet nav. `/pet` and `/me/memory` don't claim complete data from a limited sample. |
| W3 — NIAR-254 | Composer and compact/new-chat placements using existing production components. | First-send retained focus/draft/file/task/@ state; upload unavailable vs task available; keyboard/IME picker; files fail/unknown; active reply context; microphone visibility. Test EN/CS and rich OpenUI result remains readable. |
| W4 — NIAR-246/255 | Personal weather control, animation preference, output-voice settings. | Controlled transport only for tests; foreground/coarse/denied/clear location; no shared mutation; paused/reduced motion/offscreen behavior; permitted voice list and fallback; separate source owners. No unapproved provider call in QA. |
| W5 — Root integration/review | Accepted layout faithfully realized using shared tokens/primitives. | Browser screenshots of actual implementation at 1440, 390, 360 and 320px; EN/CS light/dark, 200%/400% zoom as appropriate, keyboard/focus, loading/empty/off/error/conflict, drawer no-X and actual gesture only if claimed. Compare against accepted concepts with a fidelity ledger. Required repository checks and both OpenSpec validations; record any baseline failure separately. |

Suggested focused sources are the existing NIAR-243/246 test plans and new feature tests only where behavior demands them. Full checks remain `npm run check`, `npm run admin:build`, and strict validation of the affected canonical changes. This research task did not run production application tests and does not provide a release/deployment receipt.

## Actual verification and limitations

The original artifact was rendered in its own Orca page. After that page disappeared and a replacement repeatedly timed out in Page.captureScreenshot, the centered revision used isolated Playwright Chromium against the local file. `final-layout-qa.json` records eleven renders (1440 × 960, 390 × 844, 360 × 800 and 320 × 800), no page errors or horizontal overflow, loaded local images and section-target geometry. Synthetic interaction checks verified Style opening, detail-heading focus, All sections returning focus, Personal empty data and Work restoration. The final views use actual logo geometry, unchanged pet stills and Manrope. Composer baseline remains y=928 at desktop, with height increasing for chips. Raw and final concepts were inspected visually. No emulator was used.

`spec check --project /home/flamendrin/workspace/niaro --phase design --ui` mechanically passed, semantic result unknown. Its current mapping names the attachment change; it does not validate this scratch proposal or accept it. A fresh-context root review is still required. The source hash manifest fingerprints the consulted live files at handoff, not execution or approval; concurrent owner work may advance them after this audit.

The HTML is a **synthetic concept with local section navigation**, not production code, an integrated app or a complete interaction prototype. It has no API, provider, storage or credential calls. Other controls illustrate states; they are not functional proof of saves, uploads, paging, voice, location, Escape, focus trap, swipe or screen-reader conformance. The pet is a still capture, so no animation/performance fidelity is claimed. Production 320px/zoom/keyboard/reduced-motion verification remains future work. This is not a claim that the production app matches the proposed design.
