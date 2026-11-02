# Proposal

Tracker: **NIAR-242**

## Why

A company process (owned by the workspace or by a service) cannot be taken out of use today: `POST …/processes/archive` refuses it with `process_archive_forbidden`, and the only lever an administrator has is breaking its dependencies (disabling an action or a service), which also breaks other work and says nothing to the people who use the process. Administrators need a clean, reversible way to stop offering an obsolete or misbehaving company process and to bring it back later.

## What Changes

- An owner or administrator **retires** a company process (workspace or service owner) and can **restore** it. Retirement is a property of the process, not of a version: the active version pointer, versions, tests, qualifications and run history are kept unchanged.
- A retired process is not in the start inventory (web app, mobile app, meeting launcher), is not offered in chat (`process_offer`), cannot have an input form prepared and cannot be started (`process_retired`, a new deterministic start rejection).
- Runs admitted before retirement keep their version pin and finish on the person's explicit approvals and answers within their own absolute deadline; retirement neither cancels nor resumes anything and never touches an unknown outcome.
- While retired the process stays manageable: drafts, freezing, tests, activation and rollback work as before, and none of them restores the process. Restoring makes the then-active version startable again under all the usual gates (qualification, sources, authority); nothing is retested or started by restoring.
- New registry command `POST /admin/api/identity/catalog/processes/retirement` (profile `agent-service-processes/2`, `type: "retire" | "restore"`, `id`, `revision`), revision-checked, idempotent when the process is already in the requested state, audited as `catalog.process_changed` with `processEvent` `retired` / `restored`.
- Management lists and reads carry `retiredAt` for retired processes; `/admin/processes`, the service process list and the process page show a **Retired** status. The process page offers **Retire** in its `…` menu behind a confirmation and **Restore** as the header's primary action while retired (EN/CS).
- Overview (hub) process widgets backed by a retired process show "Retired" with their last good output, start no refresh on open, manual refresh, chat `hub_refresh` or edits, and refresh again by their policy after a restore. A run already waiting keeps showing "Waiting for you".
- Personal processes are unchanged: their owner still deletes them with archive; retiring one is refused with `process_retire_forbidden`.

## Non-goals

- Permanently deleting a company process (a later change can add archive for retired company processes).
- Retiring single versions (activation and rollback already choose the version).
- Stopping runs that were admitted before retirement; the emergency stop stays disabling the service action or service, which stops runs at their next step.
- Changes to the mobile app: it reads the start inventory and shared start rejection strings, so it needs no new screen.

## Risks

- An administrator may expect retirement to stop in-flight writes. Mitigation: the confirmation says started runs finish; runs are bounded by their absolute deadline (`maxDurationMs`, capped at 600,000 ms by default).
- A retired process still references its services, so it still blocks removing them (`catalog_service_in_use`). This is deliberate (it can be restored) and stated in the specs.
- New strict-schema fields (`retiredAt`) break old management clients parsing strictly; only the bundled administration and web app read them, and pilot-stage breakage of old builds is accepted.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `process-definitions`: retire/restore command, authority, effects, management state, audit, administration UI, service removal with a retired process.
- `process-execution`: retired processes leave the inventory and offers, form preparation and starts are refused with `process_retired`, admitted runs keep their pin through retirement.
- `process-qualification`: tests, activation and rollback of a retired process are allowed and do not restore it.
- `hub`: process widgets of a retired process show a retired state and start no refresh.

## Impact

- Server: `apps/server-identity/service-processes.ts` (`retired_at` column, `retire`/`restore`, inventory and admission gates, `retiredProcessIds` for the hub), `apps/server-identity/process-controller.ts` (route), `apps/server-identity/hub.ts` (card projection and `begin`).
- Protocol: `packages/protocol/service-processes.ts` (`retiredAt`, retirement command/result schemas), `packages/protocol/process-start.ts` (`process_retired` rejection), `packages/protocol/audit.ts` (`retired`, `restored`).
- Clients: `apps/server-admin/web/process-console-page.tsx`, `service-process-overview.tsx`, `process-console-copy.ts`, `audit-page.tsx`, new `lib/process-retirement.ts`; web app `app/process-problems.ts`, `app/hub-copy.ts` and the hub card; `packages/i18n` (EN/CS `process_retired`).
- Storage: one nullable column on `agent_service_process`, added like `archived_at`; existing data stays readable.
