# Proposal: Administrators control members' external AI apps (NIAR-237)

## Why

Any organization member can today give an external AI app (Claude, ChatGPT, …) access to a workspace: the issue API for manual MCP grants and the OAuth client registration API accept every member, and any member can link any registered OAuth app through the consent page. Administrators cannot switch this off, review it or even see members' access. The owner's decision: a member's own access is fine, but an administrator must control it the same way members' own services are controlled — a per-workspace policy `off` / `review` / `free` (`service-catalog` "Member-owned services policy").

## What Changes

- A per-workspace **external AI apps policy** for members: `off`, `review` (default, like own services) or `free`, chosen by owners and administrators on External AI apps (`/admin/mcp`). Owners and administrators are not subject to it.
- **Manual grants** issued by a member follow the policy: refused under `off`, stored `pending` under `review` (token still shown once, refused by `/mcp` until approved), active under `free`. **BREAKING** for API callers: under the default `review` a member's new grant does not work until approved.
- **OAuth apps** (registered clients) now belong to the organization of a workspace named at registration and are approved per workspace. A member's registration follows the policy; an owner's or administrator's is approved for that workspace. **BREAKING**: the registration API requires `workspaceId`.
- **OAuth consent** by a member is allowed only for an app approved in the chosen workspace (or any app of the organization under `free`); the first attempt on an unapproved app files a request for administrators, and the consent page says it is waiting.
- A **review queue** on `/admin/mcp` for the selected workspace: pending member grants and app requests with approve / reject (optional reason shown to the person); a list of members' active access and approved apps with revoke / withdraw.
- **Tightening**: switching to `off` revokes every member grant in the workspace (manual and OAuth, active and pending); `free` → `review` keeps what is already active.
- Members see their pending and rejected grants (with reason) on their account page.
- Overview **Needs attention** gains a row for external AI app requests waiting for a decision.
- New audit actions: `mcp.policy_changed`, `mcp.access_reviewed`, `mcp.app_registered`, `mcp.app_requested`, `mcp.app_reviewed`; OAuth links are now audited as `mcp.access_issued`; administrator revocations as `mcp.access_revoked`.
- English and Czech strings for every new page element, error and audit label.

## Non-goals

- A member-facing form to issue manual grants or register apps outside the administration (members today only link through the consent page; the issue API stays callable). Tracked as a follow-up.
- Opening the connector approval page (`/admin/mcp?approval=…`) to members; today members get "Administrators only" there. Observed gap, follow-up.
- Changing scopes, token formats, lifetimes, the 50-grant limit or the MCP tool surface.
- Organization-level (rather than workspace-level) policy.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-server`: manual grants, grant revalidation, OAuth client registration and consent follow a workspace policy; new requirements for the policy, review queue, administrator oversight, tightening, the person's request status and the activity log.
- `administration`: Needs attention lists external AI app requests waiting for a decision.

## Impact

- Server: `apps/server-identity/mcp-access.ts` (grant status, admin listing, review, bulk revoke), a new `apps/server-identity/mcp-policy.ts` (policy and per-workspace app approvals), `apps/server-mcp/oauth.ts` (client ownership, consent gate, consent-info availability), `apps/server-identity/service.ts` routes under `/admin/api/identity/mcp/…`.
- Protocol: new DTOs for the policy, review queue and member access; `packages/protocol/audit.ts` actions and details.
- Console: `apps/server-admin/web/mcp-page.tsx`, `mcp-oauth-client.tsx`, `mcp-consent.tsx`, `mcp-copy.ts`, `overview-page.tsx`/`lib/needs-attention.ts`, `audit-page.tsx`, web app `app/account-page.tsx`.
- Data: additive SQLite columns and tables; legacy OAuth clients keep working through a one-time approval backfill (see design).
- Risk: under the default `review`, members' new manual grants stop working until approved and members cannot link apps nobody approved for their workspace; mitigated by the backfill for existing apps, the visible queue and the Needs attention row.

> Note (2026-11-04, after NIAR-288/289): MCP no longer admits tasks, and apps may now arrive by their CIMD client ID without registering. The app approval in this change must also cover CIMD clients, keyed by their `client_id`.
