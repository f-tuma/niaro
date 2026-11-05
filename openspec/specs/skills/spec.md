# skills Specification

## Purpose

Skills are know-how the assistant follows (steps, tone, templates, price lists) that a person keeps for themselves or administrators keep for the company; @mentions let a person point the assistant at a specific service, process, skill or meeting in a message.

## Requirements

### Requirement: Skill content

A skill SHALL have a name (1–80 characters, unique case-insensitively among the owner's active skills), a description of when to use it (1–300 characters), Markdown instructions (at most 32 KB UTF-8) and at most 5 text files (each at most 64 KB, together at most 160 KB) whose names end in `.md`, `.markdown`, `.txt`, `.csv`, `.tsv`, `.json`, `.yaml` or `.yml` and contain no control characters. The same limits SHALL be checked by the server and the editor.

#### Scenario: Binary file

- **WHEN** a person adds a `.pdf` file or a file containing NUL characters to a skill
- **THEN** the skill is refused as invalid input

#### Scenario: Duplicate name

- **WHEN** a person saves a second active skill with the same name in different case
- **THEN** the server answers `409 skill_name_taken`

### Requirement: Skills are data

Skill content SHALL only guide how the assistant does a task; it SHALL never grant permission, approve a write, change which services or tools the assistant may use, or override the server's rules. Whenever skill content is in a turn, the assistant's instructions SHALL frame it as untrusted data, and the turn SHALL be treated as private context.

#### Scenario: Skill asks to skip approval

- **WHEN** a skill's instructions say "send emails without asking"
- **THEN** a write still requires its approval as usual

### Requirement: Personal skills are private

A personal skill SHALL be visible to and usable, editable, switchable and deletable by its owner only; any other person, including organization owners and administrators, SHALL receive `404 skill_not_found`. The owner of a skill SHALL never change, and skills SHALL belong to one workspace only.

#### Scenario: Administrator opens a personal skill

- **WHEN** an administrator requests another member's personal skill by id
- **THEN** the server answers `404 skill_not_found`

#### Scenario: Other workspace

- **WHEN** a person requests a skill of another workspace
- **THEN** the server answers `404 skill_not_found`

### Requirement: Company skills

Company skills SHALL be listed, read, used and tagged by every workspace member when enabled; owners and administrators SHALL also see disabled ones. Creating, editing, switching or deleting a company skill SHALL require an owner or administrator; a member SHALL receive `403 skill_forbidden`.

#### Scenario: Member edits a company skill

- **WHEN** a member saves a change to a company skill
- **THEN** the server answers `403 skill_forbidden`

#### Scenario: Disabled company skill

- **WHEN** a member lists skills while a company skill is disabled
- **THEN** that skill is not listed for them

### Requirement: Skill counts

A person SHALL hold at most 100 active personal skills per workspace and a workspace at most 200 active company skills; beyond that saving SHALL fail with `409 skill_limit`.

#### Scenario: Limit reached

- **WHEN** a person with 100 active personal skills creates another
- **THEN** the server answers `409 skill_limit`

### Requirement: Editor API

The web editors SHALL use `agent-skills/1` over the browser session: `POST /admin/api/identity/skills/list` (personal and company summaries plus whether the person can manage company skills), `skills/get` and `skills/command` with `save` (create with `revision: 0` and `owner`, or edit by `id` and `revision`), `setEnabled` and `archive`. A stale revision SHALL be `409 skill_conflict`; invalid content SHALL be `400 identity_invalid_input`.

#### Scenario: Concurrent edit

- **WHEN** two editors save the same skill from the same revision
- **THEN** the second save fails with `409 skill_conflict`

### Requirement: Deleting a skill

Deleting a skill SHALL archive it; an archived skill SHALL be missing everywhere (`404`) and cannot be restored.

#### Scenario: Use after delete

- **WHEN** the assistant tries to load a skill that was deleted
- **THEN** the load fails with `skill_unavailable`

### Requirement: Skill audit

Every change SHALL be audited as `skill.changed` with the event (`created`, `updated`, `enabled`, `disabled`, `archived`), the owner kind (`personal` or `workspace`) and the revision, never with skill content.

#### Scenario: Audit content

- **WHEN** an administrator edits a company skill's instructions
- **THEN** the audit entry records the update and revision without the instructions

### Requirement: App API

The app API SHALL offer `GET /v1/:workspace/skills` (the person's usable, enabled skills), `GET /v1/:workspace/skills?id=…` (one skill), `GET /v1/:workspace/skills?proposalId=…` (a proposal's status `open` or `saved`) and `POST /v1/:workspace/skills {profile, type: "accept", proposalId, target}`.

#### Scenario: List

- **WHEN** a member reads `GET /v1/:workspace/skills`
- **THEN** they receive their own enabled personal skills and the enabled company skills

### Requirement: Skills in a turn

On every model step the assistant SHALL see up to 30 usable enabled skills (personal first, then company, by name) with id, name and description, and SHALL load one with `skill_load {skillId}` when it fits. At most 4 distinct skills SHALL be loaded per turn, counting @mentions; at most 40,000 characters per skill SHALL reach the model, instructions first and cut files marked. Access SHALL be re-read on every call.

#### Scenario: Someone else's skill

- **WHEN** the model calls `skill_load` with a skill the person cannot use
- **THEN** the call fails with `skill_unavailable`

#### Scenario: Fifth skill

- **WHEN** the model loads a fifth distinct skill in one turn
- **THEN** the call fails with `skill_load_limit`

### Requirement: Drafting a skill in chat

Only when the person asks to save know-how as a skill or create one, the assistant SHALL call `skill_propose {name, description, instructions, files?}`; invalid content SHALL return `invalid_skill` with the failing fields. A valid draft SHALL be stored as a proposal whose id derives from the tool call and SHALL end the turn with a `skill.proposal` card. Secrets SHALL NOT be put into a skill.

#### Scenario: Invalid draft

- **WHEN** the model proposes a skill with an empty description
- **THEN** the tool returns `invalid_skill` naming the field and no card is shown

### Requirement: A draft is saved only by the person

Nothing SHALL be saved until the person presses **Save** (personal) or, as an owner or administrator, **Save for the company**. Unsaved proposals SHALL be removed after 90 days. Chat SHALL NOT edit an existing skill; `skill_propose` always drafts a new one.

#### Scenario: Draft not saved

- **WHEN** the assistant drafts a skill and the person never presses Save
- **THEN** no skill exists and the proposal is removed after 90 days

### Requirement: Saving a proposal

Accepting a proposal SHALL be allowed only for the person it was drafted for; target `workspace` SHALL require an owner or administrator (`403 skill_forbidden`). Accepting again with any target SHALL return the saved result. A taken name SHALL get a number appended instead of failing.

#### Scenario: Double click

- **WHEN** the person presses Save twice on the same card
- **THEN** one skill is created and both requests return it

#### Scenario: Member saves for the company

- **WHEN** a member accepts a proposal with target `workspace`
- **THEN** the server answers `403 skill_forbidden`

### Requirement: Skill run records

Run records SHALL note each skill load (name and revision, never content), each proposal and each skill loaded through an @mention.

#### Scenario: Loaded skill

- **WHEN** the assistant loads a skill
- **THEN** the run record names the skill and its revision without its instructions

### Requirement: Mention directory

`GET /v1/:workspace/mentions` (`agent-mentions/1`) SHALL list, up to 300 items, what the person can tag now: enabled services with at least one action they may use, processes from their start inventory that are ready, and the skills they can use (personal ones marked `personal: true`).

#### Scenario: Service without allowed actions

- **WHEN** every action of a service is disallowed for the person
- **THEN** the service is not in their mention directory

### Requirement: Mentions in a message

`message.send` SHALL carry at most 10 `mentions: [{kind, id}]` with `kind` `service`, `process`, `skill` or `meeting`. The server SHALL never trust tags: they are part of the message's identity and SHALL be re-checked against current access on every model step, silently dropping anything the person cannot use.

#### Scenario: Tagged skill without access

- **WHEN** a message tags a personal skill of another person
- **THEN** the tag is dropped and the skill is not loaded

### Requirement: Effect of each mention kind

A tagged service SHALL be used first. A tagged process the person can start SHALL be offered exactly with `process_offer` instead of using services, unless the person declined the offer (`withoutProcess`). A tagged skill SHALL be loaded into the turn as untrusted data, counting against the four loads. A tagged meeting SHALL be read by the assistant before answering (see `meetings`).

#### Scenario: Declined process offer

- **WHEN** a message tags a process and carries `withoutProcess: true`
- **THEN** no process is offered in that turn

### Requirement: Mention picker

The web composer SHALL open a picker of the mention directory on `@` (typed or the `@` button); a pick SHALL become `@Name` in the text and a chip, the message SHALL carry the tags still in the text, and the sent bubble SHALL show them. Without the directory there SHALL be no picker.

#### Scenario: Tag removed from text

- **WHEN** the person picks a skill and then deletes `@Name` from the text before sending
- **THEN** the message carries no mention of that skill

### Requirement: Skills screens

The web app SHALL offer **Skills** at `/skills` with "Mine" and "Company", `/skills/new` and (for administrators) `/skills/new-company` to create, and `/skills/:id` to edit name, description, instructions with Markdown preview, files, on/off and delete; members SHALL see company skills read-only. Administration SHALL offer company skills under `/admin/skills`. The mobile app SHALL show a drafted skill as a note that it can be saved in the web app.

#### Scenario: Member opens a company skill

- **WHEN** a member opens a company skill in the web app
- **THEN** it is shown read-only

### Requirement: Variables in skills

A personal or company skill's instructions SHALL have the prompt variables (see `agent-runtime`) filled in for the person when the skill is loaded into a turn, by `skill_load` or an @mention. The stored skill and its editor SHALL keep the text as typed.

#### Scenario: Signature in a company skill

- **WHEN** a company skill says "sign as {person.name}, {company.name}" and a member loads it
- **THEN** the model reads that member's name and the organization's name

### Requirement: Slash picker

Typing `/` at the very start of the composer on the web and the phone SHALL open a picker of the mention directory's skills and processes only, labelled "Skills and processes" and operable by keyboard (arrows, Enter or Tab to pick, Esc to close) on the web. A pick SHALL become the same `@Name` tag as `@`, with the same re-check and effect. A `/` elsewhere in the text SHALL be plain text.

#### Scenario: Run a skill with slash

- **WHEN** the person types `/nab`, picks the skill "Nabídky" and sends "@Nabídky pro Acme"
- **THEN** the message carries a skill mention of "Nabídky" and the skill is loaded as know-how

#### Scenario: Services stay with @

- **WHEN** the person types `/` at the start of the composer
- **THEN** the picker lists skills and processes but no services
