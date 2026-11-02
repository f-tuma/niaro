# Tasks

Requirement references are to this change's `service-sign-in` and `service-catalog` deltas.

## 1. Protocol and server

- [x] 1.1 Add `packages/protocol/member-services.ts` (`MemberServiceList`, strict). (Member service projection)
- [x] 1.2 Add `ServiceCatalogStore.serviceActivity()` and the `agent_service_invocation(workspace_id, user_id)` index; add `apps/server-identity/member-services.ts`. (Member service projection)
- [x] 1.3 Route `member/services` in `CatalogController` (account session, own actor) and `GET /v1/<workspace>/services` through `IdentityService.mobileMemberServices()`; add `tests/member-services.node.ts` to `test:identity`; verify with `node --import tsx --test tests/member-services.node.ts tests/connections.node.ts tests/service-catalog.node.ts`. (Member service projection)

## 2. Clients

- [x] 2.1 `ClientSession.readMemberServices()` (null on an older server, workspace check). (Connections screen)
- [x] 2.2 Web: **Your account** and **Company account** groups on Connections, read-only company service page, account badges and **Your activity** on service pages, EN/CS copy in `app/member-services-copy.ts`; verify with `npx jest tests/web-personal-permissions.test.tsx`. (Connections screen)
- [x] 2.3 Phone: `MemberServicesView` (+ story, EN/CS copy) in `packages/ui-catalog` and `MemberServices` in `apps/mobile/ServiceConnection.tsx`; verify with `npx jest tests/member-services-mobile.test.tsx`. (Connections screen)
- [ ] 2.4 Mount `MemberServices` in the phone settings in `apps/mobile/App.tsx` once `phone-chat-split` has landed. (Connections screen)

## 3. Integration

- [x] 3.1 Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:identity`, `npm run admin:build`, `spec openspec --project . -- validate --specs --strict`.
- [ ] 3.2 Screenshots of Connections and a company service page on the dev server at 1440 px and 390 px, EN and CS, light and dark; phone screenshot after 2.4.

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
