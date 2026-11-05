# Tasks

## 1. Storage and API

- [x] 1.1 `workspace-instructions/1` protocol: content, scope, view, command, chat setup; audit `instructions.changed`.
- [x] 1.2 `InstructionsStore`: current row and versions, revision check, restore, manager check against the stored role, metadata-only audit, workspace cascade, fallback to the organization default.
- [x] 1.3 Console routes `instructions/get`, `command`, `effective`; app route `GET /v1/:workspace/instructions`; typed `readInstructions` / `writeInstructions` for the configuration bundle.

## 2. Prompts

- [x] 2.1 `resolvePromptVariables`: six names, one pass, cleaned values, unknown names kept, time zone with UTC fallback.
- [x] 2.2 `CatalogController.promptContext`; chat steps add framed instructions; a confirmed job title makes the step private.
- [x] 2.3 Skill loads (tool and @) and process agent prompts resolve variables.

## 3. Apps

- [x] 3.1 Administration: Instructions sheet per workspace and Default instructions in the Workspaces page menu, with variables, starters and history with Restore.
- [x] 3.2 Web: starters send at once; `/` picker; read-only instructions on Skills.
- [x] 3.3 Phone: starters on Home send at once; `/` inline rows.

## 4. Verification

- [x] 4.1 Node: store, variables, HTTP, chat framing and approval, process variables.
- [x] 4.2 Jest: admin editor, web starters and `/`, phone starters and `/`.
- [ ] 4.3 Screenshots (light/dark, desktop/phone width) and a run on the emulator.
