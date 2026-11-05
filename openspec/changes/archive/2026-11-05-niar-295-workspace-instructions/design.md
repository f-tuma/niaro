# Design

## Context

The chat's stable instructions are assembled in `apps/server-identity/mastra-domain.ts` (`prepareModel`, `instructions` beside the per-turn `context`). `agent-runtime.ts` is the historical runtime used only to drain old turns (`catalog-runtime.ts`, `createDrainCatalogRuntime`) and is left alone. Process agent steps build their prompt in `process-agent-runtime.ts` (`Configured instructions: …`). Skills (`skill-store.ts`) are the model for a workspace-owned, revision-checked, audited text.

## Decisions

### D1. One store, two scopes, every version kept

`InstructionsStore` (`apps/server-identity/instructions-store.ts`) keeps one current row per scope in `agent_instructions` (key: the workspace id, or the organization id for the default; the workspace row cascades with its workspace) and every saved version in `agent_instructions_version`. A save names the revision it started from (0 first); anything else is `409 instructions_conflict`. A restore copies an older version into a new revision (`event: restored`, `restoredFrom`). Owners and administrators only (`403 instructions_forbidden`), checked against the stored member role. Audit `instructions.changed` carries event, scope and revisions, never text.

Alternative: a JSON field on the workspace row. Rejected: no history and no author.

### D2. Replace, not prepend

A workspace's own text replaces the organization default; the default applies while the workspace's text is empty. Starters fall back separately. Keeps the model's text at most 8,000 characters and gives a workspace full control; a workspace that wants the default copies it (the editor shows it as the placeholder).

### D3. One hook for chat and processes

`CatalogController.promptContext` (set once by `IdentityService`) returns the person's variables, the workspace time zone and the instructions that apply. The chat domain reads it under the serial lock after `checkLocked`, at every step, so an edit applies from the next step. Process agent steps read only the variables (instructions are chat-only). Narrow tests without the hook get neither.

Alternative: a new `CatalogContext` member. Rejected: process runs build several contexts; the controller is shared.

### D4. Framing

The instructions are JSON-quoted after a fixed note: data about how to work, never permission; never approve a write, change tools or override approvals, policies, safety or the rules. They sit in the stable prefix, after the core rules. Authority does not depend on the framing: approval, receipts and tool exposure are server checks the text never reaches.

### D5. Variables

`resolvePromptVariables` (`prompt-variables.ts`) replaces six fixed names in one pass (a value that looks like a variable stays literal), cleans values to one line of at most 120 characters, and leaves anything else in braces as typed. A known variable without a value becomes empty. `{today}` is `YYYY-MM-DD` in the turn's time zone (the device's validated zone in chat, the workspace's in a process run; an invalid zone falls back to UTC). `{language}` is the app language, or "the person's language" in process runs, which carry none. `{person.role}` is the job title confirmed on the pet profile and is empty while the person opted out of memory; when it reaches the text the step is private context.

Skill instructions resolve when loaded (tool or `@`), process prompts when the step's model is prepared; frozen definitions and their digests keep the typed text.

### D6. Starters send at once

Starters are the person's own message, sent through the composer's path like a generated follow-up (NIAR-291), so a pressed starter never sits in the composer and never carries the composer's tags, reply or task. The fixed client suggestions shown without starters keep their current behaviour (fill the composer).

### D7. `/` is a second door to `@`

`slashQuery` matches `/query` only at the very start of the draft; `pickerMatches` limits it to skills and processes of the existing mention directory, and a pick inserts the same `@Name` tag, so the server's re-check and the effect of each kind are unchanged. On the web the textarea stays the combobox with the list labelled "Skills and processes"; on the phone the inline rows get that label. The explicit `@` sheet stays context only.

### D8. Reading surfaces

`GET /v1/:workspace/instructions` (app API) and `POST /admin/api/identity/instructions/effective` (browser session, any workspace member) return `WorkspaceChatSetup`; the editor uses `instructions/get` and `instructions/command`. `IdentityService.readInstructions` / `writeInstructions` are the typed bundle functions for NIAR-297.

## Verification

- Node: `tests/workspace-instructions.node.ts` (roles, revisions, history and restore, audit without content, limits, fallback, cascade, variables with time zones and unknown names), `tests/workspace-instructions-http.node.ts` (console and app API), `tests/mastra-domain.node.ts` (framing, variables, skill resolution, write still awaits approval, private context), `tests/service-process-agent.node.ts` (process prompt variables, no instructions).
- Jest: admin editor, web starters and `/`, phone starters and `/`.
