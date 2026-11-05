# Proposal

Tracker: **NIAR-297**

## Why

Only server settings can be exported today (`niaro-server-settings`), plus one installed connector's definition at a time. Moving a pilot setup to another server, or keeping a copy of it, means retyping providers, models, model choice, usage limits, services and actions, skills and processes. Members cannot take a chat, or what the assistant remembers about them, with them (gap analysis 2026-11-05, section 3.8).

## What Changes

- **Configuration bundle** (`niaro-config-bundle` version 1): owners and administrators export the organization, or one workspace, as JSON without keys, tokens, sign-ins or grants to one person. Each section has its own typed exporter in a registry: server settings, AI providers (`keyRequired: true`), models, installed connectors (their definition export), and per workspace roles, services and actions (grants by role name, approval settings), model choice, usage limits with prices, plugin settings, company skills with files and company/service process drafts. References are by name, never by id.
- **Import** with a preview: the bundle is applied in a rolled back transaction and the result per section (added, changed, unchanged, not imported with a reason, needs a key) is shown. The confirmed import must name the preview's revision, applies in one transaction, writes only what differs (a second import changes nothing), never removes anything, never overwrites a key or sends one to another address, and is audited as `config.bundle_imported`.
- Console page **Configuration** at `/admin/settings/configuration`, linked from Settings, in English and Czech.
- **Chat export** from the chat's `…` menu as Markdown or JSON: visible messages only, generated UI as a note, attachments as names.
- **Memory export** from the About you page and `/me/memory`: the person's own memories and observations, decrypted for them.
- Downloads are plain authenticated GETs with `Content-Disposition: attachment`.

## Non-goals

- Secrets of any kind in a file, or importing them.
- Creating workspaces or people from a bundle; removing what a bundle leaves out.
- Freezing, testing or activating imported processes (a person's decision on each server).
- Members' own services, personal skills and personal processes in a bundle.
- A phone share sheet for exports (the phone uses bearer tokens on `/v1`; follow-up).
- Importing chats from other assistants.

## Capabilities

### Modified Capabilities

- `administration`: configuration bundle export, preview, confirmed import and the Configuration page.
- `chat`: exporting a chat and what an export holds.
- `memory`: exporting one's own memory and where the app offers it.

## Impact

- Protocol: new `packages/protocol/config-bundle.ts`; audit action `config.bundle_imported` and detail `changed`.
- Server: new `apps/server-identity/config-bundle/` (registry, references, sections, HTTP) and `apps/server-identity/member-export.ts`; small additions to `service-catalog.ts` (key-free reads, imported service and action saves) and `service.ts` (routes, body limit).
- Console: `config-bundle-page.tsx`, `config-bundle-copy.ts`, route, Settings link, audit label.
- Web app: chat menu and memory menus.
- Tests: `tests/config-bundle.node.ts`, `tests/member-export.node.ts`, `tests/web-config-bundle.test.tsx`, additions to the settings, chat header and pet page tests.
