# Proposal

Itsaplan: NIAR-244.

## Why

The deployment spec promises that a newer image started on an old volume migrates it in place and keeps every record, and the upgrade guide tells operators to `git pull` and rebuild. Nothing checks it: `tests/deployment.node.ts` only starts fresh servers, and each store migrates itself at startup in its own way (Better Auth migrations, `CREATE TABLE IF NOT EXISTS` and guarded `ALTER TABLE` in each identity store, `PRAGMA user_version` and history/search backfills in the workflow store, a library-owned schema in the Mastra store). A change that drops a column, renames a table, changes the memory payload format or bumps `@mastra/libsql` can lose pilot data, and today we would only find out on the production volume.

## What Changes

- An **upgrade baseline** is committed to the repository: a backup (`niaro-backup/1` archive) written by the previous release's server after a scripted journey through its public API, plus a small JSON file with the test-only credentials, record identifiers and the expected readings.
- A new suite `tests/upgrade.node.ts` (`npm run test:upgrade`) restores the baseline with `scripts/restore.mjs` into a temporary directory, starts the current server on it the same way the image does, and checks:
  - startup and the restore succeed;
  - every database passes `integrity_check` and `foreign_key_check`;
  - no table has fewer rows and no file (secret, recovery key digest, server identity, meeting audio) changed, unless the test lists a reason;
  - the seeded records still read back through the API: accounts and roles, workspaces, conversations with their messages and titles, memory (encrypted with the identity secret), skills, hub items, processes with their versions and active version, meetings with their audio, catalog entries;
  - a browser session, an app refresh credential and the recovery key from before the upgrade still sign in;
  - a second start changes nothing, and a backup of the upgraded data restores cleanly.
- The same suite runs the baseline generator against the current server, so the generator cannot rot between releases.
- A generator, `npm run upgrade:baseline`, rebuilds the baseline from the checked-out release commit. It is run once per release and its output is committed.
- A new CI job, **Upgrade**, runs the suite on every push and pull request.
- The deployment spec's upgrade requirement states the window the test guarantees: data written by the previous release or a later version. Older data is upgraded one release at a time. The restore requirement accepts a previous release's backup format.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deployment`: "Upgrade in place" names the supported window (from the previous release) and what stays readable. "Restore" accepts backups written by the previous release. A new requirement, "Upgrade baseline check", says the repository keeps a previous-release baseline and that CI fails when the current server loses or cannot read its data.

## Non-goals

- Running an old git commit in CI (checkout, install and start a second tree on every push). This was rejected as too slow and flaky; see design.md.
- Checking the Docker image itself on the baseline (uid 1000, read-only root). The test starts the server through the same entry point (`apps/reference-server/cli.ts start`, automatic profile) but from source. `npm run smoke` remains the image check.
- Upgrades across more than one release in one step, and downgrades. Both stay unsupported, as the spec already says for downgrades.
- New migrations or a migration framework. The test checks the stores' existing startup migrations and does not change them.
- Hosted connector installations and operator plugins, apart from checking that their files are unchanged.

## Risks

- **A stale or thin baseline gives false confidence.** It covers only what the seeding journey writes. Mitigation: the journey touches every store listed in the spec, CI runs the generator on every push, and a release checklist step refreshes the baseline.
- **Time-dependent data.** Sessions expire after 30 days by default, and meeting audio retention sweeps run at startup. On a baseline weeks old, a check against real time would fail or delete records. Mitigation: the upgraded server runs with a test-only clock offset that places "now" a few minutes after the baseline was written.
- **Deliberate data drops (allowed at the pilot stage).** These now need an entry in the test's declared-change list. That is intended friction: the list documents each loss in review.
- **Test-only secrets in the repository** (identity `secret`, password hashes, a recovery key). They protect nothing real, but secret scanners may flag them. They are named as test data and documented.
- **"Release" is not defined yet.** The repository has no tags. The design picks a default and lists it as an open question for the owner.

## Impact

- New files: `tests/upgrade.node.ts`, `tests/fixtures/upgrade/baseline.tar.gz` and `baseline.json`, `scripts/upgrade/journey.mjs` (seed and read), `scripts/upgrade/baseline.mjs` (generator), `tests/helpers/clock-offset.ts` (preload).
- `package.json`: scripts `test:upgrade` and `upgrade:baseline`.
- `.github/workflows/ci.yml`: new `upgrade` job.
- Docs: the release step and the upgrade window in `docs/guides/deployment.md`, `docs/guides/development.md` and `CONTRIBUTING.md`.
- No production code changes are expected. If the test exposes a migration that loses data, the fix belongs to its own issue, or to this change if the fix is small.
