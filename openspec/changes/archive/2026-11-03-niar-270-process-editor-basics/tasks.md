# Tasks

Requirement references are to this change's `process-definitions` and `process-design` deltas.

## 1. Layout beside drafts and versions

- [x] 1.1 Add `ProcessLayoutSchema` and optional `layout` on process records to `packages/protocol/service-processes.ts`. (Canvas layout)
- [x] 1.2 Add the `agent_service_process_layout` table, draft save, freeze copy, `getOwned` and `versionLayout` to `ServiceProcessStore`; serve `layout` beside a version read in `process-controller.ts`. (Canvas layout)
- [x] 1.3 `tests/process-layout.node.ts`: a layout change keeps the review digest, the draft definition digest, the artifact digest and the "changed since active" comparison equal; version layouts are immutable; verify with `node --import tsx --test tests/process-layout.node.ts`. (Canvas layout, Layout outside every digest, Saving the arrangement)

## 2. Arrangement in the design session

- [x] 2.1 `DesignLayoutSchema`, `DesignLayoutResultSchema`, review `layout`/`layoutRevision`; `ProcessDesignStore.layout` with replay and conflict; review fields added after the digest; accept carries the layout; `POST …/design/layout`. (Saving the arrangement, Arrangement replay and conflicts)
- [x] 2.2 Canvas reads `layout` and reports moves, tidy and notes through `onLayoutChange`; `localStorage` removed; visual editor saves one layout at a time through `ProcessDesignClient.saveLayout`; verify with `npx jest tests/process-editor-canvas.test.tsx`. (Saving the arrangement)

## 3. Problems on their steps

- [x] 3.1 `lib/process-issues.ts` with EN/CS sentences; canvas step marks; process-wide sentences on the canvas; Review lists sentences; verify with `npx jest tests/process-editor-basics.test.ts tests/process-visual-editor.test.tsx`. (Problems on the steps they concern)

## 4. Agent instructions in four parts

- [x] 4.1 Designer prompt asks for Goal, Steps, Never, Done when; `lib/agent-instructions.ts`; four editor fields with **Use sections**; Review list; verify with `npx jest tests/process-editor-basics.test.ts tests/process-visual-editor.test.tsx`. (Agent instructions in four parts)

## 5. Integration

- [x] 5.1 `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`, `npm run test:process-design`, `npm run test:processes`, `spec openspec --project . -- validate niar-270-process-editor-basics --strict`.
- [ ] 5.2 Browser pass on the dev server: move a step and add a note, reload in another browser, see the same arrangement; a binding problem marked on its step; an agent's four fields; desktop and 390 px, EN and CS, light and dark.

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
- Phone proposal card: show Goal and Done when (after `apps/mobile/App.tsx` is split).
