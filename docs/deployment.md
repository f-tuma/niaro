# Deployment with a container

One container image runs the whole Niaro server: the app API used by the web
and mobile apps, the web app at `/`, administration at `/admin`, the Mastra
runtime and its storage. Everything the server writes lives in one volume
mounted at `/data`. The server profile is mounted read-only. An optional Caddy
container provides HTTPS.

| Piece                            | In the repository                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Image                            | [`Dockerfile`](../Dockerfile), [`.dockerignore`](../.dockerignore)                             |
| Compose example                  | [`compose.yml`](../compose.yml)                                                                |
| Server profile for the container | [`examples/self-hosted/server.json`](../examples/self-hosted/server.json)                      |
| HTTPS proxy                      | [`examples/self-hosted/Caddyfile`](../examples/self-hosted/Caddyfile)                          |
| Backup and restore               | [`scripts/backup.mjs`](../scripts/backup.mjs), [`scripts/restore.mjs`](../scripts/restore.mjs) |

For a development checkout without containers see [self-hosting](self-hosting.md)
(it uses `examples/self-hosted/server.local.json`).

## Requirements and sizing

- Docker Engine with Compose v2 (tested with Docker 29), x86-64 Linux.
- A DNS name for the server and ports 80 and 443 reachable from the internet
  (for the certificate) or an internal CA.
- Memory: the server idles at about 450 MB. Plan for 1 GB per instance for a
  pilot of tens of people; the compose example sets a 2 GB limit. Model calls
  run at the provider, not on this machine.
- CPU: one or two cores are enough; the process is mostly waiting on providers.
- Disk: the image is about 630 MB (130 MB compressed download). Data starts
  under 5 MB and grows with conversations, audit, Mastra memory and meeting
  audio; keep at least 1 GB free plus room for backups.
- Run exactly one container per data volume. The server holds a lock on the
  data directories and refuses to start when another process owns them; there
  are no replicas.

## Install with compose

```sh
git clone <repository> niaro && cd niaro
docker compose build
```

The build installs dependencies with `pnpm install --frozen-lockfile` (pnpm
12.4.2, as pinned in `package.json`) on a base image pinned by digest, builds the
web bundle (`npm run admin:build`) and copies into the runtime stage only the
packages the server imports, the server sources and the bundle. The runtime runs
the TypeScript sources with `tsx`, as `npm run server` does, as the unprivileged
`node` user (uid 1000). Application files are owned by root and read-only to
the server.

### Trial on one machine (HTTP, loopback only)

```sh
docker compose up -d
```

Open `http://localhost:8793/admin/` and create the owner account (see "First
run"). The defaults bind the port on `127.0.0.1` only
and use `NIARO_PUBLIC_URL=http://localhost:8793`; nothing is reachable from other
machines.

### Production behind HTTPS

1. Copy the profile and adjust it (name, time zone, adapters):

   ```sh
   mkdir -p config && cp examples/self-hosted/server.json config/server.json
   ```

2. Create `.env` next to `compose.yml` (keep it `0600`; it is never part of the
   image):

   ```sh
   NIARO_PUBLIC_URL=https://assistant.example.com
   NIARO_CONFIG=./config/server.json
   # Optional invitation mail; without it administrators copy invitation links.
   SMTP_HOST=smtp.example.com
   SMTP_PORT=587
   SMTP_SECURE=starttls
   SMTP_USER=assistant@example.com
   SMTP_PASSWORD=...
   SMTP_FROM=Niaro <assistant@example.com>
   ```

3. Point the DNS name at the machine and start both services:

   ```sh
   docker compose --profile https up -d
   ```

Caddy obtains and renews the certificate for the host in `NIARO_PUBLIC_URL`,
redirects HTTP to HTTPS, adds HSTS and forwards to `niaro:8793` with the Host
header unchanged. Starting with `--profile https` waits until the server is
healthy.

Any other reverse proxy works when it: serves exactly one origin (no path
prefix), preserves the `Host` header, terminates TLS, does not buffer streamed
responses, and is the only way into the server port. When the proxy is
trusted, the server counts rate limits by the last `X-Forwarded-For` address
when the request comes from a loopback or private-network peer. The compose
default `NIARO_TRUST_PROXY=auto` trusts it only when `NIARO_PUBLIC_URL` is
`https://…` (the `https` profile, Caddy in front); the plain-HTTP local trial
trusts no forwarded header. `1` or `0` decides explicitly; set `0` if the
server port is reachable any other way than through the proxy. Where other
containers share the proxy's network, `NIARO_TRUSTED_PROXIES` (IPs or CIDR
ranges, comma-separated) names the proxy's own addresses: only a request from
one of them is counted by `X-Forwarded-For`, any other peer by its own
address. No other forwarded header is trusted.

### Dokploy

`compose.dokploy.yml` runs the same image behind Dokploy's Traefik, which
terminates HTTPS; it has no Caddy and publishes no port. There is no published
image yet: Dokploy builds it from the GitHub repository
(`https://github.com/f-tuma/niaro.git`, branch `main`, or the branch, tag or
commit in `NIARO_GIT_REF`), so the file works without a checkout.

1. Create a **Docker Compose** service and paste `compose.dokploy.yml` as a
   raw compose (or point the service at this repository with compose path
   `./compose.dokploy.yml`). Redeploying rebuilds from the current ref.
2. **Environment**: `NIARO_PUBLIC_URL=https://assistant.example.com` (required,
   the deploy fails without it) and optionally the `SMTP_*` variables (see
   `.env.example`).
   The server profile is built into the image
   (`examples/self-hosted/server.dokploy.json` at `/app/profiles/dokploy.json`,
   name "Niaro", time zone Europe/Prague); it holds no secrets, providers,
   models and services are configured in administration. For your own profile
   add an **Advanced → Mounts** file mount and set `NIARO_CONFIG` to its path
   in the container, e.g. `/config/server.json`.
3. **Domains**: the host from `NIARO_PUBLIC_URL`, service `niaro`, container
   port `8793`, HTTPS with Let's Encrypt. The domain and `NIARO_PUBLIC_URL`
   must match: the server accepts only its public origin.
4. Deploy, then right away open `<public URL>/admin/` and create the owner
   account (see First run): the first person to sign up becomes the owner.
5. Microsoft 365 and other hosted MCP servers are added afterwards in
   administration (Hosted); they install on first start and need outbound
   access to the npm registry.

Traefik streams responses without buffering and sends `X-Forwarded-For`;
`NIARO_TRUST_PROXY=auto` trusts it because the public URL is HTTPS and the
server port is reachable only on Dokploy's network. That network is shared:
Traefik and every other application Dokploy runs on the host join it, and any
of their containers can reach port 8793 directly with an `X-Forwarded-For` of
its choosing. Rate limits (sign-in, app login, account endpoints) then count
whatever address it names, so it can spread its own attempts over made-up
addresses or spend another client's allowance. Nothing else trusts the header.
On a host that runs only applications you trust this is acceptable. Otherwise
pin the proxy: pass `NIARO_TRUSTED_PROXIES` into the `niaro` service's
`environment` with Traefik's address on `dokploy-network` (`docker inspect
dokploy-traefik`). Docker may give Traefik another address when its container
is recreated; until the variable is updated, every request then counts against
Traefik's own address, so people share one sign-in allowance. Re-check it after
Dokploy or Traefik updates. Data lives in the named
volume `niaro-data` (Dokploy's volume backups can copy it; `niaro backup` is
the consistent way, see below). Run one deployment per volume.

## First run: the owner account

A new installation has no account and needs no key: the first person who signs
up becomes the owner. The log says so while nobody has:

```text
No owner yet: open https://assistant.example.com/admin/ and create the owner account (the first account becomes the owner).
```

1. Right after deploying, open `<public URL>/admin/`. Until an account exists,
   the page shows **Set up your organization** instead of the sign-in.
2. Enter the organization name and the owner's name, email and password (at
   least 12 characters). The server creates the owner, the organization and a
   first workspace named like it, and signs the owner in (an ordinary account
   session). From then on the form is closed and the page signs in.
3. The overview's first-run checklist continues with provider, model, budget,
   services and invitations.

Anyone who reaches the URL before you could take the owner role, so create the
owner immediately after the first deploy (or keep the server unreachable until
you have). Setup requests are rate limited and accepted only from the console's
own origin.

The server also creates an administrator (recovery) key on the first start,
but stores only its SHA-256 digest (`/data/admin-key.json`) and never prints
it. It gives instance-level recovery access (it is not an organization
member): `docker compose exec niaro niaro admin-rotate-key` prints a new key to
your terminal (not to the logs), the old one stops working, and **Use a
recovery key** on the sign-in page accepts it. `niaro admin-key` only creates a
key when none exists; `niaro admin-key --initial` shows a first-start key that
an older version left in `/data/admin-key.initial`, once, and deletes it.

## Configuration reference (container)

The image sets these environment variables; compose sets the first group.

| Variable                                                                           | Default                           | Meaning                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NIARO_PUBLIC_URL`                                                                 | `http://localhost:8793` (compose) | The one public origin. Replaces `administration.identity.baseURL`. Must be `https://…` (any host), or `http://localhost:<listen.port>` for a local trial.                                                         |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | unset                             | Invitation and reset mail; replaces `identity.mail`. `SMTP_SECURE` is `true` (465), `starttls` (587) or `false` (loopback only).                                                                                  |
| `NIARO_CONFIG`                                                                     | `/config/server.json`             | Profile path inside the container.                                                                                                                                                                                |
| `NIARO_DATA`                                                                       | `/data`                           | Data volume, used by `niaro backup` / `niaro restore`.                                                                                                                                                            |
| `NIARO_LISTEN_HOST`                                                                | `0.0.0.0`                         | Overrides `listen.host`. A profile itself accepts only loopback; the image binds all interfaces of the container network so Caddy and port publishing can reach it. Allowed: `127.0.0.1`, `::1`, `0.0.0.0`, `::`. |
| `NIARO_LOG`                                                                        | `1`                               | Structured operator log lines on stdout (see Logs).                                                                                                                                                               |
| `NODE_ENV`                                                                         | `production`                      |                                                                                                                                                                                                                   |

Compose-only variables: `NIARO_CONFIG` (host path of the profile, default the
example), `NIARO_DATA_VOLUME` (volume name, default `niaro-data`),
`NIARO_IMAGE` (default `niaro:local`), `NIARO_TRUST_PROXY` (`auto`: trust the
bundled proxy's `X-Forwarded-For` only with an HTTPS public URL; `1` always,
`0` never; see Production behind HTTPS), `NIARO_TRUSTED_PROXIES` (the
proxy's own addresses, when other containers share its network; unset: any
loopback or private-network peer), `NIARO_MAX_CONCURRENT_RUNS`.

Profile (`examples/self-hosted/server.json`), container layout:

| Field                               | Container value                  | Notes                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen.port`                       | `8793`                           | Port inside the container; compose publishes it on `127.0.0.1:8793`.                                                                                                                                                                                           |
| `dataDirectory`                     | `/data/workflow`                 | Conversations, events, app sessions (`workflow.sqlite`, `auth/`).                                                                                                                                                                                              |
| `administration.keyFile`            | `/data/admin-key.json`           | Digest of the administrator key.                                                                                                                                                                                                                               |
| `administration.identity.directory` | `/data/identity`                 | `identity.sqlite` (accounts, organizations, catalog, budgets, audit, processes), `identity.sqlite.mastra.sqlite` (Mastra memory and runs), `secret` (encryption key for stored credentials), `meeting-audio/`, `hosted/`.                                      |
| `administration.identity.baseURL`   | overridden by `NIARO_PUBLIC_URL` |                                                                                                                                                                                                                                                                |
| `allowedOrigins`                    | `[]`                             | The public origin is added automatically; add other web client origins only.                                                                                                                                                                                   |
| `plugins.timeZone`                  | `Europe/Prague`                  | Default for date tools; workspaces can override.                                                                                                                                                                                                               |
| `administration.identity.hub`       | scheduler defaults               | `scheduler.intervalSeconds` (default 300, `0` turns the background refresh of hourly/daily overview widgets off), `scheduler.maxPerTick` (10 fills per pass), `scheduler.idleDays` (14: people who have not opened the overview for that long are left alone). |
| `adapters`                          | fixture / disabled / simulated   | Built-in legacy adapters; providers and models are configured in administration.                                                                                                                                                                               |

Private configuration files referenced by a profile (e.g. an OpenRouter or
Twenty config) must be mounted read-only, owned by uid 1000 and mode `0600`;
the server refuses group- or world-readable credentials. Mount them under
`/config/` and use absolute paths in the profile.

## Health checks and ports

| Port                      | Who                                        |
| ------------------------- | ------------------------------------------ |
| 8793/tcp in the container | The server. Published on `127.0.0.1` only. |
| 80, 443/tcp, 443/udp      | Caddy (`--profile https`).                 |

`GET /healthz` returns `{"status":"ok"}` while the process serves requests.
`GET /readyz` additionally checks that the workflow database answers and returns
503 otherwise. Both are unauthenticated, return no internals, are answered
before host and origin checks (so an orchestrator can call them over plain HTTP
on the container address) and are left out of the access log. The image's
`HEALTHCHECK` calls `/healthz` every 30 seconds (90 s start period); the
first start takes about 10 seconds.

## Logs

`docker compose logs niaro`. With `NIARO_LOG=1` (the image default) the server
writes one JSON object per line on stdout:

```json
{"time":"2026-10-16T20:48:23.855Z","level":"info","event":"http_request","method":"POST","path":"/admin/auth/sign-in/email","status":200,"ms":47}
{"time":"…","level":"info","event":"model_call","kind":"model","model":"<catalog model id>","workspace":"<id>","status":200,"inputTokens":812,"outputTokens":95,"ms":2140}
{"time":"…","level":"warn","event":"model_call","kind":"model","model":"…","workspace":"…","error":"catalog_budget_overrun","ms":3}
{"time":"…","level":"error","event":"http_error","path":"/v1/a/commands","error":"TypeError"}
```

- `http_request`: method, path, status, duration, `aborted` when the client
  went away. The query string is dropped and every path segment that could be
  an identifier or token (mixed case, several digits, long values) becomes
  `:id`. No IP addresses, user agents, cookies or headers.
- `model_call`: every catalog model call through the budget ledger, with
  token counts, provider status and duration; failures carry an error code.
  Never prompts, responses or keys.
- `http_error`: unexpected server errors, with the error class only.
- Existing plain-text lines: startup, worker recovery, voice and designer
  failures, service connection failures and rejected sign-in profiles. They
  carry codes, never tokens or message content.

The compose example rotates Docker logs at 5 × 20 MB. Set `NIARO_LOG=0` to turn
the structured lines off.

## Backup and restore

The backup is one `.tar.gz` of the whole volume with a manifest
(`niaro-backup.json`: SHA-256 of every file, list of databases). Every SQLite
database (identity, Mastra, workflow and any others in the volume) is copied
with SQLite's online backup API from a read-only connection, and each copy must
pass `PRAGMA integrity_check`. WAL/SHM side files, the single-owner lock files,
the npm cache of hosted servers and a first-start administrator key not yet
shown are left out. The copy is staged in a temporary directory inside the
volume (`.niaro-backup-…`, removed afterwards), so the volume needs free space
for one more copy of its databases; the container's `/tmp` is a small
in-memory filesystem.

While the server runs (each database is a consistent snapshot; the databases
are copied one after another within a second or so):

```sh
umask 077
docker compose exec -T niaro niaro backup - > niaro-$(date +%F-%H%M).tar.gz
```

For a single consistent point across all databases, stop the server first:

```sh
docker compose stop niaro
docker compose run --rm -T --no-deps niaro backup - > niaro-$(date +%F-%H%M).tar.gz
docker compose start niaro
```

The archive contains the identity `secret` (it decrypts stored provider and
service credentials) and all conversations. Store it encrypted and access
controlled, like the volume itself.

Restore into a new, empty volume (restore refuses a non-empty target, verifies
every checksum and runs `integrity_check` on every database):

```sh
docker volume create niaro-data-restored
docker run --rm -i -v niaro-data-restored:/data niaro:local restore - < niaro-2026-10-16-2200.tar.gz
docker compose stop niaro
NIARO_DATA_VOLUME=niaro-data-restored docker compose up -d   # or set it in .env
```

The previous volume stays untouched until you remove it. Without containers the
same scripts work on a data directory: `node scripts/backup.mjs <dir> <out.tar.gz | out-dir | ->`
and `node scripts/restore.mjs <backup> <empty-dir>`.

## Upgrade

```sh
umask 077
docker compose exec -T niaro niaro backup - > before-upgrade.tar.gz
git pull
docker compose build
docker compose up -d
docker compose ps        # wait for "healthy"
```

A newer image migrates the databases in place on start (schema creation and
upgrades run at startup). Roll back by restoring the pre-upgrade backup into a
new volume and starting the previous image on it; an older image may not read
data written by a newer one.

### Moving an existing non-container installation into a volume

The scripts compose a volume from the separate directories of a bare-metal
profile (e.g. `.fixture-calendar` as workflow, `.identity` as identity and the
admin key file). This also works while that server runs, without writing to it:

```sh
umask 077; mkdir stage
node scripts/backup.mjs .identity stage/identity
node scripts/backup.mjs .fixture-calendar stage/workflow
cp -p .servers/admin-key.json stage/admin-key.json
rm stage/*/niaro-backup.json
node scripts/backup.mjs stage niaro-import.tar.gz
docker volume create niaro-data
docker run --rm -i -v niaro-data:/data niaro:local restore - < niaro-import.tar.gz
```

Then write a container profile with the `/data/…` paths. Credential files used
by built-in adapters must be mounted separately (see above).

## Security notes

- **Owner setup**: open to anyone only while no account exists (the first
  account becomes the owner), same-origin only, rate limited (10 attempts per
  minute per address); closed for good once an account exists.
- **Administrator key**: created at the first start, never printed or written
  to the log, stored only as a digest, rate limited (10 attempts per minute per
  address). Get a usable one with `niaro admin-rotate-key`. It opens the
  recovery console, not company data.
- **HTTPS**: with an `https://` public URL the console only accepts that Host
  and Origin, direct plain-HTTP requests to `/admin` are rejected (403), and
  all session cookies are `Secure; HttpOnly; SameSite=Strict` with path
  `/admin` (verified through Caddy). Caddy adds HSTS.
- **CSP**: every page is served with `default-src 'none'`, `script-src 'self'`,
  per-response style nonces, `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `nosniff` and `no-referrer`. The bundle loads nothing from third parties.
- **Network**: keep port 8793 off public interfaces; the compose file publishes
  it on loopback only. With an HTTP public URL the server warns at startup.
- **Container**: non-root `node` user, application files read-only, data in
  `/data` with `0700` directories and `0600` files; `.dockerignore` is an
  allowlist, so local data, `.env` files and credentials never enter the build.
  The compose file also runs it with a read-only root filesystem (`read_only`;
  the server writes only to `/data` and a 512 MB `/tmp` tmpfs, where `tsx`
  keeps its compile cache and meeting audio is decoded in short pieces), `cap_drop: [ALL]` and `no-new-privileges`.
- **Concurrency**: `NIARO_MAX_CONCURRENT_RUNS` (default 8, at most 64) caps
  agent runs at once across everyone: chat turns and process runs. Each person
  has one chat or process run at a time plus one hub refresh beside it; further
  requests get a short "busy, try again" answer. Raise it with the provider's
  rate limits and the machine's memory in mind. The overview's scheduler
  (`administration.identity.hub.scheduler`) starts at most `maxPerTick` widget
  fills per pass, one per person, in those same hub lanes.
- **Rate limits behind a proxy**: when the proxy is trusted
  (`NIARO_TRUST_PROXY=auto` with an HTTPS public URL, or `1`) sign-in and app
  login limits (sign-in: 10 per minute; other account endpoints: 30 per
  minute) count each real client; the proxy's own address is used only when it
  sends no valid `X-Forwarded-For`.

## Not in the image

- **Docker for hosted MCP servers.** The image contains no Docker CLI and the
  socket is not mounted (that would give the container control of the host).
  Hosted templates such as Microsoft 365 (Administration → Hosted) then run as
  child processes of the server instead (`administration.identity.hosting.runtime`
  `"auto"`, or `NIARO_HOSTED_RUNTIME=process`): installed from their pinned
  lockfile into `/data/identity/hosted/`, bound to loopback, and confined by
  Node's permission model to their own directory, so they cannot read the
  server's data or start other programs. They share the server's user and
  network, so only the bundled, pinned templates run this way; custom servers
  still need Docker. See [docs/self-hosting.md](self-hosting.md#without-docker).
- **Local Whisper transcription** (`whisper.cpp` with a Whisper model) is not
  part of the image. The image carries only whisper.cpp's speech detection
  (v1.9.4, Silero v6.2.0, in `/app/voice`; the example profile points
  `administration.identity.voiceAssetsDirectory` at it), which chat voice
  needs to cut silence before it sends speech to the speech-to-text model
  chosen in administration. Meetings transcribe through that model and need
  only ffmpeg.
- Microsoft 365, CRM and other services are configured in administration and
  reached over HTTPS from the container; outbound access is required.

## Smoke test

`npm run smoke` ([`scripts/smoke/`](../scripts/smoke/)) checks a fresh
installation end to end. It builds the image (`niaro:smoke`; set
`NIARO_IMAGE=niaro:local` to use an existing one), starts it with the example
profile on a new volume and a free loopback port, hardened like the compose
example (`--read-only`, `--cap-drop ALL`, `no-new-privileges`), and always
removes the container and volume afterwards (`SMOKE_KEEP=1` leaves them for
inspection). It prints PASS / FAIL / SKIP per step and exits non-zero on any
failure.

- **Container**: `/healthz`, `niaro healthcheck`, the first start's setup hint
  with no key in the log, a recovery key from `niaro admin-rotate-key`, and at
  the end a log without passwords, tokens, message text or error lines.
- **API journey** (`api-journey.mjs`, plain `fetch` with a cookie jar per
  person): owner setup open to a signed-out visitor, the first visitor's
  bootstrap signing in as owner (then 409), recovery-key login, owner sign-in
  (overview `console: true`), workspace, invitation by link without SMTP,
  acceptance with a new password, member sign-in, organization detail, admin
  APIs refused to the member (403, overview `console: false`), the web app's
  chat credential (`app/session`) and with it the snapshot, a chat turn
  (`conversation.create` + `message.send`; with the example's fixture adapters
  the settled answer is "model not available", which counts: the turn must be
  terminal, not pending), tasks, the process inventory, the hub with its
  built-in tasks item, personal sign-ins and the account access list.
- **Browser journey** (`browser-journey.mjs`): the member signs in on `/`, sees
  the hub, sends a message and sees it and a settled answer, opens Tasks,
  Processes, Connections and Account, with no console errors and no horizontal
  scroll at 390 px; the owner signs in and opens `/admin/` with the setup
  checklist. Playwright is not a dependency of the repository: point
  `PLAYWRIGHT_CORE` at an installed `playwright-core` (or `playwright`) package
  and, if its own browser is not installed, `CHROMIUM` at a Chromium or
  `chrome-headless-shell` executable. Without them the browser part is skipped
  with a message.

```sh
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core npm run smoke
```

Screenshots, the build log and the container log (administrator key redacted)
are kept in `SMOKE_OUTPUT` (default: a new temporary directory).

## Verification (16 October 2026)

- `docker build` from the clean context: image `niaro:pilot-test`, 634 MB on
  disk, 132 MB compressed; runtime `node_modules` 228 MB (294 packages).
- Fresh volume: key printed once and not on later starts; `/healthz`,
  `/readyz`, `/`, `/admin/` 200; anonymous `/admin/api/overview` and
  `/v1/a/snapshot` 401; owner bootstrap, sign-in, workspace creation; container
  reports `healthy`.
- `docker compose --profile https` with Caddy (`https://localhost:18443`,
  internal CA): the same checks through HTTPS, `Secure` cookies, direct HTTP to
  `/admin` 403.
- Backup while running → restore into a new volume → new container: same
  organization, workspace, owner sign-in, server identity and administrator key.
- Upgrade: a copy of the development data (identity 4.5 MB with 3 users, Mastra
  123 messages / 17 threads, workflow 104 events, hosted server files) taken
  read-only from the running development server, restored into a volume and
  started with this image on an isolated network (`--network none`, so no
  provider, CRM or mail could be reached): healthy in about 10 s, schema
  migrated in place (three new identity tables: password resets and the hub),
  all existing row counts preserved, `integrity_check` ok on all three
  databases, `/healthz` and `/readyz` 200, anonymous overview and app API 401.
- Backup taken with the server stopped (`docker compose run --rm -T --no-deps
niaro backup -`), restored into a new volume and selected with
  `NIARO_DATA_VOLUME`: same data through HTTPS.
