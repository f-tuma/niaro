# Proposal

Tracker: **NIAR-295** (workspace instructions, starters, prompt variables and `/`)

## Why

A company cannot tell its assistant how to write and what its conventions are without asking every person to keep a skill, the empty chat shows fixed client copy that may mention services a workspace does not have, the same know-how has to be rewritten per person ("my name is…", "today is…"), and skills and processes are hard to start from the composer. The chat-app gap analysis of 5 Nov 2026 ranks this third (3.3) and sixth (3.6).

## What Changes

- **Workspace instructions.** Owners and administrators write Markdown instructions (at most 8,000 characters) per workspace in the administration's Workspaces page, plus an organization default. A workspace's own text replaces the default (it is not prepended); while it is empty the default applies. Every save is a new revision with author and time; any older version can be restored as a new revision. Saves are revision-checked and audited without content.
- **In the chat's system context**, the instructions that apply are framed as data that shapes tone, wording and conventions and never grants permission, approves a write, changes the usable tools or overrides approvals and policies (the "Skills are data" rule).
- **Members read them** read-only on the web app's Skills page.
- **Prompt variables** `{person.name}`, `{person.role}` (the job title the person confirmed, none while they opted out of memory), `{workspace.name}`, `{company.name}`, `{today}` (the person's date in their time zone) and `{language}`, filled by the server at turn time in workspace instructions, skill instructions and process prompts. Unknown variables stay as typed; values come only from the person the turn runs for.
- **Starters.** Up to six starter prompts per workspace (organization default as fallback) replace the fixed suggestions of the empty chat on the web and the phone's "Plan a meeting" shortcut. Pressing one sends it at once, like a generated follow-up (NIAR-291). Without starters both apps keep their own copy and behaviour.
- **`/` in the composer.** Typing `/` at the very start of the composer (web and phone) opens a picker of the person's and the company's skills and the processes they may start, from the existing `@` directory with its permission checks. A pick becomes the same `@Name` tag: a skill is loaded as know-how, a process is offered as with `@`.
- **One typed read and write** of instructions and starters for the configuration bundle (NIAR-297).

## Non-goals

- Per-language starter pairs; an administrator writes them in the company's language.
- Short command names per skill, or `/` running anything without the offer and approval flow.
- A read-only instructions view on the phone (the web Skills page has it).
- Instructions in the historical (legacy drain) runtime or in process runs (processes get variables only).

## Risk

- Instructions are text the model reads every step: a hostile or careless administrator could try to steer it. They are framed as data, and every authority check (approval, receipts, tool exposure) stays in the server, so they cannot grant anything.
- A confirmed job title in resolved text is profile data: such a turn is marked private context like a tagged skill.
- `{today}` changes the instructions' cached prefix once a day.
