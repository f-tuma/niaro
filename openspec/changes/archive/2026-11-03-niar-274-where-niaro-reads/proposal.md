# Proposal

Tracker: **NIAR-274**

## Why

A member cannot answer "what can Niaro read for me, and under whose account?" Connections lists only the services that act under the person's own sign-in; services the company runs on a shared account are invisible to members, although the assistant reads and changes things there for them every day. Neither list says when the person's assistant last read a service or last failed in it. This is gap KNOW-22 of the 2026-11-02 implementation spec (section 4.9, `where-niaro-reads`).

## What Changes

- New member projection `POST /admin/api/identity/catalog/member/services` (web) and `GET /v1/<workspace>/services` (app): every enabled service the person may use, each with whose account its reads and its changes run under (`company` or `own`), the reads and changes the person may run now (name and description only), their sign-in state when something runs under their account, and their own last successful read and last failure (time and failure kind) from their own receipts.
- Web Connections: the sign-ins stay first under **Your account**; a new read-only **Company account** group lists services that run only on the company account, with what the person may run there and their own last outcome. No sign-in, switches or menu on those rows.
- Web service page: a company-account service opens a read-only page (account badge, "Set by an administrator.", reads and changes the person may run, **Your activity**). A sign-in service shows whose account reads and changes use, and **Your activity** too; an own service shows **Your activity**.
- Phone: a shared `MemberServicesView` (`packages/ui-catalog`) with the same two groups, loaded through `ClientSession.readMemberServices` by `MemberServices` in `apps/mobile/ServiceConnection.tsx`. Mounting it in the app's settings is left to the `phone-chat-split` work on `apps/mobile/App.tsx`.
- EN and CS strings in their own copy blocks.

## Non-goals

- Signing in from the phone list (sign-in stays in chat cards and on the web).
- Other people's activity, counts across the team, service addresses, credentials, OAuth configuration, grants or policies.
- A receipt history; only the last read and the last failure.
- Changing who may run what.

## Risks

- Leaking configuration or other people's activity. Mitigation: the projection is built from a fixed list of fields, receipts are filtered by organization, workspace and the person's user id in SQL, only the failure kind leaves the receipt, and tests assert that addresses, keys, OAuth client data, inputs, results, provider messages and other people's times are absent.
- An administrator sees more than a member. Mitigation: the projection uses the person's own action rights (`allowed()`), so an owner sees what owners may run, still only with their own outcomes.
- Cost: one extra query per Connections open (a workspace/user index is added on `agent_service_invocation`).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `service-sign-in`: the Connections screen lists company-account services read-only and shows whose account reads and changes use, and the person's own last read and failure, on the web and in the phone component.
- `service-catalog`: the member service projection, its scope and what it never contains.

## Impact

- Protocol: new `packages/protocol/member-services.ts`.
- Server: new `apps/server-identity/member-services.ts`; `ServiceCatalogStore.serviceActivity()` and an index in `service-catalog.ts`; route in `catalog-controller.ts`; `IdentityService.mobileMemberServices()` in `service.ts`; app route in `apps/fixture-server/http.ts`.
- Client: `ClientSession.readMemberServices()` in `packages/client-core/session.ts`.
- Web app: new `app/member-services.tsx`, `app/member-services-copy.ts`; `app/connections-page.tsx`, `app/connection-detail.tsx`.
- Phone: new `packages/ui-catalog/MemberServicesView.tsx` (+ story, copy); `MemberServices` in `apps/mobile/ServiceConnection.tsx`.
- Tests: new `tests/member-services.node.ts` (in `test:identity`), new `tests/member-services-mobile.test.tsx`, `tests/web-personal-permissions.test.tsx`.
