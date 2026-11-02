# Design

## Context

See proposal.md for the motivation. Today:

- Web Connections (`apps/server-admin/web/app/connections-page.tsx`) lists `…/catalog/oauth/list` (`personalSignIns()` in `apps/server-identity/service-oauth-controller.ts`): services whose sign-in requirement is `writes` or `all` and that the person may connect to or use, plus **My services** (`own-services.tsx`). Services that run only with the shared credential (`requiredFor: "none"`) never appear for a member. `connection-detail.tsx` shows one sign-in service with the person's own switches, or an own service.
- Receipts of service calls live in `agent_service_invocation` (`workspace_id`, `user_id`, JSON `data` with `serviceId`, `effect`, `status`, `completedAt`, `failure`). Every completion path sets `completedAt`.
- Authorization of an action for a person is `ServiceCatalogStore.allowed(action, actor)`: service gate, enabled flags, action grants, or the person's own choices for actions under their own account.
- The phone has no Connections screen. `apps/mobile/ServiceConnection.tsx` is the sign-in card shown in chat; settings (`ConnectionCard`, `VoiceSettings`) are composed in `apps/mobile/App.tsx`, which another change (`phone-chat-split`) is splitting.

## Goals / Non-Goals

**Goals:** one server-built, person-scoped projection for both clients; company-account services visible read-only; whose account reads and changes use; the person's own last read and last failure.

**Non-Goals:** sign-in from the phone list, receipt history, anyone else's activity, configuration of any kind.

## Decisions

### D1. One member projection, computed on the server

`memberServices(catalog, target, actor)` in `apps/server-identity/member-services.ts` returns `agent-member-services` (`MemberServiceList` in `packages/protocol/member-services.ts`):

- Source: the stored catalog (`inventory` with owner visibility, as `personalSignIns()` does), so a sign-in service whose actions the person switched off stays listed with nothing to run.
- Listed: enabled services that are the person's own active service, or have a personal sign-in entry for the person, or have at least one enabled action `allowed()` for the person. Disabled services, other people's own services and own services not yet `active` are dropped.
- Account per effect: own service → `own`/`own`; `requiredFor` `all` → `own`/`own`; `writes` → reads `company`, changes `own`; `none` → `company`/`company`.
- Actions: enabled and `allowed()` for the person, split by effect, with id, name and description only.
- `signIn`: for a sign-in service, the person's `connected | expired | disconnected`, or `not_ready` when the administrator has not finished OAuth; for an own service with OAuth, `connected | disconnected`; otherwise `null`.
- `lastRead` / `lastFailure`: from `ServiceCatalogStore.serviceActivity(org, workspace, userId)`: one grouped query over the person's receipts (`workspace_id`, `user_id` in the index, organization in the JSON), latest `completedAt` of `succeeded` reads and of `failed` calls of any effect, and the failure `kind` only. A write with an unknown outcome is not a failure; awaiting, running and rejected calls are ignored.
- The result is parsed by the strict schema before it leaves, so a new field cannot slip out unnoticed.

*Alternatives.* Extending `oauth/list` with company services (mixes a sign-in contract with a read-only listing, and the phone does not use it); computing accounts in the clients from catalog data (the clients would need policy and OAuth configuration they must not see).

### D2. Routes

- Web: `POST identity/catalog/member/services` in `CatalogController`, account session required (`identity_account_required`), the actor must be the session's user (`identity_forbidden`), run inside `serial`.
- App: `GET /v1/<workspace>/services` in `apps/fixture-server/http.ts` → `IdentityService.mobileMemberServices()` (app actor from the device credential). No query keys (`400`), GET only (`405`), `404` where identity is not configured. The route never starts work (ground rule 5).
- `ClientSession.readMemberServices()` returns `null` on `404/405` (older server), checks the workspace and throws `connection_failed` otherwise.

### D3. Web Connections

- The sign-in list keeps its rows and actions and gets the title **Your account** / **Tvůj účet**. A row whose reads use the company account says "Reads with company account"; every row shows the person's latest outcome: "Failed <time>" when the last failure is newer than the last read, otherwise "Read <time>".
- New group **Company account** / **Firemní účet** between the sign-ins and **My services**: services that are not own and have `signIn: null`. Rows link to the service page and show "2 reads, 1 change" and the latest outcome. No buttons.
- `/connections/:id` for such a service renders `CompanyServiceDetail`: account badge, the reads and changes the person may run (no switches, no approval selects, no `…`), "Set by an administrator." and **Your activity** (last read; last failure with its kind). It never asks for the person's permissions, which belong to sign-in services.
- Sign-in service pages show account badges ("Reading: company account", "Changes: your account" when they differ) and **Your activity**; own service pages show **Your activity**.
- The projection is a separate query; when it fails the sign-ins and own services render as before and the company group is absent.

### D4. Phone

`MemberServicesView` in `packages/ui-catalog` renders the two groups with `Group`/`ListRow`: icon tile, name, one meta line (sign-in state, account, counts), then "Last read: …" and "Last failure: … · kind" lines; loading, failed and empty rows. `MemberServices` in `apps/mobile/ServiceConnection.tsx` loads it per session (aborts on session change, ignores a stale answer, hides on a server without the route). `apps/mobile/App.tsx` is not touched in this change: mount `<MemberServices session={connection.session} language={language} />` in the settings stack after `ConnectionCard` (the `connection.session ? … : null` pattern used for `VoiceSettings`).

### Invariants

- Only the requesting person's receipts are read; other people's times never reach the response.
- No address, credential, OAuth client data, grant, policy, input, result or provider message is in the response.
- An administrator sees only what they may run themselves.

## Risks / Trade-offs

- [Owner-visibility inventory computes `connectedPeople` per sign-in service] → same cost as `oauth/list` today; data is discarded.
- [`MAX()` with a bare column in SQLite] → SQLite returns the bare column from the row holding the maximum; documented behavior.
- [Phone not mounted] → the component and data are ready and tested; mounting waits for `phone-chat-split`.

## Migration Plan

One `CREATE INDEX IF NOT EXISTS` on `agent_service_invocation(workspace_id, user_id)`; no data change. New protocol file; nothing existing changes shape. Rollback leaves an unused index.

## Verification

- `tests/member-services.node.ts`: listing and scope per role (member, other member, owner), account per `requiredFor`, own services, pending and other people's own services hidden, disabled service hidden, switched-off actions keep the service, own outcomes only (other person, other workspace), no secrets on the wire; web and app routes (`401`, `400`, `405`, same result on both, no dispatch).
- `tests/web-personal-permissions.test.tsx`: company group read-only, detail page read-only without permission reads, account badges and activity, sign-ins unaffected when the projection fails, EN/CS keys.
- `tests/member-services-mobile.test.tsx`: groups, EN/CS and plurals, states, session switching, `readMemberServices` workspace check and `404`.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:identity`, `npm run admin:build`, `spec openspec --project . -- validate --specs --strict`.
- Not verified here: screenshots on the dev server and the phone build.
