# administration Specification

## Purpose

The administration console at `/admin` where organization owners and administrators set up and run the server: its structure and navigation, who may open it, the overview with the first-run checklist, server-wide settings and the run inspector (Runs). Sections whose behavior belongs to another capability are named here and specified there.

## Requirements

### Requirement: Console for owners and administrators only

The system SHALL serve the administration at `/admin/` from the same server and bundle as the web app, and SHALL open it only to organization owners and administrators signed in with an account, or to a recovery-key session (see `identity-access`). A signed-in member SHALL see an "Administrators only" page, and every administration API except `GET /admin/api/overview` SHALL answer a member with 403 `admin_forbidden`. Requests without a session SHALL get 401.

#### Scenario: Member opens the console

- **WHEN** a member signed in to the web app opens `/admin/`
- **THEN** the page says "Administrators only" and offers to sign out
- **AND** `GET /admin/api/overview` returns `authentication.console: false`

#### Scenario: Member calls an admin API

- **WHEN** a member sends `GET /admin/api/identity/loops?organizationId=…`
- **THEN** the server answers 403 `admin_forbidden`

#### Scenario: Anonymous request

- **WHEN** a client without a session calls `GET /admin/api/overview`
- **THEN** the server answers 401

### Requirement: Personal pages under /admin

Members SHALL still reach the personal pages served under `/admin`: device sign-in confirmation (`/admin/device`), connecting a service for themselves (`/admin/service-connect`) and the consent page for an external AI app (`/admin/mcp/consent`); their behavior is specified in `app-pairing`, `service-sign-in` and `mcp-server`.

#### Scenario: Member confirms an app sign-in

- **WHEN** a member opens `/admin/device` from the app's browser sign-in
- **THEN** the confirmation page opens instead of "Administrators only"

### Requirement: Entry from the web app

The web app's account menu SHALL show an **Administration** entry only to owners and administrators of the current organization.

#### Scenario: Member's account menu

- **WHEN** a member opens the account menu in the web app
- **THEN** there is no Administration entry

### Requirement: Console navigation

The console sidebar SHALL show the workspace switcher at the top, **Overview** first, then the groups **Services** (Services, Installed connectors, Plugins, External AI apps), **AI** (AI providers, Models, Usage limits, Skills), **Processes** (Processes, Runs), **People** (People, Workspaces, Sign-in methods) and **Settings** (Activity log, Settings), and the account menu (theme, language, sign out) at the bottom. The whole sidebar SHALL be one labelled landmark.

#### Scenario: Administrator opens the console

- **WHEN** an administrator opens `/admin/`
- **THEN** the sidebar shows the groups and items above in that order and the Overview page is selected

#### Scenario: Switching workspace

- **WHEN** an administrator chooses another workspace in the switcher
- **THEN** workspace-scoped pages show that workspace's services, models, processes and runs

#### Scenario: Switching on a workspace page

- **WHEN** an administrator chooses another workspace in the switcher while a workspace's page is open
- **THEN** that workspace's page opens, on the same tab

### Requirement: Console language

The console SHALL open in Czech when the browser prefers Czech over English and in English otherwise, until someone picks a language in the account menu; only that choice SHALL be remembered. Dates and times SHALL be formatted in the console's language.

#### Scenario: Czech browser

- **WHEN** someone with a Czech browser opens the console for the first time
- **THEN** it is in Czech and the Activity log shows Czech dates and times

### Requirement: Console pages and owners

Each console item SHALL open its page, specified by the named capability: Services `/admin/services` (`service-catalog`), Installed connectors `/admin/hosted` (`hosted-mcp-servers`), Plugins `/admin/plugins` (`plugins`), External AI apps `/admin/mcp` (`mcp-server`), AI providers and Models (`models-and-providers`), Usage limits (`inference-budget`), Skills (`skills`), Processes (`process-definitions`), People, Workspaces, Sign-in methods and Activity log (`identity-access`).

#### Scenario: Open Model choice

- **WHEN** an administrator selects Models, the former Model choice, in the sidebar
- **THEN** the address becomes `/admin/routing` and the model policy of the organization and the selected workspace is shown

### Requirement: Console addresses

The console pages SHALL have these addresses: AI providers `/admin/providers`, Models `/admin/routing`, Usage limits `/admin/usage`, Skills `/admin/skills`, Processes `/admin/processes`, Runs `/admin/loops`, People `/admin/people`, Workspaces `/admin/workspaces` (one workspace at `/admin/workspaces/<id>`), Sign-in methods `/admin/auth-providers`, Activity log `/admin/audit` and Settings `/admin/settings`.

#### Scenario: Direct link to Runs

- **WHEN** an administrator opens `/admin/loops` directly
- **THEN** the Runs page opens with Runs selected in the sidebar

### Requirement: Console routes

The server SHALL return the console page only for its known routes, including detail routes such as `/admin/services/:id`, `/admin/providers/:id`, `/admin/plugins/:id`, `/admin/skills/:id`, `/admin/workspaces/:id` and `/admin/processes/:id`, so that reload and direct links work, and SHALL answer other paths under `/admin` with 404. `GET /admin` SHALL redirect to `/admin/`.

#### Scenario: Reload a detail page

- **WHEN** an administrator reloads `/admin/providers/<id>`
- **THEN** the same provider detail page opens

#### Scenario: Old link

- **WHEN** someone opens `/admin/ai`
- **THEN** the console replaces the address with `/admin/routing`

#### Scenario: Unknown path

- **WHEN** a client requests `/admin/does-not-exist`
- **THEN** the server answers 404

### Requirement: Earlier console addresses

The console SHALL redirect earlier addresses to their current page: `/admin/access` to Settings, `/admin/accounts` to People, `/admin/ai` to Model choice, `/admin/tools`, `/admin/built-in` and `/admin/connections/*` to Services, and `/admin/settings?tab=people|workspaces|audit` to People, Workspaces or Activity log.

#### Scenario: Old settings tab

- **WHEN** someone opens `/admin/settings?tab=audit`
- **THEN** the console replaces the address with `/admin/audit`

### Requirement: Console request protection

The server SHALL reject with 403 `admin_origin_denied` any web app or administration request whose `Origin` differs from the public origin, and any cross-site request (`Sec-Fetch-Site` other than `same-origin` or `none`) except a top-level document navigation to a console or app page. The console session cookie SHALL be `HttpOnly`, `SameSite=Strict` and scoped to `/admin`.

#### Scenario: Cross-site API call

- **WHEN** a page on another site sends `POST /admin/api/identity/command` with the person's cookies
- **THEN** the server answers 403 `admin_origin_denied` and changes nothing

#### Scenario: Link from an email

- **WHEN** a person follows a link to `/admin/people` from their mail client
- **THEN** the console page opens

### Requirement: Security headers

Every page and API response of the web app and the administration SHALL carry `Cache-Control: no-store`, a Content-Security-Policy of `default-src 'none'` with `script-src 'self'`, a per-response style nonce and `frame-ancestors 'none'`, plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The pages SHALL load nothing from third parties.

#### Scenario: Framing attempt

- **WHEN** another site embeds `/admin/` in an iframe
- **THEN** the browser refuses to render it because of `frame-ancestors 'none'` and `X-Frame-Options: DENY`

### Requirement: Read-only viewing

Opening or refreshing any console page SHALL not call a model, execute a service action or contact a provider; only explicit commands (such as discovery, a test or a save) do.

#### Scenario: Refresh the overview

- **WHEN** an administrator refreshes the Overview and Runs pages
- **THEN** no model request and no service call is made

### Requirement: Overview checklist

For owners and administrators the Overview SHALL show a first-run checklist with progress, each step linking to its page: (1) an enabled provider with a key; (2) an enabled model of such a provider; (3) a chat model, the workspace's own or inherited; (4) usage limits in enforce mode with a current price for that model (see `inference-budget`); (5) an enabled service with an action granted to a role or person; (6) another member or a pending invitation. It SHALL disappear once all steps are done.

#### Scenario: New installation

- **WHEN** the owner opens the Overview right after setup
- **THEN** the checklist shows 0 of 6 with the provider step as the next one, linking to AI providers

#### Scenario: Price out of date

- **WHEN** the chat model's price was set before the model or its provider was last edited
- **THEN** the usage-limits step is not done

#### Scenario: Everything set up

- **WHEN** all six steps are done
- **THEN** the Overview shows no checklist

#### Scenario: Inherited chat model

- **WHEN** a workspace sets no chat model and the organization default has one
- **THEN** the chat model step is done

### Requirement: Needs attention

The Overview SHALL show **Needs attention** only when something needs action, in this order: actions that failed today (linking to the Activity log filtered to failures), processes that need a retest (linking to Processes), member-added services waiting for a decision, enabled services that require personal sign-in which nobody has completed, and AI requests at 80 % or more of today's request limit. Unknown inputs SHALL add no row.

#### Scenario: Requests near the limit

- **WHEN** today's AI requests reach 82 % of the limit
- **THEN** Needs attention shows the 82 % row linking to AI providers

#### Scenario: Nothing to do

- **WHEN** nothing failed, needs a retest, waits for review or sign-in, and requests are below 80 %
- **THEN** no Needs attention section is shown

### Requirement: Server settings

Owners and administrators SHALL read and change server-wide settings on **Settings** (`GET`/`POST /admin/api/identity/server-settings`, profile `agent-server-settings/1`): name (1–100 characters), default time zone, meetings (see `meetings`), overview refresh scheduler (see `hub`), trusted integration origins (up to 50) and web client origins (up to 20). The profile SHALL supply defaults; saved values SHALL win. Saves SHALL be revision-checked and audited as `server.settings_changed`.

#### Scenario: Member tries to change settings

- **WHEN** a member posts to `/admin/api/identity/server-settings`
- **THEN** the server answers 403 and nothing changes

#### Scenario: Rename the server

- **WHEN** an administrator saves the name "Acme assistant"
- **THEN** the console and new sessions show the new name without a restart and the Activity log records "Server settings changed"

#### Scenario: Add a web client origin

- **WHEN** an administrator adds `https://app.example.com` to web client origins
- **THEN** the view lists `allowedOrigins` under `restartPending` and the origin is accepted only after the server restarts

#### Scenario: Concurrent edit

- **WHEN** an administrator saves settings from an outdated revision
- **THEN** the server answers 409 `server_settings_conflict` and keeps the newer values

### Requirement: Settings page layout

The Settings page SHALL group the settings under headings with a one-line hint each (Server, Meetings, Overview refresh, Allowed addresses, Your session), link to Sign-in methods and Configuration instead of repeating them, and show the start time and protocol only as a quiet line about the server. Allowed addresses SHALL say that service addresses are private or `http://` addresses the server may call and app addresses are browser origins allowed to use Niaro (CORS).

#### Scenario: Operator origins

- **WHEN** the operator set `NIARO_INTEGRATION_ORIGINS=http://searxng:8080`
- **THEN** Allowed addresses lists `http://searxng:8080` read-only as set by the operator, outside the editable service addresses

### Requirement: Operator origins in the settings view

The settings view SHALL carry `operatorOrigins`, the service origins the operator trusts through `NIARO_INTEGRATION_ORIGINS`; they SHALL be trusted like the saved service addresses but never saved with the settings.

#### Scenario: Saving keeps them apart

- **WHEN** an administrator saves the settings while the operator trusts `http://searxng:8080`
- **THEN** the saved service addresses do not include it and the view still lists it under `operatorOrigins`

### Requirement: When settings apply

Name, time zone, meetings and scheduler settings SHALL apply at once. Integration and web client origins SHALL apply at the next start and SHALL be listed in `restartPending` until then, which the page shows.

#### Scenario: Time zone applies at once

- **WHEN** an administrator changes the default time zone
- **THEN** new date calculations in workspaces that keep the server default use it without a restart

### Requirement: Settings ranges

The settings SHALL be limited to: meeting audio retention 0–3650 days, glossary up to 200 terms of up to 100 characters, meeting chunk length 120–600 seconds, scheduler interval 0–86400 seconds (0 turns the background refresh off), 1–200 widget fills per pass and 1–365 idle days. Out-of-range values SHALL be rejected.

#### Scenario: Chunk too short

- **WHEN** an administrator saves a meeting chunk length of 60 seconds
- **THEN** the save is rejected and the stored settings stay unchanged

### Requirement: Settings move with the configuration bundle

Server settings SHALL move between servers only in the configuration bundle's `serverSettings` section (see Configuration bundle export); there SHALL be no separate settings export or import, and `…/server-settings/export` and `…/server-settings/import` SHALL answer 404.

#### Scenario: Move settings to another server

- **WHEN** an administrator exports the organization on one server and imports the bundle on another
- **THEN** after confirmation the second server has the same name, time zone, meetings, scheduler and origins

### Requirement: Run list

Owners and administrators SHALL list the organization's agent runs (chat turns, custom process runs and earlier planner turns) on **Runs** (`GET /admin/api/identity/loops?organizationId=…`, profile `agent-loops/1`), newest first, 50 per page with an opaque `nextBefore` cursor, optionally narrowed by the run filters below. Members and other organizations SHALL not read these runs.

#### Scenario: Filter failed runs

- **WHEN** an administrator filters Runs by status `failed` in one workspace
- **THEN** only that workspace's failed runs are listed, at most 50 per page

#### Scenario: Support question

- **WHEN** an administrator filters by process _Weekly pipeline_, version 3, status `failed` and the last 7 days
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

### Requirement: Run filters

Runs SHALL be filterable on the server by `workspaceId`, status (`running`, `succeeded`, `waiting`, `failed`, `cancelled`, `interrupted`, `unknown`), process (`processId`), version (`version`, only with `processId`), person (`actorId`), origin (`chat`, `hub`, `meeting`, `processes`) and start date (`from` inclusive, `to` exclusive). A filtered page MAY hold fewer than 50 runs while `nextBefore` still leads to older matches.

#### Scenario: Failed runs of one process version

- **WHEN** an administrator filters Runs by a process, its version 3 and status `failed`
- **THEN** only failed runs of that version are listed, newest first

### Requirement: Filters reveal nothing hidden

A run filter SHALL match a run only by the value its listed summary shows after redaction and provenance checks, so filtering SHALL NOT reveal anything the administrator cannot already read. A run's origin SHALL be shown only when its own record proves it: an Overview chat or any other chat for chat turns, and the admitted start receipt (meeting, Overview, Processes page) for process runs with a corroborated version.

#### Scenario: Redacted process

- **WHEN** a run's process cannot be confirmed from its record
- **THEN** no process, version or origin filter matches that run

### Requirement: Run detail

The run detail (`GET /admin/api/identity/loops/<64-hex id>?organizationId=…`) SHALL show the run's request, reply, status, provenance and its steps as a timeline in recorded order (model calls with their model, role and reason, checks, internal tools, service reads and writes), marked as recorded or reconstructed. A trace SHALL hold at most 160 nodes and 320 edges with explicit truncation. Opening a run SHALL never repeat any of its actions.

#### Scenario: Inspect a failed write

- **WHEN** an administrator opens a run whose CRM write failed with a validation error
- **THEN** the step shows the action, its bounded inputs, the recorded cause and field issues, and a next step, without the provider's raw response

#### Scenario: Server restarted mid-run

- **WHEN** the server restarted while a run was running
- **THEN** the run is shown as `interrupted` and none of its actions is executed again

#### Scenario: Escalated step

- **WHEN** an administrator opens a run whose write was rejected and escalated
- **THEN** the next model step names the escalation model, role Escalation and reason "Escalated after a rejected write"

### Requirement: Run previews

Step input and result previews SHALL hold at most 12 fields with values of at most 1,000 characters, prefer business fields, and SHALL omit or redact credentials, headers, cookies, raw response bodies and binary or media content. Omitted and truncated content SHALL be marked.

#### Scenario: Credential in an argument

- **WHEN** a recorded tool input contains an API key or an `Authorization` header
- **THEN** the preview shows it redacted

### Requirement: Run outcomes

A proposal and its approved execution SHALL be separate steps; an unverified write SHALL stay `unknown`, a declined proposal `cancelled`, and a run that was running when the server restarted `interrupted`. A failed or unconfirmed action SHALL show its recorded cause and a safe next step, or say that the cause was not recorded.

#### Scenario: Unverified write

- **WHEN** a write was sent but its result could not be confirmed
- **THEN** the step and run show `unknown` and the next step asks to verify in the service before repeating

#### Scenario: Recovered run

- **WHEN** an administrator opens a run whose first mail read failed and whose reply was delivered after a corrected read
- **THEN** the run and its Reply step show Completed with a muted "Some steps failed" badge, and the first read's step shows Failed with its cause

### Requirement: Run status follows the outcome

A run's status SHALL be its outcome as `agent-runtime` defines it; a `succeeded` run with a failed tool step SHALL carry `failedSteps: true` and show a muted "Some steps failed" badge in the list and the detail, while its steps keep their own statuses.

#### Scenario: Recovered read

- **WHEN** a run delivers its reply after one failed read
- **THEN** the run is succeeded with a muted "Some steps failed" badge and the read step stays failed

### Requirement: Revision-checked editing

Console editors SHALL keep unsaved changes across transient refresh failures, SHALL block saving after the stored revision changed until the person explicitly discards and reloads, and SHALL close an editor when the person loses the right to manage it.

#### Scenario: Stale edit

- **WHEN** another administrator saved the same item while this administrator was editing
- **THEN** the save is refused with a conflict and the console offers "Discard changes and reload" while keeping the draft until then

### Requirement: Languages, themes and widths

The console SHALL be complete in English and Czech, offer light and dark themes, and stay usable down to phone width (360 px) without horizontal page scrolling. Theme and language SHALL be stored only as local preferences of the browser, with English and the system theme as defaults.

#### Scenario: Phone width

- **WHEN** an administrator opens Runs at 390 px width
- **THEN** the run list and the selected run stack vertically and the page does not scroll horizontally

### Requirement: Run filter choices

`GET /admin/api/identity/loops/filters?organizationId=…[&workspaceId=…]` SHALL return the process choices (id, name, versions) and person choices (id, name) for the Runs filters, built only from runs the administrator can list, redacted as in the list, at most 100 each, with the same role and workspace checks as the run list. The console SHALL show them as `Select` filters in the Runs page header toolbar, with Version only after a process is chosen.

#### Scenario: Personal process name

- **WHEN** a person's process has run only with a version its pin does not corroborate
- **THEN** the process is not offered as a choice

#### Scenario: Member asks for choices

- **WHEN** a member requests the filter choices
- **THEN** the server answers 403

### Requirement: Workspace page

Each row on **Workspaces** SHALL open the workspace's page at `/admin/workspaces/<id>`, with a breadcrumb back to Workspaces and the tabs Members, Roles, Instructions and Knowledge (`?tab=`); members of the organization SHALL see only who has access. Opening the page SHALL NOT switch the console's workspace: its header SHALL say whether it is the current one or offer to switch. The row's menu SHALL hold only actions such as **Invite by email**.

#### Scenario: Open a workspace

- **WHEN** an administrator clicks the row "Sales" on Workspaces
- **THEN** the Sales page opens on Members, and Roles, Instructions and Knowledge are tabs on the same page

### Requirement: Workspace instructions editor

Owners and administrators SHALL edit Markdown instructions (at most 8,000 characters) and up to 6 distinct one-line starters (at most 200 characters each) per workspace on the Instructions tab of the workspace's page, and as an organization default from the Workspaces list. Each save SHALL be a new revision bound to the revision it started from; a stale save SHALL be `409 instructions_conflict` and a member SHALL get `403 instructions_forbidden`.

#### Scenario: Two administrators save

- **WHEN** two administrators save the same workspace's instructions from revision 3
- **THEN** the first becomes revision 4 and the second fails with `409 instructions_conflict`

#### Scenario: Member opens the editor

- **WHEN** a member requests the instructions editor of their workspace
- **THEN** the server answers `403 instructions_forbidden`

### Requirement: Instructions history

Every saved version SHALL be kept with its author and time and listed newest first (at most 50 shown). Restoring a version SHALL save its text and starters as a new revision marked as restored from it. Each save and restore SHALL be audited as `instructions.changed` with the event, the scope and the revisions, never with the text or starters.

#### Scenario: Restore

- **WHEN** an owner restores revision 1 while revision 2 is current
- **THEN** revision 3 holds revision 1's text and starters and the audit names the restore without the text

### Requirement: Organization default instructions

A workspace's own instructions SHALL replace the organization default, not add to it; while a workspace's text is empty the default text SHALL apply, and while its starters are empty the default starters SHALL apply. Deleting a workspace SHALL delete its instructions and their history.

#### Scenario: Workspace without its own text

- **WHEN** a workspace has starters but no text and the organization default has text
- **THEN** the chat uses the default text and the workspace's own starters

### Requirement: Configuration bundle export

Owners and administrators SHALL export the organization or one workspace as JSON `niaro-config-bundle` v1 (`GET …/config-bundle/export`), one typed section per part: providers, models, search backends, the model policy, connectors, server settings, instructions, roles, services, routing, usage, plugins, skills, knowledge, processes. It SHALL hold no keys, tokens, sign-ins or per-person grants; a provider or search backend that needs a key SHALL say `keyRequired: true`.

#### Scenario: Provider with a key

- **WHEN** an administrator exports a provider with a stored key
- **THEN** the file has its address with `keyRequired: true` and no key

#### Scenario: Search backend with a key

- **WHEN** an administrator exports a Brave search backend
- **THEN** the file has its kind and address with `keyRequired: true` and no key, and an import lists it as needing a key

### Requirement: Bundle references by name

A bundle SHALL name models by provider and model, services and actions by name and workspace roles by name, never by this server's ids. A section from a newer server SHALL be reported as `section_unknown` and skipped.

#### Scenario: Unknown section

- **WHEN** a bundle has a section this server does not know
- **THEN** the preview lists it as not imported and the rest still applies

### Requirement: Configuration import preview

`POST …/config-bundle/preview` SHALL apply the bundle in a rolled back transaction and return per section the added, changed, unchanged, not imported (with reason) and needs-key items and a `revision` digest of the current configuration. A preview SHALL change nothing.

#### Scenario: Fresh server

- **WHEN** an administrator previews a bundle on a server without providers
- **THEN** the providers are listed as added and as needing a key

### Requirement: Confirmed configuration import

`POST …/config-bundle/import` SHALL require the preview's `revision` (else 409 `config_bundle_conflict`), apply sections in one transaction, writing only what differs, and audit `config.bundle_imported` with counts. It SHALL never remove, overwrite a key, or send a stored key to a new address.

#### Scenario: Same bundle twice

- **WHEN** an administrator imports a bundle that was already imported
- **THEN** every item is unchanged and nothing is written

### Requirement: What an import creates

An import SHALL add missing roles without members, save processes only as drafts, add missing installed connectors after the commit and leave members' own services, personal skills and personal processes untouched. A one-workspace bundle SHALL go into the selected workspace; otherwise workspaces match by name.

#### Scenario: Process from a bundle

- **WHEN** a bundle with an active process is imported
- **THEN** the process arrives as a draft that must be tested and activated here

### Requirement: Configuration page

The console SHALL offer Configuration at `/admin/settings/configuration`, linked from Settings, with Export (organization or workspace), one Import action for a file, the preview per section and an import confirmation, in English and Czech.

#### Scenario: Import from the page

- **WHEN** an administrator chooses a bundle file
- **THEN** the page shows what changes and imports only after confirmation

### Requirement: Presets in the configuration bundle

The model policy and routing sections of a configuration bundle SHALL carry member presets as they are, since they name tiers and no models. A bundle without them SHALL leave presets off for the organization and inherited for a workspace.

#### Scenario: Workspace with presets

- **WHEN** an administrator exports a workspace that offers the preset Quick and imports it into a fresh server
- **THEN** the imported workspace offers Quick on the same tier

### Requirement: Knowledge settings

Owners and administrators SHALL find a workspace's knowledge on the Knowledge tab of the workspace's page: the index status, **Rebuild index** (disabled while a pass runs), whether files are indexed, the source candidates to pick and the passage length (300–4,000) and overlap (under half the length). Saves SHALL be revision-checked (409 `knowledge_conflict`); members SHALL get 403.

#### Scenario: Picking a source

- **WHEN** an administrator ticks "List procedures" of the Wiki and saves
- **THEN** the tab says it is saved, a pass indexes that action and the status shows its passages

#### Scenario: Member asks for the settings

- **WHEN** a member requests the knowledge settings of their workspace
- **THEN** the server answers 403

### Requirement: Knowledge in the configuration bundle

A workspace bundle SHALL carry a `knowledge` section with whether files are indexed, the passage settings and the sources by service and action name, never passages, vectors or status. An import SHALL accept only sources that are candidates on the target server, refuse a missing one as `reference_missing` and update the index after the commit.

#### Scenario: Import to a new server

- **WHEN** an administrator imports a bundle whose knowledge picks "TEST Wiki · List procedures" into a server with that service
- **THEN** the source is picked there and the new server builds its own index
