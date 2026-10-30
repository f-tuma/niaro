# Deployment

How to install, configure, back up and upgrade a Niaro server. Behavior is
specified in [deployment](../../openspec/specs/deployment/spec.md). Setting
up providers, services, sign-in methods and people after the install is in
the [administration guide](administration.md).

## What runs where

One container image runs the whole server: the app API, the web app at `/`,
administration at `/admin`, the agent runtime and its storage. Everything the
server writes lives in one volume mounted at `/data`. A reverse proxy in front
(Caddy in `compose.yml`, Traefik on Dokploy) terminates HTTPS.

| Piece                     | File                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Image                     | [`Dockerfile`](../../Dockerfile), [`.dockerignore`](../../.dockerignore)                             |
| Compose                   | [`compose.yml`](../../compose.yml), [`compose.dokploy.yml`](../../compose.dokploy.yml)               |
| Environment example       | [`.env.example`](../../.env.example)                                                                 |
| Server profile (optional) | [`examples/self-hosted/server.json`](../../examples/self-hosted/server.json)                         |
| HTTPS proxy               | [`examples/self-hosted/Caddyfile`](../../examples/self-hosted/Caddyfile)                             |
| Backup and restore        | [`scripts/backup.mjs`](../../scripts/backup.mjs), [`scripts/restore.mjs`](../../scripts/restore.mjs) |

For a development checkout without containers see the
[development guide](development.md).

## Requirements and sizing

- Docker Engine with Compose v2 on x86-64 Linux.
- A DNS name and ports 80 and 443 reachable from the internet (for the
  certificate), or an internal CA.
- Memory: the server idles at about 450 MB. Plan 1 GB for a pilot of tens of
  people; the compose files set a 2 GB limit. Model calls run at the provider.
- CPU: one or two cores.
- Disk: the image is about 630 MB. Data grows with conversations, the activity
  log, agent memory and meeting audio; keep 1 GB free plus room for backups.
- One container per data volume. There are no replicas.

## Install with compose

```sh
git clone <repository> niaro && cd niaro
docker compose build
```

### Trial on one machine

```sh
docker compose up -d
```

Open `http://localhost:8793/admin/` and create the owner (see
[First run](#first-run)). The port is published on `127.0.0.1` only.

### Production behind HTTPS (Caddy)

1. Optional: copy the profile and adjust it. Without one, the server builds the
   [automatic profile](#automatic-profile).

   ```sh
   mkdir -p config && cp examples/self-hosted/server.json config/server.json
   ```

2. Create `.env` next to `compose.yml`, mode `0600`:

   ```sh
   NIARO_PUBLIC_URL=https://assistant.example.com
   NIARO_CONFIG=./config/server.json      # only with your own profile
   # Optional invitation and reset mail; without it administrators copy links.
   SMTP_HOST=smtp.example.com
   SMTP_PORT=587
   SMTP_SECURE=starttls
   SMTP_USER=assistant@example.com
   SMTP_PASSWORD=...
   SMTP_FROM=Niaro <assistant@example.com>
   ```

3. Point the DNS name at the machine and start the server with Caddy:

   ```sh
   docker compose --profile https up -d
   ```

Caddy starts once the server is healthy, obtains the certificate for the host
in `NIARO_PUBLIC_URL` and forwards to `niaro:8793`.

### Other reverse proxies

Any proxy works when it:

- serves exactly one origin, without a path prefix;
- preserves the `Host` header;
- terminates TLS;
- does not buffer streamed responses;
- is the only way into the server port.

Rate limits count clients by `X-Forwarded-For` only when the proxy is trusted:

| `NIARO_TRUST_PROXY` | Effect                                                                    |
| ------------------- | ------------------------------------------------------------------------- |
| `auto` (compose)    | Trust the proxy only when `NIARO_PUBLIC_URL` is `https://…`.              |
| `1`                 | Always trust a loopback or private-network peer.                          |
| `0` (or unset)      | Never. Use this if the server port is reachable other than via the proxy. |

When other containers share the proxy's network, set `NIARO_TRUSTED_PROXIES`
to the proxy's own addresses (IPs or CIDR ranges, comma-separated). Only those
peers may then name the client.

## Dokploy

`compose.dokploy.yml` runs the same image behind Dokploy's Traefik. It has no
Caddy and publishes no port. Dokploy builds the image from the GitHub
repository at `NIARO_GIT_REF` (default `main`).

1. Create a **Docker Compose** service. Paste `compose.dokploy.yml` as raw
   compose, or point the service at the repository with compose path
   `./compose.dokploy.yml`. Redeploying rebuilds from the current ref.
2. **Environment**: `NIARO_PUBLIC_URL=https://assistant.example.com`
   (required). Optional: `NIARO_NAME`, `NIARO_TIME_ZONE`, `SMTP_*`.
   No profile or file mount is needed. To use your own profile, add an
   **Advanced → Mounts** file mount and set `NIARO_CONFIG` to its path in the
   container, for example `/config/server.json`.
3. **Domains**: the host from `NIARO_PUBLIC_URL`, service `niaro`, port
   `8793`, HTTPS with Let's Encrypt. The domain must equal the public URL.
4. Deploy, then at once open `<public URL>/admin/` and create the owner.

Every application Dokploy runs joins `dokploy-network`, and any of their
containers can reach port 8793 with an `X-Forwarded-For` of its choosing. On a
host that runs only applications you trust this is acceptable. Otherwise pin
the proxy: add `NIARO_TRUSTED_PROXIES` with Traefik's address on that network
(`docker inspect dokploy-traefik`). Re-check it after Dokploy or Traefik
updates; until it is updated, everyone shares Traefik's sign-in allowance.

Data lives in the named volume `niaro-data`. Use `niaro backup` (below) for a
consistent copy.

## First run

A new installation has no account. The first person who signs up becomes the
owner, so do it right after the first deploy (or keep the server unreachable
until you have). The log says so while nobody has:

```text
No owner yet: open https://assistant.example.com/admin/ and create the owner account (the first account becomes the owner).
```

1. Open `<public URL>/admin/`. The page shows **Set up your organization**.
2. Enter the organization name and the owner's name, email and password.
3. Continue with the Overview checklist; see the
   [administration guide](administration.md).

The recovery key is stored only as a digest and never printed. To get a usable
one (the old one stops working):

```sh
docker compose exec niaro niaro admin-rotate-key
```

Use it with **Use a recovery key** on the sign-in page. Keep it out of
screenshots and tickets. Behavior: [identity-access](../../openspec/specs/identity-access/spec.md).

## Configuration reference

### Environment

Read by the server (image or `pnpm server`):

| Variable                                                                           | Default (image)                          | Meaning                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NIARO_PUBLIC_URL`                                                                 | compose: `http://localhost:8793`         | The one public origin. `https://…`, or `http://localhost:<port>` for a trial. Replaces `baseURL`.   |
| `NIARO_CONFIG`                                                                     | `/config/server.json`                    | Profile path in the container. No file there: automatic profile.                                    |
| `NIARO_NAME`, `NIARO_TIME_ZONE`, `NIARO_PORT`                                      | `Niaro`, `TZ` or `Europe/Prague`, `8793` | Automatic profile only. Name and time zone can be changed later in administration.                  |
| `NIARO_DATA`                                                                       | `/data`                                  | Data directory; also used by `niaro backup` and `niaro restore`.                                    |
| `NIARO_LISTEN_HOST`                                                                | `0.0.0.0`                                | Overrides `listen.host`: `127.0.0.1`, `::1`, `0.0.0.0` or `::`.                                     |
| `NIARO_LOG`                                                                        | `1`                                      | `1` writes structured log lines; any other value turns them off.                                    |
| `NIARO_TRUST_PROXY`, `NIARO_TRUSTED_PROXIES`                                       | compose: `auto`, unset                   | See [Other reverse proxies](#other-reverse-proxies).                                                |
| `NIARO_MAX_CONCURRENT_RUNS`                                                        | `8`                                      | Agent runs at once across everyone, 1–64. Raise with the provider's rate limits and memory in mind. |
| `NIARO_HOSTED_RUNTIME`                                                             | profile (`auto`)                         | Installed connectors: `auto`, `docker` or `process`.                                                |
| `NIARO_PLUGIN_EDITING`                                                             | profile (on)                             | `0` makes plugin files read-only in administration.                                                 |
| `NIARO_DIARIZATION_TOKEN`                                                          | compose: `DIARIZER_TOKEN`                | Token for the diarization service.                                                                  |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | unset                                    | Mail; see [Mail](#mail).                                                                            |

Compose only: `NIARO_DATA_VOLUME` (volume name, default `niaro-data`),
`NIARO_IMAGE` (default `niaro:local`), `NIARO_GIT_REF` (Dokploy build ref),
and for diarization `HF_TOKEN`, `DIARIZER_TOKEN`, `DIARIZER_THREADS`,
`DIARIZER_MEMORY`, `DIARIZER_IMAGE`, `COMPOSE_PROFILES`.

### Automatic profile

Without a profile file the server builds one from the environment
(`NIARO_PUBLIC_URL` required):

| Field                               | Value                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| `name`                              | `NIARO_NAME`, default `Niaro`                             |
| `listen`                            | `NIARO_PORT` or `8793`                                    |
| `dataDirectory`                     | `$NIARO_DATA/workflow`                                    |
| `administration.keyFile`            | `$NIARO_DATA/admin-key.json`                              |
| `administration.identity.directory` | `$NIARO_DATA/identity`                                    |
| `voiceAssetsDirectory`              | `/app/voice` when it exists (in the image)                |
| `plugins`                           | `datetime` and `memory`; time zone from `NIARO_TIME_ZONE` |
| `adapters`                          | fixture / disabled / disabled / simulated                 |

### Profile file

Container layout of [`examples/self-hosted/server.json`](../../examples/self-hosted/server.json).
Paths in a profile resolve relative to the profile file.

| Field                                        | Container value                                       | Notes                                                                                             |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `listen.port`                                | `8793`                                                | Published on `127.0.0.1:8793` by compose.                                                         |
| `dataDirectory`                              | `/data/workflow`                                      | Conversations, events, app sessions.                                                              |
| `administration.keyFile`                     | `/data/admin-key.json`                                | Digest of the recovery key.                                                                       |
| `administration.identity.directory`          | `/data/identity`                                      | Identity and agent databases, the `secret`, `meeting-audio/`, `hosted/`, `plugins/`.              |
| `administration.identity.baseURL`            | `NIARO_PUBLIC_URL` replaces it                        |                                                                                                   |
| `allowedOrigins`                             | `[]`                                                  | Extra web client origins for the app API. The public origin is added automatically.               |
| `administration.identity.integrationOrigins` | `[]`                                                  | Private or local origins that services and AI endpoints may reach, e.g. `http://127.0.0.1:11434`. |
| `administration.identity.mail`               | unset                                                 | See [Mail](#mail).                                                                                |
| `administration.identity.hosting`            | `allowCustom`, `runtime`                              | See [Installed connectors](#installed-connectors-without-docker).                                 |
| `administration.identity.meetings`           | defaults                                              | Retention, chunk length, glossary, diarization. Editable in administration.                       |
| `administration.identity.hub.scheduler`      | `intervalSeconds` 300, `maxPerTick` 10, `idleDays` 14 | Overview background refresh; `intervalSeconds: 0` turns it off. Editable in administration.       |
| `plugins.timeZone`                           | `Europe/Prague`                                       | Default time zone for date tools.                                                                 |
| `adapters`                                   | fixture / disabled / simulated                        | Legacy built-in adapters. Providers and models are set in administration.                         |

Validate a profile without contacting any provider:

```sh
docker compose run --rm --no-deps niaro check
```

### Private files

Files a profile references (for example a legacy adapter's credentials) must
be owned by uid 1000, mode `0600`, mounted read-only under `/config/` and named
by absolute path. The server refuses group- or world-readable credentials.

### Mail

Invitation and password-reset mail goes over SMTP. With `SMTP_HOST` set, the
`SMTP_*` variables replace `administration.identity.mail` from the profile, so
the password stays out of the JSON.

| `SMTP_SECURE` | Meaning                                                |
| ------------- | ------------------------------------------------------ |
| `true`        | Implicit TLS, usually port 465 (default).              |
| `starttls`    | STARTTLS on port 587; fails rather than send in clear. |
| `false`       | Plain SMTP, accepted only for a loopback host.         |

The same in a profile:

```json
"administration": {
  "identity": {
    "mail": {
      "host": "smtp.example.com",
      "port": 587,
      "starttls": true,
      "secure": false,
      "from": "Niaro <assistant@example.com>",
      "user": "assistant@example.com",
      "password": "..."
    }
  }
}
```

Without mail settings, administrators copy invitation and reset links. For a
local mail sink see the [development guide](development.md#invitation-mail-and-mailpit).

### Settings in administration

Owners and administrators change some profile values in administration →
**Settings**: name, time zone, meetings, Overview refresh and the two origin
lists. Saved values win over the profile. **Export** and **Import** move them
between servers as a JSON file without secrets. Details:
[administration](../../openspec/specs/administration/spec.md) and the
[administration guide](administration.md).

### Plugins

Built-in plugins ship read-only in `/app/plugins/`. Plugins added or edited in
administration → **Built-in tools**, or copied in by the operator, live in
`/data/identity/plugins/<id>/` (`plugin.json` and `index.ts`) and are part of
the volume and its backup. Plugins run inside the server process; set
`NIARO_PLUGIN_EDITING=0` where the organization owner is not the operator.
Writing plugins: [plugins guide](plugins.md). Behavior:
[plugins](../../openspec/specs/plugins/spec.md).

## Ports and health checks

| Port                 | Who                                        |
| -------------------- | ------------------------------------------ |
| 8793/tcp             | The server. Published on `127.0.0.1` only. |
| 80, 443/tcp, 443/udp | Caddy (`--profile https`).                 |

- `GET /healthz`: the process serves requests.
- `GET /readyz`: the workflow database also answers; 503 otherwise.

Both are unauthenticated and work over plain HTTP on the container address.
The image's `HEALTHCHECK` runs `niaro healthcheck` every 30 s with a 90 s
start period.

## Logs

```sh
docker compose logs niaro
```

With `NIARO_LOG=1` (image default) the server writes one JSON object per line:
`http_request`, `model_call` and `http_error` events. Other lines are plain
text. The compose files rotate Docker logs at 5 × 20 MB. What a line contains
and never contains: [deployment](../../openspec/specs/deployment/spec.md).

## Backup and restore

A backup is one `.tar.gz` of the whole volume with a checksum manifest. It
works while the server runs; each database is a consistent snapshot. The
backup is staged inside the volume, so keep free space for one more copy of
the databases.

```sh
umask 077
docker compose exec -T niaro niaro backup - > niaro-$(date +%F-%H%M).tar.gz
```

For one consistent point across all databases, stop the server first:

```sh
docker compose stop niaro
docker compose run --rm -T --no-deps niaro backup - > niaro-$(date +%F-%H%M).tar.gz
docker compose start niaro
```

Back up the identity directory as a unit: the `secret` and a consistent
database snapshot together. A database copy without its `secret` cannot
decrypt stored provider and service credentials. The archive also holds every
conversation and the meeting audio. Store it encrypted, access-controlled and
off the server, and test a restore.

Restore into a new, empty volume:

```sh
docker volume create niaro-data-restored
docker run --rm -i -v niaro-data-restored:/data niaro:local restore - < niaro-backup.tar.gz
docker compose stop niaro
NIARO_DATA_VOLUME=niaro-data-restored docker compose up -d   # or set it in .env
```

The old volume stays untouched until you remove it. Without containers the
same scripts work on a directory:

```sh
node scripts/backup.mjs <data-dir> <out.tar.gz | out-dir | ->
node scripts/restore.mjs <backup> <empty-dir>
```

## Upgrade and rollback

```sh
umask 077
docker compose exec -T niaro niaro backup - > before-upgrade.tar.gz
git pull
docker compose build
docker compose up -d
docker compose ps        # wait for "healthy"
```

The new image migrates the databases on start. To roll back, restore the
pre-upgrade backup into a new volume and start the previous image on it. An
older image may not read data written by a newer one.

## Moving a non-container install into a volume

Compose a volume from the separate directories of a bare-metal profile. This
works while that server runs and does not write to it:

```sh
umask 077; mkdir stage
node scripts/backup.mjs <identity-dir> stage/identity
node scripts/backup.mjs <workflow-dir> stage/workflow
cp -p <key-file> stage/admin-key.json
rm stage/*/niaro-backup.json
node scripts/backup.mjs stage niaro-import.tar.gz
docker volume create niaro-data
docker run --rm -i -v niaro-data:/data niaro:local restore - < niaro-import.tar.gz
```

Then use a container profile with the `/data/…` paths, or the automatic
profile. Mount private credential files separately.

## Installed connectors without Docker

The image has no Docker CLI and the socket is not mounted. Installed
connectors (administration → **Installed connectors**) from npm definitions
then run as confined child processes of the server; image definitions need
Docker. Any other MCP server runs as its own compose service. Setup, the
runtime choice and the compose example: [installed connectors](hosted-connectors.md).
They install on first start and need outbound access to the npm registry.

## Optional speaker diarization

A separate CPU service, `services/diarizer`, numbers the voices in meeting
transcripts. Behavior: [meetings](../../openspec/specs/meetings/spec.md).

1. Create a Hugging Face account, accept the terms of
   `pyannote/speaker-diarization-community-1` on its model page and create a
   read token.
2. Add to `.env` (or Dokploy **Environment**):

   ```sh
   COMPOSE_PROFILES=diarization
   HF_TOKEN=hf_...
   DIARIZER_TOKEN=<random shared secret>
   # Optional
   DIARIZER_THREADS=0      # CPU threads, 0 = all
   DIARIZER_MEMORY=4g      # container memory limit
   ```

   Compose passes `DIARIZER_TOKEN` to the server as `NIARO_DIARIZATION_TOKEN`.

3. Start it:

   ```sh
   docker compose --profile diarization up -d --build
   ```

   With `--profile https` as well in production. On Dokploy, redeploy; the
   service runs on the project's own network, not on `dokploy-network`.

4. Turn it on in administration → **Settings** → **Meetings** → **Tell voices
   apart**; see [telling voices apart](administration.md#telling-voices-apart).

The image is about 2 GB; the model (about 30 MB) is downloaded once into the
`diarizer-models` volume. A two-hour meeting needs about 2 GB of memory on top
of the model. To switch it off, leave out the profile or remove the
`diarizer` service.

## Not in the image

- Docker for installed connectors (see above).
- Local Whisper transcription. The image carries only the speech detection
  that chat voice uses before it sends speech to the model chosen in
  administration, plus ffmpeg for meetings.
- Company services and model providers: they are reached over HTTPS, so the
  container needs outbound access.

## Smoke test

`npm run smoke` builds the image (`niaro:smoke`), starts it hardened on a new
volume and a free loopback port, runs an API journey and a browser journey,
prints PASS / FAIL / SKIP per step, removes the container and volume, and exits
non-zero on any failure.

```sh
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core npm run smoke
```

| Variable                                     | Effect                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `NIARO_IMAGE=niaro:local`                    | Use an existing image instead of building.                             |
| `PLAYWRIGHT_CORE`                            | An installed `playwright-core` (or `playwright`) for the browser part. |
| `CHROMIUM`                                   | Browser executable, if Playwright's own is not installed.              |
| `SMOKE_SKIP_BROWSER=1`                       | Skip the browser part (skipped anyway without Playwright).             |
| `SMOKE_PORT`, `SMOKE_OUTPUT`, `SMOKE_KEEP=1` | Port, output directory for screenshots and logs, keep the container.   |

## Security checklist

- Create the owner right after the first deploy.
- Keep port 8793 off public interfaces; reach it only through the proxy.
- Use an `https://` public URL in production.
- Set `NIARO_TRUST_PROXY=0` if the server port is reachable other than via the
  proxy; set `NIARO_TRUSTED_PROXIES` where other containers share its network.
- Keep `.env` and private profile files `0600`, outside version control.
- Store backups encrypted and access-controlled; they contain the `secret`.
- Keep the compose hardening (`read_only`, `cap_drop: [ALL]`,
  `no-new-privileges`).
- Set `NIARO_PLUGIN_EDITING=0` and `hosting.allowCustom: false` where the
  organization owner should not run code on the server.
- Rotate the recovery key after anyone who knew it leaves.

## Optional S3 attachment storage foundation

See [private object storage](object-storage.md) for exact operator settings, mounted secrets, the offline `check` versus explicit `storage-check`, and repeat-safe `storage-bootstrap`. Both Compose files offer the opt-in `object-storage` profile with pinned RustFS, a private persistent volume and a separately scoped application principal. External S3 deployments leave that profile disabled. Root/bootstrap credentials are never passed to Niaro. The local API binds loopback; Dokploy publishes no storage ports and the console is disabled.

This checkpoint does not activate attachment upload/UI or change meeting audio. Niaro metadata remains under its single data directory; S3 originals are an additional external persistence/backup dependency. A Niaro-volume backup does not contain those bytes, and coordinated attachment manifests/quiescence/restore verification remain later feature work. Storage location replacement is refused while retained/uncertain reservations remain; no force-reset or unknown-PUT reconciliation command is provided in this phase.
