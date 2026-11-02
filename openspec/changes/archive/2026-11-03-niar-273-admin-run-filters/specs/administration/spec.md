## MODIFIED Requirements

### Requirement: Run list

Owners and administrators SHALL list the organization's agent runs (chat turns, custom process runs and earlier planner turns) on **Runs** (`GET /admin/api/identity/loops?organizationId=…`, profile `agent-loops/1`), newest first, 50 per page with an opaque `nextBefore` cursor, optionally filtered on the server by `workspaceId`, status (`running`, `succeeded`, `waiting`, `failed`, `cancelled`, `interrupted`, `unknown`), process (`processId`), version (`version`, only with `processId`), person (`actorId`), origin (`chat`, `hub`, `meeting`, `processes`) and start date (`from` inclusive, `to` exclusive). Members and other organizations SHALL not read these runs. A filter SHALL match a run only by the value its listed summary shows after redaction and provenance checks, so filtering SHALL NOT reveal anything the administrator cannot already read. A run's origin SHALL be shown only when its own record proves it: an Overview chat or any other chat for chat turns, and the admitted start receipt (meeting, Overview, Processes page) for process runs with a corroborated version. A filtered page MAY hold fewer than 50 runs while `nextBefore` still leads to older matches.

#### Scenario: Filter failed runs

- **WHEN** an administrator filters Runs by status `failed` in one workspace
- **THEN** only that workspace's failed runs are listed, at most 50 per page

#### Scenario: Support question

- **WHEN** an administrator filters by process *Weekly pipeline*, version 3, status `failed` and the last 7 days
- **THEN** only the failed runs of that version from the last 7 days are listed

#### Scenario: Uncorroborated process

- **WHEN** a run's journal names a process that its pinned version does not corroborate
- **THEN** the list shows the run without a process and no process, version or origin filter returns it

#### Scenario: Redacted filtered result

- **WHEN** a filtered run's request contains an API key
- **THEN** the filtered list shows it redacted

#### Scenario: Run of another organization

- **WHEN** an administrator requests the detail of a run that belongs to another organization or to another workspace than the filter
- **THEN** the server answers 404 `identity_not_found`

## ADDED Requirements

### Requirement: Run filter choices

`GET /admin/api/identity/loops/filters?organizationId=…[&workspaceId=…]` SHALL return the process choices (id, name, versions) and person choices (id, name) for the Runs filters, built only from runs the administrator can list, redacted as in the list, at most 100 each, with the same role and workspace checks as the run list. The console SHALL show them as `Select` filters in the Runs page header toolbar, with Version only after a process is chosen.

#### Scenario: Personal process name

- **WHEN** a person's process has run only with a version its pin does not corroborate
- **THEN** the process is not offered as a choice

#### Scenario: Member asks for choices

- **WHEN** a member requests the filter choices
- **THEN** the server answers 403
