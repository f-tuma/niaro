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

The console sidebar SHALL show the workspace switcher at the top, **Overview** first, then the groups **Services** (Services, Installed connectors, Built-in tools, External AI apps), **AI** (AI providers, Model choice, Usage limits, Skills), **Processes** (Processes, Runs), **People** (People, Workspaces, Sign-in methods) and **Settings** (Activity log, Settings), and the account menu (theme, language, sign out) at the bottom.

#### Scenario: Administrator opens the console

- **WHEN** an administrator opens `/admin/`
- **THEN** the sidebar shows the groups and items above in that order and the Overview page is selected

#### Scenario: Switching workspace

- **WHEN** an administrator chooses another workspace in the switcher
- **THEN** workspace-scoped pages show that workspace's services, model choice, processes and runs

### Requirement: Console pages and owners

Each console item SHALL open its page, specified by the named capability: Services `/admin/services` (`service-catalog`), Installed connectors `/admin/hosted` (`hosted-mcp-servers`), Built-in tools `/admin/plugins` (`plugins`), External AI apps `/admin/mcp` (`mcp-server`), AI providers and Model choice (`models-and-providers`), Usage limits (`inference-budget`), Skills (`skills`), Processes (`process-definitions`), People, Workspaces, Sign-in methods and Activity log (`identity-access`).

#### Scenario: Open Model choice

- **WHEN** an administrator selects Model choice in the sidebar
- **THEN** the address becomes `/admin/routing` and the selected workspace's model choice is shown

### Requirement: Console addresses

The console pages SHALL have these addresses: AI providers `/admin/providers`, Model choice `/admin/routing`, Usage limits `/admin/usage`, Skills `/admin/skills`, Processes `/admin/processes`, Runs `/admin/loops`, People `/admin/people`, Workspaces `/admin/workspaces`, Sign-in methods `/admin/auth-providers`, Activity log `/admin/audit` and Settings `/admin/settings`.

#### Scenario: Direct link to Runs

- **WHEN** an administrator opens `/admin/loops` directly
- **THEN** the Runs page opens with Runs selected in the sidebar

### Requirement: Console routes

The server SHALL return the console page only for its known routes, including detail routes such as `/admin/services/:id`, `/admin/providers/:id`, `/admin/plugins/:id`, `/admin/skills/:id` and `/admin/processes/:id`, so that reload and direct links work, and SHALL answer other paths under `/admin` with 404. `GET /admin` SHALL redirect to `/admin/`.

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

For owners and administrators the Overview SHALL show a first-run checklist with progress, each step linking to its page: (1) an enabled provider with a key; (2) an enabled model of such a provider; (3) a workspace default model; (4) usage limits in enforce mode with a current price for that model (see `inference-budget`); (5) an enabled service with an enabled action granted to a role or person; (6) another member or a pending invitation. It SHALL disappear once all steps are done.

#### Scenario: New installation

- **WHEN** the owner opens the Overview right after setup
- **THEN** the checklist shows 0 of 6 with the provider step as the next one, linking to AI providers

#### Scenario: Price out of date

- **WHEN** the chat model's price was set before the model or its provider was last edited
- **THEN** the usage-limits step is not done

#### Scenario: Everything set up

- **WHEN** all six steps are done
- **THEN** the Overview shows no checklist

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

### Requirement: Settings export and import

The system SHALL export the server settings as a JSON file with `"profile": "niaro-server-settings"` and `"version": 1` that contains no secrets and no paths (`GET …/server-settings/export`), and SHALL import such a file (`POST …/server-settings/import`) only after validating it with the same rules as the profile, applying it with a revision check and auditing it as `server.settings_imported`. The console SHALL show the changes and ask for confirmation before importing.

#### Scenario: Move settings to another server

- **WHEN** an administrator exports the settings on one server and imports the file on another
- **THEN** after confirmation the second server has the same name, time zone, meetings, scheduler and origins

#### Scenario: Invalid file

- **WHEN** an administrator imports a file with another `profile` value or an out-of-range field
- **THEN** the import is rejected and no setting changes

### Requirement: Run list

Owners and administrators SHALL list the organization's agent runs (chat turns, custom process runs and earlier planner turns) on **Runs** (`GET /admin/api/identity/loops?organizationId=…`, profile `agent-loops/1`), newest first, 50 per page with an opaque `nextBefore` cursor, optionally filtered by `workspaceId` and by status (`running`, `succeeded`, `waiting`, `failed`, `cancelled`, `interrupted`, `unknown`). Members and other organizations SHALL not read these runs.

#### Scenario: Filter failed runs

- **WHEN** an administrator filters Runs by status `failed` in one workspace
- **THEN** only that workspace's failed runs are listed, at most 50 per page

#### Scenario: Run of another organization

- **WHEN** an administrator requests the detail of a run that belongs to another organization or to another workspace than the filter
- **THEN** the server answers 404 `identity_not_found`

### Requirement: Run detail

The run detail (`GET /admin/api/identity/loops/<64-hex id>?organizationId=…`) SHALL show the run's request, reply, status, provenance and its steps as a timeline in recorded order (model calls, checks, internal tools, service reads and writes), marked as recorded or reconstructed. A trace SHALL hold at most 160 nodes and 320 edges with explicit truncation. Opening a run SHALL never repeat any of its actions.

#### Scenario: Inspect a failed write

- **WHEN** an administrator opens a run whose CRM write failed with a validation error
- **THEN** the step shows the action, its bounded inputs, the recorded cause and field issues, and a next step, without the provider's raw response

#### Scenario: Server restarted mid-run

- **WHEN** the server restarted while a run was running
- **THEN** the run is shown as `interrupted` and none of its actions is executed again

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
