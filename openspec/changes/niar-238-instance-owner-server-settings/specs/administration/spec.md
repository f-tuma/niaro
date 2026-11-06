## ADDED Requirements

### Requirement: Settings only for instance owners

The console SHALL show the **Settings** item and the server settings only to instance owners (see `identity-access`). Anyone else opening `/admin/settings` SHALL see a page saying that the server's owner manages server settings, without any setting values or names of people. Console hints that point to Settings, such as a service checklist step about allowed addresses, SHALL tell others to ask the server's owner instead of linking.

#### Scenario: Administrator of another organization

- **WHEN** the owner of a non-instance organization opens the console
- **THEN** the sidebar has no Settings item

#### Scenario: Direct link without ownership

- **WHEN** an administrator of the instance organization opens `/admin/settings`
- **THEN** the page explains that the server's owner manages server settings and shows no values

#### Scenario: Checklist hint

- **WHEN** a non-owner administrator sees a service step that needs an allowed address
- **THEN** the step asks them to contact the server's owner and offers no Settings link

### Requirement: Account page

The console SHALL offer **Account** (`/admin/account`) in the sidebar's account menu to every console user, holding linking sign-in methods to one's own account, the session's sign-in method and expiry, and the server's name, start time, app session lifetime and protocol as read-only facts. A recovery session SHALL see the session and server facts only.

#### Scenario: Linking a sign-in method

- **WHEN** an administrator who is not an instance owner wants to link a Google sign-in method to their account
- **THEN** they do it on Account, which their account menu offers

#### Scenario: Recovery session

- **WHEN** a recovery session opens Account
- **THEN** it shows the recovery session's expiry and the server facts and no account linking

### Requirement: Server settings audit

Server setting changes and imports SHALL be recorded in the instance organization's activity log. A save or import refused for lack of instance ownership SHALL be audited as `server.settings_changed` or `server.settings_imported` with outcome `denied` in the organization the request named, when the person belongs to it.

#### Scenario: Refused save by another organization's owner

- **WHEN** the owner of a non-instance organization posts server settings naming their organization
- **THEN** the server answers 403 `instance_owner_required` and that organization's activity log records a denied settings change

## MODIFIED Requirements

### Requirement: Server settings

Instance owners SHALL read and change server-wide settings on **Settings** (`GET`/`POST /admin/api/identity/server-settings`, profile `agent-server-settings/1`): name (1–100 characters), default time zone, meetings (see `meetings`), overview refresh scheduler (see `hub`), trusted integration origins (up to 50) and web client origins (up to 20). The profile SHALL supply defaults; saved values SHALL win. Saves SHALL be revision-checked and audited as `server.settings_changed`.

#### Scenario: Member tries to change settings

- **WHEN** a member posts to `/admin/api/identity/server-settings`
- **THEN** the server answers 403 and nothing changes

#### Scenario: Rename the server

- **WHEN** an instance owner saves the name "Acme assistant"
- **THEN** the console and new sessions show the new name without a restart and the Activity log records "Server settings changed"

#### Scenario: Add a web client origin

- **WHEN** an instance owner adds `https://app.example.com` to web client origins
- **THEN** the view lists `allowedOrigins` under `restartPending` and the origin is accepted only after the server restarts

#### Scenario: Concurrent edit

- **WHEN** an instance owner saves settings from an outdated revision
- **THEN** the server answers 409 `server_settings_conflict` and keeps the newer values

#### Scenario: Selector naming another organization

- **WHEN** an instance owner who also owns a second organization sends a server settings request naming the second organization
- **THEN** the server answers 403 `instance_owner_required`

#### Scenario: Diarizer status

- **WHEN** an administrator who is not an instance owner requests `/admin/api/identity/server-settings/diarizer`
- **THEN** the server answers 403 `instance_owner_required` and contacts no diarizer

### Requirement: Settings move with the configuration bundle

Server settings SHALL move between servers only in the configuration bundle's `serverSettings` section (see Configuration bundle export), which only an instance owner's export carries and only an instance owner's import applies; there SHALL be no separate settings export or import, and `…/server-settings/export` and `…/server-settings/import` SHALL answer 404.

#### Scenario: Move settings to another server

- **WHEN** an instance owner exports the organization on one server and imports the bundle on another
- **THEN** after confirmation the second server has the same name, time zone, meetings, scheduler and origins

#### Scenario: Export by another organization

- **WHEN** the owner of a non-instance organization exports the organization
- **THEN** the bundle has no `serverSettings` section

### Requirement: Console navigation

The console sidebar SHALL show the workspace switcher at the top, **Overview** first, then the groups **Services** (Services, Installed connectors, Plugins, External AI apps), **AI** (AI providers, Model choice, Usage limits, Skills), **Processes** (Processes, Runs), **People** (People, Workspaces, Sign-in methods) and **Settings** (Activity log, and Settings for instance owners), and the account menu (account, theme, language, sign out) at the bottom. The whole sidebar SHALL be one labelled landmark.

#### Scenario: Administrator opens the console

- **WHEN** an administrator opens `/admin/`
- **THEN** the sidebar shows the groups and items above in that order and the Overview page is selected

#### Scenario: Switching workspace

- **WHEN** an administrator chooses another workspace in the switcher
- **THEN** workspace-scoped pages show that workspace's services, model choice, processes and runs

#### Scenario: Switching on a workspace page

- **WHEN** an administrator chooses another workspace in the switcher while a workspace's page is open
- **THEN** that workspace's page opens, on the same tab

#### Scenario: Instance owner opens the console

- **WHEN** an instance owner opens `/admin/`
- **THEN** the Settings group lists Activity log and Settings

### Requirement: Console addresses

The console pages SHALL have these addresses: AI providers `/admin/providers`, Model choice `/admin/routing`, Usage limits `/admin/usage`, Skills `/admin/skills`, Processes `/admin/processes`, Runs `/admin/loops`, People `/admin/people`, Workspaces `/admin/workspaces`, Sign-in methods `/admin/auth-providers`, Activity log `/admin/audit`, Settings `/admin/settings` and Account `/admin/account`.

#### Scenario: Direct link to Runs

- **WHEN** an administrator opens `/admin/loops` directly
- **THEN** the Runs page opens with Runs selected in the sidebar

#### Scenario: Direct link to Account

- **WHEN** an administrator reloads `/admin/account`
- **THEN** the Account page opens
