# Tasks (NIAR-237)

## 1. Policy store and grant status

- [ ] 1.1 Add `apps/server-identity/mcp-policy.ts` with `agent_mcp_policy` (default `review`, revision-checked save) and wire it into `IdentityService`; verify with new store cases in `tests/mcp-access.node.ts` (default, save, `mcp_policy_conflict`) — `node --import tsx --test tests/mcp-access.node.ts`. (Req: Members' external AI apps policy)
- [ ] 1.2 Add `status`, `revision`, `reviewed_by_user_id`, `reviewed_at`, `review_reason` to `agent_mcp_access` (guarded `ALTER TABLE`), make `create()` take a status, compute it in `issue()` from policy and role, count pending toward the limit, and refuse pending/rejected in `authenticateRow()` with `mcp_access_pending` / `mcp_access_rejected`; verify store tests for each policy × role and that existing rows stay active — `node --import tsx --test tests/mcp-access.node.ts`. (Req: Policy for manual grants, Manual access grants, Grant revalidation)
- [ ] 1.3 Add `listOwn`, `listWorkspace`, `review`, `revokeByAdministrator`, `revokeMembers` to `McpAccessStore` with digest-free DTOs; verify store tests (review conflict, idempotent revoke, OAuth tokens revoked with the grant) — `node --import tsx --test tests/mcp-access.node.ts`. (Req: Reviewing external AI app requests, Administrators oversee members' access, Tightening the policy)

## 2. OAuth apps per organization and workspace

- [ ] 2.1 Extend `agent_mcp_oauth_client` with `organization_id`, `registered_by_user_id`, `created_at`; require and authorize `workspaceId` on `/admin/api/identity/mcp/oauth/client/register` via `workspaceActor()`; return `state`; audit `mcp.app_registered` / `mcp.app_requested`; verify in `tests/mcp-oauth-http.node.ts` (member under off/review/free, admin approved, foreign workspace 403) — `node --import tsx --test tests/mcp-oauth-http.node.ts`. (Req: OAuth client registration, OAuth apps belong to an organization, Policy for app registration)
- [ ] 2.2 Add `agent_mcp_oauth_app` and the one-time legacy backfill; verify a legacy client stays linkable in existing workspaces after upgrade — `node --import tsx --test tests/mcp-oauth.node.ts`. (Req: Policy for OAuth links; design D7)
- [ ] 2.3 Add `linkable` and `availability` options to `createMcpOAuth`, call `linkable` before `issueGrant`, expose `mcp_external_apps_off` / `mcp_app_pending` / `mcp_app_rejected` to the page, add `workspaces[].state` to consent-info, audit OAuth links as `mcp.access_issued`; verify consent states, idempotent request filing, organization scoping and no grant/code on refusal — `node --import tsx --test tests/mcp-oauth.node.ts tests/mcp-oauth-http.node.ts`. (Req: Policy for OAuth links, Consent shows availability, OAuth authorization and consent, External AI app activity)

## 3. Administration API and audit

- [ ] 3.1 Add `packages/protocol/mcp-admin.ts` (`agent-mcp-admin/1`) and the audit actions/details in `packages/protocol/audit.ts`; verify `npm run typecheck`. (Req: External AI app activity)
- [ ] 3.2 Add `/admin/api/identity/mcp/admin/{list,policy,review,revoke}` with owner/admin checks, transactions and audit; switching to `off` revokes member grants in the same transaction; withdrawing an app revokes its member OAuth grants; verify in new `tests/mcp-policy-http.node.ts` (member 403, conflicts, reason, tightening stops admitted work before dispatch, audit entries contain no tokens) and add the file to `test:mcp` and `test:identity` in `package.json` — `node --import tsx --test tests/mcp-policy-http.node.ts`. (Req: Reviewing external AI app requests, Administrators oversee members' access, Tightening the policy)
- [ ] 3.3 Return status and reason of the person's own grants from `/admin/api/identity/account/access` via `listOwn`; verify in `tests/account-security.node.ts` — `node --import tsx --test tests/account-security.node.ts`. (Req: A person sees their requests)

## 4. Console and pages (EN/CS)

- [ ] 4.1 `mcp-page.tsx`: policy select, Requests, Members' access and Apps sections with revision-checked actions; strings in `mcp-copy.ts` EN/CS; verify `tests/web-mcp-policy.test.tsx` — `npx jest --runInBand tests/web-mcp-policy.test.tsx`. (Req: Members' external AI apps policy, Reviewing external AI app requests, Administrators oversee members' access)
- [ ] 4.2 `mcp-oauth-client.tsx` sends the selected workspace and shows the state; `mcp-consent.tsx` shows per-workspace state and the three error texts; verify jest cases in `tests/web-mcp-policy.test.tsx`. (Req: Consent shows availability, Policy for OAuth links)
- [ ] 4.3 Account page pending/rejected rows with reason and remove; audit labels for the new actions in `audit-page.tsx` EN/CS; verify `npx jest --runInBand tests/account-pages.test.ts`. (Req: A person sees their requests, External AI app activity)
- [ ] 4.4 Overview Needs attention row for waiting requests (`lib/needs-attention.ts`, `overview-page.tsx`), EN/CS; verify a jest case for the row order and link. (Req: Needs attention)
- [ ] 4.5 Update `docs/guides/administration.md` "External AI apps" (policy, requests, OAuth registration now per workspace) and the MCP bullet in `docs/architecture.md`; verify links resolve.

## 5. Integration checks

- [ ] 5.1 `npm run admin:build && npm run check && npm run test:mcp` pass.
- [ ] 5.2 Manual UI check on the dev server at 1440 px and 390 px, EN and CS: `/admin/mcp` (each section), `/admin/mcp/consent` in states available/request/pending/rejected/off, account page, Overview row; no horizontal scroll at 390 px.
- [ ] 5.3 `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-237-member-external-app-policy --strict` passes.

## Workflow follow-up

- Comment the outcome on NIAR-237 and use the key in commit messages.
- Open follow-ups: member "Connect an AI app" form on the account page; member access to connector approvals at `/admin/mcp?approval=…`.
- Archive the change after review.
