# Skills and @mentions

Agreed with the owner on 2026-10-17. A **skill** is know-how for the agent,
like Claude or ChatGPT skills: a name, a short description of when to use it
and instructions in Markdown, optionally with up to five small text files (a
template, a price list as Markdown, CSV or plain text). The agent sees the
list of skills it may use (name and description) and loads one when it fits
the request; a person can force it by tagging it with `@` in a message.

A skill is **data**. It guides how the agent does a task (steps, tone,
templates, prices); it never grants permission, never approves a write,
never changes which tools or services the agent may use and never overrides
the server's rules. The agent's instructions say this every time skill
content is in the turn.

## Who can do what

Mirrors [personal processes](service-processes.md#personal-processes).

| Action                                        | Owner of a personal skill | Another member             | Owner/admin of the organization |
| --------------------------------------------- | ------------------------- | -------------------------- | ------------------------------- |
| Personal: list, read, use in chat, tag with @ | yes                       | no (404)                   | no (404)                        |
| Personal: create, edit, turn on/off, delete   | yes                       | no (404)                   | no (404)                        |
| Company: list, read, use, tag (enabled only)  | —                         | yes                        | yes (also disabled ones)        |
| Company: create, edit, turn on/off, delete    | —                         | no (403 `skill_forbidden`) | yes                             |

Administrators do not see anyone's personal skills, not even read-only (this
is stricter than personal processes: skills often hold personal notes). The
owner of a skill never changes; a trigger rejects any update of the owner
columns. Skills belong to one workspace; another workspace sees nothing.

## Limits

|                                | Limit                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name                           | 1–80 characters, unique among the owner's active skills (case-insensitive)                                                                                                                             |
| When to use it (`description`) | 1–300 characters                                                                                                                                                                                       |
| Instructions                   | Markdown text, 32 KB (UTF-8)                                                                                                                                                                           |
| Files                          | at most 5, each ≤ 64 KB, together ≤ 160 KB; names end in `.md`, `.markdown`, `.txt`, `.csv`, `.tsv`, `.json`, `.yaml` or `.yml`; text only (no control characters such as NUL), no binaries or scripts |
| Active personal skills         | 100 per person and workspace                                                                                                                                                                           |
| Active company skills          | 200 per workspace                                                                                                                                                                                      |
| Listed to the agent            | 30 per turn (personal first, then company, by name)                                                                                                                                                    |
| Loaded into one turn           | 4 distinct skills (tool loads and @mentions)                                                                                                                                                           |
| Given to the model per skill   | 40 000 characters (instructions first, then files; cut files are marked)                                                                                                                               |

The limits live in `SKILL_LIMITS` (`packages/protocol/skills.ts`) and are
checked by the shared `SkillContentSchema` on the server and in the editor.

## Data

`apps/server-identity/skill-store.ts`, in the identity database:

| Table                  | Holds                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_skill`          | `id`, `organization_id`, `workspace_id` (→ `agent_workspace`, cascade), `owner_type` (`workspace` / `user`), `owner_user_id`, `name`, `description`, `instructions`, `files` (JSON `[{name, content}]`), `enabled`, `revision`, `created_by/at`, `updated_by/at`, `archived_at` |
| `agent_skill_proposal` | a skill drafted in chat until it is saved: `id`, scope, `user_id`, `content` (JSON), `content_hash`, `created_at`, `skill_id`, `target`, `saved_at`                                                                                                                             |

Tables are created with `IF NOT EXISTS`; `enabled` and `archived_at` are
added by `ALTER TABLE` when an older table lacks them. Deleting archives the
row (`archived_at`); an archived skill is missing everywhere (404). Unsaved
proposals older than 90 days are removed on start. Every change is audited as
`skill.changed` with `skillEvent` (`created`, `updated`, `enabled`,
`disabled`, `archived`), `skillOwner` (`personal` / `workspace`) and the
revision; the audit never contains skill content.

## API

Profile `agent-skills/1`.

Console and web app editors (browser session, `X-Agent-Admin: 1`):

- `POST /admin/api/identity/skills/list {organizationId, workspaceId}` →
  `{profile, canManageWorkspace, personal, workspace}` (summaries; members get
  only enabled company skills).
- `POST /admin/api/identity/skills/get {…, id}` → the skill with content.
- `POST /admin/api/identity/skills/command {…, profile, type, …}`:
  - `{type: "save", revision: 0, owner: "personal" | "workspace", content, enabled}` creates,
  - `{type: "save", id, revision, content, enabled}` edits (a stale revision is `skill_conflict`),
  - `{type: "setEnabled", id, revision, enabled}`, `{type: "archive", id, revision}`.

Errors: `skill_not_found` (404), `skill_forbidden` (403), `skill_conflict`,
`skill_name_taken`, `skill_limit` (409), `identity_invalid_input` (400).

App API (bearer credential, the same as the chat):

- `GET /v1/:workspace/skills` → the person's usable list (`SkillList`, enabled only).
- `GET /v1/:workspace/skills?id=…` → one skill.
- `GET /v1/:workspace/skills?proposalId=…` → `{profile, proposalId, status: open | saved, target?, skillId?}`.
- `POST /v1/:workspace/skills {profile, type: "accept", proposalId, target: "personal" | "workspace"}`
  saves a proposal. Only its own person can; `workspace` needs an owner or
  administrator. Repeating it (any target) returns the saved result.
- `GET /v1/:workspace/mentions` → `MentionDirectory` (see below).

`ClientSession` has `readMentions`, `readSkillProposal` and `acceptSkillProposal`.

## In chat

`apps/server-identity/mastra-domain.ts`, through the `skills` capability of
the catalog context (`service.ts`), which re-reads the person's access on
every call:

- **availableSkills**: every model step lists up to 30 enabled skills the
  person can use (id, name, when to use it, `personal`) as untrusted data,
  with the instruction to call `skill_load` when one fits.
- **`skill_load {skillId}`** returns `{status: "loaded", note, skillId, name,
revision, personal, instructions, files}`; `note` repeats the data framing.
  A skill the person cannot use (someone else's, disabled, archived) is
  `skill_unavailable`; a fifth distinct skill is `skill_load_limit`.
- **`skill_propose {name, description, instructions, files?}`** is offered only
  for requests like "save this as a skill" or "create a skill for quotes". It
  validates the content (`invalid_skill` with the failing fields), stores a
  proposal whose id is derived from the tool call (a replay is the same
  proposal) and ends the turn with a `skill.proposal` card. Nothing is saved
  until the person clicks **Save** (personal) or, as an owner or
  administrator, **Save for the company**.
- Tool arguments and results of `skill_*` tools are guarded like memory and
  hub tools (not replayed into later provider history); a turn with skill
  content in its instructions is private context.
- Loops records each `skill_load` (skill name and revision, never content),
  each proposal (`proposed`) and each skill loaded through an @mention (step
  "Skill (@)").

The `skill.proposal` card (`SkillProposalResultSchema`) is part of the
message result union. The web chat renders it with
`app/skill-proposal-card.tsx`; the mobile app shows a one-line note that it
can be saved in the web app.

## @mentions

`message.send` carries up to ten `mentions: [{kind: service | process | skill, id}]`
(`packages/protocol/mentions.ts`). `GET /v1/:workspace/mentions` lists what
the person can tag right now: enabled services with at least one action they
are allowed to use, processes from their start inventory that are ready, and
the skills they can use (personal ones marked `personal: true`).

The server never trusts the tags. `model-service.ts` passes them in the
message context (they are part of the message hash, so a tagged message is a
different request than the same text without tags; untagged messages keep
their earlier hash). The domain stores them on the turn and re-checks them on
every model step against current access; anything the person cannot use is
dropped silently:

- **service**: the agent is told to use it first (`find_actions` with that
  service's name directly).
- **process**: if the person can start it now, it is listed first in
  savedProcesses and the agent is told to offer exactly that process with
  `process_offer` and not to use services. Declining an offer
  (`withoutProcess`) wins: no offer at all.
- **skill**: its content is loaded into the turn (`mentionedSkills`) as
  untrusted data, counted against the four loads per turn.

## User interface

- Web app: **Skills** in the menu (`/skills`) with "Mine" and "Company",
  `/skills/new` (personal) and `/skills/new-company` (administrators) to
  create, `/skills/:id` to edit: name, when to use it, instructions with
  Markdown preview, files (new or uploaded text files), on/off, delete in the
  More menu. Members see company skills read-only.
- Administration: **Skills** under Workspace (`/admin/skills`,
  `/admin/skills/:id`) for company skills only.
- Shared editor: `apps/server-admin/web/skill-editor.tsx`, copy in
  `skills-copy.ts`.

## Tests

- `tests/skills.node.ts`: authorization matrix (personal vs company, members
  vs administrators, other workspace, outside the organization), limits,
  proposals (idempotent accept, targets, name numbering), migration of an
  older table and the owner trigger.
- `tests/skills-http.node.ts`: console and app API, accept over HTTP,
  `/mentions` contents and isolation.
- `tests/mastra-domain.node.ts` ("skills: …"): listing, loading as data,
  @mention re-validation and loading, proposals ending the turn.
- `tests/web-skills.test.tsx`: the chat card, the editor and the list page.

## Not in v1

- Pre-exposing a tagged service's actions: the agent is instructed to start
  with that service, but its actions are still discovered by `find_actions`.
- Binary files (PDF, images), scripts or code execution in skills.
- Promoting a personal skill to a company skill, version history and
  restoring a deleted skill.
- Saving a proposal or editing skills in the mobile app (it shows a note).
- Editing an existing skill from chat (`skill_propose` creates a new one).
