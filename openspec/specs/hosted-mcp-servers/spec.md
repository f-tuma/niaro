# hosted-mcp-servers Specification

## Purpose

Hosted MCP servers let an organization's owners and admins run an MCP server that a service does not provide itself (a built-in such as Microsoft 365, or a custom npm package or container image) next to Niaro, confined and supervised, and connect it as an ordinary MCP service in the `service-catalog`.

## Requirements

### Requirement: Administration only

The system SHALL let only organization owners and admins list, add, change, look up, read logs of and remove hosted servers. Members SHALL see no hosted servers and their commands SHALL be refused with `identity_forbidden`.

#### Scenario: Member opens Hosted

- **WHEN** a member lists hosted servers of their organization
- **THEN** the response has `canManage: false` and no servers

#### Scenario: Member command refused

- **WHEN** a member sends a hosted `create` command
- **THEN** the server answers `identity_forbidden`

### Requirement: Definition format

The system SHALL describe every hosted server, built-in or custom, by a definition with `version` 1, `name` (at most 100 characters), `source`, `args`, `env`, `secrets`, `memoryMb` (128–4096, default 512), `path` (default `/mcp`) and optional `onboarding`, and SHALL refuse unknown fields. A definition SHALL name what to run, never a command or shell, and hold no secret values.

#### Scenario: Unknown field

- **WHEN** a definition contains a field `command`
- **THEN** the definition is refused as invalid

### Requirement: Pinned sources

A definition's `source` SHALL be either an npm package name (scoped allowed; no paths, URLs or git sources) with an exact version (`1.2.3` or `1.2.3-pre.1`; ranges, tags and `latest` refused) and an optional `bin`, or a container image pinned by `sha256` digest with the port it listens on.

#### Scenario: Version range refused

- **WHEN** an administrator adds a custom definition with `"version": "^2.0.0"`
- **THEN** the definition is refused as invalid and nothing is installed

### Requirement: Arguments and variables

`args` SHALL be a list of at most 40 strings without line breaks, never passed through a shell; an npm definition SHALL include `{port}`, replaced by the listening port. `env` SHALL hold at most 30 fixed non-secret `UPPER_CASE` variables and `secrets` at most 30 unique names, no name being both. `PATH`, `HOME`, `TMPDIR` and names starting with `NODE_`, `LD_` or `DYLD_` SHALL be refused.

#### Scenario: Reserved variable

- **WHEN** a definition sets `NODE_OPTIONS` in `env`
- **THEN** the definition is refused

#### Scenario: Missing port placeholder

- **WHEN** an npm definition's `args` do not contain `{port}`
- **THEN** the definition is refused

### Requirement: Secret values

The system SHALL accept values only for the secret names a definition declares, store them encrypted (AES-256-GCM, key derived from the identity secret) and pass them to the server as environment variables, never on the command line (in Docker through a private `0600` environment file). Secret values SHALL never be returned; a server's view lists only which names have a value. Setting secrets SHALL replace only the given values and restart the server; an empty secret is not passed.

#### Scenario: Undeclared secret

- **WHEN** an administrator submits a value for a secret name the definition does not declare
- **THEN** the command is refused as invalid

### Requirement: Built-in servers

The system SHALL ship built-in definitions in the same format with their lockfiles, including Microsoft 365 (`@softeria/ms-365-mcp-server` with the calendar and mail preset and personal Microsoft sign-in for every action requesting `Calendars.ReadWrite`, `Mail.ReadWrite` and `Mail.Send`). An organization SHALL run each built-in at most once.

#### Scenario: Second Microsoft 365

- **WHEN** an administrator adds the Microsoft 365 built-in to an organization that already runs it
- **THEN** the server answers `hosted_exists`

### Requirement: Custom servers are an operator decision

The system SHALL allow custom definitions only while the server profile's `administration.identity.hosting.allowCustom` is true (the default); the console SHALL NOT be able to change it. When it is false, custom creation and package lookup SHALL be refused with `hosted_custom_disabled` and built-ins remain available.

#### Scenario: Custom servers off

- **WHEN** the operator sets `allowCustom` to false and an admin adds a custom definition
- **THEN** the server answers `hosted_custom_disabled`

### Requirement: Package lookup before install

The system SHALL let an administrator look up an npm package before anything is installed and show its exact version (the latest when none is given), description, licence, publisher, publication date, integrity and executables, and whether it has install scripts. An unknown package SHALL be reported as `hosted_package_unknown`.

#### Scenario: Install scripts warned

- **WHEN** an administrator looks up a package that declares an install script
- **THEN** the result shows `hasInstallScripts: true`

### Requirement: Definition export

The system SHALL let an administrator export a server's definition as `<name>.mcp.json` containing secret names only, never values; importing it elsewhere SHALL ask for the values again.

#### Scenario: Export has no values

- **WHEN** an administrator exports a server whose secret `TRACKER_TOKEN` is set
- **THEN** the file lists `TRACKER_TOKEN` under `secrets` and contains no value

### Requirement: Runtime selection

The system SHALL run hosted servers in Docker or as confined Node processes according to `administration.identity.hosting.runtime`, overridden by `NIARO_HOSTED_RUNTIME`: `auto` (default) uses Docker when it answers and processes otherwise, `docker` never falls back, `process` never uses Docker. Image definitions SHALL require Docker and be refused with `hosted_docker_required` when processes are in use. The listing SHALL state which runtime is in use.

#### Scenario: Image without Docker

- **WHEN** the server runs hosted servers as processes and an admin adds an image definition
- **THEN** the server answers `hosted_docker_required`

### Requirement: Pinned installation

The system SHALL pin an npm server when first installed: a built-in uses its committed lockfile; a custom package gets a lockfile resolved for its exact version once and kept. Every installation SHALL verify each package by its hash and run no install scripts (`npm ci --ignore-scripts --omit=dev`). A failed installation SHALL show the server as failed.

#### Scenario: Registry unreachable on first start

- **WHEN** the npm registry is unreachable when a new npm server first starts
- **THEN** the server's status becomes `failed` with an installation error

### Requirement: Container confinement

In Docker, the system SHALL run each server as one container from a digest-pinned image with a read-only root file system, no Linux capabilities, `no-new-privileges`, an unprivileged user, a 256-process limit and the definition's memory limit, on its own network with internet access but no access to Niaro, host loopback services or other hosted servers, with its port published on `127.0.0.1` only and one writable directory.

#### Scenario: Container cannot reach Niaro

- **WHEN** a hosted container tries to connect to Niaro's own HTTP port
- **THEN** the connection is not possible from its network

### Requirement: Process confinement

Without Docker, the system SHALL start an npm server under Node's permission model, reading only its own directory and writing only its `home/`, with no child processes, worker threads, native addons or WASI, and an explicit environment (`PATH`, `HOME`, `TMPDIR`, `NODE_ENV=production`, the definition's `env` and secrets only), on `127.0.0.1` with a heap limit from `memoryMb`. A symbolic link leading out of its directory SHALL fail the start.

#### Scenario: Identity database unreadable

- **WHEN** a process-confined server tries to read Niaro's identity database
- **THEN** the read is denied

### Requirement: Supervision and logs

The system SHALL report each server's status (`installing`, `starting`, `running`, `stopped`, `failed`) and restart count, restart a crashed server with backoff, and stop restarting after five crashes within ten minutes. It SHALL keep the last 200 log lines with tokens and secret values redacted.

#### Scenario: Crash loop

- **WHEN** a hosted server crashes five times within ten minutes
- **THEN** it is not restarted again and its status is `failed`

### Requirement: Capacity and addresses

The system SHALL run at most eight hosted servers per Niaro server, each on a loopback port in 39100–39199 reachable only from Niaro, and refuse more with `hosted_limit`. Its service URL SHALL be `http://127.0.0.1:<port><path>`, and that origin SHALL be trusted for service calls automatically while the server exists.

#### Scenario: Ninth server

- **WHEN** eight hosted servers exist and an admin adds another
- **THEN** the server answers `hosted_limit`

### Requirement: Lifecycle commands

The system SHALL let an administrator start, stop, restart and remove a server, each checked against the server's revision (`hosted_conflict` when stale). Removing a server SHALL delete its container or process, directory and address.

#### Scenario: Stale command

- **WHEN** an admin restarts a server using a revision older than the current one
- **THEN** the server answers `hosted_conflict`

### Requirement: Creating the service

The system SHALL offer, for a running hosted server without a service, to create an MCP service in the current workspace with the server's name and URL, authentication `none` and the definition's `onboarding` icon and purpose; a server that already has a service SHALL offer to open it instead. When onboarding asks for personal sign-in (`microsoft` or `google`) and the organization has an enabled sign-in method of that kind, personal sign-in SHALL be set up with the listed scopes.

#### Scenario: Microsoft 365 with a Microsoft method

- **WHEN** an admin creates the service for a running Microsoft 365 server and the organization has an enabled Microsoft sign-in method
- **THEN** the service requires personal Microsoft sign-in for every action with `Calendars.ReadWrite Mail.ReadWrite Mail.Send`

#### Scenario: No sign-in method yet

- **WHEN** the organization has no Microsoft sign-in method
- **THEN** the service is created and its checklist says it needs a Microsoft sign-in method

### Requirement: Servers run outside Niaro

The system SHALL connect an MCP server that runs outside Niaro (its own compose service or platform application) as an ordinary MCP service by its URL, subject to the operator's allowed service addresses for private or plain-HTTP origins. Niaro SHALL NOT supervise, log or hold secrets for such servers.

#### Scenario: Compose service by name

- **WHEN** the operator lists `http://tracker-mcp:8080` in allowed service addresses and an admin adds the MCP service `http://tracker-mcp:8080/mcp`
- **THEN** the service can be probed and its actions discovered like any MCP service

### Requirement: Microsoft 365 mail search order

When the Microsoft 365 built-in's `list-mail-messages` or `list-mail-folder-messages` is called with a non-empty `$search`, the system SHALL send the call without `$orderby` (any spelling, with or without `$`), because Microsoft Graph refuses the two together and returns search matches by relevance. Every other parameter, and calls without a search, SHALL be sent as given.

#### Scenario: Sorted mail search

- **WHEN** the model lists mail with `$search` "from:jane@example.test" and `$orderby` "receivedDateTime desc"
- **THEN** the call reaches the server with `$search` and without `$orderby`

#### Scenario: Sorted list without search

- **WHEN** the model lists mail with only `$orderby`
- **THEN** the order is sent unchanged
