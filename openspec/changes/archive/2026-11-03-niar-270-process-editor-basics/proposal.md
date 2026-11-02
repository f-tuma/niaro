# Proposal

Tracker: **NIAR-270** (research NIAR-265, ideas PROC-01, PROC-02, PROC-12)

## Why

- The canvas keeps where a person put the steps only in that browser's `localStorage` (`LAYOUT_PREFIX` in `apps/server-admin/web/process-editor-canvas.tsx`). Another browser, another administrator or the person on a new laptop sees the automatic layout again, and there is nowhere to leave a short note next to a step.
- Validation problems are a list of codes with JSON pointers grouped by code (`issueTarget` in `process-design-review.tsx`). A member has to work out which step is meant and what to do.
- Agent instructions are free text up to 4,000 characters. A manager cannot check them line by line, and the designer rewrites the whole text for a one-line fix.

## What Changes

- **Arrangement and notes on the server.** Step positions and up to 20 short notes (each at most 280 characters) are saved with the design session as you move a step or write a note, carried to the draft when the proposal is accepted, and copied to each version when it is frozen. They are stored beside the definition, never in it: not in the artifact digest, not in the review digest, not in the "changed since active" comparison. Moving a step of an active process therefore never asks for a new test. The canvas leaves `localStorage`.
- **Problems on their steps.** Each validation problem is shown as one sentence that names the step and the fix ("_Find contacts_: give “name” a value from the process input or an earlier step."). The step on the canvas carries a mark that selects it; problems of the whole process (limits, graph) are listed on the canvas; Review lists the same sentences. When the server stops at 20 problems, the list says so.
- **Agent instructions in four parts.** The designer writes every agent's instructions as **Goal**, numbered **Steps**, **Never** and **Done when**. The canvas edits them as four fields and saves one text; Review shows them as a list. Instructions in any other shape stay valid free text, with **Use sections** to split them.
- Protocol: `ProcessLayoutSchema` in `packages/protocol/service-processes.ts`; optional `layout` on process records and version reads; `DesignLayoutSchema`, `DesignLayoutResultSchema` and optional `layout`/`layoutRevision` on the design review in `packages/protocol/process-design.ts`; new `POST …/catalog/processes/design/layout`.

## Non-goals

- Drawing the designer's changes on the canvas (PROC-04) and step sentences (PROC-03).
- Letting the designer model read or write notes or positions: its five tools stay as they are.
- A version compare view or run graph that uses version layouts (PROC-19): the data is kept for them.
- The phone: it has no canvas. The phone proposal card showing Goal and Done when is left to the phone work after `App.tsx` is split.
- Changing validation codes or the 20-issue cap.

## Risks

- If a layout ever entered a digest, moving a box would force a retest. Mitigation: layout is a separate table and a field added to the review after its digest is computed; `tests/process-layout.node.ts` pins every digest.
- Notes are free text a person writes. Mitigation: 280 characters, 20 notes, the designer credential guard, and the designer model never sees them.
- Two people arranging the same session in two tabs: the second write over a newer arrangement is refused (`process_design_layout_conflict`); the canvas reads the session again. Arrangement is a convenience, so nothing else is blocked.
- A layout-only acceptance saves the draft and advances its registry revision; an activation dialog opened before it must be reopened (no new test is needed).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `process-definitions`: canvas layout stored beside drafts and versions, outside every digest.
- `process-design`: saving the arrangement in a session, problems shown on their steps, sectioned agent instructions.

## Impact

- Server: `apps/server-identity/service-processes.ts` (layout table, draft save, freeze copy, reads), `process-controller.ts` (version read), `process-design-store.ts` (session layout, review, accept), `process-design-controller.ts` (`/layout`), `process-design-conversation.ts` (designer prompt).
- Web: `process-editor-canvas.tsx`, `process-visual-editor.tsx`, `process-design-review.tsx`, new `lib/process-issues.ts` and `lib/agent-instructions.ts`, `lib/process-design-client.ts`, `lib/process-design-api.ts`, copy files; version response schemas in `lib/process-console-client.ts`, `lib/service-process-overview.ts`, `app/personal-processes.ts`.
- Tests: new `tests/process-layout.node.ts` and `tests/process-editor-basics.test.ts`; `tests/process-editor-canvas.test.tsx`, `tests/process-visual-editor.test.tsx`.
- Mobile: none.
