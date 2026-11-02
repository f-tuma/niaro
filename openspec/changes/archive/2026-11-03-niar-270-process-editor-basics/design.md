# Design

## Context

See proposal.md for the motivation. Today:

- The canvas (`apps/server-admin/web/process-editor-canvas.tsx`) keeps positions in `stored` state, seeded from `localStorage["niaro:process-canvas:<sessionId>"]` and written back on every change. Nothing reaches the server.
- A design session (`apps/server-identity/process-design-store.ts`, table `agent_process_design`, JSON `data`) holds the brief and candidate. `readReview` builds the review value and its `reviewDigest = processDigest(value)`; `accept` saves the candidate as the registry draft through `saveDraft` / `saveWorkspaceDraft`.
- The registry (`apps/server-identity/service-processes.ts`) stores the draft definition on `agent_service_process.draft`; `freezeDraft` appends an immutable `agent_service_process_version` row with `digest = processDigest({definition, sources})` and reuses the latest version when that digest is unchanged.
- "Changed since active" is `sameProcessDefinition(p.draft, latest.definition)` in the console (`process-console-page.tsx`) and `processDigest(process.draft) === processDigest(artifact.definition)` in `process-activation-store.ts` (`canActivate`, `decide`).
- Validation returns at most 20 `{code, path}` issues; paths address steps by index (`/steps/2/input/to`) or, for graph problems, by id (`/steps/check`). Review groups them by code with `issueTarget` labels; the canvas shows only local structural problems.
- The designer prompt is `designerInstructions` in `process-design-conversation.ts`; agent instructions are edited in one `Textarea` in `process-visual-editor.tsx`.

## Goals / Non-Goals

**Goals:** a server-held arrangement that never touches any digest; problems placed on their steps as fix sentences; a fixed four-part shape for agent instructions.

**Non-Goals:** designer access to layout, phone changes, version compare, new validation codes.

## Decisions

### D1. Layout lives beside the definition, in its own table

`ProcessLayoutSchema = {positions: Record<ProcessKey, {x, y}>, notes: [{id, x, y, text}]}` (integers within ±100,000; at most 64 positions, 20 notes, 280 characters each). The registry adds `agent_service_process_layout(process_id, version, layout)`: version `0` is the draft, every other row belongs to a frozen version and an `UPDATE` trigger refuses changes to it (as for versions).

- `saveOwnedDraft` takes an optional `layout`: left out, the draft's row stays; `null` deletes it; a value replaces it after dropping positions of steps the definition does not have.
- `freezeDraft` copies the draft row to the new version's row only when it inserts a version. A reused version keeps the arrangement it was frozen with.
- `getOwned` returns `layout` beside `draft` when there is one; `versionLayout` serves `GET …/catalog/processes?id&version` as a sibling `layout` of `version`.
- `ProcessVersion` (the artifact) does not change. Native testing, qualification and admission hash or compare whole artifacts (`process-native-test-admission.ts`), so the layout stays out of that object.

_Alternatives._ A column on the draft row and the version row (the version table's blanket `UPDATE` trigger and its column list in `INSERT … VALUES` make that a migration of an immutable table); a field inside the definition ignored by the digest (every digest call site would have to remember to strip it, which is the Arche mistake the research warns about).

### D2. The session holds the arrangement while it is edited

The canvas works on a design session, also for a new process that has no draft yet, so the session state gains `layout` and `layoutRevision`. `start` copies the draft's layout. `POST …/design/layout` with `{sessionId, layoutRevision, layout}`:

- refuses an accepted session (`409 process_design_conflict`) and runs `assertDesignContent` on the body (credential guard for notes);
- when `layoutRevision` is current, stores the layout and increments it; otherwise answers the stored state when the sent layout equals it (a lost response) and `409 process_design_layout_conflict` when it differs;
- never touches `revision`, `updatedAt`, acknowledgments or the command table, so the review digest and acceptance stay valid.

`readReview` adds `layout` and `layoutRevision` after computing `reviewDigest`. `accept` passes the session layout to the draft save; sessions from before this change have no `layout` key and keep the draft's arrangement.

The write is outside the browser's durable command outbox (`process-design-client.ts`): it is presentation only and idempotent by content, so a lost response is simply sent again with the next move. The visual editor saves one layout at a time, latest wins, and shows "The arrangement wasn't saved" when a write fails. The designer's tools do not expose the layout.

_Alternative._ Sending positions with `update` (the proposal command): every drag would advance the proposal revision and need **Save**, and would race designer turns.

### D3. Problems as sentences, placed by path

`lib/process-issues.ts` maps each `{code, path}` to `{stepId, sentence}` with fixed EN/CS templates: the step is found by index or id under `/steps`, the field is the last named key, and the template depends on code and area (`input`, `output`, `condition`, `actionId`, `modelId`, `capabilities`, `limits`, `memory`). The server stays the only source of the codes. The canvas gets `stepIssues` (a mark on the node's corner, its label and title are the sentences, a click selects the step) and the process-wide sentences in its existing problem list; Review lists every sentence instead of codes with labels. Server issues belong to the saved proposal, so the canvas shows them only while there are no local edits. At 20 issues a last line says only the first 20 are shown.

### D4. Agent instructions in four parts

`lib/agent-instructions.ts` parses and formats `Goal:`, `Steps:` (numbered), `Never:` (dashed) and `Done when:`; headings stay English in the stored text and are translated only in the apps. The editor shows four fields while the text has this shape or is empty, and the single field with **Use sections** otherwise. Review renders the parts as a list. The designer prompt (static, in the cached instructions) asks for this shape and repeats that instructions never change actions or approval. No schema change: the 4,000-character limit and server enforcement stay.

### Invariants

- No layout value is part of a definition, `ProcessVersion`, artifact digest, review digest or the draft/version comparison.
- A frozen version's layout is written once.
- Only the session owner writes a session's layout; only a manager's accept writes it to the draft.

## Risks / Trade-offs

- [Two tabs on one session] → conflict and re-read; positions are a convenience.
- [Layout-only accept bumps the registry revision] → an open activation dialog closes as stale; no new test is needed because the version digest is unchanged.
- [Notes visible to everyone who can read the process] → same audience as the draft; 280 characters; credential guard.

## Migration Plan

`CREATE TABLE IF NOT EXISTS` on start; older drafts have no row and open with the automatic layout. Arrangements saved in a browser's `localStorage` are not migrated (pilot; they reappear after the first move). Rollback leaves an unused table.

## Verification

- `tests/process-layout.node.ts`: a layout write keeps the review digest, revision and `updatedAt`; a layout-only accept keeps the draft definition digest equal to version 1's definition; freezing again returns version 1 with the same artifact digest and sources; lost-response replay and conflict; credential guard on notes; a changed definition freezes version 2 with the layout, positions of missing steps dropped, version layout immutable; accepted sessions refuse layout writes.
- `tests/process-editor-basics.test.ts`: issue sentences and placement (EN, CS, process-wide, 20-cut); instruction parse/format.
- `tests/process-editor-canvas.test.tsx`: saved arrangement opens, a moved step reports a layout, notes add/write/remove, issue mark selects the step.
- `tests/process-visual-editor.test.tsx`: server problems on steps, sectioned instructions saved as one text.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`, `npm run test:process-design`, `npm run test:processes`, `spec openspec --project . -- validate niar-270-process-editor-basics --strict`.
- Not verified here: a browser pass on the dev server (desktop and 390 px, light and dark).
