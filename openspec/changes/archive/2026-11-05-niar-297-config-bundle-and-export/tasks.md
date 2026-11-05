# Tasks

## 1. Configuration bundle

- [x] 1.1 Protocol `packages/protocol/config-bundle.ts` (envelope, preview, import, results) and audit action `config.bundle_imported`. (Configuration bundle export)
- [x] 1.2 Section registry, name references and one typed exporter per section, routing isolated in `sections/routing.ts`. (Bundle references by name)
- [x] 1.3 Preview as a rolled back apply, revision digest, confirmed import with audit and policy epoch. (Configuration import preview, Confirmed configuration import, What an import creates)
- [x] 1.4 Console page `/admin/settings/configuration`, Settings link, EN and CS. (Configuration page)
- [x] 1.5 `tests/config-bundle.node.ts` (no secrets, round trip into a fresh server, conflicts, idempotent re-import, audit) and `tests/web-config-bundle.test.tsx`.

## 2. Member exports

- [x] 2.1 Chat export endpoint and chat `…` menu items. (Exporting a chat, Chat export contents)
- [x] 2.2 Memory export endpoint and About you and memory page menus. (Exporting own memory, Memory export in the web app)
- [x] 2.3 `tests/member-export.node.ts`, chat header and pet page jest tests.
- [ ] 2.4 Phone share sheet (follow-up: needs a bearer route on `/v1`).
