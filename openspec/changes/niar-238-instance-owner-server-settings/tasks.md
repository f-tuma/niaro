# Tasks (NIAR-238)

## 1. Instance organization

- [ ] 1.1 Add `apps/server-identity/instance.ts` (`agent_instance`, insert-only `record`, deterministic `backfill`, `isOwner`) and wire it into `IdentityService` start-up and lookups; verify new `tests/instance-owner.node.ts` (backfill of the earliest of two organizations, never changes after restart) — `node --import tsx --test tests/instance-owner.node.ts`. (Req: Instance organization)
- [ ] 1.2 Record the organization in `bootstrap()` inside its transaction for console and recovery setups; verify both setup paths in `tests/instance-owner.node.ts` and that `tests/identity.node.ts` still passes — `node --import tsx --test tests/instance-owner.node.ts tests/identity.node.ts`. (Req: Instance organization)
- [ ] 1.3 Add `instance` to `IdentityStateSchema` and `state()`, with the identifier only for instance owners; add the file to `test:identity` in `package.json`; verify state cases (owner, other organization's owner, recovery) — `node --import tsx --test tests/instance-owner.node.ts`. (Req: Instance owner in the identity state, Instance owners)

## 2. Server gates and audit

- [ ] 2.1 Add the `instanceOwner(req, organizationId)` helper and use it for every server-settings sub-path (read, save, export, import, diarizer); audit refused saves/imports as `denied` in the named organization; update `tests/server-settings.node.ts` (instance owner works; instance-organization admin, second organization's owner, wrong selector refused with `instance_owner_required`; diarizer not contacted; recovery `identity_account_required`) — `node --import tsx --test tests/server-settings.node.ts`. (Req: Server settings, Settings export and import, Server settings audit, Instance owners)
- [ ] 2.2 Gate plugin files and the inventory's `files.allowed` with the helper and audit refused saves; update `tests/plugin-files-http.node.ts` — `node --import tsx --test tests/plugin-files-http.node.ts`. (Req: Plugin files in the console)

## 3. Console (EN/CS)

- [ ] 3.1 Move `AccountProviders`, session and server facts from `Settings()` to a new Account page (`/admin/account`, account menu entry, `router.tsx`, console route pattern in `apps/server-admin/http.ts`, sign-in `returnPath` pattern in `service.ts`, `account-providers.tsx` return path); verify a jest case for the Account page incl. the recovery variant and that `/admin/account` reloads (`tests/admin-mcp-login.node.ts`-style HTTP check or a new case in `tests/server-settings.node.ts`). (Req: Account page, Console addresses)
- [ ] 3.2 Show Settings only to instance owners (navigation flag, shell filter), render the explanation for others, query server settings with `instance.organizationId`, map `instance_owner_required` in copy EN/CS; verify `npx jest --runInBand tests/web-server-settings.test.tsx`. (Req: Settings only for instance owners, Console navigation)
- [ ] 3.3 Replace the service checklist's Settings link with the "ask the server's owner" hint for non-owners and hide plugin file access in Built-in tools; verify `npx jest --runInBand tests/web-plugin-files.test.tsx` and a checklist case. (Req: Settings only for instance owners, Plugin files in the console)
- [ ] 3.4 Update `docs/guides/administration.md` (Settings for the server's owner, account linking under Account) and add the instance-organization decision to `docs/architecture.md` "Identity and credentials"; verify the documented paths match the routes.

## 4. Integration checks

- [ ] 4.1 `npm run admin:build && npm run check && npm run test:identity` pass.
- [ ] 4.2 Manual UI check on the dev server at 1440 px and 390 px, EN and CS: sidebar for an instance owner and for an administrator, `/admin/settings` both ways, `/admin/account` for account and recovery sessions, checklist hint; no horizontal scroll at 390 px.
- [ ] 4.3 `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-238-instance-owner-server-settings --strict` passes.

## Workflow follow-up

- Comment the outcome on NIAR-238 and use the key in commit messages.
- Open follow-up issues: installed connectors' shared host and custom images; public sign-in page listing every organization's methods; plugin load errors shown to every organization.
- Archive the change after review.
