# Design: Members' external AI apps policy (NIAR-237)

## Context

See proposal.md for the motivation. Current code, as read:

- **Manual grants** — `apps/server-identity/mcp-access.ts` `McpAccessStore` (table `agent_mcp_access`): `issue()` binds the session user, checks the workspace membership (`membership()`: owner/admin of the organization or a member with `agent_workspace_member`), the 30-day TTL and 50 active grants per server, and returns the token once. No status: every grant is usable at once. `authenticateRow()` revalidates expiry, revocation, server, original member row and workspace access on every MCP use and before dispatch (`authenticateGrant()`, used by `IdentityService.mcpRuntimeAccess()`).
- **Routes** — `apps/server-identity/service.ts`, inside `IdentityService.handle()` after the recovery guard (`if (operator) throw identity_account_required`): `/admin/api/identity/mcp/access/{issue,list,revoke,connector-call,connector-reject}` (any signed-in session) and `/admin/api/identity/mcp/oauth/client/register` (any account that is a member of *any* organization). These paths go through `options.identity.handle()` in `apps/server-admin/http.ts` and are **not** covered by the console's `admin_forbidden` gate, so a member can call them directly although the console page itself shows members "Administrators only".
- **OAuth** — `apps/server-mcp/oauth.ts` `createMcpOAuth()`: `registerClient()` creates a Better Auth OAuth client plus a row in `agent_mcp_oauth_client(client_id, name, redirect_uris)` — **server-wide, no owner, no organization**. Consent (`/admin/auth/mcp/oauth/consent`) checks the signed query, then calls `options.issueGrant` (= `McpAccessStore.issue`) for the chosen workspace and records `agent_mcp_oauth_binding(grant_id, user_id, session_id, client_id, expires_at)`. Consent info (`/admin/auth/mcp/oauth/consent-info`) returns client, scopes and redirect; the page (`apps/server-admin/web/mcp-consent.tsx`) offers the person's workspaces from the identity state. OAuth links are not audited today.
- **Console** — `apps/server-admin/web/mcp-page.tsx` (own grants of the signed-in administrator for the selected workspace, connector approval, task view) and `mcp-oauth-client.tsx` (register form, no list of clients). The web app's account page (`apps/server-admin/web/app/account-page.tsx`, data from `AccountSecurity.access()` → `McpAccessStore.listOwnActive()`) lists a person's active grants with revoke.
- **Pattern to follow** — members' own services: `service-catalog.ts` `personalServicesPolicy()` (table `agent_catalog_personal`, default `review`), enforcement in `catalog-controller.ts` (`catalog_personal_services_off`), review via `reviewPersonalService` audited `catalog.personal_service_reviewed`, UI `OwnServicesPolicy`/`OwnServiceReview` in `catalog-services.tsx`, Needs attention row in `overview-page.tsx` + `lib/needs-attention.ts`.

## Goals / Non-Goals

**Goals:** one per-workspace policy governing every way a member gets MCP access (manual issue, app registration, OAuth link); administrators see and decide requests and can revoke members' access; tightening has defined effects; everything audited; no hole through the identity API paths that bypass the console gate.

**Non-Goals:** see proposal (member issuance UI, member access to connector approvals, organization-level policy). No change to MCP transport, scopes, tool lists or token formats.

## Decisions

### D1. Policy lives per workspace, default `review`

New table `agent_mcp_policy(workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE, policy TEXT NOT NULL CHECK(policy IN ('off','review','free')), revision INTEGER NOT NULL) STRICT` in a new module `apps/server-identity/mcp-policy.ts` (`McpPolicyStore`). No row = `review`, revision 0.

- Per workspace because grants and OAuth links are per workspace and the own-services policy is per workspace; administrators already think per workspace on `/admin/mcp` (workspace switcher).
- Default `review` matches own services and the owner's "admin approves" intent. Existing grants are not touched by the default (D6), so the default only affects new requests.
- *Alternatives:* organization-level policy (simpler, but inconsistent with own services and with workspace-scoped grants); reuse `agent_catalog_personal` with a third column (couples two features' migrations and revisions; rejected).

### D2. The policy binds members only

The role is read from the current `member` row at the moment of the request (`McpAccessStore.membership()` already returns it). Owners and administrators are the reviewers and can grant themselves anything anyway, so their grants are `active`, their registrations `approved` and their consents allowed. A member promoted later keeps their pending grant pending (they can approve it themselves, which is audited). *Alternative:* policy for everyone (own-services style) — rejected, it would block administrators from setting up the apps they approve.

### D3. Review unit: the grant for manual access, the app per workspace for OAuth

- **Manual grant** — `agent_mcp_access` gets `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','pending','rejected'))`, `revision INTEGER NOT NULL DEFAULT 0`, `reviewed_by_user_id TEXT`, `reviewed_at INTEGER`, `review_reason TEXT` (added with `ALTER TABLE … ADD COLUMN` after a `PRAGMA table_info` check, the pattern used in `apps/server-hosting/manager.ts`). `create()` takes the status computed from policy + role. The token is still returned once at issue; `authenticateRow()` refuses `pending` with 403 `mcp_access_pending` and `rejected` with 403 `mcp_access_rejected` (after the revoked/expired check, so revoked stays 401). Expiry counts from issue; approval does not extend it.
  - *Alternative:* issue the token only after approval — needs a second "fetch once" channel for the secret and a member page that does not exist; rejected.
- **OAuth app** — per-link (per-grant) review is unworkable: an OAuth grant lives at most one hour and is bound to the browser session, so it would usually expire before anyone approves it. Instead the app is approved per workspace, once; afterwards members link it freely. New table `agent_mcp_oauth_app(client_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('approved','pending','rejected')), requested_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL, requested_at INTEGER NOT NULL, reviewed_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL, reviewed_at INTEGER, reason TEXT, revision INTEGER NOT NULL, PRIMARY KEY(client_id, workspace_id)) STRICT` in `mcp-policy.ts`.

### D4. OAuth apps get an organization

`agent_mcp_oauth_client` gains `organization_id TEXT`, `registered_by_user_id TEXT`, `created_at INTEGER` (nullable: legacy rows). The register route requires `workspaceId`, authorizes it with `workspaceActor()` (replacing today's "member of any organization" check), and `registerClient()` stores the organization. Consent and consent-info reject workspaces outside the app's organization. Legacy clients (`organization_id IS NULL`) remain linkable in any organization, but only where an approval row allows it (D7). This also closes the cross-organization exposure of the server-wide client registry noted for NIAR-238.

### D5. Gate placement

- `McpAccessStore.create(userId, issuer, input, status)`; `issue()` gets a `policy(workspaceId)` callback in the store options (wired from `McpPolicyStore`) and computes `off`→throw 403 `mcp_external_apps_off`, `review`→`pending`, `free`→`active` for role `member`; owners/admins → `active`. The 50-grant count includes `pending`.
- OAuth: `createMcpOAuth` options gain `linkable({ userId, clientId, workspaceId }) → void` (throws `IdentityError` with `mcp_external_apps_off` / `mcp_app_pending` / `mcp_app_rejected`, filing the pending row and `mcp.app_requested` audit on first refusal) and `availability({ userId, clientId }) → { workspaceId, state }[]`. `mcpOAuthConsent` calls `linkable` before `issueGrant`; the existing `catch` that maps every `IdentityError` to `access_denied` is narrowed so these three codes reach the page (`{ error: code }`, HTTP 403). `mcpOAuthConsentInfo` adds `workspaces: [{ id, state }]`. Filing the pending row inside a refused consent is a deliberate write; it is idempotent on `(client_id, workspace_id)`.
- Grant revalidation needs no new hook: `authenticateRow()` already runs for every MCP request and before each dispatch, so status checks there cover admitted work too.

### D6. Tightening

`McpPolicyStore.save(workspaceId, policy, revision, actor)` runs inside `IdentityService.transaction()`: on `off` it calls `McpAccessStore.revokeMembers(workspaceId)` = `UPDATE agent_mcp_access SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL AND member_id IN (SELECT id FROM member WHERE role='member')` plus `revokeOAuthTokens` for those grants, returning the count for the audit detail. Admitted work stops through revalidation (no policy-epoch bump needed; the grant itself is the authority). `free`→`review` changes nothing stored. App states stay so switching back restores approvals but not grants. *Alternative:* re-review all active grants on `free`→`review` — surprising for members and administrators; rejected (matches own services, where active services stay active).

Withdrawing an app approval sets the row `rejected` and revokes member grants in that workspace whose `agent_mcp_oauth_binding.client_id` is the app.

### D7. Legacy data

- Existing `agent_mcp_access` rows get `status='active'` by the column default — nothing stops working.
- When `agent_mcp_oauth_app` is first created and `agent_mcp_oauth_client` exists, insert `approved` rows (requested_by/reviewed_by NULL, `reason` NULL) for every legacy client × every existing workspace, in one transaction, once. This preserves today's behaviour (any member could link any registered client) and makes the apps visible to administrators, who can withdraw them. Runs when the OAuth provider is configured; the marker is the table's creation.

### D8. API and DTOs

New routes in `service.ts`, all `POST`, body JSON with `organizationId` and `workspaceId` (selectors), authorized by `workspaceActor()` and an explicit `owner`/`admin` role check (403 `identity_forbidden` for members — needed because these paths bypass the console gate):

- `/admin/api/identity/mcp/admin/list` → `{ policy, revision, requests: { grants[], apps[] }, access[], apps[] }` (profile `agent-mcp-admin/1`, new `packages/protocol/mcp-admin.ts`). Grants: id, person (name, email), label, mode/scopes, createdAt, expiresAt, lastUsedAt, status, revision, kind `manual|oauth`, app name for OAuth. No token digests.
- `/admin/api/identity/mcp/admin/policy` `{ policy, revision }` → 409 `mcp_policy_conflict` on stale revision.
- `/admin/api/identity/mcp/admin/review` `{ kind: 'grant'|'app', id, revision, decision: 'approve'|'reject'|'withdraw', reason? (≤500) }` → 409 `mcp_review_conflict`; `withdraw` only for approved apps.
- `/admin/api/identity/mcp/admin/revoke` `{ grantId }` (idempotent).
- `/admin/api/identity/mcp/oauth/client/register` body gains `workspaceId`; response gains `state`.
- `AccountSecurity.access()` uses a new `McpAccessStore.listOwn(userId)` (active + pending + rejected, unrevoked, unexpired) with `status` and `reason`; `revokeOwn` already handles removal.

### D9. Audit

`packages/protocol/audit.ts`: add `mcp.policy_changed`, `mcp.access_reviewed`, `mcp.app_registered`, `mcp.app_requested`, `mcp.app_reviewed`; `AuditDetails` gains `externalAppsPolicy`, `previousExternalAppsPolicy` (enum), `accessStatus` (`active|pending|rejected`), `decision` (`approved|rejected|withdrawn`), `revokedCount` (int ≥ 0), `oauth` (boolean). Reasons are not copied into the audit (free text). `mcp.access_issued` is now also appended for OAuth consent (actor = consenting person, source `console`). Labels EN/CS in `apps/server-admin/web/audit-page.tsx` copy.

### D10. Console and pages (EN/CS)

- `mcp-page.tsx`: for owners/admins, above the own-grants card: a policy select ("Members' AI apps: Off / Administrator approves / Allowed" — CS "AI aplikace členů: Vypnuto / Schvaluje správce / Povoleno"), a **Requests** section (approve / reject with reason, the `OwnServiceReview` pattern), **Members' access** (revoke with `ConfirmAction`) and **Apps** (state badge, withdraw/approve). Revision-checked editing per the administration requirement.
- `mcp-oauth-client.tsx`: sends the selected workspace; shows state `pending` text after a member-role registration (not reachable from the console for members today, but the API answer is typed).
- `mcp-consent.tsx`: per-workspace state from consent-info; a disabled accept with explanation for `pending`, `rejected`, `off`; an explicit "Request access" wording for `request`; error texts for the three codes.
- `app/account-page.tsx`: status badge and reason for pending/rejected grants.
- `overview-page.tsx` + `lib/needs-attention.ts`: one row "N external AI app requests waiting" linking to `/admin/mcp`, inserted after the own-services row.
- All strings in `mcp-copy.ts`, `audit-page.tsx` copy, account-page copy, `overview` copy — EN and CS.

## Risks / Trade-offs

- [Members' new manual grants silently wait under the default] → the issue response returns `status: "pending"`, the account page and the API say so, and Needs attention surfaces requests.
- [A consent refusal writes a pending app row] → idempotent per app/workspace, audited, bounded by apps registered in the organization (refuse filing when an organization already has 100 pending app requests: `identity_limit`).
- [Legacy apps approved everywhere, including organizations that never used them] → visible on every workspace's Apps list for withdrawal; in practice a pilot server has one organization (see NIAR-238).
- [Pending tokens exist in clients] → unusable until approval, digest-only storage unchanged, removable by the person or an administrator.
- [Narrowing the consent error mapping could leak why a link failed] → only the three policy codes are exposed, to the signed-in person about their own workspace.
- [Admitted work after `off`] → covered by the existing revalidation before dispatch; tests assert it.

## Migration Plan

Additive columns and tables, created at startup; the legacy app backfill runs once. Rollback: older code ignores the new columns/tables; grants created `pending` would become usable on an older build (acceptable in pilot; note in release notes).

## Verification

- Store tests (`tests/mcp-access.node.ts`): status on issue by role and policy, pending/rejected authentication codes, limit counts pending, `listOwn`, `revokeMembers`.
- OAuth tests (`tests/mcp-oauth.node.ts`, `tests/mcp-oauth-http.node.ts`): registration requires and authorizes `workspaceId`, organization scoping, consent states and errors, consent-info availability, request filing idempotency, withdraw revokes OAuth tokens, legacy backfill.
- New `tests/mcp-policy-http.node.ts` (added to `test:mcp` and `test:identity`): policy default/conflict/member 403, admin queue approve/reject with reason, admin revoke, `off` revokes and stops admitted work before dispatch (reuse the `mcp-http` fixtures), owners/admins exempt, audit entries without secrets.
- Web tests (jest): `tests/web-mcp-policy.test.tsx` (policy select, queue, members' access, consent states EN/CS), `tests/account-pages.test.ts` (pending/rejected rows).
- `npm run check`, `npm run test:mcp`, `npm run admin:build`, `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-237-member-external-app-policy --strict`.
- UI check on the dev server (tmux `niaro-dev`) at 1440 px and 390 px in EN and CS: `/admin/mcp` (policy, requests, members' access, apps), `/admin/mcp/consent` in each state, account page, Overview row; no horizontal scroll at 390 px.

## Open questions for the owner

- **Default `review`** (decided): matches own services; existing grants and legacy apps keep working. Say if you prefer `free` for continuity.
- **Owners/admins exempt** (decided): the policy governs members only.
- **OAuth reviewed per app and workspace, not per link** (decided): per-link review cannot work with one-hour, session-bound OAuth access.
- **Member issuance UI** (deferred): should members get a "Connect an AI app" form on their account page so `review` of manual grants is reachable without the API? Follow-up issue suggested, together with opening connector approvals (`/admin/mcp?approval=…`) to members, which today show "Administrators only".
