# Proposal

Tracker: **NIAR-273** (from the NIAR-265 inspiration research: `admin-run-filters`, idea PROC-14).

## Why

"All failed runs of *Weekly pipeline* v3 this week" is the first support question, and Runs (`/admin/loops`) cannot answer it: the list filters only by workspace and status, 50 runs per page, newest first.

## What Changes

- `GET /admin/api/identity/loops` accepts `processId`, `version` (only with `processId`), `actorId`, `origin` (`chat`, `hub`, `meeting`, `processes`), `from` (inclusive) and `to` (exclusive), next to `workspaceId`, `status` and `before`. All filters run on the server.
- Every filter is applied to the run summary the administrator reads, after redaction and provenance checks. A run whose process is not corroborated by its pinned version is never selected by process, version or origin.
- Run summaries carry `origin` when the run's own record shows it: a chat turn (`chat`, or `hub` for an Overview chat), or a process run whose admitted start receipt names a meeting, an Overview item or the Processes page.
- New `GET /admin/api/identity/loops/filters` returns the process and person choices, built only from runs the administrator can already list, with the same roles and workspace check.
- Runs gets Process, Version, Person, Started from and Date filters in the page header `toolbar`, next to Workspace and State. Run details show Started from. EN and CS.

## Non-goals

- A `field:value` search box or saved views.
- Filters on cost, model or service.
- Changing who may read runs, what a run summary or detail shows (beyond `origin`), or redaction itself.
- Member-facing run history.

## Risks

- Personal process names must not leak. Mitigation: choices and matches come only from summaries the list already shows (the run's request is the process name), with `loopText` redaction; uncorroborated provenance never matches.
- A sparse filter could scan a long history. Mitigation: SQL pre-filters narrow the rows, and a page reads at most 5,000 rows; when it stops early it still returns `nextBefore`, and the page offers Older.
- `origin` is new information in the summary. It is derived from data the summary already exposes (conversation id, admitted start receipt), never from content.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `administration`: Run list filters and filter choices.

## Impact

- Protocol: `packages/protocol/loops.ts` (`LoopOrigin`, `LoopQuery` filters, `origin` in `LoopSummarySchema`, `LoopFiltersQuery`, `LoopFiltersSchema`).
- Server: `apps/server-identity/loops.ts` (`page()`, new `filters()`), `apps/server-identity/service.ts` (route).
- Admin web: `apps/server-admin/web/loops-page.tsx`, `loops-copy.ts`.
- Tests: new `tests/loop-filters.node.ts`; `tests/loops.node.ts`.
- Mobile: none.
