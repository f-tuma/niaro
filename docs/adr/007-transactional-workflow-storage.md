# ADR 007 — Transactional workflow state and event delivery

Date: 2026-09-24. Status: implemented and verified for the local synthetic fixture (DEV-011). Wire profiles and mobile UI are unchanged.

## Storage boundary

Use `.fixture/workflow.sqlite` with SQLite WAL, `synchronous=FULL`, foreign keys, strict tables and bound SQL parameters. `workflows` contains the validated snapshot, next work ID and scheduled jobs. `events` contains the ordered full-entity event suffix; `receipts` contains the original command and its accepted/conflict/rejected outcome. All records use the complete connection/server/user/workspace identity. SQL uniqueness covers event sequence/ID and both command ID and idempotency key within that scope.

Each command or worker transition begins `BEGIN IMMEDIATE` **before reading** current state and receipts, runs the existing deterministic engine, and commits all three tables together. Engines are not cached across requests. A failed transaction leaves no partial state, event, receipt or scheduled job. A duplicate command returns its recorded outcome with the current snapshot; changed payloads cannot reuse its identity. Independent readers load a consistent database snapshot and cannot see uncommitted changes. Writer contention waits at most one second, then fails without acknowledging the command; the existing explicit retry flow remains applicable. [SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html).

HTTP returns success only after commit. The retained event table is the durable outbox for the existing cursor-based polling transport: GET does not consume events, and no volatile publication queue or global delivered flag exists. If the process dies after commit and before its response, a restarted server serves the events again and recognizes the command receipt. Multiple clients can independently resume their own cursors. Delivery is repeatable, not an exactly-once claim about a remote calendar.

Pending worker jobs and their next due time commit with the transition. Startup polls stored jobs without needing a connected client. One failed account does not starve other due accounts. The simulator preserves pending → executing → succeeded across crashes; future external integrations still need provider idempotency and reconciliation of uncertain outcomes.

The event suffix remains bounded to 1,000 events. An older or future cursor returns `409 snapshot_required`. Receipts are **not pruned**: at 2,000 receipts per scope, new commands fail until an explicit demo reset; existing IDs still deduplicate. Other existing fixture schema limits also remain. This is bounded reference storage, not a production retention or capacity policy.

## Runtime and server ownership

Use the built-in `node:sqlite` API available without a flag from Node 22.13; verified on this project's pinned CI runtime, Node 22.23.2. No package or lockfile changes were needed. The API remains experimental in this Node version and emits its documented warning. [Node 22.23.2 API documentation](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html).

WAL with FULL requests a WAL sync at every commit; actual guarantees depend on the filesystem and storage honoring sync. Use a local disk, not a network share. Tests exercise application process crashes, not a machine power cut or storage hardware failure. [SQLite synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous).

Pairing/session files retain ADR 006's separate persistence model; workflow transactions do not encompass auth files. A second SQLite file, `server-lock.sqlite`, holds an exclusive OS lock for the HTTP server's lifetime. Another server using this data directory fails before loading auth state. The lock is released automatically on process death, and the reset command also acquires it before archiving. Do not delete lock files or move an active directory. This is one local HTTP owner, not an HA deployment. Database files are owner-only; auth and workflow data remain unsuitable for real personal data without the wider production controls.

## Migration and recovery

Stop the old server and back up its entire data directory before upgrading. On first startup, import only `authenticated/<user>/<a|b>.json` using the existing v1/v2 validator and exact stored server identity. Import every account and the completion marker in one transaction. Anonymous root-level `a.json`/`b.json` remain untouched and are never assigned to a paired user. An invalid account, inconsistent scope/event log, or duplicate receipt key aborts the import and prevents startup; repair the source and retry. There is no silent reset or partial adoption.

The original JSON files are retained unchanged. Once migration commits, its marker prevents importing stale sources again. SQLite becomes authoritative, so running the old JSON server would fork the history. Do not remove only `workflow.sqlite` to repair an error. Stop the server before copying/restoring the **whole** directory, including server identity, sessions and any WAL/SHM files. A reset still archives the entire directory and starts a new identity; it is not migration or automatic recovery.

## Verification

`npm run check` passed: clean lint, dependency/token boundaries and TypeScript, **120 tests in 19 suites**. Twenty added cases cover ordinary rollback at each write stage, independent-reader isolation, uncertain replies, retained receipts, multi-connection state freshness, scoped identities, migration/retry, invalid imports, SQL uniqueness, expired event cursors, lock contention and worker isolation.

Seven of those tests launch a separate real HTTP server with the test-only `tests/helpers/crash-server.ts` harness. Five kill it with SIGKILL while approving a proposal: after writing state, events, receipts, immediately before commit, and immediately after commit before the response. Recovery checks the expected snapshot, replayable events, changed-payload rejection and exactly one simulated operation after manual retry. Two more kill a worker before/after its commit, then restart twice and observe its completion without client requests. No crash trigger is exposed through an HTTP request or production server environment variable.

A separate local smoke check also passed: a second HTTP server and the real reset CLI were refused while the first server owned a temporary directory; after server shutdown, the same CLI archived the directory including its database. Test data and processes were cleaned up.

Run the focused suite with:

```sh
npx jest --selectProjects core --runTestsByPath tests/storage.test.ts tests/storage-crash.test.ts tests/auth-http.test.ts tests/http.test.ts --runInBand
```

This phase changes server storage only; no new UI/story or native module is involved. Android/iOS/browser visual walkthroughs and export builds were not repeated. No production data migration, external service write, physical device test or remote CI run was performed. The next implementation step is the bounded test calendar integration (DEV-015), including provider idempotency and verifying the external result.
