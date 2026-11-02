# Design

## Context

See proposal.md for the motivation. Today:

- `ServiceProcessStore` (`apps/server-identity/service-processes.ts`) owns `agent_service_process` (`active_version`, `revision`, `archived_at`). `archive()` accepts only the actor's own personal process (`process_archive_forbidden` otherwise); `row()` makes an archived row 404 except for run provenance (`archived = true` in `assertExecutionScope` and `pinnedVersion`). `resolveRun()` calls `row(…, "execute")` without `archived`, so an archived process also stops its in-flight runs at their next step.
- Start paths all funnel through the store: the inventory SQL in `executionInventory()` (also behind `hubInventory()` in `hub.ts`, the chat `processOffers` in `service.ts` ~L3376 and the hub runner in `hub-runner.ts`); input preparation `executionArtifact()` (`process-input.ts`); intent issuance `ProcessStartStore` → `registry.activeRunVersion()` (`process-start-store.ts` L183); admission `pinRun()` (L461), which also calls `activeRunVersion()` for a new pin and `resolveRun()` for a replayed one. Continuation calls `resolveRun()` (`process-coordinator.ts` L136, `service-process-runtime.ts` L131/L262).
- `executionEntry()` (inventory readiness and the management `retestNeeded` flag) calls `activeRunVersion()` to decide `source_changed` vs `qualification_required`.
- HTTP: `handleServiceProcesses()` in `process-controller.ts` serves `/admin/api/identity/catalog/processes` (`/archive` is the model for the new route) behind `context.serial`, `context.transaction` and `context.validateRequest` (origin/CSRF).
- Audit: `changed()` writes `catalog.process_changed` with `processEvent` from the enum in `packages/protocol/audit.ts`; `audit-page.tsx` maps each event to a label in `apps/server-admin/web/i18n.ts`.
- Hub: `createHub()` in `hub.ts`: `cards()` projects items (with `sync()` from journals and `hubItemStale()`), `begin()` starts process refreshes after reading `hubInventory()`; `record()` stores runner failures. The web card text comes from `hubWidgetProblem()` (`app/hub-copy.ts`) → `processProblemKey()` (`app/process-problems.ts`) → `packages/i18n`.
- Console: `process-console-page.tsx` (shared by `/admin/processes/{id}`, `/admin/services/{serviceId}/processes/{processId}` and the web app's personal `/processes/{id}` with `personalOnly`), list rows in `service-process-overview.tsx` (`ProcessRows`), copy in `process-console-copy.ts`, archive client in `lib/process-archive.ts`.

## Goals / Non-Goals

**Goals:** one reversible, audited switch per company process that removes it from every start path and every offer, leaves history and in-flight runs intact, and is visible wherever the process or its widgets appear.

**Non-Goals:** deleting company processes; per-version retirement; cancelling in-flight runs; a mobile UI; changing personal-process archive.

## Decisions

### D1. Retirement is per process, stored as `retired_at`

A nullable `retired_at TEXT` on `agent_service_process`, added after the `archived_at` check with the same `PRAGMA table_info` + `ALTER TABLE … ADD COLUMN` pattern (the owner migration copies only fixed columns and runs first, so both shapes end up with the column). `active_version` is not touched.

*Alternatives.* (a) Per active version, i.e. clearing `active_version`: loses the pointer, and restoring would require a fresh activation, which needs a qualified test by the same person in an unchanged environment (`process-qualification` "Activation decision") — an administrator who did not qualify it could not bring it back. (b) Reuse `archived_at` for company processes: archive is irreversible from the apps and stops in-flight runs; it is a different promise. (c) A separate `retired` table: more joins for the one predicate every start path needs.

### D2. Retirement gates starts, not runs (in-flight runs finish)

The retired check belongs to *admission*, never to *continuation*:

- `executionInventory()` adds `AND retired_at IS NULL` to its SQL; this alone removes the process from the web/mobile inventory, meeting launcher, hub add (`hub_process_unavailable`) and chat `processOffers`.
- Split `activeRunVersion()` into a private readiness check (used by `executionEntry()` so `retestNeeded` and blocked reasons stay truthful for a retired process) and the public admission gate, which after the authority/source/qualification checks throws `409 process_retired` when `retired_at` is set. The order means only a person who could otherwise start the process learns that it is retired; others keep getting 404/`capability_denied` as today.
- `executionArtifact()` (form preparation) and the new-pin branch of `pinRun()` go through that public gate; `ProcessStartStore` intent issuance already calls it. `process_retired` joins `PROCESS_START_REJECTIONS` (`packages/protocol/process-start.ts`) so a rejected admission gets an immutable 422 receipt; the intent stays unused, so after a restore the same form can be started with a new command.
- `resolveRun()`, `pinnedVersion()`, `assertExecutionScope()` and the replay branch of `pinRun()` do not look at `retired_at`.

Why let runs finish: runs are already decoupled from the pointer (`Version pins`: activation and rollback do not affect a waiting run), retirement is reversible and frequently just "obsolete", and stopping mid-run leaves partial effects (an earlier write succeeded, the rest never happens) that are harder to reason about than a bounded finish. Every run has an absolute deadline from admission (`maxDurationMs`, server cap 600,000 ms by default), waiting runs continue only on the person's explicit decision, and nothing implicit resumes work (`No implicit execution`). Unknown receipts are untouched. The emergency stop for a harmful process remains what it is today: disabling the action or service, which stops runs at their next step through the authority recheck.

*Alternative.* Stop runs at their next server step like archive. Rejected as the default (see Open questions); it would also make restore unable to revive anything, since those runs end terminally.

### D3. Management stays open while retired

`row()` ignores `retired_at`, so `saveDraft`, `freezeDraft`, tests, `activate()` and rollback keep working and keep the process retired. This supports "retire the broken process, fix, test, activate, then restore" without a window in which the broken version is startable. The activation review (`packages/protocol/process-activation.ts` `ProcessActivationReviewSchema`, built in `process-activation-store.ts`) gains `retired: z.literal(true).optional()` so the decision dialog can say the decision takes effect after a restore.

*Alternative.* Refuse activation/rollback while retired: forces restore first, exposing the old version to new starts.

### D4. API shape: `POST …/processes/retirement`

`WorkspaceProcessRetirementSchema = CatalogTarget.extend({profile: "agent-service-processes/2", type: "retire" | "restore", id, revision})`; result `WorkspaceProcessRetirementResultSchema = {profile, id, revision, retiredAt: iso | null}`. Handled in `handleServiceProcesses()` next to `/archive`, inside `context.serial` → `authorized()` (actor from the session, `validateRequest()` for origin/CSRF) → `context.transaction`. Store method `setRetired(actor, id, revision, retired)`:

1. `row(actor, id, "manage")` → members 403 (`identity_forbidden` via `manager()`), someone else's personal process 403 `process_personal_read_only` / 404 as today, archived 404.
2. Personal owner → `403 process_retire_forbidden` (checked before the revision, mirroring `archive()`).
3. Already in the requested state → return current state, no write, no audit (replay-safe without a receipt table; the outcome is a state, not an effect).
4. Otherwise `check(row, revision)` → `process_conflict`; update `retired_at`, `revision+1`, `updated_at`; `changed(actor, …, "retired" | "restored")` in the same `atomic()` savepoint so an audit failure rolls back.

Summaries gain `retiredAt: z.iso.datetime().optional()` in `ProcessSummarySchema` (inherited by the workspace summaries), filled by `summary()`.

*Alternatives.* Extending `/archive` with more `type`s mixes an irreversible owner action with a reversible admin one under one name; a generic `/command` type would need the `workspace` profile split that `/command` already has. A dedicated path keeps the authority rule and the audit event obvious.

### D5. Hub: project the retired state, never start

- New store read `retiredProcessIds(actor, processIds): Set<string>`: one `SELECT id … WHERE organization_id=? AND workspace_id=? AND owner_type<>'user' AND retired_at IS NOT NULL AND archived_at IS NULL AND id IN (…)`. Passive, no authority beyond workspace scope (the person added the widget when they could start it; telling them it was retired reveals nothing new).
- `HubDependencies.processes` Pick gains `retiredProcessIds`; test fakes stub it with an empty set.
- `cards()`: for a `process` item in the set whose synced result is not `running`/`waiting`, project `{status: "failed", error: "process_retired", startedAt: result?.startedAt ?? item.createdAt, producedAt: result?.producedAt ?? null, output: result?.output, conversationId}` and `stale: false`. Projection only; nothing is written on read. A waiting run keeps "Waiting for you" until it settles (D2).
- `begin()`: retired items are filtered out of `due` before `hubInventory()`; for an explicit refresh they get a stored failed result `process_retired` that keeps the previous output. The runner (`hub-runner.ts`) is never called for them. A race (retired between `begin()` and the runner) ends as `hub_process_unavailable` and the next read projects `process_retired`.
- Web card: `processProblemKey()` maps `process_retired` → i18n key `process_retired`; `hubWidgetProblem()` gives administrators the fix link to `/admin/processes/{id}` (label "Restore" / "Obnovit"); the card hides its refresh control when the error is `process_retired` and keeps Remove in `…`.

### D6. Console UI (EN/CS)

Per `docs/ui-system.md` (detail page: destructive actions only in `…`; one primary action) and `apps/server-admin/DESIGN.md` (`ConfirmAction`, `StatusBadge`):

- `process-console-page.tsx`: when `!personalOnly`, the process is not personal and the person can manage it: `…` menu item **Retire** (`variant="destructive"`, `Archive`/`CircleOff` icon) → `ConfirmAction` titled "Retire this process?" / "Vyřadit proces?" with one line "People can't start it any more. Runs already started finish." / "Nikdo ho už nespustí. Rozběhnuté běhy doběhnou.". While retired: header `StatusBadge tone="neutral"` **Retired** / **Vyřazený**, and the primary action becomes **Restore** / **Obnovit** (no confirmation; reversible, non-destructive); the activation dialog shows an `Alert` "Takes effect after you restore it." when `review.retired`.
- `ProcessRows` in `service-process-overview.tsx`: Retired badge on the row.
- New client `apps/server-admin/web/lib/process-retirement.ts` modelled on `lib/process-archive.ts`; the console stores nothing locally (the command is replay-safe by state, see D4) and on an unknown outcome re-reads the process before offering the action again.
- Audit labels `auditProcessRetired` / `auditProcessRestored` in `apps/server-admin/web/i18n.ts` (EN "Process retired"/"Process restored", CS "Proces vyřazen"/"Proces obnoven"), mapped in `audit-page.tsx`.
- `packages/i18n`: `process_retired` EN "An administrator retired this process." CS "Správce tento proces vyřadil."; used by the web launcher, offer cards, meeting launcher, the hub card and the mobile app's existing error display.

### Invariants

- No path that admits a new run (inventory, form, intent, pin) accepts a retired process; no path that continues an admitted run consults retirement.
- Retire/restore never changes `active_version`, versions, tests, qualifications, pins, receipts or journals.
- Every state change commits with its audit entry or not at all; replays write nothing.
- Personal processes are never retired; company processes are never archived (unchanged).

## Risks / Trade-offs

- [Admin expects in-flight writes to stop] → confirmation copy says runs finish; runs are deadline-bounded; disabling the action remains the stop. Recorded as an open question.
- [Retired processes keep blocking service removal] → stated in the spec; permanent deletion is a follow-up.
- [Inventory fingerprint changes on retire/restore] → clients already handle `process_inventory_changed` by reloading.
- [Hub read cost] → one indexed `IN (…)` query per hub read (≤ hub item limit ids).
- [Strict schemas] → `retiredAt` and `retired` are optional fields; only bundled clients parse them; pilot stage accepts old-build breakage.

## Migration Plan

Additive column, default NULL (nothing retired). Rollback of the server build: an older build ignores `retired_at`, so retired processes become startable again — acceptable for a pilot, noted in the release notes. No data rewrite.

## Verification

- Store and HTTP: extend `tests/personal-processes.node.ts` (it already exercises archive via `h.registry` and HTTP) or add `tests/process-retirement.node.ts` to `test:processes` and `test:identity`: retire/restore authority (owner, admin, member 403, personal `process_retire_forbidden`, archived 404, stale `process_conflict`, replay no-op), audit rollback on audit failure, inventory omission and fingerprint change, `executionArtifact` `process_retired`, start rejection 422 receipt and correction after restore, waiting run approved after retirement continues once (reuse the approval harness of `tests/process-execution.node.ts` / `tests/process-coordinator.node.ts`), `retestNeeded` still computed for a retired process, activate while retired keeps it retired, `catalog_service_in_use` with a retired process.
- Activation review: `tests/process-activation.node.ts` asserts `retired: true`.
- Hub: `tests/hub.node.ts` / `tests/hub-http.node.ts`: retired widget projected failed with last output, not stale, explicit refresh starts nothing (runner fake not called), waiting run keeps waiting, restore makes it due.
- Client: `tests/process-retirement-client.node.ts` modelled on `tests/process-archive-client.node.ts`; `tests/admin-service-process-overview.node.ts` Retired badge; `tests/web-processes-account.test.tsx` or the hub copy test for the `process_retired` text.
- Commands: `npm run test:processes`, `npm run test:identity`, `npm run typecheck`, `npm run lint`, `npm run admin:build`, `npm run check`, `spec openspec --project . -- validate niar-242-retire-company-process --strict`.
- UI: `/admin/processes/{id}` (retire confirm, Retired badge, Restore) and the overview widget, at 1440 px and 390 px, EN and CS, light and dark, on the dev server.

## Open questions for the owner

1. **In-flight runs on retirement.** Decision taken: they finish (D2). If you prefer a hard stop, retirement would also make `resolveRun()` refuse retired processes (runs end at their next server step like archive, unknown outcomes stay unknown) and restore would not revive them; specs `Runs admitted before retirement` and `Version pins` would change.
2. **Restore confirmation.** Decision taken: no confirmation (non-destructive). Add one if restoring should name the version that becomes startable.
3. **Deleting retired company processes.** Not in this change; a follow-up could let administrators archive a process that has been retired, which would also release `catalog_service_in_use`.
