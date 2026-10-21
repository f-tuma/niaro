> The console opens on an **Overview** of the selected workspace (for administrators, a first-run checklist until it is complete: AI provider with a key → enabled model → chat model in routing → usage limits in enforce mode with a current price for the chat model → a service with actions people may use → another member or a pending invitation; each step links to its page. Then the assistant runtime from voice input to voice reply, key counts and recent activity). The sidebar groups **Workspace** (Services, Plugins, Model routing), **Organization** (AI providers, People, Workspaces, Sign-in methods) and **Server** (Audit log, Loops, Settings). The workspace switcher sits at the top of the sidebar; theme, language and sign-out live in the account menu at its bottom. Start with the [catalog guide](service-catalog.md) and [self-hosting guide](self-hosting.md). Services are added explicitly through **Add service** using an API or MCP URL and credentials; there is no built-in connector section. **Plugins** at `/admin/plugins` manages shipped local tools for the selected workspace: enablement, default timezone, inherited defaults and technical details. See [internal plugins](internal-plugins.md#workspace-administration) for permissions, persistence and the API. The connector/account APIs below remain available for compatibility; public HTTPS origin support supersedes earlier localhost-only restrictions.

# Server administration foundation

The reference server can serve its own React administration at `/admin/`. It displays the selected workspace’s configured services, actions and model assignments. Viewing or refreshing the dashboard never calls a model, scans CRM, or writes a calendar event. `Configured` is configuration evidence, not a live provider health check. Expired credentials remain expired; this UI does not extend access windows.

Instance adapter configuration stays in the private server profile. Better Auth organization accounts manage workspace-owned API/MCP services, credentials and role grants directly in the console. The earlier Twenty/CalDAV-specific APIs documented below remain compatibility interfaces, not separate console screens. These changes take effect without a restart; allowed provider origins remain operator-owned configuration. App sign-in now supports a server URL and browser confirmation through the existing Better Auth account. Backup pairing remains available. Personal Twenty OAuth is configured per service and initiated by an account card in chat. Organization-scoped Google, Microsoft and GitHub sign-in providers have their own menu and can be assigned to a service. See [account and service authentication](service-authentication.md).

The console supports a mobile navigation drawer, searchable lists, focused edit panels and bulk action/model editing. See [long-list workflows](service-catalog.md#working-with-long-lists) for selection and failure behavior.

Services, Plugins, AI providers and Sign-in methods share a card overview. Each card opens a dedicated detail page; configuration and destructive actions stay inside that detail. AI provider models and their bulk controls live at `/admin/providers/:providerId`, plugin settings and previews at `/admin/plugins/:pluginId`, and sign-in configuration at `/admin/auth-providers/:authProviderId`. Detail URLs support direct loading and refresh. Breadcrumbs (or a back link on narrow screens) return to the overview even while data is loading or unavailable. The organization/workspace scope and management permissions are unchanged.

## Enable and run

From the repository root:

```sh
npm run admin:build
```

Restart the running reference-server process after rebuilding: it loads the console assets at startup.

Add an optional section to a private server profile; the key path resolves relative to that profile:

```json
{
  "administration": {
    "keyFile": "./admin-key.json",
    "sessionSeconds": 1800
  }
}
```

Then, once:

```sh
npm run server:admin-key -- .servers/current.json
```

Save the displayed key privately. The key file contains only a SHA-256 digest of a cryptographically random key, with owner-only permissions; the CLI refuses to overwrite an existing key. Start the server normally:

```sh
npm run server -- .servers/current.json
```

Open `http://localhost:8793/admin/` and enter the administrator key. Use the same hostname throughout sign-in. Rebuild and restart to pick up web code changes. Omitting `administration` leaves all `/admin` routes disabled.

The local development instance has administration enabled. Its initial recovery copy is in the ignored, owner-only `.servers/admin-backup-key.txt`; this is an operator backup, not read by the server. Do not copy it into a client bundle or a public profile. Other installations do not create this recovery copy automatically.

Rotation is an explicit local operator command:

```sh
npm run server:admin-rotate-key -- .servers/current.json
```

It replaces the digest atomically, invalidates existing administration sessions on their next request, and prints a new key once. Replace any private backup copy too. Restart clears recovery-key sessions; Better Auth account sessions persist until expiry or revocation. Normal application sessions use their separate existing persistence and are unaffected by admin logout/rotation.

## Access boundary

This development service binds to loopback only. Admin APIs accept the exact localhost/127.0.0.1/IPv6-loopback host and same origin, require JSON plus a custom header for POST, and reject cross-site fetches. Sessions use an independent opaque, HttpOnly, SameSite=Strict cookie scoped to `/admin`. The browser does not store the administrator key. The current HTTP-loopback cookie is not a production HTTPS deployment configuration.

Only the login shell, compiled public assets, enabled-auth-methods metadata and, while no account exists, the owner setup are unauthenticated. Instance inventory requires a recovery-key session; organization accounts receive no legacy instance integrations or tools. A mobile bearer token or pairing code cannot grant it. Login attempts and recovery-key sessions are bounded. Responses are no-store, carry a restrictive CSP and anti-framing headers, and expose an explicit metadata allowlist. Provider keys, credentials, private paths, linked-provider account data and contacts are never part of the inventory DTO.

The management contract is `agent-server-admin/2`, separate from the unchanged mobile workflow contract. It exposes:

- `POST /admin/api/login`: `{ "key": "…" }`, sets a session cookie; JSON has only `{ "ok": true }`.
- `GET /admin/api/overview`: instance label, workflow profile, service state/model/expiry/calendar label, registered tools and their permissions, sign-in readiness and the personal principal ID (null for the instance operator).
- `POST /admin/api/logout`: revokes both recovery and personal sessions and clears their cookies.

Instance inventory never executes tools or edits the server profile. The scoped personal test endpoint below can explicitly execute read-only TEST-contact tools. Calendar writes remain in the existing approved meeting workflow; the inventory does not invent a calendar-search tool.

## UI and validation

The developer console is an isolated npm workspace (`apps/server-admin`) with React, **TanStack Router + Query**, **shadcn/ui Radix Nova**, Tailwind CSS v4 and Vite. It shares the repository's npm lockfile, not the mobile entry point. Navigation has real same-origin routes: `/admin/` (overview), `/admin/services`, `/admin/services/new`, `/admin/services/{id}`, `/admin/plugins`, `/admin/routing`, `/admin/providers`, `/admin/people`, `/admin/workspaces`, `/admin/auth-providers`, `/admin/audit`, `/admin/loops` and `/admin/settings`. Earlier links (`/admin/access`, `/admin/accounts`, `/admin/settings?tab=people|workspaces|audit`, `/admin/tools`, `/admin/connections/…`) redirect to their current page. Reload and browser history work; the server serves the shell only for this explicit route allowlist.

The interface follows [`apps/server-admin/DESIGN.md`](../apps/server-admin/DESIGN.md): semantic tokens with light and dark themes, shared page/section/status/form primitives, compact tables, provider/model IDs and permission metadata. Theme and language are changed in the account menu or on **Settings**, stored only as local preferences; EN and the system theme are the defaults. Narrow layouts collapse table columns while retaining identifiers and permissions in the remaining cells or the detail page. Reduced motion is respected. Fonts are bundled locally with their OFL notice; no external assets are requested.

**Settings** (`/admin/settings`) also holds the server-wide settings for owners and administrators (signed in with an account): the server's name, its default time zone, meetings (audio retention, chunk length, glossary), the overview refresh and the integration and web client origins. The profile supplies the defaults; saved values live in the identity database (`GET`/`POST /admin/api/identity/server-settings`, with the revision for conflicts) and are audited. The origins apply after a restart, marked on the page. **Export** (`GET …/server-settings/export`) downloads them as a `niaro-server-settings` file, version 1, without secrets or paths; **Import** (`POST …/server-settings/import`) validates a file with the profile's rules, shows the changes in a confirmation and applies them. See [deployment](deployment.md#server-settings-in-administration).

Query manages inventory and cancellation. A 401 replaces cached inventory with an unauthenticated state; session expiry and logout cancel pending reads. The instance overview retains last valid data on non-auth failures with an explicit stale-state alert. Authorization errors hide identity/workspace contents. The calendar and AI editors retain drafts on temporary refresh errors and block saving until current permissions and revisions are reloaded. Requests time out after 10 seconds. Keys never enter Query's mutation cache or persistent browser storage. Rendering and refresh remain free of provider/tool side effects.

`@shadcn/lint` is registered in the existing ESLint configuration for the administration only, with every rule enabled: `no-raw-colors`, `no-arbitrary-values`, `no-unknown-classes`, `no-inline-styles`, `require-static-classes` and `no-restyle` (call sites may only place components; color, type, spacing, shape and effects come from component variants). Generated component internals under `components/ui` are exempt from the restyle/arbitrary-value/inline-style rules; the component library owns those measurements. For UI work with hot reload, run `npx vite --config apps/server-admin/vite.config.ts` against a running reference server (proxied from `http://localhost:5174/admin/`, override with `ADMIN_API_ORIGIN`). Run `npm run lint`. Component configuration is `apps/server-admin/components.json`; add official components with `npx shadcn add <component> --cwd apps/server-admin`. The normal build remains `npm run admin:build`.

## Better Auth accounts and workspaces

Better Auth **1.7.6** and its Organization plugin own the identity tables. Enable this optional section inside `administration`:

```json
"identity": {
  "directory": "../.identity",
  "baseURL": "http://localhost:8793"
}
```

The directory resolves relative to the profile and must differ from `dataDirectory`. The origin must be loopback HTTP at the configured listener port. The console redirects known UI routes to that canonical origin, also printed by the CLI. This is a local development foundation, not a production HTTPS/auth deployment.

Startup creates a private directory (0700), persistent random secret (0600), SQLite database (0600), official Better Auth schema and application-owned workspace, connection and policy tables. Another process cannot open the same identity directory for serving. Back up this directory as a unit, including the secret and a consistent SQLite snapshot, before changing auth versions. Workflow data and pairing files are not migrated or assigned to a company.

1. Open `/admin/`. While the identity database has no users, the page shows the owner setup instead of the sign-in (also inside the console after **Use a recovery key**, in **People**).
2. Enter the company name and its first owner's name, email and a password of at least 12 characters. This one-time operation is atomic: it creates the owner, the company and a first workspace named like it, and signs the owner in. Whoever does it first becomes the owner, so do it right after deploying.
3. In **People**, the owner can provision local accounts, change roles and remove membership. No invitation emails are sent. Existing global accounts cannot be reset or silently added by another owner.
4. In **Workspaces**, an owner or administrator can create spaces and grant members access. Ordinary members see only explicitly assigned spaces. Removing organization membership also removes its workspace grants.

Only owners manage organization roles/accounts; owners and administrators manage all of their organization's workspaces. The last owner cannot be removed or demoted. Membership and session validity are re-read for each request, including mutations. A selected organization ID never grants access, and the recovery key never impersonates an organization member. Body reads have an 8 KiB cap and a 10-second deadline outside the serialized DB operations. User + membership creation rolls back as one transaction if any step fails.

API contracts are explicit and do not expose the entire Better Auth router:

- `GET /admin/api/auth-methods`: whether account authentication is enabled (`identity`) and whether owner setup is open (`setup`, no account exists yet).
- `POST /admin/auth/sign-in/email`: local email/password sign-in; HttpOnly/SameSite cookie, rate-limited; response only `{ "ok": true }`.
- `POST /admin/auth/sign-out`: account sign-out (empty body is supported). The console uses the unified `/admin/api/logout` endpoint to revoke both types of session.
- `GET /admin/api/identity`: `agent-identity/1` principal and organization memberships, or setup status for the recovery operator.
- `POST /admin/api/identity/bootstrap`: first company/owner and workspace, only while no account exists (409 afterwards); no session needed, same-origin console request, 10 attempts per minute per address. Signs the new owner in (Better Auth session cookie) and ends a recovery session that made the request.
- `GET /admin/api/identity/organization?id=…`: permitted members and workspaces, with server-computed management flags.
- `POST /admin/api/identity/command`: validated `createAccount`, `changeRole`, `removeMember`, `createWorkspace`, `setWorkspaceMember` commands.

Public signup and raw organization endpoints are not exposed. Passwords never enter Query's mutation cache. The console scopes identity cache by principal and organization; logout/expiry clears it, session changes notify other tabs, focus always revalidates the overview, and identity pages refresh permissions every 15 seconds. Authorization errors hide previously displayed organization content. The server never relies on these client checks.

**Deliberately unconnected:** self-service ("forgot password") recovery without an administrator, and additional-company provisioning UI. Invitations (emailed or copied link) and administrator-issued password reset links are described in [app sign-in](app-sign-in.md). Workspace connection management and explicit test dispatch are implemented below. New workspaces have zero connection/tool grants. Global CRM/calendar adapters remain confined to their existing explicit fixture scope; model and voice sharing for account workspaces require operator opt-in. There is no automatic grant based on a role label. See [ADR 013](adr/013-better-auth-organizations.md).

Storybook exception: this is a standalone DOM administration entry, not a React Native catalog component. It is covered by real-browser EN/CS checks, desktop/mobile screenshots and server authorization tests. `npm run check` covers authentication expiry/rotation, throttling, origin rejection, token separation, metadata redaction, registry consistency and unchanged workflow tests. Run `npm run admin:build` separately; server tests create isolated public asset fixtures and do not depend on a checked-in build.

`npm run test:identity` runs real Better Auth + SQLite + HTTP tests through Node/tsx, separately from the Expo Jest transform; it is included in `npm run check`. Tests cover two organizations, multiple roles, immediate demotion/removal, workspace grants, last owner, signup/origin rejection, transactional rollback, concurrent bootstrap, slow uploads, persistence, revocation and both logout paths. All records are synthetic; there are no external requests.

## Workspace connections and tool grants

The first configurable provider is **Twenty · TEST contacts**, using the existing bounded read-only adapter. It exposes `crm.contacts.list` and `crm.contacts.search`; neither can mutate records or return non-TEST contacts. No legacy instance credential is imported into a company or workspace.

An instance operator first allows the exact trusted HTTPS origin in the private server profile, then restarts:

```json
"identity": {
  "directory": "../.identity",
  "baseURL": "http://localhost:8793",
  "connectionOrigins": ["https://crm.example.com"]
}
```

The default allowlist is empty. Origins cannot contain a path, query, credentials or fragment; redirects are rejected. The operator must control/trust the destination and its DNS/TLS configuration. This is an operator allowlist, not a public arbitrary-URL proxy or DNS-pinning mechanism. Removing an origin makes existing connections to it unavailable after restart. The example is not a deployed CRM address. The current local profile does not automatically enable any destination.

1. Sign in as an organization owner/admin and select **Connections → Workspace → Add connection**.
2. Choose an allowed origin, name the connection and enter its API key and actual expiry. The key is write-only. A new connection is disabled and has no tool grants.
3. Choose **Configure**, enable the connection and select allowed organization roles separately for each tool. Management access does not imply execution access: even an owner must be granted the tool to run it.
4. In **Tools**, run an explicit test. List returns up to 20 TEST contacts; search accepts a name (the API also supports a verified UUID). The result includes names and validated contact fields; incomplete scans are marked. Refreshing, navigating and editing configuration never trigger provider calls.
5. **Replace key** requires a new key and expiry; **Remove** deletes that connection's stored ciphertext and grants from the active database. SQLite backups/WAL retention remains an operator responsibility. An expired key is not renewed implicitly.

An ordinary member must belong to both organization and workspace and have a matching role grant. Its discovery response includes only enabled, unexpired, permitted tools/connections; manager responses also include disabled configuration for editing. Counts in Workspaces come from that scoped inventory. A connection currently belongs to one workspace; reuse across workspaces requires separate explicit setup.

API (personal Better Auth session only; the recovery key cannot invoke or manage these):

- `GET /admin/api/identity/connections?organizationId=…&workspaceId=…`: typed metadata, permitted tool inventory and management flag. No key or ciphertext is returned.
- `POST /admin/api/identity/connections/command`: `create`, `configure`, `rotate`, `remove`, `selectAgentConnection`; all include the organization/workspace selector. Existing-record mutations require `connectionId` and current `revision`; stale revisions return 409. Configuration supplies the two supported tool IDs and their explicit role arrays. `selectAgentConnection` takes a connection ID (or null) and the current `bindingRevision`; changing this selection also invalidates in-flight agent work.
- `POST /admin/api/identity/connections/invoke`: organization/workspace, `connectionId`, `revision`, supported `toolId`, validated `input`. Only read operations are exposed. The server builds the execution scope from its authenticated actor and authorized records.

Credential storage uses AES-256-GCM with a random nonce for every write, AAD bound to workspace/connection IDs, and an HKDF-derived key separated from Better Auth's persistent secret. Back up the identity secret and consistent database together; a database-only copy cannot decrypt credentials. This does not protect against compromise of the running server or its whole private directory.

Dispatch re-reads the session, organization/workspace membership, current role, origin/expiry, connection revision and tool policy before **and after** remote I/O. Membership commands increment an organization policy revision, so revoke-then-restore also discards an in-flight result. Remote work runs outside the serialized identity DB queue; it cannot prevent a revocation request. At most one invocation per user and eight overall may run, with an 8-second deadline and cancellation on disconnect/shutdown. Input/output schemas, TEST filtering, size limits and sanitized provider errors remain enforced by the shared tool registry/adapter.

The console keys inventory by principal, organization and workspace; switching scopes cancels pending local actions and clears test results. Permission loss closes privileged editors, and account changes clear scoped queries across tabs. Credentials use direct requests, never Query mutations or browser persistence. Account app execution uses the same scoped connection policy through the bridge below. This remains a local development profile.

Validation: `npm run test:identity` also runs `tests/connections.node.ts` against real local HTTP/SQLite with an injected synthetic CRM transport. It covers no implicit I/O, exact-origin denial, default deny, cross-company/workspace substitution, per-tool grants, encryption/record-bound ciphertext, revision conflicts, expired/revoked access during I/O, concurrent-call limits, safe failures, credential replacement, restart, and operator allowlist removal. It never calls the real CRM. Browser QA covers owner/member, live demotion with an editor open, scoped navigation/results, error states, unique form labels, and EN/CS at desktop and narrow widths. The standalone DOM Storybook exception applies here too.

Implementation references: [Twenty API authentication and endpoints](https://docs.twenty.com/developers/extend/api), [Node 22 authenticated encryption and HKDF](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

## Pair an app with an account workspace

1. Sign in with a personal account, open **Workspaces → Connect app**, then **Create pairing code**. The recovery key cannot create app identities.
2. Copy the displayed server address and code into the app's existing connection form. A code is single-use, expires after at most five minutes, and replacing it invalidates the previous pending code for this account/workspace. The console holds plaintext only in local component memory; closing the panel clears its display. **Disconnect my devices** also revokes undisplayed pending codes.
3. In **Connections**, select **Use in chat** on the intended CRM. Exactly one binding per workspace is supported initially; no connection is chosen automatically. Enabling/binding a connection does not grant its tools to any role. Listing and searching have separate permissions. The app renders the existing typed contact cards from server results.
4. An organization owner/admin selects the workspace's model and speech recognition profile in **Models & voice**. Both start disabled. The operator publishes the available profiles through the server configuration described below. To include an already configured instance adapter in that catalog, add the following to `administration.identity`, then restart:

```json
"mobile": { "model": "instance", "voice": "disabled" }
```

`voice` also accepts `instance`. These switches only publish the `instance` choice; they do not enable it for any workspace, configure a provider, renew a key or extend a budget. **After upgrading from the earlier global-sharing version, an owner/admin must explicitly select profiles for each workspace.** With the model disabled, new messages fail with `model_unavailable`; receipt replay and non-model workflow commands remain available. Instance CRM credentials are never inherited. Account meetings use an explicitly enabled workspace calendar (below), otherwise the existing simulation. They can never reach the legacy CalDAV target. The current main profile leaves both catalog switches disabled and does not renew the earlier test credentials.

The local server listens on loopback. In the Android emulator, replace localhost/127.0.0.1 in the displayed address with `10.0.2.2` (keep the port and workspace path), or use an explicit `adb reverse` mapping. This is not a physical-phone/production HTTPS setup.

For current apps (`agent-device-session/1`), the bearer lasts the configured server `sessionSeconds` (30–3600 seconds) and renews automatically using a separate device grant. Idle device grants expire after `administration.identity.mobile.sessionIdleDays` (1–90 days, default 30). Signing out of the console leaves enrolled devices signed in. Older clients retain their parent-session expiry/logout behavior; **Disconnect my devices** revokes this user's devices and pending codes for the selected workspace across console sessions. Revoking one app token does not sign out the console or another device. There is a limit of eight devices per account across workspaces and 512 overall; the panel shows workspace device count and account-wide remaining capacity controls issuance. Membership removal, workspace removal from a member, and role changes revoke affected devices/codes, including revoke-then-restore. A fresh pairing is needed afterward. The app can now start this account-scoped session through browser confirmation instead of copying a pairing code. QR and device naming/listing are still pending.

API:

- `GET /admin/api/identity/mobile?organizationId=…&workspaceId=…`: own workspace device count, account capacity and availability of the selected model/voice profiles.
- `POST /admin/api/identity/mobile/pairing`: organization/workspace selector; returns one code, address, code deadline and session deadline. No user/role/token is accepted from the caller.
- `POST /admin/api/identity/mobile/revoke`: revoke own devices and pending codes for that workspace.
- `/v1/<workspace UUID>/auth/pair`, `auth/session`, `snapshot`, `events`, `commands`, `activity`, `voice`, `voice/transcriptions`, `server`: existing app contracts with the authenticated account scope. The pairing request/bearer format and workflow profile are unchanged. Optional discovery uses `agent-server-info/2`, adding an explicit disabled interpretation state.

All codes, access tokens and refresh tokens are high-entropy and stored only as digests. Enrollment is tied to the consenting Better Auth session; current devices then have a separate grant linked to membership/workspace/user foreign keys. Each request rechecks device validity and current workspace access; legacy grants also recheck parent-session expiry. Captured policy/binding/connection revisions are rechecked before provider dispatch, after its result, and atomically with the final workflow commit. The account model service admits at most two concurrent interpretations, distinct from the legacy demo service; CRM calls use an 8-second bound. History is private to the account/workspace. Changing a tool grant stops future execution; it does not erase previously authorized contact results from that user's history.

`tests/mobile-identity.node.ts` uses real local HTTP, SQLite and Better Auth with injected model/CRM/voice doubles. It covers one-use/replaced codes, namespace and workspace substitution, restart, no implicit provider inheritance, independent grants, typed cards, replay with inference disabled, revocation during model/CRM/transcription, code cancellation, expiry and cross-workspace capacity. No real providers are contacted. Browser QA also pairs the web client through the console, renders a contact card and verifies that console revocation hides the user's chat on the next authenticated poll. The standalone DOM Storybook exception applies to the small inline pairing panel; the native app uses its unchanged pairing/card components.

## Workspace models and speech recognition

**Models & voice** at `/admin/ai` lets an organization owner/admin select a chat model and speech recognition profile independently for each workspace. Ordinary members use the server's selection in chat; they cannot read the profile catalog or change the selection, including through direct API requests. The recovery key cannot manage company AI settings. The mobile app has no model picker, provider credentials or routing logic.

The instance operator publishes a bounded catalog under `administration.identity.aiProfiles`. For example, merge this into that identity configuration:

```json
"aiProfiles": {
  "models": [
    { "id": "fast", "label": "Fast", "configFile": "./private/fast.json" }
  ],
  "voices": [
    {
      "id": "speech",
      "label": "Cloud speech",
      "adapter": {
        "provider": "openrouter",
        "configFile": "./private/voice.json",
        "assetsDirectory": "../.voice"
      }
    },
    {
      "id": "local",
      "label": "Local speech",
      "adapter": { "provider": "whisper.cpp", "assetsDirectory": "../.voice" }
    }
  ]
}
```

Paths resolve relative to the server profile. Each list accepts at most 12 unique IDs; `instance` is reserved for the optional existing-adapter entry above. Private OpenRouter files use the existing integration format, including the actual model, key, expiry, request cap and timezone. Cloud speech uses the implemented Gemini transcription adapter; its model is independent of the text model setting. Local speech uses the existing Whisper assets. The console does not accept arbitrary model names, provider URLs, executable adapters or credentials. Check the profile with `npm run server:check -- <profile.json>`; catalog/config-file changes require a server restart. Checks and UI refreshes make no provider calls.

The catalog is available to authorized managers across organizations on this instance. Selection is workspace-specific, but provider credentials and budgets remain operator-owned, not a per-company credential vault or billing system. Profiles using private configurations in the same directory share the existing budget database/window; choosing a profile never resets its cap or expiry. Unavailable, expired or removed selections do not fall back to another profile. Availability metadata is a local configuration/expiry check, not a remote health guarantee.

API, restricted to current organization owners/admins:

- `GET /admin/api/identity/ai?organizationId=…&workspaceId=…` returns `agent-workspace-ai/1`, the current `revision`, `selection: { modelId, voiceId }` and catalog metadata. Null means disabled. No secret, path or configuration file is returned.
- `POST /admin/api/identity/ai` accepts that organization/workspace selector, current revision and selection. Stale edits return 409; unavailable or unknown profiles are rejected. Current role and workspace access are checked on every request. Selection and the `workspace.ai_changed` audit record commit atomically.

Selection changes take effect without restarting or re-pairing. In-flight model/tool/transcription results recheck the captured policy revision; changing and restoring the selection still invalidates old work. Model availability is checked again at the final workflow commit, including after a CRM lookup. History and receipt replay remain readable when inference is disabled or expires. All selected text profiles share the account execution concurrency limit; selecting another profile does not bypass it.

The additive `agent_workspace_ai` table preserves selections across restarts. Back up the identity database, run `npm run admin:build`, and restart the server. Existing workspaces without a row default to both disabled, including previously globally opted-in workspaces. Legacy demo scopes and stored workflows are unchanged. The console preserves unsaved choices across refresh failures and conflicts, blocks saving stale data, and closes the editor on permission loss.

Verification uses real local HTTP, Better Auth and SQLite with injected synthetic providers: role and company isolation, conflicts, audit rollback, per-workspace routing, persistence, replay, in-flight policy changes and expiry during CRM. Browser QA covers saving/reload, conflicting edits, transient identity failures, live demotion and EN/CS at desktop and 320/393 px. No paid providers are called. The standalone DOM console retains its Storybook exception; the native client is unchanged. OAuth, workspace calendar connections, browser editing of provider credentials and per-company billing remain separate work.

## Audit records

Organization owners and admins can open **Audit** at `/admin/audit`. The page filters by workspace, configuration/tool events and result, with newest-first cursor pagination (50 records per page), manual refresh and 15-second refresh on the newest page. Ordinary members and recovery-key sessions cannot read an organization's history. Recovery access only records the initial owner/company bootstrap; it does not impersonate an account.

`GET /admin/api/identity/audit?organizationId=<id>` returns `agent-audit/1` with `entries` and nullable `nextBefore`. Optional parameters are `workspaceId`, `category=changes|tools`, `outcome=succeeded|running|failed|denied|cancelled|interrupted`, and `before=<positive record id>`. Authorization is rechecked for the selected organization and workspace. Invalid cursors are rejected. UI caches are scoped to the personal principal and organization, discarded on account/session changes, and hidden on permission errors.

Recorded events:

- Initial organization/owner bootstrap, local account creation, workspace creation, member role/removal and workspace membership changes.
- Workspace connection creation, configuration/grants, key replacement, removal and chat binding selection.
- Workspace model/voice selection changes, with previous/current profile IDs and policy revisions.
- Admitted workspace tool attempts from the console and account chat, followed by a validated outcome and duration. Authentication, scope lookup and capacity rejection before admission do not create a tool record. A committed message replay does not run or audit the tool again.

A configuration change and its audit row commit in the same identity SQLite transaction. Tool calls append `running` before provider dispatch, then finish once after the final permission/revision check. Revocation during I/O produces a denied outcome; aborted requests are cancelled. Unfinished records become interrupted when the identity service closes or next opens after a crash. A succeeded tool row describes that individual validated read, **not** a committed chat message, approved proposal, calendar write or completed workflow.

The strict metadata allowlist stores IDs, roles, grants, revisions, timestamps, outcome and a bounded reason code. It never stores keys, passwords, request bodies, tool arguments/results, transcripts, contact records or raw provider exceptions. Account and workspace names are resolved from current identity metadata when reading; they are not historical snapshots. Tool errors use generic localized descriptions in the console.

The additive `agent_audit` table is created automatically in the existing private identity database. Back up the identity SQLite database before upgrading, rebuild `npm run admin:build`, then restart the backend. Existing rows and workflow data are preserved; events before this version are not reconstructed. There is no new profile setting and no client workflow-contract change.

This is a local operational history, not a tamper-evident compliance archive. There is no automatic retention/purge or export yet. Login/logout, pairing, inference/transcription calls and legacy fixture `/v1/a` / `/v1/b` operations are outside this audit scope. Operator profile/CLI changes are also outside it. Further coverage, bounded retention and remote durable export remain prerequisites for a production audit policy.

Verification: `npm test` covers storage ordering/pagination, strict metadata, terminal outcomes, crash recovery and the route; `npm run test:identity` covers real Better Auth HTTP permissions, organization isolation, mutation rollback on audit failure, console/chat outcomes, replay and rotation/revocation races. Browser QA uses isolated TEST accounts and a simulated CRM; no provider credentials are required. The standalone DOM console retains its documented Storybook exception and is checked through its real browser route.

## Agent loops

Owners and admins can open **Loops** beside Audit log at `/admin/loops`. Select a run to read its steps as a vertical timeline in recorded order. **Run overview** is the default: every recorded model, verification and tool call remains visible, including discovery and card composition. Only a tool and its exactly bound result share a step; proposal and execution remain separate. **All steps** shows the separate recorded results; retried steps are marked. Each step shows a readable action or tool name, the service or model, at most two important facts, and its state and reason only when it did not succeed. Missing evidence is omitted on the step and stated in its details. EN/CS, light/dark themes and narrow screens are supported. Workspace/state filters and stable cursor pagination return 50 runs per page; the current page refreshes while open.

Clicking a step opens, in place, an action overview, its canonical input fields and its known result. Technical identifiers and transport metadata are collapsed separately. Action details come from a stored receipt bound to that turn's operation, organization, workspace and actor, rather than model-authored arguments or prose. Each input/result preview allows at most 12 fields, 1,000 characters per value and 4,000 value characters in total, up to three collection records and eight nested levels. Omitted/truncated content is explicit. Business fields such as names, email, phone, title and dates take precedence; recognizable credentials, headers/cookies, raw response blobs, binary content and MCP media/resources are omitted or redacted. MCP structured results take precedence over their text copy. An unavailable historical result is not represented as a successful empty lookup.

Each step's icon and label carry its role (conversation, model, validation, internal tool, service read or write); there are no role columns. Measured durations appear when available. The exact tool identifier, operation ID and timestamps stay in the step's collapsed technical details. One step is open at a time. Expansion animates in place; reduced-motion preferences disable it. **Run details** retains the full recorded request and immutable run/process/version/artifact/actor/conversation/command/admission provenance. The header is a short preview. A request-only trace shows an explicit empty step state. On wide screens the run list and timeline scroll independently; narrow screens use the stacked layout.

Native observer events now record optional `tool` evidence (name, outcome, bounded input/output fields and typed failure) alongside the canonical `action` receipt. Discovery includes its requested need, selected service and returned counts; card composition and memory mutation expose only safe structural/canonical status, not card documents, private memory bodies or model reasoning. Actual model identifiers come from the selected runtime model. Missing, omitted and truncated evidence have distinct labels. Both capture and the read-only API sanitize these projections; known credential values in failure fields are redacted before clipping. Legacy envelopes are recognized conservatively and cannot reconstruct raw arguments or results.

Native argument validation checks original JSON against the same declared schema before SDK normalization/checkpointing and before every invocation/resume. Invalid calls have one `invalid_arguments` step with safe structural field issues and no captured input values; unavailable tools remain `unavailable`. Opaque rejection markers survive process restart without becoming valid empty arguments. Unknown model-supplied tool names use a safe unavailable identifier instead of entering native history. Current root-field compatibility restrictions and reload instructions are in [self-hosting](self-hosting.md#loop-evidence-and-recording-interruption-4-october-2026).

Failed and unconfirmed actions also show **Why this did not complete**: the recorded cause, reported field issues and a safe next step. Error code, HTTP status and failure stage stay in technical details. The optional bounded `action.failure` projection shares the agent's diagnostic evidence; it is not the provider's raw response. An unknown write always asks for verification before repeating it. Earlier attempts with no saved diagnostic say that the cause was not recorded, rather than guessing it. See [failure semantics](service-catalog.md#authority-and-failure-semantics).

The read-only `agent-loops/1` API is `GET /admin/api/identity/loops?organizationId=<id>` and `GET /admin/api/identity/loops/<64-hex-turn-id>?organizationId=<id>`. List parameters: optional `workspaceId`, `status=running|succeeded|waiting|failed|cancelled|interrupted|unknown`, and the opaque `before` value from `nextBefore`. Both endpoints check current organization management permissions. Organization/workspace scope comes from the server's stored turn ownership; members, recovery operators and foreign organizations cannot read these traces.

New `agent-1` turns record server timestamps and operational metadata in their existing durable journal. A decision shows its explicit question, selected criterion and confidence; no private model reasoning or prompts are copied into the trace. Administrators see bounded request/reply and business-field previews, not complete arguments or provider bodies. The optional typed `action` projection is additive within `agent-loops/1`; it does not expand who can read a turn. Credential-bearing URL user info, query and fragments are removed. Unknown model-authored tool names receive a generic label. A trace is limited to 160 nodes/320 edges, with explicit truncation when its 120 recorded steps are exhausted.

Completed loops can contain failed attempts followed by successful recovery. An unverified write remains **unknown**, missing lookup evidence and exhausted budgets remain **failed**, and awaiting a question or approval remains **waiting**. A waiting proposal keeps its original state and has no execution output even after a later approval; the separate approved step shows its outcome. A declined proposal is cancelled/rejected and never claims an attempted write. Restart marks previously running traces **interrupted** without rerunning actions. Memory mutation checkpoints retain their atomic result when diagnostic finalization follows a crash. Old turns are labeled **reconstructed**: only recognized recorded tool request/result envelopes are used, without fabricating decisions, success from an empty envelope or unavailable durations. Historical clock timestamps identify the stored request reference, not measured start latency.

Known terminal model/protocol/native execution failures now have a safe correlated chat explanation and a native task, including failures with no tool operation. A failed run can still contain confirmed successful actions; an unknown write remains unknown. A terminal candidate whose native retirement is unproved stays unavailable for continuation and appears as waiting for the system, rather than falsely showing success or an answerable question. Passive result checks cannot rerun the loop. Existing historical missing answers are not automatically repaired; see [terminal failure semantics and coverage](agent-trust.md).

This view covers native chat (`mastra-1`), custom service processes (`service-process-1`) and earlier planner turns (`agent-1`), not legacy fixture/progressive workflows, transcription or speech playback. Custom processes use the same safe model/tool observer projection as chat; workflow scaffolding is labeled separately from actual provider calls. Canonical unknown writes and declined proposals keep their original uncertainty/phase even when a native tool throws. Historical traces with missing previews are not backfilled from raw bodies. It is a local diagnostic view with the identity journal's existing retention; it is not an immutable audit archive. Rebuild `pnpm admin:build`, restart the backend and reload the console to activate it. No mobile protocol/profile change or new dependency is needed.

Verification uses isolated synthetic SQLite/Better Auth fixtures and injected providers (`tests/loops.node.ts`, `tests/loop-trace.node.ts`, `tests/loop-action-details.node.ts`). `tests/loops-admin-fixtures.ts` supports browser QA without business actions; layout and summary tests cover branching, cycles, observed-edge contraction, preserved uncertainty/retries and separate proposal/execution. The DOM console has the same Storybook exception as Audit and is verified through its actual route.

## Workspace calendar

Connections (`/admin/`) now includes one CalDAV calendar per workspace. Owner/admin can connect it, replace credentials, configure its enabled state and grant event creation to owner/admin/member roles. Creation starts **disabled with no roles**; ownership alone does not grant execution. Members see only an enabled, operator-allowed calendar they may use. Recovery sessions cannot manage company calendars. Tools lists `calendar.create` as a chat capability; it has no direct test/write button.

The instance operator must publish exact collection URLs in the private profile, then restart:

```json
"identity": {
  "directory": "../.identity",
  "baseURL": "http://localhost:8793",
  "calendarCollections": ["http://127.0.0.1:5232/test-company/meetings/"]
}
```

Merge this with the existing identity settings. The list defaults to empty and accepts up to 20 canonical HTTPS collection URLs, or explicit loopback HTTP (`127.0.0.1`/`[::1]`). A collection ends in `/`; URL credentials, queries, fragments and encoded/non-ASCII paths are rejected. Each exact URL can belong to only one workspace on this instance. The operator is responsible for selecting dedicated collections and narrowly scoped service accounts. This is not CalDAV collection discovery, a network sandbox or proof that two different URLs cannot alias the same calendar. Removing a URL from the profile makes that connection unavailable after restart.

The console accepts a connection label, allowed collection, CalDAV username (letters, numbers, `_`, `-`) and app password (16–512 characters). Credentials are write-only, AES-256-GCM encrypted in the private identity database with a separate HKDF context and workspace/connection AAD. Neither username nor password/ciphertext is returned in the DTO or retained in the Query mutation cache. Connect/configure/rotate/remove and refresh perform **no provider I/O**; “Configured” does not assert that credentials work. Disconnection removes configuration, never existing remote events.

Management contract `agent-workspace-calendar/1`:

- `GET /admin/api/identity/calendar?organizationId=…&workspaceId=…`: role-filtered metadata, revision, allowed collections for managers, and `canCreate`.
- `POST /admin/api/identity/calendar`: strict `organizationId`, `workspaceId`, `type` plus command fields. `create` takes `name`, `collectionUrl`, `username`, `password`. `configure` takes `calendarId`, `revision`, `enabled`, `roles`. `rotate` takes `calendarId`, `revision`, `username`, `password`. `remove` takes `calendarId`, `revision`. All successful mutations return current metadata.

Connection ID **and** revision are required: an old form cannot alter a replacement connection whose revision starts at 1. Mutation and metadata audit commit atomically. The UI preserves drafts during polling, transient failures and revision conflicts; it blocks stale saving and requires explicitly loading the newer version. Workspace/account changes and known loss of management rights remove the editor. Organization and connection permissions must agree before rendering a cached administrator projection.

### Approved execution and recovery

The server attaches the authorized target to the existing meeting proposal card. Explicit approval binds its exact parameters, connection revision and the initiating member's relevant access epochs. The worker rechecks the current role, workspace membership, operator allowlist and calendar grants before and after each CalDAV request and at final workflow commit. Revoking then restoring access does not revive the old attempt; changing an unrelated workspace does not interrupt it. Logout/session expiry do not cancel an already approved durable operation: current membership and grants authorize its continuation. The app needs a valid session again to read the result.

Execution uses the existing bounded CalDAV adapter: a stable UID, initial GET reconciliation, conditional PUT (`If-None-Match: *`), then GET verification of the exact event and a strong ETag. Redirects are rejected and each request has an 8-second deadline. Lost responses can be reconciled after restart without a duplicate write. A configuration or access change stops subsequent network requests and disables retry of the old target. A request already in flight may have created the event; it is reported as **result unconfirmed**, never as undone, cancelled or verified success. Inspect the old target before preparing a replacement proposal in that situation. Calendar changes also invalidate in-flight interpretations prepared against the old connection.

No `ATTENDEE`, `ORGANIZER` or scheduling `METHOD` is emitted: **no invitations or emails**. This remains the existing TEST meeting workflow, not general calendar search/free-busy/edit/delete or a production scheduling service. Proposals created while the workspace was simulated remain simulated; enabling a connection does not silently upgrade their effect. Legacy demo scopes keep their separately configured adapter; account scopes never fall back to it.

Audit includes calendar creation, permissions, credential rotation, disconnection and admitted execution attempts. Attempts start `running` and end `succeeded`, `unknown` or `interrupted`; `unknown` means the external result was not verified. The tools category includes these attempts. Metadata contains connection/revision, actor/workspace, roles for configuration and duration/reason, never event content or credentials. As before, identity audit and workflow SQLite are separate stores, not a distributed transaction or immutable compliance log.

`tests/workspace-calendar.node.ts` exercises real HTTP/Better Auth/SQLite and the mobile proposal/worker with a synthetic CalDAV transport: default deny, owner/admin/member, strict input and scope rejection, encrypted storage, audit rollback, replacement conflicts, approval/replay, revocation before/after PUT, permission revoke→restore, lost response + unrelated workspace mutation + restart reconciliation, and removal from the operator allowlist. It makes no real calendar/CRM or paid model calls. UI uses the standalone DOM Storybook exception; browser QA covers saved settings, credential field structure, stale drafts, conflicts, permission changes, workspace switching, audit, EN/CS and narrow layouts. Native cards are unchanged.

Protocol reference: [CalDAV, RFC 4791](https://www.rfc-editor.org/info/rfc4791/). A real provider compatibility test, OAuth and broader calendar operations remain separate work.
