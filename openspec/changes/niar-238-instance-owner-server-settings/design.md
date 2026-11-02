# Design: Server-wide settings only for the instance owner (NIAR-238)

## Context

See proposal.md for the motivation. Current code, as read:

- **Server settings route** — `apps/server-identity/service.ts`, `IdentityService.handle()`, branch `url.pathname.startsWith("/admin/api/identity/server-settings")` (sub-paths `""` GET/POST, `/export` GET, `/import` POST, `/diarizer` GET). Authorization: `this.actor(req, organizationId)` (member row of the *named* organization) and `actor.role === "member"` → 403 `identity_forbidden`. So any owner/admin of any organization reads and writes the single `agent_server_settings` row (`apps/server-identity/server-settings.ts`). Saves audit `server.settings_changed`/`server.settings_imported` into the named organization. The branch sits after the recovery guard (`if (operator) throw identity_account_required`), so recovery sessions are already refused.
- **Plugin files** — same file, `/admin/api/identity/plugin-files`: `this.actor(req, organizationId)` and `actor.role !== "owner"` → 403. The plugins inventory (`/admin/api/identity/plugins`) returns `files.allowed: actor.role === "owner" && !!this.pluginFiles`. Plugin code runs in the server process for every organization.
- **Can a second organization exist?** `IdentityService.bootstrap()` creates the account, the organization (`auth.api.createOrganization`) and a first workspace, only while no user exists (`needsSetup()`), else 409 `identity_already_initialized`. Better Auth's `organization({ allowUserToCreateOrganization: false })`. The `/admin/auth/*` passthrough only allows `sign-in/email` and `sign-out` (plus the MCP OAuth endpoints). Invitations add `member` rows to the inviting workspace's organization. `createAccount` answers 410. Conclusion: the product cannot create a second organization; one can exist only from earlier versions' data, direct database edits or tests (several node tests create extra organizations through `auth.api.createOrganization`). The code otherwise treats organizations as plural (identity state lists them, every API takes an `organizationId` selector).
- **Console** — `apps/server-admin/web/console-navigation.ts` (static list, Settings group: Activity log, Settings), `console-shell.tsx` (renders all items), `pages.tsx` `Settings()` (personal `AccountProviders`, session facts, read-only server facts, and `ServerSettingsSections` for any owner/admin of the *selected* organization), `server-settings.tsx` (queries with the selected `organizationId`), `service-checklist.tsx` (a `settings` fix links to `/settings`). Identity state: `IdentityStateSchema` in `packages/protocol/identity.ts`, built by `IdentityService.state()`.
- **Recovery** — `apps/server-admin/http.ts` lets a recovery session into `/admin/api/identity*`; `bootstrap()` accepts it (`source: "recovery"`) and the console ends recovery afterwards. `GET /admin/api/overview` shows the server name to any session.

## Goals / Non-Goals

**Goals:** a reliable, durable definition of who owns the server; server settings and plugin code gated by it on the server; console visibility matching the server rule; personal settings still reachable for everyone; recovery unchanged; audit of refusals.

**Non-Goals:** multi-organization support, instance-ownership transfer, an instance-admin role, the follow-up surfaces below.

## Decisions

### D1. Instance organization recorded explicitly, backfilled once

New `apps/server-identity/instance.ts` (`InstanceStore`) with `agent_instance(id INTEGER PRIMARY KEY CHECK(id=1), organization_id TEXT NOT NULL REFERENCES organization(id), recorded_at INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('setup','backfill'))) STRICT`.

- `bootstrap()` calls `record(org.id, "setup")` inside its existing `this.transaction()`, so console and recovery setups both record it atomically with the organization.
- Backfill: when no row exists and at least one organization does, record the earliest-created one (`organization."createdAt"` parsed in JS — Better Auth may store it as ISO text or epoch depending on adapter — ties by `id`), `source='backfill'`, once. Run at service start after Better Auth migrations, and lazily inside the identity queue on first lookup (covers tests that create organizations after start). Log `instance_organization_recorded` (organization id and source only) to the operator log.
- `record()` is insert-only; nothing updates it. Organizations cannot be deleted through the product, so the foreign key needs no cascade.
- *Alternatives:* (a) infer on every request from the earliest `createdAt` — no durable decision, silently changes if data is edited or restored inconsistently; (b) infer from the first `organization.created` audit entry — the audit log is metadata for people, not authority; (c) an instance-admin flag per user — needs its own management UI and recovery story; (d) owners of *any* organization — the current bug. The explicit record plus a deterministic backfill gives a stable answer for existing servers and a crisp one for new servers.

### D2. Instance owners = owners of the instance organization

`InstanceStore.isOwner(userId)` = `SELECT 1 FROM member WHERE "userId"=? AND "organizationId"=<instance> AND role='owner'`, re-read on every request (authority is never cached). The last-owner rule (`identity_last_owner`) guarantees at least one instance owner exists, so no recovery-key escape hatch is needed.

- Owners only, not administrators: server settings carry security boundaries for every organization (web client origins decide which browser origins may call the API with credentials; integration origins open private-network and plain-HTTP reach for every organization's services; meeting retention deletes everyone's audio) and plugin code runs in-process. That is the same trust level as plugin code, which is already owner-only. *Alternative:* owners and administrators of the instance organization — keeps today's behaviour for single-organization pilots; offered as an open question because it is a one-line rule change.

### D3. Server gate

A helper `IdentityService.instanceOwner(req, organizationId)`: no session → 401 `identity_unauthorized`; the selector must equal the instance organization and the person must be an instance owner, else 403 `instance_owner_required`. The selector stays in requests (and in `ServerSettingsViewSchema.organizationId`) so audit entries keep an organization and existing clients only change the value they send; it is never authorization.

- Server settings branch: replace `this.actor()`+role with the helper for all sub-paths, including `/diarizer` (which makes an outbound request) and `/export`.
- Refused `POST` (save/import): if the person is a member of the named organization, append `server.settings_changed`/`server.settings_imported` with outcome `denied` there (no details beyond revision numbers). Reads are not audited (consistent with other reads).
- Plugin files: the helper replaces `actor.role !== "owner"`; refused saves are audited as `server.plugin_changed` with `pluginEvent: "refused"`, outcome `denied`, in the named organization when the person belongs to it. Plugins inventory: `files.allowed = isOwner(userId) && !!this.pluginFiles`.
- Recovery sessions keep hitting the existing guard first (`identity_account_required`).

### D4. Identity state

`IdentityStateSchema` gains `instance: z.strictObject({ owner: z.boolean(), organizationId: IdentityId.optional() })`; `organizationId` only when `owner` is true, so other organizations do not learn it. Recovery: `{ owner: false }`.

### D5. Console: Settings for instance owners, personal parts to Account

- `console-navigation.ts`: `NavItem` gets `instanceOwner?: true`, set on Settings; `console-shell.tsx` filters with the identity state. Account menu (sidebar footer) gets **Account** linking to `/account`.
- `pages.tsx`: new `AccountPage` with `AccountProviders`, the session section and read-only server facts (moved from `Settings()`); `Settings()` renders `ServerSettingsSections` with `instance.organizationId`, or an explanatory empty state ("Server settings are managed by the server's owner." / "Nastavení serveru spravuje vlastník serveru.") for everyone else. `router.tsx` adds `/account` to the console routes; `/admin/account` must be added to the console route pattern in `apps/server-admin/http.ts` (so reloads work) and to the sign-in-method `returnPath` pattern in `service.ts` (the auth-providers sign-in start), because account linking now returns to Account instead of Settings (`account-providers.tsx`).
- `service-checklist.tsx`: for non-owners the `settings` fix renders a hint ("Ask the server's owner to allow this address.") instead of a link.
- `apps/server-admin/web/lib/api.ts` error mapping and copy: `instance_owner_required` in EN/CS.
- *Alternative:* keep the Settings entry for everyone and hide only the server sections — rejected because the brief asks for no Settings entry for others and a page titled Settings that cannot change settings is confusing; the personal pieces are account matters anyway.

### D6. Other server-wide surfaces (reviewed)

| Surface | Scope today | Decision |
| --- | --- | --- |
| Server settings incl. meetings, diarizer, scheduler, origins, export/import | any org's owner/admin | **Included** |
| Plugin files (trusted in-process code) | any org's owner | **Included** |
| MCP OAuth client registry (`agent_mcp_oauth_client`) | server-wide, any member | Handled by NIAR-237 (clients get an organization) |
| Installed connectors (`agent_hosted_server`) | rows per organization, but one host: server-wide cap of 8 servers, ports, custom npm packages/container images on the host | **Follow-up**: per-organization quota and custom definitions only for instance owners (or operator `allowCustom`) |
| Sign-in methods (`agent_auth_provider`) | per organization, but `AuthProviderStore.publicChoices()` without an organization lists every organization's enabled methods on the public sign-in page | **Follow-up**: show only the instance organization's methods (or none) on the generic sign-in page |
| Plugin load failures | reported to owners/admins of every organization (directory and reason) | **Follow-up**: show load details only to instance owners, others see "not available" |
| AI providers, models, usage limits, built-in tool enablement, skills, processes, people | per organization or workspace | No change |
| Overview server name | readable by any session | No change (intended) |

## Risks / Trade-offs

- [Administrators of the founding organization lose Settings] → explanatory page and checklist hint; open question below; one-line change if the owner prefers owners+admins.
- [Backfill picks the wrong organization on a server with legacy multi-organization data] → deterministic earliest-created rule, operator log line, documented; such data does not arise from the product. A wrong pick can only be corrected in the database (documented in the deployment guide note).
- [Clients still send the selected organization] → the console switches to `instance.organizationId`; API callers get a clear 403 naming `instance_owner_required`.
- [Moving account linking changes a documented path] → docs updated; the old Settings URL still exists for owners.

## Migration Plan

Table created at start, backfilled once; no change to `agent_server_settings`. Rollback: older code ignores the table and reopens settings to all owners/admins (the old behaviour).

## Verification

- `tests/server-settings.node.ts`: update — the admin of the instance organization now gets 403; owner works; add a second organization (via `auth.api.createOrganization` in the test, as other node tests do) whose owner gets 403 on read/save/export/import/diarizer and a denied audit entry in their organization; instance owner naming the second organization gets 403; recovery session `identity_account_required`.
- `tests/plugin-files-http.node.ts`: second organization's owner refused and audited; inventory `files.allowed` false for them.
- New `tests/instance-owner.node.ts` (added to `test:identity`): setup records the organization (account and recovery setup), backfill picks the earliest of two organizations and never changes, promotion to owner takes effect on the next request, identity state flag and identifier exposure.
- Web (jest): `tests/web-server-settings.test.tsx` (non-owner sees the explanation and no Settings nav item; instance owner sees sections and uses the instance organization id), a case for the Account page (links, recovery variant), `tests/web-plugin-files.test.tsx` (no file access for non-owners).
- `npm run admin:build && npm run check && npm run test:identity`; `node scripts/smoke/run.mjs` if the smoke journey reads Settings.
- UI check on the dev server at 1440 px and 390 px in EN and CS: sidebar for owner and non-owner, `/admin/settings` both ways, `/admin/account` for account and recovery sessions, service checklist hint.
- `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-238-instance-owner-server-settings --strict`.

## Open questions for the owner

- **Owners only** (decided): administrators of the instance organization lose server settings. Say if they should keep them (owners and admins of the instance organization).
- **Backfill rule** (decided): earliest-created organization. Only relevant for servers carrying multi-organization data from earlier versions.
- **Follow-ups** (deferred): installed connectors' shared host and custom images, the public sign-in page listing every organization's methods, plugin load errors shown to all organizations — suggest one NIAR issue each.
