# Design

## Context

See proposal.md (Why). The facts below shape the approach.

**Data layout** (automatic profile, `apps/reference-server/config.ts` `automaticServerProfile`): everything sits under `NIARO_DATA`:

| Path | Written by | How it migrates at startup |
| --- | --- | --- |
| `identity/identity.sqlite` | `openIdentity` in `apps/server-identity/service.ts` | Better Auth `getMigrations(authOptions).runMigrations()` (better-auth 1.7.6); `mcpOAuth.upgradeResourceScopes()`; each store's own `CREATE TABLE IF NOT EXISTS` and guarded `ALTER TABLE` (`memory.ts`, `skill-store.ts`, `mobile.ts`, `device-sessions.ts`, `invitations.ts`, `hub-store.ts`, `account-security.ts`, `service-catalog.ts`, `service-processes.ts`, `process-design-capabilities.ts`, `process-owner-migration.ts`, `server-hosting/manager.ts`); a read-only `assertNativeMemoryFormat` preflight that refuses unknown memory formats |
| `identity/identity.sqlite.mastra.sqlite` | `LibSQLStore` (`@mastra/libsql` 1.25.0), opened in `server-agent/runtime.ts` `newOwner` at the URL from `service-catalog.ts` | Schema owned by the library; a dependency bump can migrate or reject it |
| `identity/secret` | `openIdentity` | Never rewritten. It encrypts provider and service credentials and memory payloads (`memory-payload-crypto.ts`). An existing database without it refuses to start |
| `identity/meeting-audio/*.audio` | `meeting-store.ts` | Files. The retention sweep `scheduleMeetingSweep` runs once at startup (`setImmediate`) and then daily |
| `identity/hosted/`, `identity/plugins/` | hosted connectors, operator plugins | Files |
| `workflow/workflow.sqlite` | `FixtureStorage` in `apps/fixture-server/storage.ts` | `PRAGMA user_version` must be 0 or 1, otherwise "Unsupported workflow storage version"; idempotent DDL; deletes `card.respond` receipts; `ConversationHistory.migrate()` (adds `custom_title`, `deleted`); `ChatSearchIndex.migrate()` backfill; `importLegacy`; checks `metadata.server_id` |
| `workflow/auth/server-id` | fixture auth | File. Must match `metadata.server_id` ("Persisted server identity mismatch") |
| `admin-key.json` | `issueAdminKey` | SHA-256 digest only |

On startup, `apps/reference-server/cli.ts start` opens identity first (`openIdentity`) and the workflow store second (`createReferenceServer` → `createFixtureServer`). If the workflow store refuses the data, the identity database has already been migrated. A refused start is therefore not side-effect free; rollback is the pre-upgrade backup, which the spec already says.

**Existing tooling we build on:**

- `scripts/backup.mjs` and `scripts/restore.mjs` with the `niaro-backup/1` format (`backup-common.mjs`). Restore checks the manifest checksums and runs `integrity_check`.
- `tests/deployment.node.ts`. Its last two tests spawn the real CLI (`node --import tsx apps/reference-server/cli.ts start`) on a free port, using a profile file or the automatic profile, and wait for `Administration:`.
- `scripts/smoke/lib.mjs` (`Client` with a cookie jar and bearer support, `Report`, `assert`) and `scripts/smoke/api-journey.mjs`: owner bootstrap, workspace, invitation by link, member onboarding, app credential, chat with the fixture model, hub, connections and account access, all through public routes.
- A fresh automatic-profile server is ready in about 4 s. Its backup is about 40 KB (3 databases, 102 tables in `identity.sqlite`).
- The repository has no git tags. The pilot deploys `main` (`compose.dokploy.yml`, `NIARO_GIT_REF` default `main`).
- CI (`.github/workflows/ci.yml`) has jobs lint, jest ×3, server ×6 (`test:identity`, sharded by `scripts/ci-node-tests.mjs`), mcp, app and extras. Checkout is shallow, with no tags.

## Goals / Non-Goals

**Goals:**

- On every push, prove that the current server upgrades data written by the previous release's server: startup succeeds, nothing is lost, everything reads back, sessions survive.
- Keep the per-push cost to one restore and two short server starts, plus one fresh seeding run. Use no network, no Docker and no second dependency install.
- Make refreshing the baseline at a release one command on a clean checkout.
- Make deliberate data drops explicit and reviewable.

**Non-Goals** (beyond proposal.md):

- No change to production migration code and no migration framework. If the test finds a loss, the fix is tracked in its own issue unless it is trivial.
- No coverage of upgrades that skip a release. The spec says these go one release at a time.
- No check of the image-level details (uid 1000, read-only root, `/app/voice`). `npm run smoke` covers the image on a fresh volume.

## Decisions

### D1. A committed baseline written by the real previous-release server (chosen)

The baseline is `tests/fixtures/upgrade/baseline.tar.gz`, a normal `niaro backup` archive, plus `tests/fixtures/upgrade/baseline.json`. It is produced at release time by `npm run upgrade:baseline` (`scripts/upgrade/baseline.mjs`), which does the following on the checked-out release commit:

1. Refuses to run when `git status --porcelain` is not empty.
2. Starts that commit's server from source with the automatic profile in a temporary `NIARO_DATA` on a free port, with `NIARO_LOG=1`.
3. Runs `seed()` from `scripts/upgrade/journey.mjs` through public routes only (D3).
4. Calls `read()` from the same module to record the expected readings.
5. Stops the server with SIGTERM and runs `scripts/backup.mjs <data> baseline.tar.gz`. Stopping first gives one consistent point across all databases, as the deployment guide recommends.
6. Writes `baseline.json`: `format: "niaro-upgrade-baseline/1"`, `sourceCommit` (`git rev-parse HEAD`), `sourceTag` (`git describe --tags --exact-match`, or null), `createdAt` (the backup manifest's), `node`, the test-only `credentials` (owner and member email and password, recovery key, member browser session cookie, app refresh credential), the seeded `ids`, and `expect` (the `read()` result).

Alternatives considered:

- **(A) Check out and run the previous tag in CI on every push** (git worktree, `pnpm install`, `admin:build`, start, seed, stop, then start HEAD). This is the most realistic option, because old code writes data during the test. It was rejected for every push: it adds 2–4 minutes and a network install per run, it breaks when the old lockfile, Node engine or registry drift, it needs full-depth checkout and tags (CI is shallow and there are no tags), and it doubles the moving parts that can time out. Option B keeps its realism, because the same "old server writes data through its API" step runs once per release instead of once per push.
- **(C) Schema-level migration tests per store** (hand-written old DDL for identity, workflow, Mastra, meetings, secrets). These are the cheapest and give precise failure messages. They were rejected as the upgrade guarantee because they test the author's idea of the old schema. They also miss library-owned schemas (Better Auth tables, about 30 `mastra_*` tables) and cross-store invariants (`secret` paired with `identity.sqlite`, `workflow/auth/server-id` paired with `metadata.server_id`). They remain the complement: a change that writes a non-trivial migration still adds a focused store test, as `tests/hub-widgets.node.ts` ("older type version") and `tests/legacy-catalog-migration.node.ts` do today.
- **(D) Synthetic fixture written by test code with direct SQL** (the `tests/helpers/identity-seed.ts` style). Rejected: the data shape would come from the test rather than from the server.
- **(E) Old Docker image plus volume.** This would also cover ownership and permissions. Rejected for CI: it needs Docker and an image build that compiles whisper.cpp. It can be added to `npm run smoke` later (open question 3).

### D2. The suite: `tests/upgrade.node.ts`

There are three `node:test` cases. A shared helper `verifyUpgrade(archive, baseline)` does the work:

1. **Restore**: `scripts/restore.mjs archive <tmp>/data`. Exit code 0 is required. This is the previous-release backup format being read by the current restore.
2. **Before counts**: open every SQLite file under `<tmp>/data` read-only, as `scripts/backup-common.mjs` `isSqlite` detects them. Record each table's row count, skipping `sqlite_*` tables and the shadow tables of virtual tables (found from `CREATE VIRTUAL TABLE` rows in `sqlite_master`). Record `PRAGMA foreign_key_check` rows and the SHA-256 of every non-SQLite file, taken from the backup manifest.
3. **Start** the current CLI exactly as the image does: `node --disable-warning=ExperimentalWarning --import tsx apps/reference-server/cli.ts start`. Use the automatic profile (`SERVER_PROFILE=""`, `NIARO_CONFIG=""`), `NIARO_DATA=<tmp>/data`, a free port, `NIARO_PUBLIC_URL=http://localhost:<port>`, `NIARO_LOG=1`, and the clock preload (D4). Wait for `Administration:` and `/readyz` 200, with a 90 s limit, the image's start period. Fail if the process exits or the log contains "No owner yet" (the owner must still exist) or any operator line with `"level":"error"`.
4. **Read back**: `read()` must deep-equal `baseline.expect` after `normalize()`, which drops timestamps such as last-used times and replaces the public origin. Session checks: the stored member cookie gets 200 from `/admin/api/identity` as the same user, and the same request without a cookie gets 401. The stored app refresh credential is exchanged at `/v1/<ws>/auth/refresh`, and the new bearer token reads `snapshot`. The stored recovery key gets 200 from `/admin/api/login`, and `acadmin_wrong` gets 401. The owner signs in with email and password.
5. **Restart**: SIGTERM, wait for exit, start again, read back again, stop.
6. **After checks**, with the server stopped:
   - `PRAGMA integrity_check` returns `ok` for every database.
   - `foreign_key_check` finds no violation that was not already in the before set.
   - For every table that was counted before: if the table is missing or has fewer rows, the test fails with `<db>:<table> before → after`, unless `DECLARED_CHANGES` lists it.
   - Every non-SQLite file from the manifest still exists with the same hash, unless it is declared.
   - The workflow `metadata.server_id` still equals `workflow/auth/server-id`.
7. **Round trip**: `scripts/backup.mjs <tmp>/data <tmp>/after.tar.gz`, then `scripts/restore.mjs` into another empty directory. Both must exit 0.

The cases:

- **"the current server upgrades the previous release's baseline"** runs `verifyUpgrade(tests/fixtures/upgrade/baseline.tar.gz, baseline.json)`. It prints the baseline age and `sourceCommit` with `t.diagnostic`.
- **"the baseline journey still seeds the current server"** runs the generator's pipeline (start, `seed()`, `read()`, stop, backup) into a temporary directory and then calls `verifyUpgrade` on that archive. This keeps `seed()` working between releases and also checks a same-version restore and restart. The generator and this test share one function (`createBaseline(outDir)` exported from `scripts/upgrade/baseline.mjs`). The CLI wrapper only adds the clean-tree check and copies the result into `tests/fixtures/upgrade/`.
- **"a refused upgrade fails closed"** restores the baseline twice into fresh directories. In the first, it sets the workflow store's `PRAGMA user_version=99` and expects the generic "Server setup failed…" message and a non-zero exit. In the second, it deletes `identity/secret` and expects a non-zero exit with the `identity.sqlite` hash unchanged.

`DECLARED_CHANGES` is a constant in the test. Each entry has `{ db, table | file, kind, reason, issue }`:

- `kind: "ephemeral"` is for state that is not user data and may change either way, for example Better Auth's `rateLimit` or `verification` if they turn out to churn. This kind is used only for tables observed to churn during implementation.
- `kind: "dropped"` is for a deliberate loss (pilot-stage breaking change). It must lose rows: an unused `dropped` entry fails as stale. After a baseline refresh the dropped data is no longer in the baseline, so the refresh commit removes the entry.

### D3. What the journey seeds and reads

`scripts/upgrade/journey.mjs` reuses `Client`, `assert` and `expectStatus` from `scripts/smoke/lib.mjs`, and follows the steps of `scripts/smoke/api-journey.mjs`. It uses public routes only and the fixture model, so it needs no network.

| Store / record | Seed | Read (part of `expect`) |
| --- | --- | --- |
| Accounts and roles (Better Auth, `member`) | Owner bootstrap (`/admin/api/identity/bootstrap`, organization "TEST Upgrade Company"); member invited by link and accepted; a second invitation left pending | `/admin/api/identity` user and organizations; organization members with roles; pending invitations count |
| Workspaces | Two workspaces (`createWorkspace`), member in the first | Workspace names and member counts |
| Browser session | Member signs in; the cookie is kept | Cookie still valid (D2.4) |
| App session (`mobile.ts`, `device-sessions.ts`) | App sign-in that returns a refresh credential, following `tests/mobile-identity.node.ts` / `tests/app-login.node.ts` | Refresh works; `account/access` lists the device |
| Conversations (workflow store, history, search index, Mastra messages) | Two chats in workspace 1 via `conversation.create` and `message.send` with the fixture model; one `conversation.rename` | `conversations` and `conversations/messages`: ids, titles, message roles and texts; `search` finds a seeded word |
| Memory (encrypted with `secret`) | One saved memory via `api/identity/memory` | The same text reads back, which proves the secret still decrypts |
| Skills | One skill via `skills` | Name and text |
| Hub | One typed widget (`agent-hub/3`, `meetings`) kept | Hub item kinds and ids |
| Processes and versions (process design, versions, activation, runs) | One literal workflow saved twice, tested and activated without a model, following `tests/process-model-free-journey-http.node.ts` (`api/identity/catalog/processes`); one run to completion | Process list, version count, active version id, one finished run |
| Catalog | One provider saved with a test API key (`saveProvider`) and one model entry (`saveModel`). No provider call is made | Provider and model present; the key is reported as saved |
| Meetings and audio | One short meeting uploaded via `meetings/<id>/audio` (a few seconds of tone generated with ffmpeg), left in whatever terminal state the fixture setup reaches | Meeting present with its state; audio bytes unchanged (D2.6 hash) |
| Server settings | Server name changed in administration | Name in `/admin/api/identity` or `server` |
| Recovery key | `cli.ts admin-rotate-key` against the data directory; the plaintext key is kept | Login works (D2.4); digest file unchanged |
| Server identity | Implicit | `server` route identity and file equality (D2.6) |

All names, emails and texts start with `TEST` / `test` so the data can never be mistaken for real records. Exact routes are confirmed during implementation against the current HTTP tests. A route that turns out to need network is dropped from the journey and noted in tasks.md.

### D4. A test-only clock offset for the upgraded server

`tests/helpers/clock-offset.mjs` is preloaded with `--import` only by `tests/upgrade.node.ts`. It reads `NIARO_TEST_NOW` (ISO time), computes the offset from the real time once, and replaces `globalThis.Date` with a subclass whose `now()` and argument-less constructor add the offset. The test sets `NIARO_TEST_NOW` to the baseline `createdAt` plus 10 minutes. Then session expiry (`accountSessionDays` and `sessionIdleDays` default 30), the 1800 s access tokens and the meeting audio sweep that runs at startup all behave as if the operator upgraded right after the release, however old the committed baseline is. No store uses SQL-side time (`unixepoch`, `datetime('now')` and `CURRENT_TIMESTAMP` do not appear in `apps/`), so a JS clock is enough. Precedent: `Date.now` overrides in `tests/process-work-items.node.ts` and `tests/service-oauth-integration.node.ts`. The preload lives in `tests/`, which the Dockerfile never copies into the image.

Alternatives: rewriting expiry columns in the restored copy before the start. This couples the test to old column names and hides retention sweeps. Refreshing the baseline often does not stop the startup sweep and is no guarantee.

### D5. The public origin changes, the readings do not

The test uses a random free port and `http://localhost:<port>`, so the public origin differs from the one at generation. In a real upgrade the origin stays the same. `normalize()` replaces the origin in readings such as invitation links and the app `address`. Data bound to an origin (MCP OAuth resources, external sign-in providers) is deliberately not seeded. Alternative: a fixed `https://upgrade.test` origin with a forged `Host` header. Node's `fetch` cannot set `Host`, so this would need a separate HTTP client for little gain.

### D6. Where it runs

- `package.json`: `"test:upgrade": "node --import tsx --test tests/upgrade.node.ts"`, `"pretest:upgrade": "npm run admin:build"` (as `pretest:identity`), and `"upgrade:baseline": "node scripts/upgrade/baseline.mjs"`. `check` gets `&& npm run test:upgrade` appended. Its local cost is under 2 minutes, and `test:identity` already needs ffmpeg.
- It stays out of the `test:identity` list, so the shard balance does not shift and a failure shows up under its own name.
- `.github/workflows/ci.yml` gets a new job `upgrade` ("Upgrade"), modeled on `mcp`: checkout, pnpm, Node 22.23.3, `pnpm install --frozen-lockfile`, `FedericoCarboni/setup-ffmpeg@v3` (the journey uploads audio), `pnpm run admin:build`, then `node scripts/ci-node-tests.mjs test:upgrade 1/1`. Timeout 20 minutes. Expected run time is 3–4 minutes, mostly the install, in parallel with the other jobs.

### D7. Refreshing the baseline at each release

The repository has no tags yet. The decision (open question 1): a release is an annotated tag `vYYYY.MM.DD` on `main`, created when the pilot server is updated to that commit. Steps, documented in `docs/guides/development.md` (release checklist) and named in `CONTRIBUTING.md`:

1. `git tag -a vYYYY.MM.DD && git push --tags`
2. On a clean checkout of the tag: `npm run upgrade:baseline`. This writes `tests/fixtures/upgrade/baseline.{tar.gz,json}`.
3. Commit the two files on `main` as "NIAR-… Upgrade baseline from vYYYY.MM.DD". Remove any `dropped` entries that are now stale (the test says which).

One baseline is kept. Older ones stay in git history. The first baseline is generated from the commit that implements this change. Its production code equals `main`, so the first run checks a trivial upgrade, and the value grows with each later change.

## Data and invariants

- The test only reads `tests/fixtures/upgrade/`. All restores, starts and writes go to `mkdtemp` directories that are removed in `finally`, as in `tests/deployment.node.ts`.
- The baseline and its JSON contain only test credentials and a test `secret`. They protect nothing real and are labeled so at the top of `baseline.json` (`"note": "TEST data …"`).
- Size guard: the test fails if `baseline.tar.gz` exceeds 2 MB. The expected size is well under 1 MB.
- No production code path reads `NIARO_TEST_NOW`. Only the preload does.
- Readings compare data, not presentation. `read()` returns plain ids, counts and texts so UI-only API changes do not break it. When an API reshapes a record, `read()` is updated to produce the same summary from the new shape. `expect` stays as it is.

## Risks / Trade-offs

- [The baseline covers only what the journey seeds] → The journey touches every store in the data-layout table. Raw per-table counts catch losses in tables the journey never reads, and the generator self-check stops the journey from rotting.
- [A library upgrade adds or reshapes tables and the counts look different] → Extra tables and rows are allowed (the rule is "not fewer"). A reshaped table that loses rows is exactly what the check is for. If the loss is deliberate, it is declared.
- [Churning tables make the check flaky] → `ephemeral` entries, limited to tables observed to churn, each with a reason. The clock offset removes expiry-driven churn.
- [The clock preload misses a time source] → The suite fails visibly, for example on an expired session. Fix the preload, not the assertion.
- [The forgotten release step leaves the baseline stale] → A stale baseline still checks an upgrade from an older version, so it is more demanding, not less. The test prints the baseline's age and source commit. The release checklist names the step.
- [Partial migration on a refused start (identity migrated, workflow refused)] → This is documented here and in the guide ("restore the pre-upgrade backup"). It is not changed by this change.
- [Test secrets in the repository trip a secret scanner] → They are clearly named, and an allowlist entry is added if a scanner is introduced.
- [The pilot runs `main`, not tags, so production may be at a commit between baseline and HEAD] → The spec guarantees only "from the previous release". Intermediate commits are best effort, and every change is still tested from the baseline.

## Migration Plan

Not applicable to production data: no runtime behavior changes. Rollout:

1. Land the suite with the first baseline generated from the implementation commit.
2. Enable the CI job.
3. Update the deployment guide's "Upgrade and rollback" section: upgrade from the previous release, and if you are more than one release behind, step through each release tag.

## Verification

- `npm run test:upgrade` passes locally, and so does the new **Upgrade** CI job.
- Mutation checks, run once during implementation and not committed:
  - Add `DELETE FROM agent_workspace_member` at the end of `openIdentity`. The suite fails, naming `identity/identity.sqlite:agent_workspace_member`.
  - Make `assertNativeMemoryFormat` reject the current format. Startup fails.
  - Change `FixtureStorage` to accept only `user_version` 2. The baseline case fails at startup.
  - Delete a file in `meeting-audio` after the start. The file check fails.
- `npm run test:deployment` is unchanged and still passes.
- `npm run lint` and `npm run typecheck` pass. The new `.mjs` files and the test are linted.
- `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-244-upgrade-path-test --strict`.
- No UI changes, so there are no viewport checks.

## Open Questions

Open questions for the owner. Each has a default that the design already uses:

1. **What is a release?** Default: an annotated tag `vYYYY.MM.DD` on `main`, made when the pilot server is updated, with the baseline refreshed in the next commit. An alternative is semver tags with a `package.json` version bump.
2. **First baseline source.** Default: the implementation commit. Alternative: the commit the pilot server runs today, which gives immediate coverage of the next upgrade but needs the journey copied into a worktree of that commit.
3. **Image-level variant.** Default: not now. Later, `SMOKE_BASELINE=1 npm run smoke` could restore the baseline into the smoke volume to cover uid 1000, the read-only root and permissions.
4. **Window.** Default: only the previous release (one baseline). Keeping N−2 baselines would let operators skip a release, at the cost of a second fixture and run.
5. **`npm run check`.** Default: include `test:upgrade`. Drop it if the local run proves too slow.
