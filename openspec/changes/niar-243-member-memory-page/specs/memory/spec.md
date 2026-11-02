## ADDED Requirements

### Requirement: Erasing all of a person's memories

A `forgetAll` command with `scope: "private"` SHALL erase every private memory of the authenticated person in the workspace (active, candidate, superseded and expired but not yet scrubbed) with the same lineage erasure and tombstones as `forget`, in one commit that advances the memory version once. Shared workspace memories, chat history and service receipts SHALL stay. Disabled plugin and opt-out SHALL NOT block it.

#### Scenario: Erase everything

- **WHEN** a member with 12 private memories, two of them corrected, sends `forgetAll`
- **THEN** all of them and their earlier versions are erased, the list is empty and the memory version advanced once

#### Scenario: Shared notes stay

- **WHEN** an administrator who also saved a shared workspace note sends `forgetAll`
- **THEN** their private memories are erased and the shared note stays

#### Scenario: Plugin disabled

- **WHEN** the memory plugin is disabled and a person sends `forgetAll`
- **THEN** their private memories are erased

#### Scenario: Another person's memories

- **WHEN** a person sends `forgetAll` in a workspace where another member has private memories
- **THEN** the other member's memories are unchanged

### Requirement: Erase-all replay

Repeating a `forgetAll` with the same `requestId` SHALL return the current view without erasing anything, including memories saved after the first command, and SHALL never return erased content. The same `requestId` with another command type SHALL fail with `409 memory_request_conflict`.

#### Scenario: Lost erase-all response

- **WHEN** the page resends the same `forgetAll` after the person saved a new memory in chat
- **THEN** the new memory stays and no erased content is returned

### Requirement: Memory page in the web app

The web app SHALL offer **Memory** at `/me/memory`, linked from the account menu and the Account page and not from the sidebar. It SHALL list the person's own private memories newest first with text, kind, origin, saved and expiry time, earlier versions of a corrected memory under it, and the **Use memory** opt-out switch. Shared workspace memories SHALL NOT be listed. It SHALL work without a chat connection.

#### Scenario: Member opens the page

- **WHEN** a member with private memories opens `/me/memory`
- **THEN** the page lists only their private memories, newest first, and the sidebar order is unchanged

#### Scenario: Corrected memory

- **WHEN** a memory was corrected once in chat
- **THEN** the page shows the current text with the earlier text under it as an earlier version

#### Scenario: More than 200

- **WHEN** a person has 250 private memories
- **THEN** the page shows the newest 200 and says it shows 200 of 250

### Requirement: Deleting on the memory page

**Delete** on a memory SHALL erase it with its earlier versions using `forget` at the revision shown, only after a confirmation. **Erase all** SHALL be only in the page's `…` menu and send `forgetAll` only after a confirmation naming the count. Each command SHALL keep its `requestId` until a known outcome, so an unknown outcome is resent only as the same command by the person.

#### Scenario: Delete one memory

- **WHEN** the person confirms Delete on one memory
- **THEN** that memory and its earlier versions disappear and the others stay

#### Scenario: Changed meanwhile

- **WHEN** the memory was corrected in chat after the page loaded and the person confirms Delete
- **THEN** the server answers `409 memory_conflict`, nothing is erased and the page reloads the list and asks to try again

#### Scenario: Cancel erase all

- **WHEN** the person opens Erase all and cancels the confirmation
- **THEN** nothing is sent

### Requirement: Memory page states

The page SHALL show a loading skeleton, an empty state, a plugin-off note (listing and erasure stay available), an error with retry, and a notice after a deletion. All text SHALL exist in English and Czech, and every icon button SHALL carry an accessible label.

#### Scenario: Nothing remembered

- **WHEN** a person with no private memories opens the page while the plugin is enabled
- **THEN** an empty state says the assistant remembers nothing and that a message starting with "Remember" saves something

#### Scenario: Plugin off with old memories

- **WHEN** the plugin is disabled and the person still has memories
- **THEN** the page lists them with a note that memory is off and Delete and Erase all still work

#### Scenario: Load failure

- **WHEN** reading the memories fails
- **THEN** the page shows an error with Retry and no stale list

## MODIFIED Requirements

### Requirement: Memory management API

The system SHALL offer `GET /admin/api/identity/memory?organizationId=…&workspaceId=…` returning `agent-memory/1` with the current version, plugin state, personal opt-out, at most 200 visible records and their `total`. With `scope=private` it SHALL return only the person's own private records. Any workspace member SHALL read it. The recovery-key operator session SHALL be refused (`identity_account_required`).

#### Scenario: Operator session

- **WHEN** the recovery-key session reads the memory route
- **THEN** the server answers `403 identity_account_required`

#### Scenario: Private only

- **WHEN** a member reads with `scope=private` while shared memory is allowed and shared notes exist
- **THEN** only the member's own private records are returned and `total` counts only them

#### Scenario: Unknown query key

- **WHEN** a read carries a query key other than the target and `scope`
- **THEN** it is refused with `400 identity_invalid_input`

### Requirement: Memory commands

`POST /admin/api/identity/memory` SHALL accept strict commands with an idempotent `requestId`: `remember` (`content`, `kind` preference|fact|note, optional `scope`), `revise` (`id`, `revision`, `content`), `forget` (`id`, `revision`), `forgetAll` (`scope: "private"`) and `preference` (`optOut`). Identity, source and trust SHALL always be set by the server. Administration shows this under **Plugins → Memory** and the web app under **Memory** (`/me/memory`).

#### Scenario: Stale revision

- **WHEN** a client revises a memory with an outdated revision
- **THEN** the server answers `409 memory_conflict` and nothing changes

#### Scenario: Retry

- **WHEN** a client repeats a `remember` with the same `requestId`
- **THEN** the recorded result is returned and no second memory is created

#### Scenario: Erase all of the workspace

- **WHEN** a client sends `forgetAll` with `scope: "workspace"`
- **THEN** the request is refused with `400 identity_invalid_input` and nothing is erased
