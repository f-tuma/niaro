# Centered Pet/profile screens — 31 October 2026

Delivered the owner-requested native and web screens before weather. Web `/pet` and `/me/memory` work on direct load and refresh; the app opens **You and Niaro** from Library and its drawer. Both use the standard PawPrint entry icon. Six work sections surround the existing interactive pet on desktop and sit below it on mobile/narrow views. Observed, Saved, About you and appearance settings use real owner data, without needing a chat. New web chats show the pet centrally and conversations keep a small still pet outside the composer.

## Behavior and boundaries

- Per-owner/workspace persisted name, original colour/shape choices, animation/chat visibility and confirmed job/department, with revision conflicts, idempotent receipts and explicit retry of unknown writes. Current confirmed position reaches both actual context consumers as untrusted facts, never permissions.
- Authenticated cookie and paired APIs reuse encrypted private memory. Filtering precedes complete pagination, with owner/filter/version/source-bound cursors, source/history controls, correction to Saved, classification, deletion, erase-all, opt-out and personal retention. No admin/shared-row read authority.
- Shared shader/motion/fallback preserve original optics and touch interactions, bounded morph/resolution/frame rate, visibility/reduced-motion pausing and immediate static fallback updates. Removing memory refreshes derived appearance; stale native reads cannot overwrite acknowledged settings.
- Destructive actions stay in menus/privacy detail with confirmation. No fake production records, growth scores/helper prose, weather activation or Microsoft suggestions were added.

## Verification

Exact49 source hashes, context hashes, commands, durations and exit statuses are in [pet-pages-evidence.json](pet-pages-evidence.json). Base is `aff4af0d3c8592e4b1c2ec65f1ac0bec5986b091`. Full local reports/logs and selected screenshots are preserved in the durable evidence directory recorded there.

| Executed check | Result |
| --- | --- |
| Final20 affected Jest suites: profile/mobile/web, renderer/touch/lifecycle, routing, chat/composer/references and personal voice, plus actual server shell handler |266/266,39.92s |
| Eight production Node suites: pet storage/HTTP, memory store/HTTP/runtime/native I/O, voice HTTP/dispatch |155/155,30.50s; backend subject unchanged |
| Full `tsc --noEmit --incremental false` |Pass,29.53s |
| `node scripts/check-boundaries.mjs` |Pass,0.73s |
| `npm run admin:build` in exact source export |Pass,1.15s; existing chunk-size warning |
| `spec openspec --project . -- validate niar-246-work-pet --strict` |Pass |
| `spec openspec --project . -- validate --specs --strict` |27/27 pass |
| `npm run check` |Stops at inherited3 unresolved imports in historical attachment QA scripts; no whole-check green claim |

The three inherited failures are `docs/design/attachments-ui-2026-10-30/fix-r1/independent-closure/closure-probe.mjs` importing `/fix-r1/independent-closure/closure-parent.tsx`, and `review/{accessibility-checks,visual-checks}.mjs` importing a removed `/tmp/niaro-attachment-ui-tools/node_modules/playwright/index.mjs`.15 existing warnings remain. Those unrelated files/rules were not altered.

Two fresh-context read-only reviews cover initial46 plus the final12-path integration delta, with zero unresolved concrete findings. Six discovered correctness issues were repaired and independently closed; integration checks then caught and repaired the adapter boundary, incomplete isolated chat mocks, RAF fixture typing and direct shell routes. Actual route regression failed at `/pet=404`, then accepted four exact paths and refused four unknown paths. A controlled isolated shared-row privacy defect was detected by the real existing test and restored cleanly. These are bounded behavioral checks, not universal privacy or release certification.

Actual browser QA used the production AppShell/router/profile against synthetic intercepted HTTP: desktop/narrow, light/dark, EN/CS,320px/font200%, fallback, correction, appearance and conflict. A font-scaled switch overlap was reproduced and repaired with measured bounds. Installed Playwright was used because no Browser plugin was available; no dependency was installed. Actual Android App QA used RAM-only credentials and a real synthetic SQLite/HTTP fixture: Library/drawer entry, Saved memory, name save/keyboard and320dp/font2. Root rechecked final PawPrint Library entry and profile on the normal8087 preview after refreshing its fixture; device density/font/permissions and saved credential vault were preserved. Earlier device matrix predates the final renderer repairs; current component tests cover those repairs. No new iOS, physical screen-reader or GPU timing claim.

Public dev verification: `https://aa.f-tuma.dev/pet` and `/me/memory` return200, unknown `/pet/not-a-route` remains404, and public `/admin/app.js` SHA-256 matches the built exact source export. No private account was used to certify this public-shell check.

## Accepted intent restored in canonical sources

1. Proposal and design explicitly include the requested native and web centered profile delivery, removing the obsolete native-screen exclusion; future weather/Graph/growth work stays separate.
2. Work-pet delta adds native entry, no-chat web access, centered sections and display-preference scenarios, removing the obsolete permanent growth helper.
3. Tasks5.1 and5.3 describe and record the delivered bounded screens; renderer qualification5.2/5.4 and other incomplete tasks stay open.
4. UI-system order and design/task navigation glyph now specify the owner's latest standard PawPrint decision.

These changes restore explicit owner instructions, without introducing a new product decision or approval gate. The entire NIAR-246 change remains open. Paging materializes a complete owner snapshot before bounded response pages; it is not constant-memory DB keyset paging, and client response validation is not a streaming allocation bound. Weather, Graph suggestions, growth/greeting and full low-end-GPU/Storybook qualification remain outside this checkpoint.
