# Proposal: Server-wide settings only for the instance owner (NIAR-238)

## Why

Server-wide settings (`/admin/api/identity/server-settings`: name, time zone, meetings and diarizer, overview scheduler, trusted integration origins, web client origins, export/import) are read and written by owners and administrators of **any** organization on the server, and plugin code (`/admin/api/identity/plugin-files`, trusted code running in the server process for everyone) by the owner of **any** organization. The owner confirmed that this is wrong: only the person who owns the server should control what affects every organization.

Today the product cannot create a second organization (owner setup runs once, Better Auth's `allowUserToCreateOrganization` is off, raw organization endpoints are not exposed, invitations only add members to an existing organization), so the hole is latent: it opens with data from earlier versions, direct database edits or any future multi-organization feature. Closing it now also defines who "owns the server" for later work.

## What Changes

- The organization created by the first owner setup is recorded as the **instance organization** (also when setup ran from the recovery console); servers without a record adopt their earliest-created organization once at start. The record never changes through the console or API.
- **Instance owners** = people with the role `owner` in the instance organization.
- Server settings (read, save, export, import, diarizer status) are limited to instance owners; everyone else gets 403 `instance_owner_required`. **BREAKING**: administrators of the instance organization lose access to server settings (see design, open question).
- Plugin files (read and edit) are limited to instance owners; Plugins offers file editing only to them.
- The identity state reports whether the signed-in person is an instance owner; the console shows **Settings** only to instance owners and explains the restriction on a direct link.
- The personal parts of today's Settings page (linking a sign-in method to one's account, session information, read-only server facts) move to a new **Account** page (`/admin/account`) in the sidebar's account menu, so every console user keeps them.
- Refused server-setting changes are audited with outcome `denied`.
- The recovery key path keeps working: it can still run owner setup (which records the instance organization) and read the overview; it still cannot read organization data or server settings.

## Non-goals

- Supporting or creating several organizations per server.
- An "instance administrator" role or transferring instance ownership to another organization.
- Other server-wide surfaces found in the review (installed connectors' shared host resources and custom images, the public sign-in page listing every organization's sign-in methods, plugin load errors shown to every organization's administrators) — listed as follow-ups in design.md. The server-wide MCP OAuth client registry is handled by NIAR-237.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `identity-access`: the instance organization, instance owners and the instance flag in the identity state.
- `administration`: server settings and export/import for instance owners only, Settings visibility, the Account page, navigation and addresses, audit of refused changes.
- `plugins`: plugin files in the console for instance owners only.

## Impact

- Server: a new `apps/server-identity/instance.ts`, `IdentityService.bootstrap()`, `state()`, the server-settings and plugin-files routes and the plugins inventory in `apps/server-identity/service.ts`; `packages/protocol/identity.ts` (identity state).
- Console: `console-navigation.ts`, `console-shell.tsx`, `pages.tsx` (Settings split, new Account page), `router.tsx`, `server-settings.tsx`, `service-checklist.tsx`, `plugins-page.tsx`/`plugin-files-page.tsx`, copy files EN/CS.
- Data: one new table with a one-time backfill; no change to stored settings.
- Docs: `docs/guides/administration.md` (Settings and Account), `docs/architecture.md` (instance organization decision).
- Risk: administrators of the founding organization who used Settings lose it; mitigated by the clear 403 page saying that the server's owner manages these settings (without naming anyone from another organization) and the open question in design.
