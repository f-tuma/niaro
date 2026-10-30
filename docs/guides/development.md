# Development

How to run, change and check Niaro from a source checkout. Current behavior is
in [`openspec/specs`](../../openspec/specs); lasting design decisions are in
[architecture](../architecture.md). For container installs see
[deployment](deployment.md).

## Prerequisites

- Node 22.13 or newer.
- pnpm through Corepack (`corepack enable`); the version is pinned in
  `package.json`.
- A local persistent filesystem.
- For native app builds: the Android SDK, or Xcode on a Mac.
- Optional: Docker (Mailpit, smoke test, installed connectors), ffmpeg
  (meeting tests), cmake and a C++ compiler (`voice:install`).

## Local first run

```sh
pnpm install --frozen-lockfile
pnpm admin:build
mkdir -p .servers/local
cp examples/self-hosted/server.local.json .servers/local/server.json
npm run server:check -- .servers/local/server.json
npm run server -- .servers/local/server.json
```

1. Open `http://localhost:8793/admin/` and create the organization and its
   owner. The first account becomes the owner.
2. Add an AI provider, assign a model and add services; see the
   [administration guide](administration.md).
3. Open `http://localhost:8793/` for the web app.

Notes:

- Start the server from the repository root; it serves `dist-admin` from
  there and reads the console assets at startup. Restart it after
  `pnpm admin:build`.
- `SERVER_PROFILE=.servers/local/server.json` in the root `.env` makes the
  profile the default for `pnpm server` and `pnpm server:check`. An explicit
  argument wins.
- Keep the `NIARO_*` deployment variables commented in a development `.env`:
  the server reads it, and `NIARO_PUBLIC_URL` would replace the profile's
  `baseURL`.
- `server:check` validates the profile and its files without contacting any
  provider.
- `npm run server:admin-rotate-key -- .servers/local/server.json` prints a
  recovery key.
- Only one server may own a data directory at a time.
- Keep `.servers/` and every private profile, key and database out of version
  control.

## Running without containers

For a long-running install without Docker:

- Set `administration.identity.baseURL` to the one HTTPS origin, for example
  `https://assistant.example.com`, and keep the server on `127.0.0.1:8793`.
- Put Caddy in front with [the example Caddyfile](../../examples/self-hosted/Caddyfile):
  export `NIARO_PUBLIC_URL` or replace the placeholders. Caddy must preserve
  `Host` and forward to the loopback address.
- Run the server under a service manager as an unprivileged, dedicated user,
  with restart on failure and a shutdown grace period longer than an outbound
  request.
- Profile paths resolve relative to the profile file. Keep the identity and
  workflow directories separate; the identity directory is `0700`, private
  files `0600`, owned by the server's user.
- Origin lists (`allowedOrigins`, `integrationOrigins`) and mail: see the
  [configuration reference](deployment.md#configuration-reference).
- Backups: `node scripts/backup.mjs` and `node scripts/restore.mjs`; see
  [deployment](deployment.md#backup-and-restore).

## Legacy adapter profiles

A profile's `adapters` block configures the built-in legacy adapters. Models
and services for chat are configured in administration instead.

| Adapter  | Configuration                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model    | `{ "provider": "fixture" }` or `{ "provider": "openrouter", "configFile": "…" }`                                                                                   |
| Voice    | `{ "provider": "disabled" }`, `{ "provider": "whisper.cpp", "assetsDirectory": "…" }` or `{ "provider": "openrouter", "assetsDirectory": "…", "configFile": "…" }` |
| CRM      | `{ "provider": "disabled" }` or `{ "provider": "twenty-test", "configFile": "…" }`                                                                                 |
| Calendar | `{ "provider": "simulated" }` or `{ "provider": "caldav", "configFile": "…" }`                                                                                     |

- Paths resolve relative to the profile, not the launch directory.
- Credentials live in separate owner-only files (`0600`), never inline.
- A CRM adapter needs a non-fixture model adapter.
- `servers/personal.json` and `servers/team.json` are two independent
  instances (ports 8794 and 8795) with their own data directories.

## Invitation mail and Mailpit

Mailpit is a local SMTP sink; it never forwards mail.

```sh
npm run mailpit:start      # inbox http://localhost:8025, SMTP 127.0.0.1:1025
npm run test:mailpit       # sends a synthetic invitation and checks the link
npm run mailpit:stop
```

Point the server at it in `.env`:

```sh
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=assistant@localhost.test
```

Plain SMTP is accepted only for a loopback host. Other mail settings:
[deployment](deployment.md#mail).

## Voice assets

Chat voice on a source checkout needs the local speech detection:

```sh
npm run voice:install
```

It builds a pinned whisper.cpp in `.voice/` (needs git, cmake, a C++
compiler and curl) and downloads checksummed models. Set
`administration.identity.voiceAssetsDirectory` to that directory, relative to
the profile. The container image ships these assets already.

## Console and web app work

The web app and administration are one Vite app in `apps/server-admin`
(React, TanStack Router and Query, shadcn/ui, Tailwind CSS v4). `pnpm
admin:build` writes `dist-admin`, which the server serves.

Hot reload against a running server:

```sh
npx vite --config apps/server-admin/vite.config.ts
# open http://localhost:5174/admin/
```

The dev server proxies `/admin/api/` and `/admin/auth/` to
`http://localhost:8793`; set `ADMIN_API_ORIGIN` for another server.

- Add official components with `npx shadcn add <component> --cwd apps/server-admin`
  (configuration in `apps/server-admin/components.json`).
- `@shadcn/lint` runs in `pnpm lint`. Follow
  [`apps/server-admin/DESIGN.md`](../../apps/server-admin/DESIGN.md) and
  [the UI system](../ui-system.md).

### Web app routes

The server gives the app shell only to these paths (`APP_ROUTE` in
`apps/server-admin/http.ts`); everything else, including `/v1`, stays with
the API. The public account pages `/account/login`, `/account/invite` and
`/account/reset` are `ACCOUNT_ROUTE`.

| Path                | Page                                                  | Spec                                                                    |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `/`                 | Overview                                              | [hub](../../openspec/specs/hub/spec.md)                                 |
| `/chat`             | New chat; becomes `/chat/:id` after the first message | [chat](../../openspec/specs/chat/spec.md)                               |
| `/chat/:id`         | A saved chat                                          | [chat](../../openspec/specs/chat/spec.md)                               |
| `/tasks`            | Open and done tasks                                   | [tasks](../../openspec/specs/tasks/spec.md)                             |
| `/meetings`         | Meetings; `/meetings/:id` is one meeting              | [meetings](../../openspec/specs/meetings/spec.md)                       |
| `/processes`        | Processes to start, recent runs, personal processes   | [process-execution](../../openspec/specs/process-execution/spec.md)     |
| `/processes/design` | Process designer                                      | [process-design](../../openspec/specs/process-design/spec.md)           |
| `/processes/:id`    | A personal process: versions, tests, activation       | [process-definitions](../../openspec/specs/process-definitions/spec.md) |
| `/skills`           | Skills; `/skills/:id` edits one                       | [skills](../../openspec/specs/skills/spec.md)                           |
| `/connections`      | Personal sign-ins; `/connections/:id` is one service  | [service-sign-in](../../openspec/specs/service-sign-in/spec.md)         |
| `/search`           | Search in chats and meetings                          | [chat-search](../../openspec/specs/chat-search/spec.md)                 |
| `/me`               | Account: password, devices, sessions, archived chats  | [identity-access](../../openspec/specs/identity-access/spec.md)         |
| `/admin/…`          | Administration                                        | [administration](../../openspec/specs/administration/spec.md)           |

### Adding a hub widget type

A widget type is two modules:

1. A protocol module `packages/protocol/widgets/<type>.ts` built with
   `defineWidget` (`define.ts`), added to `HUB_WIDGET_TYPES` in
   `packages/protocol/widgets/index.ts`. It exports `type`, `version` (bump it
   when the data schema changes incompatibly), `fill` (`ai`, `server` or
   `client`), `name` and `description` (cs/en), the bounded `data` schema,
   `config` with `defaultConfig`, `size`, default `refresh`, for AI types
   `brief`, `guide` and `describeConfig`, and `sample(language)` for the
   gallery preview. Use the helpers in `define.ts` (`widgetText`,
   `widgetDateTime`, `widgetLink`, …) so every list and string is bounded and
   links are `http(s)` only.
2. A web renderer `apps/server-admin/web/app/widgets/<type>.tsx` exporting
   `{type, icon, Body, Config?, describe?}`, added to `RENDERERS` in
   `apps/server-admin/web/app/widgets/index.ts`.

Nothing else changes: the server, the agent tools and the gallery read the
registry. `tests/hub-widgets.node.ts` checks every registered type. Behavior:
[hub](../../openspec/specs/hub/spec.md).

## Mobile development

The app (`apps/mobile`, Expo) uses custom native modules, so use its
development build, not Expo Go.

```sh
pnpm android --device      # build and install on an Android phone
pnpm ios                   # on a Mac
pnpm web                   # browser preview on http://localhost:8081
```

Rebuild after changing native dependencies, permissions or modules; a
JavaScript reload cannot add them. For the browser preview, add
`http://localhost:8081` to `allowedOrigins` and restart the server.

All Expo, build and Storybook scripts set `EXPO_NO_DOTENV=1`: the root `.env`
belongs to the server. Pass any public client variables to the command
explicitly.

### Over Wi-Fi

```sh
pnpm start --lan --port 8081
```

Check `http://<computer-LAN-IP>:8081/status` from the phone's browser; it
returns `packager-status:running`. Then scan the QR code in the development
build. A timeout means the phone cannot reach Metro: check the network, client
isolation on the Wi-Fi and the computer's firewall. With UFW, allow only the
LAN interface, subnet and port, for example:

```sh
sudo ufw allow in on eth0 from 192.168.1.0/24 to 192.168.1.20 port 8081 proto tcp comment 'Expo dev LAN'
```

### Over Tailscale or an Expo tunnel

```sh
REACT_NATIVE_PACKAGER_HOSTNAME=$(tailscale ip -4) pnpm start --lan --port 8081 --scheme agentclient
pnpm start --tunnel --port 8081      # without Tailscale; needs @expo/ngrok
```

Stop a running Metro before starting another mode on the same port.

### Meeting recorder on a device

```sh
pnpm android   # or pnpm ios: rebuild after recorder changes
```

Android needs microphone and notification permission; iOS needs microphone
permission and the audio background mode. To exercise the native recorder
without a server:

```sh
MEETING_RECORDER_QA=1 EXPO_NO_DOTENV=1 npx expo start --dev-client --port 8081
adb reverse tcp:8081 tcp:8081
```

See [`spikes/meeting-recorder/README.md`](../../spikes/meeting-recorder/README.md).

## Checks and test suites

Tests use synthetic data, local transports and isolated servers. Live
provider, CRM and voice scripts are opt-in and never run in CI.

```sh
pnpm check            # lint, boundaries, types, Jest and test:identity
pnpm admin:build      # console and web app bundle
pnpm build            # app export for web, iOS and Android
pnpm storybook:web    # component catalog of the app's cards (port 8082)
pnpm format           # Prettier
```

Server suites (`node --test`):

| Script                                            | Covers                                                      |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `test:identity`                                   | The full server suite that `check` runs                     |
| `test:agent`                                      | Agent runtime, approvals, streaming, crash regressions      |
| `test:mcp`                                        | MCP transport, OAuth and the MCP endpoint                   |
| `test:processes`                                  | Process registry, design, tests, execution and recovery     |
| `test:budget`                                     | Usage ledger, policy HTTP, budget failures                  |
| `test:saved-memory`                               | Saved memory                                                |
| `test:meetings`                                   | Meeting upload, transcription pipeline, record, diarization |
| `test:deployment`                                 | Container environment, probes, logs, backup and restore     |
| `test:global-processes`                           | Workspace and personal processes                            |
| `test:legacy-inventory`, `test:legacy-continuity` | Legacy run inventory and continuity                         |

Process subsets, for faster loops:

```text
test:process-design       test:process-contract     test:process-native
test:process-activation   test:process-console      test:process-start
test:process-execution    test:process-coordinator  test:process-projection
test:process-questions    test:process-mobile-http  test:process-pipeline-http
test:process-restore      test:process-output
```

CI splits a suite into shards with
`node scripts/ci-node-tests.mjs <script> <index>/<total>`.

### Browser checks

These use an installed Playwright; nothing is added to the repository.

```sh
NIARO_PLAYWRIGHT_MODULE=/abs/path/to/playwright/index.mjs pnpm test:process-mobile-web
NIARO_PLAYWRIGHT_MODULE=… pnpm test:process-pipeline-web
NIARO_PLAYWRIGHT_MODULE=… pnpm test:chat-history-web
NIARO_PLAYWRIGHT_MODULE=… node --import tsx scripts/meetings-web-qa.mjs
```

Screenshots go to `NIARO_PROCESS_QA_OUTPUT`, `NIARO_PIPELINE_QA_OUTPUT`,
`NIARO_CHAT_QA_OUTPUT` or `NIARO_MEETING_QA_OUTPUT`.
`NIARO_PIPELINE_QA_OWNER=workspace` runs the pipeline check with a workspace
process instead of a personal one. The container smoke test is in
[deployment](deployment.md#smoke-test).

### Agent trust runner

`eval:trust` runs whole conversations against the real runtime, stores and
catalog with a scripted model and synthetic services. It reads no server
profile or key and makes no network requests. It measures application
mechanics, not model quality.

```sh
pnpm eval:trust --list
pnpm eval:trust --json /tmp/agent-trust-report.json
pnpm eval:trust --scenario loop.clarification-after-restart
pnpm eval:trust --allow-known-gaps
```

Exit codes: `0` passed; `1` an assertion, setup, cleanup or deadline failed;
`2` a recorded capability gap remains (`--allow-known-gaps` turns this into
`0`).

Live-model mode is separate and OpenRouter only:

```sh
NIARO_TRUST_MODEL_API_KEY=... pnpm eval:trust:live --confirm-live \
  --model <exact model id> --scenario <id> [--scenario <id> …] \
  --max-requests <n> --max-input-tokens <n> --max-output-tokens <n> \
  --max-output-tokens-per-request <n> --max-cost-usd <usd> \
  --input-usd-per-million <usd> --output-usd-per-million <usd> \
  --json <report file> [--repeat <n>]
```

- It does not use the server's provider credentials. The decision checker and
  services stay synthetic, so nothing writes to a real service.
- Token and cost limits are local reservations; the provider account limit is
  the only firm ceiling.
- Matrices: `quality.*` (contact lookups), `ui.*` (generated UI where it
  helps and where it does not) and `robust.loan-cashflow.*` (a CRM that
  rejects a wrong date format). Every case has an EN and a CS variant; select
  both.

To add a scenario, put it in `tests/agent-trust/`, assert observable effects
with `probe.check`, register cleanup with `probe.defer` and record a known
capability gap with `probe.gap`. A thrown error fails only that scenario.

### Voice QA tools

Synthetic Czech speech corpus (needs Python 3.12+, ffmpeg, `piper-tts==1.8.0`
in a separate venv and the `cs_CZ-jirka-medium` Piper voice):

```sh
python3 -m venv .voice/eval-venv
.voice/eval-venv/bin/python -m pip install piper-tts==1.8.0
.voice/eval-venv/bin/python scripts/audio/generate_voice_quality.py \
  --model .voice/eval-models/cs_CZ-jirka-medium.onnx --output <new-dir>
npm run test:voice:quality -- <new-dir>/manifest.json
```

The evaluator transcribes the corpus with the local whisper.cpp from
`npm run voice:install` (or `FIXTURE_VOICE_DIR`) and makes no network calls.
The Piper voice files go into `.voice/eval-models/`. Opt-in paid comparison (at most 20 requests,
key from `.openrouter/config.json` or `FIXTURE_MODEL_CONFIG`):

```sh
npm run test:voice:openrouter -- <dir>/manifest.json guarded   # or callout
```

Other opt-in live scripts: `test:models`, `test:crm`, `test:voice`,
`test:voice:gemini`, `test:trust:live`.

## Working with OpenSpec

Current behavior lives in `openspec/specs/<capability>/spec.md`. Every change
to behavior goes through an OpenSpec change.

1. **Propose.** Run `/opsx:propose <id or description>` in Claude Code, or
   create the change by hand:

   ```sh
   spec openspec --project . -- new change <id>
   ```

   The change lives in `openspec/changes/<id>/`:
   - `proposal.md`: the user outcome, scope, non-goals and risk;
   - `design.md`: how, with the code and boundaries it touches, alternatives
     and verification;
   - `tasks.md`: small checkpoints tied to requirements and checks;
   - `specs/<capability>/spec.md`: delta requirements under
     `## ADDED Requirements`, `## MODIFIED Requirements`,
     `## REMOVED Requirements` or `## RENAMED Requirements`.

   `/opsx:explore` helps think a change through first; `/opsx:update` revises
   a change's artifacts.

2. **Review the design** before implementing, preferably in a fresh context
   (for example the `spec-review` skill).
3. **Implement** the tasks (`/opsx:apply`), with tests for each checkpoint.
4. **Validate:**

   ```sh
   spec openspec --project . -- validate <id> --strict
   spec openspec --project . -- validate --specs --strict
   ```

5. **Archive** once merged (`/opsx:archive`, or
   `spec openspec --project . -- archive <id>`). Archiving applies the deltas
   to `openspec/specs/` and moves the change to `openspec/changes/archive/`.
   `/opsx:sync` applies deltas without archiving.

Decisions that outlive the change and cut across capabilities go to
[architecture](../architecture.md). Put the tracker key in each commit
message: `NIAR-<n> <summary>`.

### Optional Expo MCP local support

The SDK 57-compatible `expo-mcp` development dependency supports the Expo MCP connection when starting an explicitly enabled local dev server:

```sh
EXPO_NO_DOTENV=1 EXPO_UNSTABLE_MCP_SERVER=1 pnpm exec expo start --dev-client
```

Use the same Expo CLI account as the authenticated remote MCP connection. Reconnect that MCP connection after starting or stopping the dev server; only one local connection should own a server. This installs local support without changing normal startup or enabling automation automatically. See [Expo's MCP setup](https://docs.expo.dev/mcp/#set-up-local-capabilities-recommended).
