# deployment Specification

## Purpose

How an operator installs, configures, runs, observes, backs up and upgrades a Niaro server: one container image with one data volume, optionally behind an HTTPS reverse proxy (Caddy in compose, or Traefik on Dokploy).

## Requirements

### Requirement: One image, one data directory

The system SHALL ship as one container image that serves the app API, the web app at `/`, the administration at `/admin/` and the agent runtime, and SHALL keep all persistent data under one data directory (`NIARO_DATA`, default `/data`): the workflow store in `workflow/`, the identity, agent memory, credential key, meeting audio, hosted connectors and operator plugins in `identity/`, and the recovery key digest in `admin-key.json`.

#### Scenario: Fresh container on an empty volume

- **WHEN** the image starts with an empty volume mounted at `/data` and `NIARO_PUBLIC_URL` set
- **THEN** the web app answers at `/` and the administration at `/admin/` on port 8793
- **AND** every file the server creates is inside `/data` or the temporary directory

### Requirement: Unprivileged, read-only runtime

The image SHALL run the server as the unprivileged user with uid 1000, with application files owned by root and read-only to that user, and the server SHALL need write access only to the data directory and `/tmp`. The data directories SHALL be created with mode `0700` and private files with mode `0600`.

#### Scenario: Hardened container

- **WHEN** the container runs with a read-only root filesystem, a writable `/tmp`, all Linux capabilities dropped and `no-new-privileges`
- **THEN** the server starts, serves requests and passes its health check

### Requirement: Health and readiness probes

The system SHALL answer `GET` and `HEAD` on `/healthz` with 200 and `{"status":"ok"}` while the process serves requests, and on `/readyz` with 200 `{"status":"ok"}` only while the workflow store answers, otherwise 503 `{"status":"unavailable"}`. Both probes SHALL be unauthenticated, `no-store`, answered before host, origin and session checks, contain no internals and stay out of the access log. Other methods SHALL get 405 with `Allow: GET, HEAD`.

#### Scenario: Orchestrator probes the container address over HTTP

- **WHEN** an orchestrator calls `GET http://<container-ip>:8793/healthz` with any Host header
- **THEN** it receives 200 `{"status":"ok"}`

#### Scenario: Workflow store unavailable

- **WHEN** the workflow store cannot answer or the server is shutting down
- **THEN** `/readyz` returns 503 `{"status":"unavailable"}` while `/healthz` still returns 200

#### Scenario: Wrong method

- **WHEN** a client sends `POST /healthz`
- **THEN** the server returns 405 with `{"error":"method_not_allowed"}`

### Requirement: Container health check

The image SHALL define a health check that runs `niaro healthcheck` every 30 seconds with a 90-second start period, exiting 0 only when `/healthz` answers.

#### Scenario: Unhealthy server

- **WHEN** the server process no longer answers `/healthz`
- **THEN** `niaro healthcheck` exits non-zero and the container is reported unhealthy after the configured retries

### Requirement: Operator commands

The image entry point SHALL provide `start` (default), `check`, `admin-key`, `admin-rotate-key`, `backup`, `restore` and `healthcheck`, and SHALL reject any other command with exit code 64 and a list of the valid ones.

#### Scenario: Unknown command

- **WHEN** an operator runs `niaro migrate`
- **THEN** the command exits 64 and names the supported commands

### Requirement: Automatic profile

Without a profile file (no `NIARO_CONFIG` file, nothing at `/config/server.json`, no profile argument or `SERVER_PROFILE`), the system SHALL build its profile from the environment and validate it like a file: name `NIARO_NAME` (default `Niaro`), time zone `NIARO_TIME_ZONE`, else `TZ`, else `Europe/Prague`, port `NIARO_PORT` (default 8793), data under `NIARO_DATA`, plugins `datetime` and `memory`, public origin `NIARO_PUBLIC_URL`.

#### Scenario: Start without a profile

- **WHEN** the server starts with only `NIARO_PUBLIC_URL=https://assistant.example.com`
- **THEN** it logs that it uses the automatic profile and serves under that origin with name "Niaro"

#### Scenario: Missing public URL

- **WHEN** the server starts without a profile file and without `NIARO_PUBLIC_URL`
- **THEN** it refuses to start with a message asking for `NIARO_PUBLIC_URL` or a profile file

### Requirement: Profile validation

The system SHALL accept only a strict version-1 profile of at most 64 KiB: unknown fields, unsupported adapters, inline credentials and malformed origins SHALL be rejected, paths SHALL resolve relative to the profile file, the identity and workflow directories SHALL differ, and the profile's `listen.host` SHALL be loopback (`127.0.0.1` or `::1`). The server SHALL refuse to start on an invalid profile with a message that names what to check and no secret values.

#### Scenario: Unknown field

- **WHEN** a profile contains a field the schema does not define
- **THEN** `start` and `check` fail with "Invalid server profile" and exit non-zero

#### Scenario: Shared data directory

- **WHEN** the identity directory equals the workflow data directory
- **THEN** the server refuses to start with "Identity and workflow directories must be separate."

### Requirement: Public origin

The system SHALL serve exactly one public origin, taken from `NIARO_PUBLIC_URL` when set (it replaces the profile's `administration.identity.baseURL`), which MUST be an `https://` origin or `http://localhost`, `http://127.0.0.1` or `http://[::1]` with the listener's port.

#### Scenario: Plain HTTP on a public name

- **WHEN** `NIARO_PUBLIC_URL=http://assistant.example.com` is set
- **THEN** the server refuses to start, saying the public URL must be one HTTPS origin or `http://localhost:<listen port>`

### Requirement: Environment overrides

The system SHALL apply these environment overrides after reading the profile and refuse to start when a value is invalid: `NIARO_LISTEN_HOST` (one of `127.0.0.1`, `::1`, `0.0.0.0`, `::`; the image sets `0.0.0.0`), `NIARO_HOSTED_RUNTIME` (`auto`, `docker`, `process`), `NIARO_PLUGIN_EDITING` (`0` or `1`), `NIARO_PORT` (a port number, automatic profile only) and the `SMTP_*` group.

#### Scenario: Invalid listen host

- **WHEN** `NIARO_LISTEN_HOST=192.168.1.5` is set
- **THEN** the server refuses to start with "NIARO_LISTEN_HOST must be one of 127.0.0.1, ::1, 0.0.0.0, ::."

#### Scenario: Plugin editing turned off

- **WHEN** `NIARO_PLUGIN_EDITING=0` is set
- **THEN** plugin files are read-only in administration regardless of the profile (see `plugins`)

### Requirement: Mail from the environment

When `SMTP_HOST` is set, the system SHALL take invitation and reset mail settings from `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM` instead of the profile. `SMTP_SECURE` SHALL be `true` (implicit TLS, default port 465), `starttls` (upgrade, default port 587, refuse to send without TLS) or `false`, which is accepted only for a loopback host. Without mail settings, invitations work by copied link (see `identity-access`).

#### Scenario: Unencrypted mail to a remote host

- **WHEN** `SMTP_HOST=smtp.example.com` and `SMTP_SECURE=false` are set
- **THEN** the server refuses to start with "Invalid SMTP settings in the environment."

### Requirement: Configuration check without network

The system SHALL validate a profile (or the automatic profile) with `niaro check` (`npm run server:check` outside a container) and print `{"valid": true, ...}` with the server name and adapter kinds, without any network request and without contacting providers.

#### Scenario: Check a valid profile

- **WHEN** an operator runs `niaro check` on a valid profile
- **THEN** it prints `"valid": true` and exits 0 having made no outbound request

### Requirement: Private configuration files

The system SHALL refuse to load private credential files referenced by a profile (model, CRM, calendar adapter configurations) or the recovery key file when they are readable by group or others.

#### Scenario: World-readable credential file

- **WHEN** a profile references a credential file with mode `0644`
- **THEN** the server refuses to start

### Requirement: One server per data directory

The system SHALL hold an exclusive lock on its data directory while running and SHALL refuse to start a second server process on the same directory.

#### Scenario: Second instance on the same volume

- **WHEN** a second server starts against a data directory another running server owns
- **THEN** it fails with "Server setup failed. Check the profile, private files and whether its data directory is already in use." and exits non-zero

### Requirement: First start

On a start with no account yet, the system SHALL log `No owner yet: open <public URL>/admin/ and create the owner account (the first account becomes the owner).` and SHALL create a recovery (administrator) key whose SHA-256 digest alone is stored in `admin-key.json` with mode `0600`; the key itself SHALL never be printed or logged. Owner sign-up itself is specified in `identity-access`.

#### Scenario: Fresh start logs the hint and no key

- **WHEN** the server starts on an empty data directory
- **THEN** the log contains the setup hint and no `acadmin_` key
- **AND** `admin-key.json` contains only a 64-hex digest

#### Scenario: Owner exists

- **WHEN** the server restarts after the owner account was created
- **THEN** the setup hint is not logged and the key digest is unchanged

### Requirement: Recovery key commands

The system SHALL print a new recovery key with `niaro admin-rotate-key`, after which the previous key no longer signs in; `niaro admin-key` SHALL print a key only when no key file exists and otherwise refuse; `niaro admin-key --initial` SHALL print a first-start key left by an older version in `admin-key.initial` once and delete it. Rotation SHALL also discard such a leftover key.

#### Scenario: Rotate the key

- **WHEN** an operator runs `niaro admin-rotate-key`
- **THEN** a new `acadmin_…` key is printed to the terminal, not to the server log
- **AND** sign-in with the old key fails

#### Scenario: Key already exists

- **WHEN** an operator runs `niaro admin-key` and a key file exists
- **THEN** the command fails with "An administrator key already exists and is never shown again. Use admin-rotate-key to replace it."

### Requirement: Public origin enforcement

For the web app, the administration and their APIs, the system SHALL accept only requests whose Host is the public origin's host (or, with an HTTP loopback origin, a loopback name with the listener port) and SHALL reject others with 403 `admin_origin_denied`. With an `https://` public origin, session cookies SHALL carry `Secure` in addition to `HttpOnly` and `SameSite=Strict`.

#### Scenario: Request through another host name

- **WHEN** a client reaches the server port with `Host: 10.0.0.5:8793` while the public URL is `https://assistant.example.com`
- **THEN** the server answers 403 `{"error":"admin_origin_denied"}`

#### Scenario: Navigation through another loopback name

- **WHEN** a person opens `http://127.0.0.1:8793/admin/` while the public URL is `http://localhost:8793`
- **THEN** the server redirects to the same path on `http://localhost:8793`

### Requirement: Listening warning

The system SHALL warn at startup when it listens on all interfaces while the public URL is not HTTPS, telling the operator to publish the port on loopback only.

#### Scenario: Container trial on HTTP

- **WHEN** the image starts with `NIARO_LISTEN_HOST=0.0.0.0` and `NIARO_PUBLIC_URL=http://localhost:8793`
- **THEN** the log contains "Listening on all interfaces without an HTTPS public URL: publish this port on loopback only."

### Requirement: Client address behind a proxy

The system SHALL count rate limits by the socket address unless proxy trust is on. `NIARO_TRUST_PROXY` SHALL turn trust on with `1`, off with `0` or when unset, and with `auto` only when `NIARO_PUBLIC_URL` is `https://`. With trust on, a request from a trusted peer SHALL be counted by the last valid address in `X-Forwarded-For`, and any other peer, or a missing or malformed header, by the peer address. No other forwarded header SHALL be trusted.

#### Scenario: Client-supplied prefix ignored

- **WHEN** trust is on and a private peer forwards `X-Forwarded-For: 198.51.100.1, 203.0.113.9`
- **THEN** the request counts against `203.0.113.9`

#### Scenario: Public peer cannot spoof

- **WHEN** trust is on and a public peer `203.0.113.7` sends `X-Forwarded-For: 198.51.100.1`
- **THEN** the request counts against `203.0.113.7`

### Requirement: Trusted proxy addresses

Without `NIARO_TRUSTED_PROXIES`, any loopback or private-network peer SHALL count as a trusted proxy. With `NIARO_TRUSTED_PROXIES` set to IPs or CIDR ranges (comma- or space-separated), only a listed peer SHALL count as trusted; entries that are not addresses SHALL be ignored, so a typo trusts less, never more.

#### Scenario: Unlisted private peer

- **WHEN** `NIARO_TRUSTED_PROXIES=10.0.1.5` and a request comes from `10.0.1.6` with a forwarded address
- **THEN** the request counts against `10.0.1.6`

#### Scenario: Listed range

- **WHEN** `NIARO_TRUSTED_PROXIES=172.20.0.0/16` and a request comes from `172.20.3.4` forwarding `203.0.113.9`
- **THEN** the request counts against `203.0.113.9`

### Requirement: Concurrent agent runs

The system SHALL run at most `NIARO_MAX_CONCURRENT_RUNS` agent runs (chat turns and process runs) at once across all people, default 8, clamped to 1–64; per-person run lanes are specified in `agent-runtime`.

#### Scenario: Server-wide cap reached

- **WHEN** eight runs are active with the default setting and another person sends a message
- **THEN** that request fails with `model_busy` ("try again in a moment") instead of starting a ninth run

### Requirement: Structured operator log

With `NIARO_LOG=1` (the image default) the system SHALL write one JSON object per line to stdout with `time`, `level` and `event`, including `http_request` (method, route path, status, duration), `http_error` (error class only) and `model_call` (catalog model ID, workspace, status or error code, token counts, duration). Any other value of `NIARO_LOG` SHALL turn these lines off.

#### Scenario: Request line

- **WHEN** a person signs in through `POST /admin/auth/sign-in/email`
- **THEN** an `http_request` line with method, path, status and duration is written

#### Scenario: Budget refusal

- **WHEN** a model call is refused by the usage limits
- **THEN** a `model_call` line with level `warn` and an error code such as `catalog_budget_overrun` is written, without the prompt

### Requirement: Log privacy

Operator log lines SHALL never contain credentials, tokens, prompts, message content, email addresses, client IP addresses, user agents, cookies or headers. Logged request paths SHALL drop the query string and replace every segment that could be an identifier or token (mixed case, several digits, encoded characters, long values) with `:id`.

#### Scenario: Identifier in a path

- **WHEN** a request for `/admin/api/identity/loops/Ab3dEf9GhIjK?organizationId=x` is logged
- **THEN** the logged path is `/admin/api/identity/loops/:id` with no query string

### Requirement: Backup

The system SHALL produce, with `niaro backup -` (or `node scripts/backup.mjs <data-dir> <out>`), one `.tar.gz` (or a directory copy) of the data directory with a `niaro-backup.json` manifest of every file's SHA-256 and the databases. Each SQLite database SHALL be copied with the online backup API from a read-only connection and pass `PRAGMA integrity_check`; WAL/SHM files, locks and npm caches SHALL be left out. Backup SHALL work while the server runs.

#### Scenario: Backup of a running server

- **WHEN** an operator runs `docker compose exec -T niaro niaro backup - > backup.tar.gz` while people use the server
- **THEN** the archive contains every database as a consistent copy that passed the integrity check, and the manifest lists their checksums

#### Scenario: Output exists

- **WHEN** the output file already exists
- **THEN** the backup fails with "Output already exists" and writes nothing

### Requirement: Restore

The system SHALL restore a backup with `niaro restore -` (or `node scripts/restore.mjs <backup> <dir>`) only into an empty target, SHALL reject unknown formats and unsafe paths, SHALL verify every file's checksum and run `integrity_check` on every database, and SHALL report success only when all checks pass.

#### Scenario: Round trip into a new volume

- **WHEN** an operator restores a backup into a new empty volume and starts the server on it
- **THEN** the same organization, workspaces, accounts, conversations, recovery key and server identity are present

#### Scenario: Non-empty target

- **WHEN** the restore target already contains files
- **THEN** restore fails with "Target is not empty" and changes nothing

#### Scenario: Corrupted archive

- **WHEN** a file's checksum does not match the manifest
- **THEN** restore fails with "Checksum mismatch" and says the target may be partial

### Requirement: Upgrade in place

The system SHALL create and upgrade its database schemas at startup, so that a newer server started on an existing data directory migrates it in place and keeps existing records readable. Downgrading to an older server on upgraded data is not supported; rollback is restoring a pre-upgrade backup into a new volume.

#### Scenario: Newer image on an old volume

- **WHEN** a newer image starts on a volume written by an older one
- **THEN** it becomes healthy with existing accounts, conversations and catalog entries preserved

### Requirement: Compose installation

The repository's `compose.yml` SHALL run the server with the volume `niaro-data` (or `NIARO_DATA_VOLUME`), publish port 8793 on `127.0.0.1` only and apply the hardened runtime (read-only root, 512 MB `/tmp`, no capabilities, `no-new-privileges`, 2 GB memory, rotated logs). With the `https` profile Caddy SHALL start on ports 80/443 once the server is healthy, obtain a certificate for the public host, add HSTS and not buffer streamed responses.

#### Scenario: Local trial

- **WHEN** an operator runs `docker compose up -d` without settings
- **THEN** the server is reachable at `http://localhost:8793` from this machine only

#### Scenario: Production with HTTPS

- **WHEN** an operator runs `docker compose --profile https up -d` with `NIARO_PUBLIC_URL=https://assistant.example.com`
- **THEN** Caddy starts after the server reports healthy and serves it over HTTPS with HSTS

### Requirement: Dokploy installation

The repository's `compose.dokploy.yml` SHALL build the image from the GitHub repository at `NIARO_GIT_REF` (default `main`), publish no host port, join `dokploy-network`, use the automatic profile unless `NIARO_CONFIG` names a mounted file, and fail the deployment when `NIARO_PUBLIC_URL` is not set.

#### Scenario: Missing public URL on Dokploy

- **WHEN** the compose file is deployed without `NIARO_PUBLIC_URL`
- **THEN** compose fails with "Set NIARO_PUBLIC_URL to the https:// domain"

### Requirement: Optional diarization service

Both compose files SHALL start the speaker-diarization service only with the `diarization` profile and pass `DIARIZER_TOKEN` to the server as `NIARO_DIARIZATION_TOKEN`; without the profile no diarizer is built or started (behavior in `meetings`).

#### Scenario: Profile not enabled

- **WHEN** an operator starts compose without the `diarization` profile
- **THEN** only the server (and Caddy with `https`) runs
