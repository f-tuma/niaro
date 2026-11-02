# Design

## Context

- `GET /admin/api/identity/loops` (`apps/server-identity/service.ts`) parses the strict `LoopQuery`, refuses members (`identity_forbidden`), checks `workspaceId` with `workspaceActor()` and calls `LoopsStore.page()`.
- `LoopsStore.page()` (`apps/server-identity/loops.ts`) selects supported turns of the organization (`agent-1`, `mastra-1` roots, `service-process-1`) by rowid, newest first, `LIMIT 51`, and maps each row through `summary()`: request and reply through `loopText()` (credential and URL redaction), and for process runs a `process` provenance only when the immutable pin (`agent_service_process_run` + version digest) corroborates the journal; the admitted start receipt adds command, admission and conversation ids.
- A process run's request is the process name (`text` of the journal), so administrators already read process names in the list. A chat turn's `conversationId` starts with `chat-hub-` for Overview items (`hubConversationId`). Start receipts carry `origin.type` `command` or `meeting`; the Processes page and Overview starts are `command` origins, told apart by the hub conversation prefix.

## Decisions

### D1. Filter on the summary the administrator reads

`page()` builds SQL pre-filters (workspace, status, `t.user_id`, journal `processId`/`version`, kind and conversation prefix for origin, `julianday()` of the start time for dates) and then applies `matches()` to each `summary()` result: status, actor, `process.processId`, `process.version`, `origin` and `startedAt`. A run passes only if the list would show the value it is filtered by. So a journal that claims a process without a corroborating pin is listed (unfiltered) without `process`, and never matched by process, version or origin.

*Alternative.* SQL only: faster, but it would select runs by journal fields the list deliberately hides.

### D2. Scanning and cursors

Rows are read in batches of 200 below the cursor until 51 matches or 5,000 rows. `nextBefore` is the 50th match's rowid when there are more matches, `null` when the rows are exhausted, and otherwise the last scanned rowid, so a page may hold fewer than 50 runs (even none) while older matches remain. The unfiltered list behaves exactly as before.

### D3. Origin

`LoopSummary.origin` (optional):

- `agent-1`/`mastra-1` turns: `hub` when `conversationId` starts with `chat-hub-`, otherwise `chat`.
- `service-process-1` runs: only with a corroborated pin and an admitted receipt that matches the run: `meeting` for a meeting origin, `hub` for a command origin in an Overview conversation, `processes` for another command origin. Otherwise no origin.

### D4. Choices

`GET /admin/api/identity/loops/filters?organizationId=…[&workspaceId=…]` (strict `LoopFiltersQuery`) shares the route's authority checks. `LoopsStore.filters()` reads the newest 5,000 process runs through `summary()` and keeps those with `process`: id, the newest run's request as name (at most 160 characters), versions newest first. People are the distinct actors of listed runs with their redacted names. Each list is sorted by name, then id, at most 100.

*Alternative.* Organization members for Person and the process registry for Process: the registry needs workspace management rights per process and members miss people who left; both could show choices the run list does not.

### D5. Web

`loops-page.tsx` keeps the `PageHeader` `toolbar` of `Select` filters (`docs`: `apps/server-admin/DESIGN.md`): Workspace, State, Process (when choices exist), Version (when a process is chosen), Person (when more than one), Started from, Date (Any time, Today, Last 7 days, Last 30 days, from the start of the local day). Changing a filter resets paging and the selection. An empty filtered page with `nextBefore` says "No matches in the newest runs" and keeps Older. Run details list Started from. Copy in `loops-copy.ts`, EN and CS, one NIAR-273 block.

## Verification

- `tests/loop-filters.node.ts`: each filter and a combination; uncorroborated provenance never matched, foreign organization never matched, choices only from listed runs; redaction of filtered pages and choices; stable cursors and continuation past 5,000 non-matching rows; strict query validation.
- `tests/loops.node.ts`: HTTP filters, choices endpoint authority (owner/admin allowed; member, operator, anonymous, foreign organization and foreign workspace refused), invalid filter queries.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`.

## Not verified

- The toolbar in a browser at 1440 px and 390 px, light and dark (no dev server in this change).
- Scan cost on a large production history.
