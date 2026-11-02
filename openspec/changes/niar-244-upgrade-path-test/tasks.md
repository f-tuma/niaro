# Tasks

Requirements are in `specs/deployment/spec.md`: R-Restore ("Restore"), R-Upgrade ("Upgrade in place") and R-Baseline ("Upgrade baseline check"). The design sections are D1–D7.

## 1. Test harness pieces

- [ ] 1.1 Add `tests/helpers/clock-offset.mjs` (D4): a preload that shifts `Date.now()` and `new Date()` by `NIARO_TEST_NOW − real now`, and does nothing when the variable is unset. Verify with a small `node:test` case in `tests/upgrade.node.ts`: a child `node --import ./tests/helpers/clock-offset.mjs -e "console.log(Date.now())"` prints a time within 5 s of the given `NIARO_TEST_NOW`, and `new Date(0)` is unchanged. Check: `node --import tsx --test tests/upgrade.node.ts`. (R-Baseline "Baseline older than its sessions")
- [ ] 1.2 Add a server-process helper `tests/helpers/server-process.ts`. It takes a free port, starts the automatic profile with `NIARO_DATA`, `NIARO_PUBLIC_URL=http://localhost:<port>` and optional extra `--import`, waits for `Administration:` and `/readyz` 200 within 90 s, collects the log, and stops with SIGTERM. The spawn pattern is copied from `tests/deployment.node.ts`, which stays unchanged. Verify through 1.1's test file: start on an empty temp dir and see `/readyz` 200. (R-Upgrade)
- [ ] 1.3 Add the store inspector to the same file (`snapshotStores(dir)`). It finds every SQLite file with `isSqlite` from `scripts/backup-common.mjs`, counts rows per table (skipping `sqlite_*` and virtual-table shadow tables), runs `integrity_check` and `foreign_key_check`, and hashes the non-SQLite files. Add `compareStores(before, after, DECLARED_CHANGES)`, which returns `<db>:<table> before → after` lines, enforces `ephemeral` and `dropped` entries, and fails on stale `dropped` entries. Verify with a unit case on two hand-made temp databases: a dropped row fails, a declared drop passes, and a stale declaration fails. Check: `node --import tsx --test tests/upgrade.node.ts`. (R-Baseline "A change silently loses rows", "A declared drop")

## 2. Seeding journey and generator

- [ ] 2.1 Write `scripts/upgrade/journey.mjs` `seed(ctx)` per D3: accounts and roles, a pending invitation, two workspaces, the member's browser cookie, an app refresh credential, two chats with one rename, a memory, a skill, a hub widget, a literal process with two versions activated and one finished run, a catalog provider with a test key and a model, a meeting with generated audio, the server name, and the recovery key via `admin-rotate-key`. It reuses `scripts/smoke/lib.mjs` and uses only public routes, with no network. Any record that needs network is left out, and this task records which. Verify by running it against a fresh server from 1.2 with every step passing. Check: `node --import tsx --test tests/upgrade.node.ts`. (R-Upgrade "Newer image on an old volume")
- [ ] 2.2 Write `read(ctx)` and `normalize()` in the same module. They return plain ids, counts and texts per store (D3, "Read" column), with no timestamps, and with the origin replaced. Write the session checks: the cookie returns 200 and no cookie returns 401; the refresh credential leads to `snapshot`; the recovery key returns 200 and `acadmin_wrong` returns 401; the owner password signs in. Verify that `read()` called twice on the same server is deep-equal. (R-Upgrade "Signed in across the upgrade", R-Baseline "Stored data no longer readable")
- [ ] 2.3 Write `scripts/upgrade/baseline.mjs`. It exports `createBaseline(outDir)` (start, seed, read, SIGTERM, `scripts/backup.mjs`, write `baseline.json` with `format`, `sourceCommit`, `sourceTag`, `createdAt`, `node`, `note`, `credentials`, `ids`, `expect`). When run as a CLI, it refuses a dirty tree (`git status --porcelain`) and copies the output into `tests/fixtures/upgrade/`. Add `"upgrade:baseline"` to `package.json`. Verify: `npm run upgrade:baseline` on a dirty tree exits non-zero with a clear message, and on a clean tree writes both files. (R-Baseline "Refreshing the baseline at a release")

## 3. The upgrade suite

- [ ] 3.1 Implement `verifyUpgrade(archive, baseline)` in `tests/upgrade.node.ts` per D2: restore, before snapshot, start with the clock preload at `createdAt + 10 min`, the log checks (no "No owner yet", no `"level":"error"`), `read()` equal to `expect`, the session checks, restart and read again, stop, after snapshot and `compareStores`, the `server_id` file and metadata match, then backup → restore round trip. Verify with case "the baseline journey still seeds the current server" (`createBaseline` into temp, then `verifyUpgrade`). Check: `node --import tsx --test tests/upgrade.node.ts`. (R-Restore "Round trip into a new volume", R-Upgrade "Restart after the upgrade", R-Baseline "Generator kept working")
- [ ] 3.2 Generate the first committed baseline with `npm run upgrade:baseline` on the clean implementation commit (D7, open question 2). Add case "the current server upgrades the previous release's baseline" (prints the age and `sourceCommit` with `t.diagnostic`) and the size guard (under 2 MB). Fill `DECLARED_CHANGES` only with `ephemeral` tables observed to churn across three consecutive runs, each with a reason. Verify: `npm run test:upgrade` passes three times in a row. (R-Restore "Backup from the previous release", R-Upgrade "Newer image on an old volume", R-Baseline)
- [ ] 3.3 Add case "a refused upgrade fails closed". With the workflow store at `user_version=99`, the server exits non-zero with "Server setup failed. Check the profile, private files and whether its data directory is already in use." With `identity/secret` removed, the server exits non-zero and the `identity.sqlite` hash is unchanged. Check: `npm run test:upgrade`. (R-Upgrade "Workflow store from a newer version", "Identity database without its secret")
- [ ] 3.4 Mutation checks, run once and not committed (design, Verification): delete rows from `agent_workspace_member` at the end of `openIdentity`, make `assertNativeMemoryFormat` reject the current format, accept only `user_version` 2, and delete a meeting audio file after the start. Each must make `npm run test:upgrade` fail with the store, table or reading named. Record the four failure lines in the checkpoint evidence. (R-Baseline "A change silently loses rows", "Stored data no longer readable")

## 4. Scripts, CI and docs

- [ ] 4.1 `package.json`: add `"test:upgrade"`, `"pretest:upgrade": "npm run admin:build"`, and append `&& npm run test:upgrade` to `check`. Verify: `npm run test:upgrade` from a clean shell, and `npm run lint && npm run typecheck`. (R-Baseline)
- [ ] 4.2 `.github/workflows/ci.yml`: add job `upgrade` ("Upgrade") with checkout, pnpm, Node 22.23.3, `pnpm install --frozen-lockfile`, `FedericoCarboni/setup-ffmpeg@v3`, `pnpm run admin:build` and `node scripts/ci-node-tests.mjs test:upgrade 1/1`, timeout 20 minutes. Verify that the job is green on the pull request and takes under 6 minutes. (R-Baseline "Generator kept working")
- [ ] 4.3 Docs:
  - `docs/guides/deployment.md` "Upgrade and rollback": upgrade from the previous release; if you are more than one release behind, step through each tag; a refused start may already have migrated the identity database, so roll back with the backup.
  - `docs/guides/development.md`: the release checklist (tag, `npm run upgrade:baseline` on a clean checkout of the tag, commit, prune stale `dropped` entries).
  - `CONTRIBUTING.md`: a change that loses stored records declares it in `DECLARED_CHANGES` with its issue key, and a non-trivial migration still adds a focused store test.

  Verify that the commands in the docs run as written. (R-Upgrade, R-Baseline "Refreshing the baseline at a release")

## 5. Final checks

- [ ] 5.1 Run `npm run check` and `npm run test:deployment` locally, then `spec openspec --project /home/flamendrin/workspace/niaro -- validate niar-244-upgrade-path-test --strict`. All must pass, and every CI job must be green on the pull request.

## Workflow follow-up

- Owner answers the open questions in design.md (release tag format, first baseline source, image-level variant, window, `check` inclusion). Adjust 3.2, 4.1 and 4.3 if an answer differs from the default.
- At the first release tag after merge, refresh the baseline per D7 and confirm that the Upgrade job is green on the refresh commit.
- Archive the change after review, then sync the deployment spec deltas.
