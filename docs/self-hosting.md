# Self-hosting

## Physical default-session follow-up — 8 October 2026

ADB is connected again. Passive observation of the user's actual Android conversation and read-only journals confirms three accepted default-chat messages: fresh CRM lookup, an ordinary phone follow-up, then a note request. Only the first message reset the session; all three native runs share the server generation and Mastra thread. The first two succeeded without another legacy-context conflict. Microphone and New chat controls are enabled, with no fatal exception in the app-PID log. The session-boundary fix is complete in this scope. No messages, retries, approvals or business writes were sent during this inspection; physical restart-between-messages acceptance is still limited to the prior isolated regression.

The note request did not complete. Twenty confirmed one create_note write with a record ID, but no person-link write is confirmed. add_note_target was rejected first for missing required /position, then twice by the intent checker; the native run ended at its 12-model-call budget. The phone shows task failure alongside a green Create note / Done card. The user confirms the note is absent under the person in Twenty. Creating an entity does not verify assigning it to the requested person. Source inspection confirms the write checker lacks verified read/write receipt mapping, but the exact reason for its refusal and rejected arguments cannot be recovered from redacted native history. Do not bypass the checker or replay the confirmed create.

The two-step CRM workflow, checker context and truthful partial-completion presentation are high-priority follow-up work. The server remains PID88262 / source b187fee with zero restarts; no code or runtime change was made during this inspection. Screenshots and raw logs stay private. Full mobile/business acceptance and the related diagnostics work remain open. Next: reproduce create_note followed by add_note_target using synthetic services and current per-action authority before any new real CRM write.

## Durable default-chat sessions — 8 October 2026

The default conversation has no accepted conversation.create receipt. Its first session:new request succeeded, but an ordinary follow-up re-entered unproved historical question discovery and failed with legacy_context_unavailable before native/model/CRM work. The authenticated server now journals each reset atomically with archive/clear under the full connection/server/user/workspace Scope, including an empty reset or an interrupted first command. Native roots, ordinary thread recall and pending-question selection carry the server-owned generation. Client/model requests cannot supply it. Explicit bound old-task answers retain their existing proof, revision and authority checks.

Exact reset retries use their own original generation without clearing messages again, even if a newer reset already exists. Forks reusing either command ID or idempotency key fail before effects. No historical commands, receipts or roots are backfilled into trusted generations. After deploying to an already-open unmarked default conversation, cold close/reopen the app once to send a fresh first session:new message; subsequent ordinary messages retain the generation across server restart. No new Android build is needed; retrying an old failed command returns its original result.

Full identity QA passed **1471/1471**, zero failures/cancellations/skips; full Jest **1561/1561 in 119 suites**. Targeted native continuity and Tasks passed **15/15**, including cross-generation bound answers, same-generation ambiguity, delayed reset replay and restart. Types, full lint, boundaries, formatting and independent review passed. An initial full run failed an old Tasks fixture that used a session reset while expecting same-generation ambiguity; it now creates distinct goals through actual new_task routing within one generation and retains all selection/no-write assertions.

Source b187fee is running in niaro-dev-server.service, PID 88262, since 10:23:24 CEST, zero restarts. The previous PID exited; a verified private stopped copy contains 24762 files / 162080153 bytes. Public Loops/JS/CSS200 and matching assets, anonymous API401, original first-success/failed-followup receipts unchanged, session journal present and FKs valid at 10:23:31 CEST. Android is currently offline in ADB, so post-deployment physical conversation acceptance remains pending; full physical acceptance remains separately open. No new live model/service dispatch was performed during this validation. Existing client/UI changes remain outside this backend fix.

## Development chat cleanup — 8 October 2026

The user explicitly requested clearing previous chats and starting the current development server. A verified private stopped-state backup was taken first; the scoped procedure passed schema/FK checks and two workflow-store bootstraps on a disposable copy. The live operation removed 385 public messages, 11 archived sessions and 139 Mastra conversational messages, cleared live transcript and per-chat contact/memory caches, and advanced the event floor so old polling cursors require a new snapshot. Public message/archive counts and native message count remained zero after the real server startup.

Keep work/proposal/operation entities, command idempotency receipts, native roots/invocations, threads/checkpoints, accounts and service configuration. They were compared with the stopped copy after startup: all original rows remained unchanged. This development cleanup retained 213 command receipts. Reset markers in the existing turn ledger are inert JSON with `kind: conversation-history-reset-1` and a timestamp, referenced by valid global/per-conversation cursor FKs; strict native command parsing excludes them, preventing `latestTurn` from falling back to old recall. No pending invocation was running and no native process answer history needed new delivery markers in this server. Required blank chat shells remain available to existing Tasks (three in the current testing account, one in the other account); startup migration must not recreate old transcripts from snapshot or archive sources.

Runtime: `niaro-dev-server.service`, PID 27785, started 09:52:42 CEST / 07:52:42 UTC, active/running, zero restarts. Public verification at 09:53:16 CEST: `/admin/loops`, JS and CSS returned 200; assets matched `dist-admin`; anonymous `/admin/api/overview` returned 401. Repository HEAD `96a6780`, application source `d0a5bde`; unrelated local UI work was preserved. Recovery copies and operational scripts stay outside the repository. This was an authorized one-off data operation, not a source or public protocol change.

After cleanup, cold-reload the mobile app: Session deliberately preserves cached selected-chat text during passive empty projections, and default chat `session:new` is set at app launch. The next step is a new physical CRM lookup; no live model/CRM request or physical acceptance was performed by this cleanup.

## Created public chat isolation — 7 October 2026

The authenticated server derives created-chat provenance from an accepted durable
`conversation.create` receipt under the full connection/server/user/workspace
scope. This excludes only legacy-question discovery throughout that chat's life.
It preserves native thread recall, question continuation and current authority
checks. Unproved historical questions remain fail-closed in their original chats;
old journals and receipts are retained. No client flag, ID-prefix heuristic,
repeated `session:new`, migration or new APK is needed.

The ADB report reproduced the original bug on Android: creation succeeded, but
an unrelated historical question blocked the first message before model/CRM work.
The full server suite passed **1467/1467**; storage/header/history Jest passed
**24/24**. Both historical kinds now have native read/question/A→B→restart→A
regressions; actual restored-account HTTP tests cover public creation and ordinary
first/followup requests with missing old proof. TSC, full lint, boundaries,
formatting and fresh independent review passed.

Source commit `d0a5bde` loaded on the dev server at **23:29:56 CEST**, PID724436,
with a verified stopped data copy. Loops/JS/CSS200, matching build and anonymous
API401 verified at23:30:16CEST. The original creation and failed-message receipts
are unchanged. No live model/service action was used for validation; post-fix
physical acceptance remains pending. Send the question as a **new message** in
the already-created chat; retrying the same old command retains its stored result.
Existing uncommitted UI changes remain outside this server fix.

## Empty home New chat correction — 7 October 2026

The header New chat action no longer requires existing messages or tasks. Offline,
pending delivery and blocked answer recovery still disable it. A new conversation
is selected only after acceptance; failed creation preserves the old transcript
and draft. Reload Expo to load this JS change; no new APK or backend restart.

History/header Jest passed 19 tests in two suites; rendered actual App and isolated
HTTP passed 43 checks at EN1100×900 and CS390×900, including header creation, menu
creation and pin persistence. No errors or external requests; four expected fixture
discovery 404 warnings. TSC, scoped lint, boundaries and formatting passed. Existing
Playwright substitutes for the unavailable Browser plugin. Evidence is under
`/tmp/niaro-new-chat-25w4lyqv/browser-accepted/`; no physical Android acceptance is
claimed. The narrow fix remains with the existing uncommitted mobile UI work.
Next, create a chat on the phone and retry the CRM lookup.

## Native CRM tool schema correction — 7 October 2026

Native tool definitions opt out of Mastra's OpenAI schema compatibility with
`strict: false`. This preserves the original optional/required fields, numeric
and array constraints, and local references. Niaro still validates the original
JSON without coercion before effects. Card composition returns a content-free
success status/revision or a document error; persistence authority errors remain
fatal. Loops retains bounded, sanitized validation field diagnostics.

The server suite passed **1465 tests**, with no failures, cancellations or skips;
TSC, ESLint, boundaries and formatting passed. Three new scripted OpenAI native
regressions include invalid input correction, exactly one CRM read, a broken card
graph, successful composition and final reply. Clean independent review found no
blocker. No paid model or live service action was dispatched for verification.

The development backend restarted at 23:04:31 CEST with the same profile after a
verified stopped data copy. PID 675270 is active, with 0 restarts. Public Loops and
matching JS/CSS return 200; anonymous admin API returns 401. The existing successful
CRM receipt is unchanged. No new APK is needed; retry the lookup in a new chat.
Stale running diagnostics after a routing/authority change are tracked
separately, as is physical acceptance.

This is a working development preview for a single organization server. The administration, catalog and identity controls are implemented; public release still needs the operating-limit work in [service catalog](service-catalog.md), an agreed license, deployment verification and account-recovery/OAuth configuration. No public deployment is implied by these examples.

## Local first run

For a container deployment (one image, one data volume, Caddy HTTPS, backup, restore and upgrade) see [deployment](deployment.md). This section runs from a development checkout.

Use Node 22.13+ (tested on 22.23.3), pnpm (`corepack enable`) and a local persistent filesystem.

```sh
pnpm install --frozen-lockfile
npm run admin:build
mkdir -p .servers/local
cp examples/self-hosted/server.local.json .servers/local/server.json
npm run server:check -- .servers/local/server.json
npm run server -- .servers/local/server.json
```

Open `http://localhost:8793/admin/` and create the first owner/company: while no account exists the page shows the setup form instead of the sign-in, and the first account becomes the owner (signed in, with a first workspace named like the company). Then add services/providers and assign models. The first start also creates a recovery key stored only as a digest; `npm run server:admin-rotate-key -- <profile.json>` prints a usable one. Save it outside source control; do not include it in screenshots or support tickets. The recovery account has instance privileges; it is not an organization member and cannot run company tools. Regular login uses Better Auth accounts. Public self-signup, email delivery and social OAuth providers are not configured in this build.

The example has no paid services or real calendar writes. `fixture` is the fallback built-in interpreter; models added in the console run independently through the new catalog. Nothing seeds fake services into a real company. Built-in connectors are configured separately; see [server profiles](server-profiles.md).

Account-backed chat also has [internal server plugins](internal-plugins.md). The shipped pure datetime tool calculates dates for the model and forwards exact timestamps to service actions. Set `plugins.timeZone` to the intended IANA zone (e.g. `Europe/Prague`); the example uses UTC. Owners/admins can override the timezone and enablement for each workspace under **Plugins** (`/admin/plugins`), or restore the server defaults. Changes persist and apply without a restart. `plugins.enabled: []` disables the tool at the operator level; workspaces cannot override that restriction. These local functions are separate from configured external connections.

All profile paths resolve relative to its JSON file. Keep the identity and workflow directories separate. Identity directory permissions must be `0700`; private files `0600`, owned by the process user. `npm run server:check` validates configuration without contacting providers.

## HTTPS reverse proxy

Set `administration.identity.baseURL` to one exact HTTPS origin, e.g. `https://assistant.example.com`. Keep Node on `127.0.0.1:8793`. Use [the example Caddyfile](../examples/self-hosted/Caddyfile) with your hostname; Caddy must preserve Host and forward to that loopback address. TLS/DNS issuance and installation are deployment tasks, not performed by this repository.

For HTTPS configuration the admin accepts only that configured Host and Origin and uses Secure, HttpOnly, SameSite=Strict cookies. It does not trust X-Forwarded-Host/Proto/IP supplied by callers. Local direct HTTP admin access is rejected in this mode. Keep the Node port private; do not bind it publicly or disable TLS validation. A shared proxy IP shares login rate limits, so account for that in your deployment.

`allowedOrigins` controls the mobile/web workflow API's CORS origins, not admin authorization. Add only actual client origins when serving a web client on another origin. Keep it empty for a same-origin/native-only setup. Connection and integration allowlists are distinct:

- `integrationOrigins`: explicit private/local network origins for generic API/MCP and AI endpoints (e.g. `http://127.0.0.1:11434`). Grant only endpoints the operator trusts; saved service URLs can reach paths within them.
- `connectionOrigins` and `calendarCollections`: existing CRM/CalDAV connector restrictions.

Start Node under a service manager as an unprivileged dedicated user. Use persistent local storage, restart on failure, and a shutdown grace period longer than an outbound request. No horizontal replicas may share these data directories.

## Invitation email

Workspace invitations are sent over SMTP. Copy `.env.example` to `.env` (ignored by git, keep it `0600`) and fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM`; the server reads it at start. When `SMTP_HOST` is set these values replace `administration.identity.mail` from the profile, so the password never has to be in the JSON profile. `SMTP_SECURE=true` means implicit TLS (usually port 465); `SMTP_SECURE=starttls` upgrades a plain connection on port 587 and refuses to send if the server does not offer TLS; `false` (unencrypted) is accepted only for a loopback host such as the local Mailpit (`npm run mailpit:start`). Without mail settings, sending an invitation reports that SMTP is not configured.

## Mobile development over Wi-Fi

Install a current development build with `pnpm android --device` for Android, or `pnpm ios` on a Mac for iOS. This app uses custom native audio modules, so use its development build rather than Expo Go. After changing native dependencies, rebuild and reinstall; hot reload cannot add native modules to an older installed binary. An Android APK built for a selected ARM phone is not an x86_64 emulator build.

For subsequent JavaScript work, start Metro in the repository root:

```sh
pnpm start --lan --port 8081
```

The phone needs access to the computer's advertised LAN address. Open `http://<computer-LAN-IP>:8081/status` in the phone's browser; a reachable Metro server returns `packager-status:running`. Then scan the development-build QR code or reopen that project's URL. A `java.net.ConnectException` / `ETIMEDOUT` to that address means the phone cannot reach Metro yet; check that Metro is running, both devices share a reachable network, the Wi-Fi does not isolate clients, and the computer firewall permits this TCP port. This address is separate from the assistant backend's HTTPS address.

For a UFW firewall with blocked incoming traffic, allow only the actual LAN interface, subnet, computer address and development port. For example, for interface `eth0`, subnet `192.168.1.0/24` and computer `192.168.1.20`:

```sh
sudo ufw allow in on eth0 from 192.168.1.0/24 to 192.168.1.20 port 8081 proto tcp comment 'Expo dev LAN'
```

This system change requires the computer administrator. Remove the same development exception when it is no longer needed by using `sudo ufw delete allow` with the same remaining arguments. If LAN addressing changes, update the exception and reopen the project's current URL.

All repository Expo start, build, prebuild and Storybook scripts set `EXPO_NO_DOTENV=1`. The root `.env` is server-owned SMTP configuration and must not enter Expo's environment logs. Client settings needed by these scripts are supplied explicitly; additional public variables should likewise be passed to the frontend command. The server launcher continues to load its `.env`. [Expo environment-variable documentation](https://docs.expo.dev/guides/environment-variables/) describes the dotenv opt-out.

## Mobile development over Tailscale or Expo tunnel

Connect the computer and phone to the same Tailscale network. Run `tailscale ip -4` on the computer and use that address as Metro's advertised hostname. For example, replace `100.x.y.z` below with the actual address:

```sh
REACT_NATIVE_PACKAGER_HOSTNAME=100.x.y.z pnpm start --lan --port 8081 --scheme agentclient
```

With Tailscale active on the phone, open `http://100.x.y.z:8081/status` to verify `packager-status:running`, then scan Metro's development-build QR code or enter `http://100.x.y.z:8081` in the installed development launcher. Metro's Android manifest and bundle URL must advertise the same Tailscale address. The assistant backend continues to use its configured HTTPS address; its authentication origin does not need to change.

Expo's tunnel is an alternative when the phone is not on Tailscale:

```sh
pnpm start --tunnel --port 8081
```

The installed Expo CLI requires a compatible `@expo/ngrok` helper for that mode. Its generated development URL is temporary; use the current QR code or URL from Metro. Stop an existing Metro process before starting another mode on the same port.

## Hosted MCP servers

Some services have no MCP server of their own. **Hosted servers** runs them on this
machine, in a Docker sandbox, or as Node processes where there is no Docker (see
[without Docker](#without-docker)). **Services → Add service → Microsoft 365** starts
the prepared Microsoft 365 server (Outlook calendar and mail, Softeria
`ms-365-mcp-server`), links it to a Microsoft sign-in method and creates the service with
personal sign-in.

Every hosted server is one container:

- the official Node image pinned by digest, or a custom image pinned by `@sha256:`;
- a read-only root file system, no Linux capabilities, `no-new-privileges`, the
  server's own unprivileged user, 256 processes and a memory limit;
- its own `agent-hosted` network: internet access, but no access to this server,
  other services on the host's loopback or other hosted servers; its port is published
  on `127.0.0.1` only;
- one writable directory under `<identity directory>/hosted/`. It inherits no keys or
  passwords; each request carries the person's own token.

npm servers install with `npm ci --ignore-scripts` inside the sandbox, so every package
is verified by its integrity hash and no install script runs. Prepared templates ship a
committed lockfile; a custom package gets one generated for its exact version before
installation. The server needs Docker, and registry access on first start.

**Custom servers** (an npm package at an exact version, or an image by digest) run code
you chose and are off by default. Only the operator can allow them, in the server
profile; the console cannot:

```json
"administration": { "identity": { "hosting": { "allowCustom": true } } }
```

Then organization owners and admins use **Hosted servers → Add custom**: the console
shows the package's publisher, licence, date and integrity before installing.
Arguments are a list with `{port}` for the listening port (listen on `0.0.0.0` inside
the container), never a shell command. Secret variables are encrypted and passed through
a private environment file.

The server restarts a crashed container with backoff and stops after five crashes in ten
minutes. The console shows the last 200 log lines with tokens and secret values
redacted. Up to eight hosted servers run on loopback ports 39100–39199. Removing one
deletes its container, directory and address. Access to Docker is equivalent to root on
the host, so run Agent Server only on a machine you trust it with.

### Without Docker

A container image (Dokploy) has no Docker CLI or socket. There the prepared templates
run as Node child processes of the server, in the same container; custom servers do not
run at all. The profile chooses the runtime, and `NIARO_HOSTED_RUNTIME` overrides it:

```json
"administration": { "identity": { "hosting": { "runtime": "auto" } } }
```

`auto` (default) uses Docker when `docker info` answers and processes otherwise;
`docker` never falls back; `process` never uses Docker. **Hosted servers** says
"Without Docker" in its header when processes are in use.

Installation is the same `npm ci --ignore-scripts --omit=dev` from the template's
committed lockfile, run by the server's npm in the hosted server's directory with its
cache, `HOME` and `TMPDIR` there too, so it works on a read-only root file system. It
needs the npm registry on first start; without it the server shows "Installation
failed". The program then starts with Node's permission model:

- `node --permission`, reading only its own directory under
  `<identity directory>/hosted/` and writing only its `home/`. The identity database,
  `secret`, the admin key and workflow data are unreadable; so are `/proc` and other
  hosted servers. No child processes, worker threads, native addons or WASI. A
  symbolic link leading out of the directory fails the start, because Node follows it;
- an explicit environment: `PATH`, `HOME`, `TMPDIR`, `NODE_ENV=production` and the
  template's fixed settings. Nothing of the server's own environment is passed;
- `127.0.0.1` on its assigned port (a `0.0.0.0` host in the arguments becomes
  loopback), a heap limit from the template's memory, and the same readiness check,
  crash backoff and restart on server start as in Docker. It exits when the server is
  gone, so no process keeps the port.

The limits are weaker than the container's: the process runs as the server's own user,
only Node's permission model limits its file access (Node does not call it a defence
against malicious code), its network is not restricted (it can reach the internet, this
server and other loopback services), and there is no process or hard memory limit.
That is why only templates pinned in code run this way.

## Backups and upgrades

Stop the process before copying the complete profile, recovery key, identity directory and workflow directory. Back up the identity `secret` together with `identity.sqlite` — it is necessary to decrypt credentials. Include workflow/auth identities and sessions; do not copy only an SQLite main file while WAL writes are active. For online backups use SQLite's backup API, then securely copy the secret/configuration separately.

Encrypt backups and restrict access: operation parameters/results and conversation history can contain private business data. Restore the whole matched set to an isolated path, run checks, and verify before switching over. Test restores regularly. Never reset a live workflow store merely to clear a failed operation.

Before upgrading: back up, run `pnpm install --frozen-lockfile`, `npm run check`, `npm run admin:build`, stop the old process and start the new one. This update preserves old workflow data while upgrading the protocol to 0.6; update clients at the same time. Stored 0.2–0.5 sessions and client caches migrate without automatically retrying pending commands. An unknown write requires reconciliation with the external service, not deleting its receipt.

## Composable cards

The updated server offers `compose_card` to the model planner (`routing.planner: "model"`) and provides a typed `CardBuilder` for server integrations. New task layouts use the shipped primitives and do not require new client components. No extra dependency, provider or permission is required. Use [the card authoring guide](composable-cards.md) for the SDK, layout rules and confirmation boundary.

Restart the server with the updated code and rebuild the app to use the new renderer. Updated clients request `agent-card/1` on workflow delivery and discovery; older clients keep their existing textual/service/workflow presentation. New card content persists with its normal message or entity and is replayed without calling the composer again. Keep useful textual answers for clients that have not negotiated cards.

Run `pnpm run check`, `pnpm run build` and `pnpm run storybook:export`. In Storybook select **Workflow / Composable card** for EN/CS overview, forms, long text, read-only and invalid-document states. Use synthetic service data for confirmation checks; no live model or business operation is needed to exercise the renderer. Inspect both narrow mobile and wide browser layouts. Physical-device accessibility and live-model content quality need separate evaluation.

## October 1 client and loop diagnostics update

Rebuild the console with `pnpm admin:build` and restart the reference server with the existing profile. Owners/admins can then open **Loops** beside Audit log (`/admin/loops`); [the administration guide](server-admin.md#agent-loops) describes recorded and reconstructed steps.

Loops opens on **Run overview** with a vertical timeline in recorded order. It combines only exact call/result pairs and shows up to two meaningful safe input/result previews per step. Select **All steps** to inspect the full trace. Open a step to inspect its input, known result, approval/execution phase and duration; its details expand in place. Technical tool identifiers remain behind a disclosure. **Run details** keeps the full recorded request and the immutable process/run/version/artifact/conversation/command identities. A request-only trace shows an explicit empty step state rather than a blank timeline. On wide screens the run list and timeline scroll independently within the available height; on narrow screens the list and timeline are stacked, with the timeline bounded for scrolling.

Custom service-process traces record actual model/tool identifiers with the same safe projection as native chat, without rewriting canonical unknown or rejected outcomes. Existing traces are not retroactively enriched from raw provider bodies. This update requires a console rebuild, backend restart and browser reload. It does not need a new Android build or a Metro restart. Refreshing these diagnostics reads stored data without executing the displayed actions.

The failure-reporting update also records the cause of future service errors, invalid fields and a safe next step for the agent, chat card and Loops inspector. Rebuild the console and restart the reference server, then reload the browser. The existing mobile contract remains compatible. Previous completed errors without diagnostics cannot recover a discarded provider message; verify an unknown write directly in the service before issuing a new request.

The follow-up fix for native Twenty error envelopes and uncertain reply checks needs only a backend restart with the existing profile. It changes no client or console assets. A record found by email with a different name is a possible identity conflict; it does not confirm a new creation, and the update does not automatically retry or modify that record.

Keep Metro running on the same reachable Tailscale/LAN address and reload the installed development app to receive the card links and reply/audio synchronization fix. No native dependency changed in this update, so an already current Android development build can use a JavaScript reload. Contact cards have tappable telephone, email and HTTP(S) fields; autogenerated source details are hidden. A voice reply appears when playback starts, or after an eight-second startup fallback that cancels delayed audio. On a physical phone, check these three behaviors before judging playback timing accepted.

## Loop trust scenarios

Run `pnpm eval:trust --json /tmp/agent-trust-report.json` to exercise memory, clarification, restart, interruption, approval and card interactions against isolated production stores with scripted inference. It does not use the configured server or existing data. The latest full run on October 4 passed 18 scenarios and 86 checks with exit 0. Exit 2 means a recorded coverage gap; exit 1 means an assertion failure. See [results, measurement limits and follow-up work](agent-trust.md) before treating passing regressions as evidence of live-model reliability.

### Chat recovery and Markdown (3 October 2026)

This update keeps `agent-client/0.8-fixture` and introduces no native module. Restart the reference server with its existing profile; a connected development client can receive JavaScript through Metro (`pnpm start --lan --port 8081` or the existing tunnel/Tailscale setup). No APK rebuild is required for these changes. Do not discard credentials, cached work or unknown write receipts to recover a stuck chat.

“Check result” verifies the same pending command. Definitive catalog rejection releases input and preserves its explanation; a terminal native step-limit failure replays the recorded answer without further inference. Recording a draft is available while waiting, but submitting it waits for pending delivery.

On the current development host the existing managed unit is `niaro-dev-server.service`: `systemctl --user restart niaro-dev-server.service` reloads it and `systemctl --user status niaro-dev-server.service` checks it. Allow startup to finish before checking the public admin URL. This transient user unit survives a terminal/chat turn; host-boot setup remains separate.

### Loop evidence and recording interruption (4 October 2026)

Rebuild the administration console, restart the backend with the existing profile, reload the browser and reload the development client through Metro. No native dependency or APK rebuild is required. Loops now separates conversation, agent and tool/service roles, shows recorded tool/model identifiers and bounded input/result/failure evidence, and expands cards in place with animation. Historical missing evidence is explicitly marked; this update cannot recover discarded provider payloads.

Recording starts immediately and asks the server to interrupt the exact pending command. Submitting the next draft waits for a scoped durable interruption acknowledgment and proof that the old run has retired. A lost or unconfirmed acknowledgment keeps the draft available; **Retry interrupt** checks that same interruption without rerunning the old task. A confirmed external write stays confirmed, and an unknown write still requires verification in its service. Cancellation does not undo an effect.

Definitive failures preserve the submitted message and a correlated explanation in chat instead of returning submitted text to the composer. Native final replies validate the conversation revision, so unrelated progress polling no longer discards an already finalized result. Existing historical missing messages are not automatically reconstructed. The mobile progress card omits the redundant step-number prefix.

The native tool-validation follow-up requires a backend restart only. Declared schemas now validate the original provider JSON before native dispatch and again before invocation/resume. Invalid calls return a bounded correction result without creating an approval, receipt or external effect; unavailable tools retain that separate outcome. Invalid inputs and unrecognized tool names are replaced with safe native checkpoint markers, so a crash cannot restore normalized arguments as an accepted call. Plugin references must point to an existing server-calculated receipt.

The native runtime reserves the root keys `resumeData`, `_background`, `suspendedToolRunId` and `suspendedToolCallId` for Mastra. When a catalog action declares any of them as a root business field, the native Agent exposes its full input inside the `niaroBusinessInput` envelope and unwraps it only after schema validation. This preserves the exact arguments through approval and checkpoint recovery while keeping Mastra metadata separate. Unwrapped calls that collide with the reserved keys still fail closed. See the native tool-validation tests for coverage; direct catalog/workflow action calls continue using their regular input schema.

The native fatal-reply follow-up also needs only a backend restart. Known invalid model responses, provider failures and native execution failures produce a correlated EN/CS explanation after the native run has verifiably retired. The original submitted text stays in chat; a failed task with no action still appears in Tasks. Confirmed actions and memory changes remain recorded, and an unknown write still asks for verification instead of being repeated.

If retirement cannot be proved, the original command remains pending and blocks new execution in that scope, including after server restart. **Check result** and **Retry interrupt** may passively finish the exact recorded candidate; they cannot drive native recovery, resume, inference or service dispatch. A lost suspended checkpoint is not an answerable question or approvable native continuation. The server rechecks current permissions, source/memory pins and card revisions before publishing a final reply. Historical missing replies are not automatically reconstructed, and old orphaned checkpoints still require separate reconciliation.

If the old session loses permission, proved retirement still lets a new authorized session continue without publishing the old result. After a native approval, the existing card receives the decision's final reply and speech correlation; this does not add another card or repeat the confirmed action.

### Service designer proposal foundation (4 October 2026)

The internal native comparison is verified with
`pnpm test:process-native`. It exercises actual Mastra Agents and the Niaro
catalog loop over one pinned dataset using detached stores, scripted model
responses and a closed business transport. It reads no credentials and makes
no live model/CRM calls. Its `native_scripted` report always remains ineligible
for activation. It is connected to the existing shared private test
journal through an internal adapter, with original command replay, fresh
creator/source/baseline/budget checks and atomic report/audit publication.
`pnpm test:process-native` includes actual native journal/reopen regressions.
The server bootstraps the shared journal once under the existing identity owner
lock and exposes [authenticated native test HTTP and private history](service-processes.md#authenticated-native-test-http).
Restart the backend with its existing profile to load it; no new startup command,
dependency or APK is required. Explicit test POSTs accept only bounded scripted
fixtures; GET/history/replay never run a model or business action. The test request
has a 120-second total cancellation deadline and shutdown awaits native cleanup
before database close. Qualified activation/rollback, test UI and actual crash
qualification remain separate work.
A [server-derived native runtime qualification](service-processes.md#server-derived-native-runtime-qualification)
is added to new terminal native jobs and a bounded private history summary. Reload the
same backend profile to load it; no dependency, startup command or APK change is
needed. A passing subset remains unqualified, historical jobs are not upgraded,
and `qualified` still means controlled runtime evidence with `liveAcceptance:false`.
The report remains `activationEligible:false`; explicit human activation/rollback
and their current-source/runtime/budget gates are supplied by the
[account-only lifecycle API](service-processes.md#human-activation-and-rollback).
Rebuild the admin bundle and restart the same backend profile to load its EN/CS
audit labels and one-time owner bootstrap; no new dependency, startup command or
APK is required. `pnpm test:process-activation` verifies isolated native decisions,
private replay and actual pinned runs through rollback and store reopen. The
console supplies the test/activation controls. [Proved native crash recovery](service-processes.md#proved-native-crash-recovery) supplies
actual SIGKILL/concurrent-owner recovery evidence.

The **Tests and versions** action in **Services → Processes** opens the EN/CS
console for explicit freeze, structured isolated scenarios, private report/history,
current qualification review and human activation/rollback. It is also linked
from an accepted designer proposal. Session storage preserves the exact command
before dispatch; reload/check only read, and an unknown response can be retried
explicitly. Invalid recovery data is left intact and blocks sending. A lost response
never automatically reruns a test or decision. See [the console contract](service-processes.md#process-test-and-lifecycle-console).
Run `pnpm test:process-console` for its focused API/client lifecycle regressions.

Use a fresh explicit native test after upgrading: historical jobs without the
new durable admission ordinal stay readable but cannot be promoted. Activating
does not execute the process. Review the exact frozen artifact and limited native
qualification, then explicitly acknowledge `controlled_native_test_only` in the
activation command. After a lost response, read the original private receipt by
request ID or explicitly replay the same command; neither action switches back
to its historical active version. Native retesting of the current active version
requires `retestActive: true` and immediately supersedes its previous readiness;
a new qualified result still needs a fresh human decision. Do not treat a
historical registry testStatus as current qualification readiness.
See [the native comparison and remaining lifecycle work](service-processes.md#isolated-native-agent-comparison).

The internal compiler-contract harness is verified with
`pnpm test:process-contract`. It tests inactive frozen versions in isolated
Mastra datasets/workflows and retains private reports; it does not expose a
test/activation button or HTTP endpoint. Native temporary storage is removed
after report copy. IdentityService now instantiates its shared journal, but the
compiler-contract adapter remains internal and cannot qualify activation. Follow [the contract and remaining lifecycle work](service-processes.md#isolated-compiler-contract-tests)
before integrating it. No credentials, live model or production memory belong
in static test fixtures, and every current report remains ineligible for
activation. The web designer remains available as described below.

The designer has a creator-private proposal store and safe local capability projection, plus a native conversational adapter with isolated Mastra Memory, a shared session budget, durable tool receipts and passive crash recovery. IdentityService instantiates the store and adapter once and exposes [authenticated designer HTTP](service-processes.md#authenticated-designer-http). The EN/CS console: open **Services → a service → Processes → Add process** or **Design changes** on its current draft. Review the conversation, definition, diff and validation; confirm assumptions, then explicitly save the reviewed draft. The controlled test/activation console and the setup flow below complete it.

An owner/admin account with workspace access is required; the operator key alone cannot use the designer. Select a tool-capable model and explicitly configure enforced workspace budget mode with prices matching its current model/provider revisions. Observe-only defaults are rejected without changing settings. Metadata reads, proposal edits, assumption acknowledgment and draft acceptance make no model or business calls. Only an explicit conversation-turn POST can infer, and its five tools cannot run business actions, test or activate a process. Disconnecting that request or shutting down the server interrupts the tracked native turn and preserves submitted text and a safe outcome. Polling/replay never resends it. `pnpm test:process-design` verifies isolated synthetic store, actual native conversation/crash and local HTTP boundaries; it is not live model or business acceptance.

The UI bridge adds required original model/provider revision metadata to each private turn response and shared strict capability schemas. Rebuild the bundled admin client (`pnpm admin:build`) and restart the backend together when loading this API extension. Existing journal rows project their original conversation binding without rewriting history; no database, dependency, mobile profile or APK migration is needed. The web capability reader merges flat pages under one fingerprint before exposing an inventory. Recovery requires browser session storage: retain the conversation URL or use its local entry in the service's Processes tab. Reload only checks the server; **Retry same request** explicitly replays the exact saved command. Changing account, expiry or losing authority clears private state. The original designer model stays bound even after a failed turn; changed model configuration requires a new conversation.

The mobile **Processes → Process designer** panel can target the workspace or a configured service. Service proposals use the existing `/1` route and are saved only after explicit confirmation as inactive versions in the same service process registry; the workspace route stays `/2`. The panel lists that service's process versions and the current user's proposal history, can reopen a prior conversation, start another, or open a saved process for a change proposal. Listing and reopening are passive. Restart the backend to load the new service history and process-list endpoints; Expo Reload is enough for the JavaScript UI update, and no native dependency or APK rebuild is needed. Run `pnpm run test:process-design` for the paired HTTP and rendered mobile fixture coverage. This is synthetic integration evidence, not physical-device, live-provider or production acceptance.

### Native process recovery (4 October 2026)

Restart the backend with its existing profile to load crash recovery. No dependency,
new startup command, admin asset change, Metro restart or APK rebuild is needed.
Only an explicit retry of the original internal process command may restart a
proved native parent; boot, Loops, test history and console reload do not execute
it. Known output/receipts are reused without another model/service call;
unproved child completion, missing/corrupt checkpoints and unknown writes fail
closed. Verify unknown effects in the original service instead of deleting their
receipts or starting a replacement command.

The existing identity owner lock must remain held for the full server lifetime.
Do not run replicas over the same directories. After an actual server crash, an
unfinished isolated test becomes interrupted once; its temporary experiment is
not resumed. A newer interrupted retest prevents reuse of an older qualified
pass. Run a fresh explicit test, review its exact qualification, then make a new
human activation decision. See the [recovery contract](service-processes.md#proved-native-crash-recovery).

`pnpm test:processes` includes actual SIGKILL/native restart and OS owner tests
with synthetic transports and temporary databases. `pnpm test:process-native`
also includes the owner/journal proof. Public mobile process invocation remains
separate work; these controlled tests do not establish live-model/business quality.

### Services setup (4 October 2026)

Build the updated console with `pnpm admin:build` and restart the existing backend
profile. No new command, dependency, database/connection migration, Metro restart
or APK rebuild is needed. **Services → Add service → Configure with assistant**
first saves the explicitly chosen connection, then opens its Overview. An
existing service has the same assistant action in its menu. Choose **Add process**
or **Design changes** to enter the native designer. The model runs only after a
conversation message; navigation does not discover actions, run tests or activate
a version. **Configure manually** and all existing connection/action forms remain.

Check purpose and connection settings, then select a process to compare Draft
with its exact active/saved versions and test state. Use **Tests and versions**
for private evidence, further history and human decisions. A paused service must
be explicitly enabled in Connection. If Microsoft personal sign-in setup is not
confirmed after creating the service, use its persistent **Sign-in** repair
notice. Do not create another service just because the second stage failed.
Saving sign-in settings does not prove that an account is connected.

`pnpm test:identity` includes the seven passive overview reader regressions and
the existing native/designer lifecycle. Actual browser QA uses synthetic accounts
and isolated HTTP; it does not call live OAuth, CRM or a paid model. See the
[Services overview contract and QA](service-processes.md#service-setup-and-lifecycle-overview).

### Exact process start foundation (4 October 2026)

Internal intent/command tables are added to the existing identity SQLite database
once at workflow attachment. Start the server with its existing profile and the
normal `pnpm server` command; no provider, routing, active process, plugin or existing
connection is selected automatically. Preserve the matched identity/WAL/native/chat
backup described above. Native checkpoints and compiler identities stay compatible.

`pnpm test:process-start` runs isolated contract and process-crash fixtures. Direct
`node --import tsx tests/process-start.node.ts` and
`node --import tsx tests/process-start-crash.node.ts` also expose each of the 14 + 4
cases when the nested test runner reports only a file aggregate. They use synthetic
accounts, schemas and service/model adapters, never the configured live server.

There is no public process-start HTTP/command dispatch or mobile form in this
foundation. Later steps must still connect authorized forms, request/session checks,
native coordination, task/loop projection, question resume and mobile acceptance.
No APK, Metro restart, UI language or Storybook change is needed for this backend
contract. See [the admission contract](service-processes.md#exact-process-start-admission).

## Process input development — 5 October 2026

The account API now supports passive execution inventory and explicit typed form preparation via `agent-process-execution/1`; see [the contract](service-processes.md#passive-execution-inventory-and-structured-inputs). Preparation creates only intent metadata. Explicit public process execution is supplied by the separate coordinator contract below, which is followed by the Tasks/Loops projection. Questions and the mobile process menu are separate steps.

```sh
pnpm test:process-execution
pnpm exec jest --runInBand tests/process-input-form.test.ts tests/process-input-card-view.test.tsx
pnpm storybook:generate
pnpm storybook:web
```

In Storybook, open **Catalog / ProcessInputCardView** for the 14 EN/CS, nested, array, enum/range, optional/null, validation, revision and unavailable examples. These are synthetic inputs with local callbacks; they do not contact a model or service. The renderer introduces no native dependency, so this JavaScript slice does not require a new development APK. A physical phone and the complete process harness still need separate acceptance.

## Process coordinator development — 5 October 2026

The authenticated account API supports explicit native process start, exact original approval and interruption under `agent-process-execution/1`; see [the coordinator contract](service-processes.md#public-native-process-coordinator). Use an existing server profile with `pnpm server <profile.json>`. Workflow attachment creates decision/interruption tables once in the existing identity database. Preserve the matched identity/WAL/native/chat backup; no checkpoint/compiler identity or connection configuration is renamed.

```sh
pnpm test:process-coordinator
pnpm test:identity
```

The coordinator command runs all20 direct native cases plus6 real local HTTP cases with temporary synthetic accounts, transport/model adapters and databases. The standard identity/process suites also include these files and prior native crash/owner proofs. If a nested runner emits only a file aggregate, the direct `node --import tsx tests/process-coordinator.node.ts` exposes individual cases. No test command contacts the configured development database, business services or paid model.

Prepare a form through the inventory/input routes before sending its exact original typed command. Use the admitted canonical parent for private GET reads; repeat the original approval command only for its original operation/revision. An interruption's settled control outcome does not turn an unknown write into success. Unavailable native proof retains request ownership instead of authorizing a new effect.

The coordinator backend slice needs no APK or Metro restart. The Tasks/Loops card transport is described below; the form callback is still local. Native questions and the complete mobile process menu/device acceptance are separate steps.

## Process projection development — 5 October 2026

The mobile workflow session negotiates `tasks=agent-process-work/1` automatically.
Existing admitted service processes appear passively in Tasks/chat with canonical
receipt statuses and in Loops with their pinned process/version provenance. No
active process is started by loading these views. Older strict clients retain a
text projection. See the [projection contract](service-processes.md#passive-process-tasks-and-loops).

```sh
pnpm admin:build
pnpm test:process-projection
pnpm exec jest --runInBand tests/process-work-card.test.tsx
pnpm storybook:generate
pnpm storybook:web
```

The focused script runs twelve direct projection cases, four durable-window cases
and two local HTTP cases using synthetic databases/accounts/services. In Storybook,
open **Catalog / WorkItemCard** for process failure, unknown, cancelled and success
examples, including EN/CS receipt disclosures. The normal identity and Jest suites
include these checks. No command above contacts the development identity database,
live model or business service.

Use `pnpm server <profile.json>` and the existing development build/Metro command
for manual testing. These JavaScript changes add no native dependency and require
no new APK. **All** keeps failed/cancelled/unknown work; Done contains successes.
The process card currently provides passive details. Questions and explicit mobile
start/approval/interruption controls are connected in later steps. Component
browser QA does not replace physical Android acceptance of that full flow.

## Pinned compiler preparation — 6 October 2026

Rebuild the admin console with `pnpm admin:build` and restart the reference server
with its existing profile to load the reviewed UI and compiler preparation.
Reload the browser and the existing Expo development app for JavaScript card
changes; no native dependency or Android APK changed in this batch.

Use `pnpm test:process-native` for the saved compiler regressions and
`node --import tsx tests/native-tool-validation.node.ts` for the trusted answer
hook. `pnpm test:identity` includes both paths. These tests use isolated stores
and scripted inference, not the configured workspace or CRM. The saved compiler
is preserved across resume and retirement; process questions and public answers
are a later step and cannot yet be tested through the mobile menu.

The native failure correction also loads on server restart. It adds no
client code or native dependency, so no Metro restart or APK is needed for this
backend correction. `node --import tsx tests/native-tool-validation.node.ts`
checks all 59 targeted cases, including empty invocation/observer rejections;
`pnpm test:identity` covers the complete server regression. Test fixtures use
synthetic accounts, isolated databases and scripted inference. See [the failure
contract](service-processes.md#fatal-native-boundary-failures).

## Native process question development — 6 October 2026

This adds exact typed and voice answers for existing server-published process
questions. Rebuild the admin console and restart the server with the existing
profile, then reload Metro JavaScript in the existing development build. No
native dependency or new APK is required. Use `pnpm start --tunnel` for the Expo
development client when the LAN connection is unavailable; the API still uses
the paired server connection. The complete process selection/start/approval
menu is the next step, not part of question answering alone.

```sh
pnpm admin:build
pnpm test:process-questions
pnpm exec jest --runInBand tests/process-answer-session.test.ts tests/process-answers.test.ts tests/process-question-mobile.test.tsx tests/process-question-voice.test.ts
pnpm storybook:generate
pnpm storybook:web
```

These tests use synthetic accounts, local HTTP servers, isolated identity/native
databases and scripted inference. They do not use the configured CRM or model.
Open **Catalog / WorkItemCard** question stories for EN/CS, stale/offline and
fallback cards. The admin test-scenario editor accepts exact question fixtures
for both configured and generic strategies; a pending question cannot count as
a completed qualification observation.

New question-capable artifacts opt into `humanInput: "text"` and compiler `/3`;
freeze, test and qualify that new version before activation. Existing `/1` and
`/2` pins and reports remain unchanged. Session-capable mobile clients negotiate
work `/2` and answer through the process `/2` command endpoint. Raw answer text
is preserved, and a transport acknowledgement does not claim native success.

Workflow attachment creates the immutable question/answer/consumption tables in
the identity database and a text-free publication-marker table in workflow
storage. Preserve the matched identity/WAL, native and chat backup together.
Older clients retain profile `/1`; they cannot execute the question-capable
artifact. See [the question contract](service-processes.md#exact-native-process-questions-and-answers)
for exact retry, authority, crash and accepted-history behavior. Browser and
scripted checks do not replace the physical Android flow.

## Saved mobile answer recovery — 6 October 2026

This is a client JavaScript change; reload the existing development build
from Metro after updating it. It adds no native dependency or new APK requirement.
After a submitted process answer, restarting the client should preserve the
original question/text in a **Saved process answer** card in Chat and Tasks until
the server confirms consumption or the user explicitly discards a known local
copy. Unconfirmed delivery uses **Retry same command**; opening or reconnecting
does not resend it. **Retry saving** after a known delivery outcome retries only
local storage. Unreadable recovery storage offers Refresh and prevents new
commands from bypassing an unresolved original request.

Useful focused commands are `pnpm exec jest --runInBand --runTestsByPath
tests/process-answer-session.test.ts tests/process-answer-recovery-mobile.test.tsx
tests/process-question-mobile.test.tsx` and the corresponding EN/CS saved-answer
stories. These use synthetic transport and local storage. Physical Android and
the complete process menu/approval flow remain separate acceptance checks.

## Shared mobile process transport — 6 October 2026

This extends the existing client JavaScript Session for frozen process start
and approval commands; reload Metro in the existing development build. No
native dependency or new APK is needed. The launcher/form and detailed approval
controls are separate steps, so this transport patch alone does not
add a mobile process menu. The server's existing execution endpoint is reused.

```sh
pnpm exec jest --runInBand --runTestsByPath tests/process-commands.test.ts tests/process-transport-session.test.ts tests/process-answer-session.test.ts
node --import tsx --test tests/process-transport-client-http.node.ts
```

The Node test pairs actual local accounts, uses ClientSession with isolated
storage and native process persistence, and tests response loss after real
server commit, client/server reopen, exact A retry while B awaits approval,
HTTP422 rejection, compiler3 questions and pre-admission interruption. Services
and inference are scripted synthetic fixtures; this is not physical Android or
live workspace acceptance. The same test is included in `pnpm test:identity`.

## Mobile process launcher — 6 October 2026

This adds the mobile **Processes** panel in chat and Tasks. Reload the existing
Expo development build through Metro; this JavaScript-only slice needs no new APK.
With an authenticated connection, choose **Processes → Load processes → select
a ready process → Prepare form**. Fill the typed fields, prepare them for review,
then inspect the complete inputs/version/conversation/language before choosing
**Start process**. Back to edit and closing/reopening the panel retain its local
draft; unsent drafts are not promised across a full app restart.

A blocked process explains the missing setup. Unknown saved delivery offers
**Retry same start**; accepted/rejected requests awaiting local cleanup offer
**Retry saving**, which makes no new start and can work offline. A changed active
version, permissions or form needs a fresh selection/preparation; retry never
rewrites the saved original request. Server handoff acknowledgement is separate
from process completion. Progress and canonical outcomes remain in Tasks/chat.

```sh
pnpm exec jest --runInBand --runTestsByPath tests/process-reader-session.test.ts tests/process-launch-mobile.test.tsx tests/process-launch-view.test.tsx tests/process-input-form.test.ts tests/process-input-card-view.test.tsx
node --import tsx --test tests/process-transport-client-http.node.ts
```

Storybook **Catalog / ProcessLaunchView** has EN/CS selection, blocked, empty,
loading, local form/review, accepted/rejected and original recovery examples.
The actual Session HTTP reader test verifies authorized inventory/form reads and
identical form-origin replay without command or business dispatch. RN interaction
and isolated browser acceptance use synthetic injected transports; physical
Android, real model/service quality and full rendered HTTP acceptance
remain separate checks.

Client limits fail visibly without selecting partial inventory: 4 MiB/page,
16 MiB/complete list, 10 pages/1,000 entries, 2 MiB/form response. If these limits
are reached, simplify the server's process catalog or forms; there is no hidden
truncation or alternate mobile transport.

## Mobile canonical process confirmation — 6 October 2026

This requires the updated development server plus a Metro JavaScript reload. It adds no native dependency or APK requirement. The regular mobile connection opts into Work `/3`; old Work `/1` and `/2` remain compatible. Inventory stays read-only and requires genuinely activated, qualified saved processes; do not activate production workflows simply to populate a test menu.

For synthetic testing, use the EN/CS `Work/WorkItemCard` and `Workflow/Service action` approval stories, or the isolated process HTTP fixtures. Open a waiting native process from Tasks, review its effect and full parameters with the original workspace and revisions, and explicitly confirm or reject. Offline/stale/unavailable review must disable the controls. Reopening, expanding details and polling must do no business work. After an accepted delivery, wait for canonical status; a disabled confirm button is not evidence that the write succeeded.

Test recovery separately: lose the response to A, reopen while B is current, and use the explicit saved-decision recovery card. It must repeat A's original command exactly and keep B disabled while delivery is unresolved. Saved A is identified for review, with an explicit offline Retry saving control for known outcomes. The complete rendered HTTP flow is verified separately. Known cleanup retries save locally, without another command or business POST; a passive snapshot GET after saving is allowed. Previous effects remain recorded on failure/unknown, and an earlier unknown action prevents fresh approval. A missing or too-large parameter review leaves the task visible with an unavailable explanation.

The rendered harness uses real `ClientSession` with a synthetic injected transport at EN/CS 320/390/700 px; actual paired-account HTTP/Session verification is a separate suite. Full rendered authenticated HTTP, physical Android, speech/model quality and live CRM/OAuth acceptance are not implied by either result.

## Mobile saved process decision recovery

Reload Metro JavaScript to load this client-only change; the existing server is compatible and no new APK is needed. Use the **Workflow / Saved process decision** stories for synthetic previews of an unknown decision, a known outcome whose local saving failed, historical missing parameters and unavailable proof. Story previews never contact a real service.

In Chat or Tasks, the saved-decision card identifies the original action, decision and effect. Its expandable review contains only the original source, workspace, conversation, revisions and full parameters. If the task already shows a later action, retry still addresses the saved decision. A historical saved target without parameters explains that limitation and never substitutes the current task's parameters.

For an unknown outcome, reconnect and select **Retry same decision**. For an acknowledged or rejected outcome with unfinished local saving, select **Retry saving**; this also works offline and sends no additional command POST. A delivery acknowledgement does not establish the action's business result: read the canonical task, including any failure or uncertain earlier effect. Unverifiable saved proof leaves retry disabled. This has synthetic actual Workspace/ClientSession/RN-web verification; the complete paired HTTP/mobile acceptance is separate.

## Isolated mobile process HTTP acceptance

Run `pnpm test:process-mobile-http` for actual paired HTTP, ClientSession and file-backed storage regressions. The server uses temporary SQLite and the existing native Mastra runtime. Only model responses and service transport are scripted; no production account or live provider is used.

The optional rendered test uses an already installed Playwright runtime:

```sh
NIARO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs pnpm test:process-mobile-web
```

If Playwright is already resolvable by Node, omit the environment variable. This command does not install dependencies. `NIARO_PROCESS_QA_OUTPUT` chooses an evidence directory; otherwise a fresh directory is created under the system temporary directory. `NIARO_PROCESS_QA_CASES=happy-390-en` selects a single case for diagnosis. Run the rendered matrix after the broad server regressions rather than concurrently with their resource-intensive crash tests.

The preview runs the actual App, Connections, credential vault, AsyncStorage, ClientSession and localhost HTTP endpoints. Pairing uses the real Connections API because the current ConnectionCard offers browser SSO rather than pairing-code controls. Tests exercise the typed form, questions, approvals, output disclosures and historical Tasks navigation. A completed process appears under Tasks after App remount; open it to return to its chat card and expand its output.

App remount retains the real memory-only web credential vault and persistent AsyncStorage. It is not a full browser reload or native SecureStore/physical Android acceptance. Standalone bundling omits Metro HMR and replaces native audio, haptics and SSO peripherals only. These tests do not assess transcription, speech quality, native hardware Back or browser SSO. The web process panel skips the unsupported Android BackHandler registration; native handling remains unchanged. No new APK is needed for that JavaScript change.

On web, automatic chat scrolling also preserves composer focus. React Native Web's `on-drag` keyboard dismissal runs for programmatic scroll events, so the chat uses `none` on web while retaining `on-drag` on native platforms. The acceptance flow checks focus before typing each real process answer and after a real ScrollView event. Its one-request lost-ACK simulation observes the actual HTTP response independently of client cancellation, then discards it; all ordinary requests preserve their signals and timeouts. The final root run passed 28 EN/CS cases, 485 checks and 42 screenshots. This result does not replace physical Android acceptance.

## Qualified designer-to-mobile pipeline

`pnpm test:process-pipeline-http` runs the actual designer, acceptance, freeze,
native qualification, activation, pairing and Session HTTP lifecycle. It creates
temporary private databases and synthetic CRM/Calendar/model responses. Native
Mastra, immutable artifacts, qualification records and command receipts are real.
It does not activate a production process or call a live provider.

For the actual administration and App screens, use an already available browser
runtime, without installing another dependency:

```sh
NIARO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs pnpm test:process-pipeline-web
```

`NIARO_PIPELINE_QA_OUTPUT` chooses the evidence directory. The optional
`NIARO_PIPELINE_QA_CASES=success-en` filter is for diagnosis; omit it for the five
EN/CS success, denial, failed and unknown cases. Run rendered qualification after
the broad server suite to avoid competing with its crash and native-test jobs.
The browser clicks Services, designer, assumption acknowledgement, draft save,
freeze, native test and explicit activation before pairing and opening the App.
Setup alone creates no process. Do not replace these actions with an injected
activation receipt when assessing this pipeline.

The meeting review must contain the original CRM identity, participant,
calendar, title, absolute start/end and time zone. There is no Calendar write
before approval. A confirmed write is followed by readback; rejection and
failure before dispatch have no write. A lost reply after dispatch remains
unknown, with no readback or automatic resend. Chat, Tasks and authenticated
Loops retain the same process provenance. The current bounded output disclosure
only shows eight fields; full output visibility, including the meeting ID and
business status, is tracked separately.

This preview has the same remount, memory-only web vault and native peripheral
limits as the rendered HTTP acceptance. It is not a full browser reload, physical
Android, native SSO/audio or live CRM/OAuth acceptance. Physical acceptance is
explicitly deferred while isolated work continues. This server change requires a restart to load the
identity preflight below; the tests themselves do not restart a deployed server.

## Matched restore and process rollback

Restore the complete stopped server state as one matched set: configuration and
administration key, identity database and its original secret, native Mastra
database, workflow/chat/auth data, server ID and any other files referenced by
that configuration. Keep a protected original copy. An identity database without
its secret now refuses startup with `Existing identity database requires its
original secret`; restore the original file rather than generating another key.
The refusal occurs before opening or migrating the database and releases the
owner lock so a corrected set can be reopened.

A syntactically valid but wrong secret can still pass bootstrap. Startup success
does not verify credential decryption. Compare the original matched manifest and
verify decryption of a known controlled credential without logging it or invoking
a live action. Never reset identity, re-pair a device or reseed receipts to make
an incomplete restore appear healthy.

1. Stop and drain the single owner, and wait for its process to exit before
   taking the snapshot. Awaiting an in-process native storage `close()` alone is
   insufficient: deferred libsql statement finalization can later checkpoint WAL
   and remove sidecars. Copy every
   configuration-referenced path at the same checkpoint; do not mix current
   identity with older native or workflow databases. Preserve private ownership
   and permission bits, including private directories and key files.
2. Restore into a separate private directory while stopped. Compare an offline
   hash manifest with the snapshot. On a disposable full inspection clone,
   including WAL/SHM, run SQLite `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check` on every database before acquiring runtime locks.
   Normal read-only SQLite inspection can change sidecars; immutable main-only
   reads can omit committed WAL. Keep the protected snapshot and restore target
   unchanged during this inspection.
   An `ok` database check alone does not establish that files belong together.
3. Relocate configuration paths to the copied files. Preserve the server ID,
   account/workspace scope and externally visible URL used by existing devices.
   Verify original credential decryption and stored process/version/proof pins.
   If a file, identity binding or proof is missing or differs, keep the owner
   stopped and correct the snapshot. Do not mint replacement authority.
4. Reopen one owner and first perform passive authenticated reads. Original
   questions, decisions, receipts and run versions must remain; these reads must
   cause no model or service work. Reconcile any uncertain external effect before
   permitting continuation. An older snapshot can lack knowledge of a write
   already performed outside the server.
5. Roll a process back only to an existing qualified version through explicit
   activation review, with the current catalog revision and expected active
   version. Suspended A on v1 stays v1 and suspended B on v2 stays v2; only new
   starts use the reverted v1. Replaying an old activation receipt does not reset
   the current pointer. Process rollback does not undo external writes.

`pnpm test:process-restore` runs the synthetic missing/wrong-key preflight,
whole-directory copied restore, pinned v1/v2 approval and rollback, captured
compiler compatibility, qualification-reference and native-admission-ordinal
loss, historical catalog-router and paired HTTP regressions, foreign server-ID and missing canonical native
SQLite negatives, and a separate deferred-finalizer GC worker. The copied
restore closes the fixture owner, preserves all file bytes and modes, checks all
SQLite files offline and opens the relocated set on the same HTTP listener. It
also verifies that a new start uses v1 after rollback and denial creates no extra
write. The original historical runtime regression produces authentic `agent-1`
pending data with the retained old runtime and continues/replays it through
today's catalog router. Eight further paired HTTP cases cover both `agent-1`
and `progressive-1` journals: pending approvals complete, reject or record an
unknown write after a complete copied restore, preserving the original input,
scope and receipt identity. Two genuine waiting questions have no outer command
receipt before copying; their first current public request must read the original
journal without inference. Two owner reopens, exact-byte command replay and
snapshot GETs preserve both identity and workflow ledgers and all protected
source bytes and modes. Each case uses a separate bounded child process, so
the real pairing rate limit is retained.

A stable snapshot boundary is established for this synthetic in-process
fixture. After graceful close and before any baseline hash, a separate SQLite
connection must complete `wal_checkpoint(TRUNCATE)` and close both sidecars.
Busy checkpoints and orphaned sidecars refuse copying; the helper neither forces
GC nor manually removes them. A separate `--expose-gc` worker binds the exact
public parent checkpoint to its trusted journal, exercises busy-reader and
orphan refusals, and verifies the entire original manifest after finalization,
paired reopen and passive replay. This does not replace process exit in the
production procedure above.

The foreign-ID regression changes only the copied server-ID file. Bootstrap
refuses the mismatch; restoring its exact original bytes, without removing
owner locks, permits the original approval with one write and passive replay.
Removing only the copied canonical native database family allows passive
history to reopen but the original approval fails with
`process_checkpoint_missing`, visibly in the work card. The canonical action
receipt remains `awaiting_approval`, and retry/reopen add no inference or write.
Neither branch changes the protected original tuple.

Two further paired cases delete the completed native qualification job with
its actual foreign-key admission cascade, or combine an earlier waiting
domain/workflow tuple with a genuinely denied later native checkpoint under
the same server ID. Fresh execution is blocked without model/service work;
the mixed approval has a visible `process_checkpoint_interrupted` failure
and keeps its canonical action receipt awaiting approval. Reopen and exact
replay remain passive. A separate complete original snapshot fork and its
original client cache resume the same pin with one controlled write, without
resetting a failed copy's receipts or cursors. Original hashes and modes stay
unchanged.

The bounded synthetic compatibility/restore matrix is now complete.
The ten-case authentic historical matrix includes pre-existing failed receipts;
Separate tests prove original-question context and current verified
READ/Memory continuity, including an interleaved native run. Others prove
loss of the admitted domain journal and truthful saved-command recovery.
Recorded receipt replay alone is not the evidence for new-answer context.
This closes the confirmed missing-reference exception: an attached native
owner requires the original private qualification reference before activation,
form preparation, new admission or execution of an existing pin. Missing proof
returns `process_qualification_unavailable`. Passive historical provenance and
exact recorded terminal replay are not new grants. Restore the exact matched
proof from the same stopped snapshot; do not synthesize a replacement record or
requalify an artifact merely to make an incomplete restore selectable.

The genuine regressions delete only the copied reference or native admission
ordinal after real isolated qualification and human activation. Missing ordinal
returns `process_test_superseded`, without recreating the ordinal from completed
test or historical passed evidence. Public start and fresh approval/denial add
no model/service dispatch. Reinstating the exact original proof, including the
original ordinal sequence, resumes the original pending pin with one write.
Reopen before approval and replay after completion stay passive. The bounded
matrix also covers foreign identity, missing native family/job, interrupted
same-ID mixed checkpoints and missing admitted domain journal. A successful
bootstrap is not a universal matched-set verifier. The old engines' inventory/drain
and removal and the deferred physical acceptance remain separate.
These tests are not a production backup CLI, actual server-process failover or
old-binary migration rehearsal. Backup encryption and automation are
separate work. A server-binary downgrade needs an explicitly tested compatible release;
do not promise that older code can read compiler `/3` merely because process
rollback works on the current release.

## Native budget diagnostics — 6 October 2026

Native chat now explains missing model pricing, configured budget limits,
unverifiable model usage and changed policy using their specific server cause.
Submitted messages, the explanation and any recorded action remain in chat
after refresh or server reopen. A budget rejection no longer claims that a
task revision changed. Actual revision conflicts and authorization checks
retain their existing behavior. An uncertain service write still needs
verification before retrying; a budget error does not undo a prior effect.

Configure prices for both selected tools and decision models in the workspace
budget settings before testing. The agent does not invent prices or widen
limits. Inspect the recorded actions and usage before retrying an attempt
with missing usage or an overrun. Remote provider errors cannot masquerade
as internal budget codes.

`pnpm test:budget` includes twelve synthetic paired HTTP/ClientSession cases
in EN/CS, with real owner settings, confirmed/unknown write receipts and two
owner reopens. `pnpm test:process-restore` includes the new missing-job and
mixed-checkpoint cases. The accepted server/client batch passed 1228 server
and 1363 Jest tests; physical Android and live services remain deferred.
Load the changed server sources through the normal server restart, and
reload Metro JavaScript for the updated shared client banner. No native
dependency or APK change is required. The development server was not
restarted as part of this isolated acceptance.

## Reading full process output

Open the process output control on a completed task in Chat or Tasks. The card
is a bounded summary; the detail provides the full available safe values, page
navigation and nested fields. Sensitive values remain hidden. Loading, retry,
unsupported connections and lost context have explicit EN/CS explanations.
Reading, expanding and reopening do not execute the process again.

The server advertises `agent-process-output/1`; the current client negotiates
work/4 only after its same-Scope capability succeeds. No operator toggle or
new native dependency is needed. Older servers keep the previous work profile
and show that the full detail is unavailable for that connection. A result can
remain succeeded while current permissions, expired source receipts or OAuth
changes make its details unavailable. Check the recorded action outcome before
considering another write; loss of disclosure authority does not undo it.

`pnpm test:process-output` runs the synthetic server reader and historical
delivery regressions. `pnpm test:process-pipeline-web` runs the isolated actual
designer, qualification, human activation and paired App/HTTP meeting flow with
scripted external providers. The existing Playwright module must be available
through `NIARO_PLAYWRIGHT_MODULE`; this is a local browser check, not Android or
live-service acceptance. The implementation requires a normal server restart
and Metro JavaScript reload to appear in a running development environment;
this isolated work does not restart or activate that environment.

The accepted isolated implementation is in local commits `b57488e` and
`c3b24e3`. Final verification passed 1252 server tests, 1389 Jest tests and
five actual browser scenarios with 323 checks and 21 screenshots. Source
fingerprints stayed unchanged during final verification. This does not imply
physical Android or live-service acceptance, and the development environment
still needs the normal restart/reload before testing the new behavior.

## Old questions and clear process outcomes

After a normal server restart and Metro JavaScript reload, a reply to a still
valid old `agent-1` or `progressive-1` question can continue in a fresh native
Mastra run. It retains the original task and only currently verified read
sources. A missing, changed or expired question/source/Memory proof gives an
explicit explanation to start a new chat and recheck current data. The original
question has a 30-minute resume window; a new command in the same conversation
does not reset that window. Old pending calls and approvals are not transferred.
Any new write requires its own human review and approval.

Chat and Tasks now distinguish a declined action, a failed task and an unknown
effect. Unknown means the original action must be checked before another write.
A saved accepted answer whose current outcome cannot be correlated shows that
its result needs review. The original message, answer and recorded effects
remain available. Later local authentication, storage or connection failures
show their actual cause rather than borrowing an older process explanation.

No new native dependency, operator toggle or database reset is needed. Keep
the matched identity/native/workflow restore procedure above; context continuity
does not reconstruct missing proof or make a mixed restore valid.

`pnpm test:legacy-continuity` runs the two genuine synthetic legacy question
families, copied restore/reopen, verified READ and Memory continuity, singleton
handoff, proof-loss and final-publication races. `pnpm test:agent` also covers
the late authority guard regression. `pnpm test` covers shared announcements
and real ClientSession answer recovery. `pnpm test:process-pipeline-web` uses
the existing `NIARO_PLAYWRIGHT_MODULE` and checks EN/CS narrow/wide success,
human decline, unknown effects and failures through the actual admin/App/HTTP
pipeline. These are isolated checks; physical Android and live-service
acceptance remain separate.

New and revised saved Memory records calculate their retention deadline from
the same instant as their creation timestamp. This needs no operator
setting or data migration. The current retention policy and exact request
replay rules remain in force.

The accepted isolated changes are local commits `02762cc`, `a1a4702` and
`45a149d`. Verification passed 1257 server tests, 1462 Jest tests and eight
actual browser scenarios with 608 checks and 38 screenshots. Source
fingerprints remained stable. Restart the server and reload Metro JavaScript
normally before testing this code in a running development environment.

## Interleaved old questions

After a normal server restart, the server can find a still-valid original
legacy question even when another native domain run moved the catalog cursor.
It uses the original authenticated public proof and conversation, retaining the
goal, exact question and currently verified READ/Memory context in a fresh
native thread. A malformed, ambiguous or unavailable continuation gives the
existing explanation to start a new chat and check current data. No new
operator switch, native dependency, persistent schema or data reset is needed.
The existing 30-minute question deadline and approval/access guards remain.

Run pnpm test:legacy-continuity for both genuine families in direct and
interleaved scenarios. These tests include real paired HTTP/ClientSession,
copy/reopen/retry, provider context, original command/idempotency IDs and
source/Memory/authority loss. pnpm test:agent also checks hidden bindings,
400-candidate overflow, permanent consumed history, malformed accepted/pending
status, alias copies and asynchronous ownership.

Local source commit 2e9cd4b passed 1315 server tests, TypeScript, whole lint and
boundaries. Fresh independent review passed 113 targeted tests, 12 independent
boundary checks and the unchanged 2-case regression, with no remaining P1/P2.
All 735 source fingerprints stayed stable. Client/UI were unchanged; previous
Jest and browser results are historical, and this is not physical Android or
live-service acceptance. The production/devserver was not restarted by this
batch. Later work completed historical failed receipts, admitted-domain loss and
saved-command explanation. Their combined acceptance closes the bounded restore
matrix; engine removal and physical migration remain open.

## Historical failed-write restore

No new operator setting, schema migration or runtime dependency is needed.
Current public replay preserves an already recorded failed legacy write,
including its safe reason and next step. Its original ID, input, audit and
history remain intact. A failure before dispatch is distinct from an uncertain
outcome after a write was sent; verify the latter before another attempt.

Run `pnpm test:process-restore` for the ten-case historical HTTP matrix and
other restore guards. The two new failed cases use genuine retained production,
a complete stopped copy, first current public message/resolve without hot outer
receipts, exact retries and two owner reopens. All services and models are
synthetic. Do not treat these tests as populated OAuth or live CRM acceptance.

The accepted local test commit passed 1317 server tests, TypeScript, whole lint
and boundaries. Fresh review passed two failed cases, two independent wire
observers and the dispatched-write unknown guard. All 735 source fingerprints
remained stable. Client/UI and runtime were unchanged, so no new APK or client
reload is required for this test-only commit. This batch did not restart the
running server. Subsequent acceptance closes the missing admitted
journal and the bounded restore matrix. Engine removal and physical
migration acceptance remain open; Android acceptance is deferred.

## Admitted-journal loss and saved execution recovery

The isolated mechanical regression is part of `pnpm test:process-restore`.
It genuinely qualifies, activates and pairs a process, then loses exactly its
admitted parent journal on a private verified stopped copy. Original start and
approval commands return409 before execution; the canonical awaiting-approval
receipt remains intact. The declared orphan operation link is preserved, so
this deliberate fault is not represented as a foreign-key-clean backup.

A separate intact original-source fork performs one controlled write and no
replay effects. Independent focused20 and source controls6 passed; private logs stay in the ignored `.local-qa`. The client preserves the exact unknown
command and now explains an unverifiable execution in EN/CS. The reason survives
validated reopen; current local errors and native notices retain precedence.
A received conflict is not called a lost response. Explicit retry sends only
the original saved command; rendering and reopen do not retry it automatically.

The separate present-journal conflict uses the same general explanation, without
claiming a particular missing record. Restoring the original complete proof
permits one explicit original write and no later replay effects. The final
acceptance covered 1322 server tests, 1520 Jest
tests, independent21/21/196 controls and eight rendered EN/CS recovery scenarios.
The rendered scenarios use the actual Workspace/launcher and Session with an
injected synthetic transport; genuine backend HTTP has separate evidence.

Use `pnpm test:process-restore` for the permanent copied-proof regressions and
`pnpm test` for Session/mobile recovery. Reload Metro JavaScript to test the
updated mobile explanation; no native dependency changed. These fixture
operations are not a production backup command, universal restore guarantee,
old-server-binary downgrade, live-service or physical-device acceptance.
Engine removal and physical acceptance remain separate
work. Native-test diagnostics are described below.

## Incomplete native-test diagnostics — 7 October 2026

Update the backend and rebuilt admin console together, then reload the browser.
Use `pnpm admin:build` and the usual reference-server restart procedure. This
change adds no native dependency or mobile execution profile; it needs no new
Android binary. These are rollout instructions, not a claim that this session
restarted or deployed a server.

The console explicitly reads native-test detail with
`profile=agent-process-native-test-detail/2` and exactly one `requestId` or
`testId`. The response contains the unchanged `/1` job and request plus a bounded
diagnostic or `null`. Old `/1` detail clients still receive exactly their
original shape. All admission, list, read, tools and qualification contracts
remain `/1`; do not send the new detail profile to those endpoints. There is no
silent profile fallback.

Unexpected approval or an unanswered native question now has a specific reason
in the EN/CS test detail. Partial evidence preserves actual pending, unknown and
already successful action states. Storage and infrastructure failures have
separate explanations. Missing counters are not presented as zero. Technical
evidence expands on demand and excludes raw error text, stack, questions,
action input and output. An incomplete test cannot qualify activation. A
complete, correctly expected domain failure keeps its prior test semantics.

Read, refresh, replay and reopen are passive. To run another experiment after
correcting a scenario or storage problem, explicitly create a new test attempt
from the original scenario. Retrying the original request ID retrieves the
immutable interrupted outcome. Do not reinterpret a recorded successful or
unknown write as an instruction to dispatch it again.

`TSX_DISABLE_CACHE=1 pnpm test:process-native` runs the permanent native and
diagnostic regressions. `pnpm test:process-console` covers the detail contract
and console client; `pnpm test` includes the EN/CS report component regression.
The checks use isolated fixtures and synthetic model/action replies. They do
not verify live model quality, real service outcomes, physical Android, audio
or SSO. Physical acceptance remains deferred.

## Offline legacy inventory — 7 October 2026

The inventory is accepted as a bounded passive offline tool in isolated tests.
It examines an
explicit copied tuple without opening the identity server, loading a profile or
environment configuration, decrypting credentials, resuming a run or invoking a
model or service. Ordinary store constructors are unsuitable: they can migrate
tables and settle running action receipts as part of startup.

Keep the complete stopped copy private, using the matched snapshot procedure
above. Place its manifest and any output report outside the tuple root. An output
file inside the protected tuple would itself change the manifest. Invoke the
standalone tool with an explicit manifest:

```sh
pnpm inventory:legacy --manifest /private/manifests/legacy-inventory.json
```

The strict `niaro-legacy-inventory-snapshot/1` manifest declares the tuple root,
identity and workflow database families, original secret, server-ID file,
configuration, admin key, native families and owner-lock families. It includes
every regular file and directory with its relative path, size, mode and file
SHA-256. The `tupleRoot` must be its canonical absolute real path; trailing
separators, dot segments and symbolic-link aliases are refused. Every SQLite family explicitly declares whether its WAL and SHM are
present or absent. Missing declarations, undeclared files, escaping paths,
symlinks, mismatched bytes or modes, and orphaned sidecars are refused. The tool
does not offer a CLI mode to generate a manifest from a live server, or delete
locks or sidecars. The `observeLegacyTuple` library helper records observed
bytes only; calling it supplies no stopped-owner or common-checkpoint proof.
The exact role keys are `identityDatabase`, `workflowDatabase`,
`workflowServerId`, `originalSecret`, `configuration`, `administrationKey`,
`nativeDatabases` and `ownerLocks`. Database roles currently require `.sqlite`
filenames and their explicit families; other SQLite naming conventions are
unsupported. The CLI accepts only a regular manifest file of at most 2 MiB.

Inspection uses a complete disposable private clone, including declared
sidecars. Only that clone is opened through SQLite read-only transactions with
query-only mode and integrity/foreign-key checks. The original tuple is checked
before and after inspection. Explicit row, byte and file limits are checked
before large payloads are materialized or parsed; overflow cannot establish a
singleton binding or a zero count. No repair or checkpoint is performed on the
protected copy.
Limits are 10,000 total file/directory entries, 1 GiB of tuple files, 1,000 rows
per inspected table, 1 MiB per selected row and 64 MiB of aggregate selected
payload. The exported pure classifier also checks row count and aggregate flat
row bytes before serialization or JSON parsing; exceeding a cap cannot produce
passive entries or establish an empty inventory. A private outer directory keeps
the clone inaccessible even when its
inner copied directory preserves wider original permissions. The temporary
parent must lie outside the protected tuple.
Each database schema is inspected before integrity, foreign-key or data queries.
The reader supports ordinary physical tables and columns only. Views, virtual
or shadow tables and generated columns are rejected, including unused objects.
Schema limits are 1,000 objects/tables, 256 columns per table, 256 bytes per name,
1 MiB per selected schema row and 64 MiB of selected schema text per database.
These checks prevent a small recursive view from turning a bounded file scan
into an unrestricted data query. Duplicate canonical journal identities block
classification; a recorded completion must also agree with any public result,
even when the old answer omits its result field.

The report distinguishes complete enumeration (`scanComplete`) from supported
classification (`classificationComplete`). Canonical action receipts are counted
separately from their containing turns: a successful or unknown action does not
prove that all remaining work finished. Questions, approvals, incomplete batches
and unresolved delegated workflows stay active or blocking. A consumed question
requires its original accepted command, scope, request and correlated question
proof, one canonical native root, and complete ownership proofs for its aliases.

Report profile `/4` adds a redacted `nativeRuns` projection for recognized
`mastra-1` and `service-process-1` rows in the bounded identity-journal scan. It
contains only a 64-hex-shaped opaque row id when present, kind, a finite
classification and (when supported) finite saved status; it never copies native
goal, inputs, outputs, trace, pending approval or question. `terminal_candidate`
means only that a saved `service-process-1` journal, trace and all exactly linked
invocation receipts agree on a terminal status. `waiting` means its saved pending
question or exact write approval is consistent with the child journal or
invocation receipt; it remains a blocker. Running, unknown, malformed,
contradictory or unproven journals remain `unclassified`. A persisted status is
not proof that the owner stopped or that the journal shares a checkpoint with
the rest of the tuple. `mastra-1` records remain unclassified because the
inventory does not interpret their snapshot payloads or bind them to identity
roots. Legacy `entries` and `activeTurns`/`passiveTurns` remain legacy-only.
The report also checks the exact
`@mastra/core@1.74.0` / `@mastra/libsql@1.25.0` schema for
`mastra_workflow_snapshot` and `mastra_background_tasks` in each declared native
database, then emits bounded row counts only. It computes byte bounds inside SQLite across supported columns;
private values are never returned or interpreted. The report never contains
snapshot bodies, task status, arguments, results, errors or suspend
data. The complete input tuple has its separate 1 GiB cap. Schema drift,
corruption or a projection row/byte
limit marks the native scan incomplete and blocks classification. Every SQLite
family must have a declared identity, workflow, native or owner-lock role; an
unassigned family makes the manifest invalid rather than allowing a false
"no native database declared" result. The known canonical Mastra storage path
must carry the native role, not an owner-lock label. A scan of `not_declared`
means the manifest contains no native role after these checks. Any declared native database adds
`native_store_unclassified`, even when both counts are zero. A supported saved
waiting journal adds `native_waiting`; any uncovered row keeps
`classificationComplete` false. Other Mastra tables,
including memory and messages, are not enumerated. Exact ownership of a
`service-process-1` receipt may remove a false
`unowned_receipt`, but does not prove settlement. Unmatched receipts, ambiguous
ownership and native lifecycle remain explicit blockers.
An expired question is not evidence of consumption. Unknown effect receipts are
preserved; the tool never treats them as instructions to retry a write.

Standalone provenance remains `ownerStop: unverified` and
`commonCheckpoint: unverified`. Matching file hashes, an `ownerStopped` boolean
or an operator attestation cannot prove original process exit or a common
database checkpoint. Even a fully enumerated and classified copy therefore has
overall `status: incomplete` and exits with code **2**. Invalid input or an
inspection failure exits with code **1**. Neither output is permission for an
automated cutover or engine removal. The bounded report contains finite reasons,
validated identifiers, counts and a fingerprint, excluding transcripts, tool
arguments, action inputs/outputs, credentials and raw exception text.

Use `TSX_DISABLE_CACHE=1 pnpm test:legacy-inventory` for the classifier and copied
snapshot and CLI regressions; all are also in `pnpm test:identity`. Final focused
acceptance passed 77 tests (45 pure, 19 genuine stopped copies and 13 derived
snapshot controls), plus six CLI controls using a derived synthetic empty tuple.
The complete server regression passed 1,429 tests, with no failures, cancellations,
skips or todos, including the admin build. These counts overlap and must not be
added. Fresh independent review has no remaining P1/P2; 747 execution/config
files preserved their bytes and modes throughout final QA and the source commit.
Synthetic stopped fixtures and derived corruption controls are distinct from an inventory of a
deployed server. Retiring the old engines still requires that real inventory, safe
drain/closure and removal; live-model evaluation gates production cutover.
Snapshot automation and backup encryption remain separate work, as does physical
acceptance.

## Mobile task filters — 7 October 2026

Reload the Expo development app to load the three Tasks filters: **Waiting,
Active and Done**. Waiting is selected initially;
the All filter is removed from the mobile UI. This is a JavaScript change with
no new native dependency or APK requirement.

Done includes unsuccessful and cancelled terminal work as well as successful
work. Its cards keep their actual status, explanation and recorded receipts.
A stale open input cannot move a terminal task back to Waiting; live waiting
tasks are shown in one filter. Removing All does not hide closed errors or
change server execution, approval or effect outcomes.

The final complete client regression passed 1,533 tests in 114 suites; the
isolated native Tasks/projection regression passed 29 tests. TSC, scoped ESLint,
boundaries and formatting passed. These checks do not replace the pending
physical acceptance.

## Compact mobile Processes entry — 7 October 2026

Processes now opens from the small link icon beside the account icon in Chat,
or from the same icon in the Tasks header. The full-width button is removed.
The existing saved-request label, draft recovery, recording/playback cleanup
and Android Back behavior remain available. Reload Expo to load this JavaScript
change; no new APK or server restart is required.

The existing launcher mobile/view regression passed 37 tests in two suites;
TSC, scoped ESLint, Prettier and diff checking passed. These checks do not
establish a new physical-device or browser acceptance.

## Workspace processes, chat history and native saved Memory — 7 October 2026

Isolated implementation acceptance passed: backend 1462/1462,
client1551/1551, rendered workspace processes248 checks and chat history41.
Independent reviews have no remaining blockers. These synthetic/copy proofs do
not deploy the running server or accept the physical mobile harness.

Administration has a top-level **Processes** directory and designer for
workspace-owned processes. Their declared capabilities can reference several
services in the same workspace. They use the existing native compiler,
qualification, activation and execution flow, including explicit approvals.
Existing service-owned processes retain their identity and service placement;
creating a workspace process does not grant access to every service. New
workspace metadata/designer requests use `/2`; `/1` remains service-only on the
new server. Parent ownership is immutable. The new parent schema is a forward
migration; API compatibility does not establish old-binary downgrade support.

In Chat, the top-left history icon opens a drawer on the **right**. The directory
pages all chats authorized for the connection. Pins persist locally for that
connection identity. **New chat** creates an idempotent public conversation;
switching chats preserves each draft and native continuation. Old reset-session
archives are read-only. Historical pages display public text; current questions,
approvals and result cards still require fresh authorized projections. The
history/projection profiles negotiate explicitly, including a clear response
for an unsupported server or client. Expo Reload loads this JavaScript UI; no
new native package or APK is required.

Saved plugin payloads now live in encrypted thread-scoped **Mastra Memory**.
The original identity secret is required to read them. Niaro retains policy,
scope, expiry, lineage and receipts. The plugin still requires explicit save,
correction and erasure; opening history does not extract facts or run a model.
See [ADR 018](adr/018-native-saved-memory-and-conversation-identity.md).

A database containing legacy plaintext saved facts intentionally refuses
ordinary startup with `memory_copied_tuple_migration_required`. Rehearse the
transition on a complete stopped **disposable copy**, using its explicit
verified inventory manifest and original secret. The Memory tool does not stop
or certify owners, construct a production backup, or modify the source tuple.
The following placeholders are absolute paths to private copied artifacts:

```sh
pnpm memory:copied-tuple check --disposable-copy-manifest /absolute/private/copied-manifest.json
pnpm memory:copied-tuple migrate --disposable-copy-manifest /absolute/private/copied-manifest.json --output /absolute/private/fresh-native-output
pnpm memory:copied-tuple reverse --disposable-copy-manifest /absolute/private/current-native-manifest.json --output /absolute/private/fresh-reverse-output
```

Conversion outputs must be fresh directories outside the source. A native
manifest includes the adjacent `identity.sqlite.mastra.sqlite` family when
present, alongside identity/workflow storage, server ID, original secret,
configuration and administration key roles. Checks open only private clones.
The bounded supported format rejects unsupported SQL objects, oversized rows
and native metadata before SDK parsing. Reverse refuses staged publication or
pending erasure and exports **current** facts, revisions and tombstones. It does
not certify whole-server operation by an old binary. A server rollback needs a
matched tuple of all affected stores and its original secret.

The implementation batch does not migrate the running development instance.
Its last verified startup was HEAD `9e43da9`, unit `niaro-dev-server.service`,
7 October at 18:43:23 CEST. Isolated validation passed;
deployment and physical acceptance remain separate.

Operational follow-up: on the user's request, the current backend was started
on 7 October 2026 at 22:43:25 CEST, baseline `de7648bb`, after the old owner exited
and a private stopped data copy was verified. The actual legacy saved-fact and
receipt counts were both zero, so startup only converted the empty schema;
no populated facts needed conversion. At 22:45:35 CEST the unit was active
(PID629300, zero restarts), web/JS/CSS returned200 and matched local assets, and
the anonymous administration API returned401. Preexisting client/UI worktree
changes were preserved. Authenticated passive projections/receipt checks remain
open; physical acceptance remains separate.

## Chat-first mobile layout — 7 October 2026

The bottom tab bar is gone. Chat is the home screen with one top bar: **Menu**
on the left (a dot when work is waiting), the conversation title and **New
chat** on the right. The menu is a left drawer with New chat, Tasks, Meetings,
Processes, recent chats with pins, and Settings with the server host. Tasks,
Meetings and Settings return with Back; Android Back also returns to Chat.
Settings are grouped rows (Connection, Voice, App). Reload Expo to load this
JavaScript change; no new APK or server restart is required.

Jest passed 1,552 tests in 118 suites; TSC, ESLint and boundaries passed. The
chat-history browser QA passed 41 checks. `test:process-mobile-web` stops at
`openHistory` on this change and on clean HEAD alike: after a restart the
expected task is not listed under the default Waiting filter.

## Manual meeting recording — 8 October 2026

Meetings can start an explicit recording without a calendar event. **Stop and
process** uploads a durable, destination-scoped audio file in resumable binary
blocks, then produces one continuous complete transcript, one compact whole-meeting
summary and a consolidated task list through a closed Mastra agent. Proposals
do not create business records. Processing failure and restart preserve completed
excerpts; retry is explicit because a lost provider result may be charged again.
Configure the existing transcription service and language model, and install
`ffmpeg` / `ffprobe` on the server. Back up the entire private identity directory,
including its new `meeting-audio` files, alongside workflow and native Mastra stores.

This feature requires a rebuilt native client: run `pnpm android` or `pnpm ios`.
A JavaScript Expo reload cannot add the background recording permissions. The
Android development APK has been built successfully; iOS and physical background,
lock, interruption, storage exhaustion and sixty-minute acceptance remain open.
The server and browser/controller verification use synthetic audio/provider data.
See [meeting recording](meetings.md).

## Whole meeting record and human Tasks — 8 October 2026

A meeting record now has three sections: **Complete transcript**, **Meeting
summary**, and **Tasks from this meeting**. Transcription chunks remain internal
checkpoints/source locations; the transcript has no minute cards or pagination.
One closed Mastra call receives the entire original transcript in order. Model
context, budget and extraction limits fail visibly and preserve the transcript;
no partial task list is marked ready. Older Ready records require the explicit
Prepare unified record action to consolidate them, with no paid work on read or
server boot.

Tasks is now human work and decisions: Waiting proposals plus real unanswered
agent questions/approvals, Active accepted human tasks, and Completed finished or
dismissed human tasks. Agent execution status, failures, output and original
receipts remain in Chat and Loops. This replaces the earlier projection
of every agent execution in Tasks. Accept task assigns human work; Mark completed
records a human declaration. These controls do not invoke an external workflow
or create a CRM task.

Whole meeting record and its human proposals publish atomically. Task decisions
are revision-bound and use durable exact-command retry. Conflicts from another
device and deleted source meetings reconcile with fresh scoped state. Native
human_task_propose lets the ordinary agent save an obligation for a person under
current server authority; all owner/origin identifiers come from the server.

Reload Expo for the changed client interface. The recording feature still needs
the rebuilt native application described above. Isolated regressions and browser
QA prove contracts, persistence, rendering and native Mastra integration with
synthetic responses. Real Czech transcription/summary quality and Android/iOS
background capture still need acceptance. External action approval from a
meeting proposal is separate work. See [meetings](meetings.md)
and [human Tasks](human-tasks.md).
