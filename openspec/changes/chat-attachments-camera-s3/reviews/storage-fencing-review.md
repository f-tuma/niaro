# Focused independent SR1/SR2 re-review

**Verdict: ready for the bounded design question; SR1 and SR2 are resolved in the reviewed design/specification.** This does not accept implemented phase-2 behavior, complete the attachment feature, or establish execution evidence.

2026-10-30. Checkout: `/home/flamendrin/orca/workspaces/niaro/niaro-s3-rustfs`; HEAD `260b1eef413dc3e6295ef9776c2a5ea868a8ef0f`, with pre-existing dirty/untracked files. Fresh dispatched Codex reviewer: task `task_631070b259a8`, dispatch `ctx_72d6bbaf9569`; no author transcript, historical provider session or delegation. The prior scoped report supplied the question, not a presumed verdict. No applicable ancestor/local `AGENTS.md` was found; CONTRIBUTING, development guidance, the requested spec-review skill and its review contracts were read. `spec status` returned `not-installed`, supplying no review-mode override.

References to `design.md`, `tasks.md` and delta specs below are under `openspec/changes/chat-attachments-camera-s3/`.

## SR1 — Resolved in design

The revised contract preserves a non-deleted registry reference for every handle whose PUT could still arrive. Its protection is durable admission **before** asynchronous I/O, rather than trying to undo a remote write through a later local check.

- **Concurrent/delayed PUT:** `design.md:58–64` adds persisted mutation state and a fresh operation UUID, atomically admitted against the immutable row and active location. Another mutation returns `busy` without queuing, including from another wrapper sharing the DB. A paused PUT therefore prevents DELETE admission; its non-deleted reservation independently prevents location replacement. Only matching post-I/O completion can clear admission. A settled PUT followed by explicit confirmed deletion can eventually release the reference.
- **Unknown PUT plus missing HEAD:** `design.md:66` explicitly quarantines a dispatched PUT whose outcome is unknown, retains its reservation, and refuses every subsequent mutation with non-retryable `uncertain`. Clearing that operation's token does not clear quarantine. Neither missing HEAD nor a successful later conditional request settles the earlier request. A remote PUT may still arrive, but the original location remains retained; the original SR1 location-release step is no longer permitted.
- **Post-I/O/crash/restart:** `design.md:64,68` requires matching token/location/state checks, prohibits restoring deleting/deleted rows or clearing another operation's admission, and recovers persisted interrupted PUTs into quarantine. Recovery belongs only to the owning workflow initialization after the owner lock, not secondary wrapper construction. A crash before recording the outcome leaves durable admission for conservative recovery. Closing/aborting local requests makes no claim of remote cancellation.
- **Delayed/unknown DELETE:** `design.md:62,68` makes deleting irreversible and keeps the reference until explicit retry confirms deletion. No PUT may reuse that handle; a late DELETE targets only its original immutable key/location and cannot create data. This makes delete retry materially different from PUT uncertainty.

These rules fit the actual interfaces. `apps/fixture-server/http.ts:320–341` acquires the owner lock before opening `FixtureStorage`; `apps/fixture-server/storage.ts:59–72` implements that OS-held lock. The workflow DB uses WAL/FULL synchronization and additive initialization (`storage.ts:94–164`), with existing shared-DB module migration precedent in `conversation-history.ts:33–65` and `chat-search.ts:319–340,400–413`. Its transaction helper commits synchronously (`storage.ts:183–200`), so admission and completion must be separate short transactions around I/O, as the revision now specifies. The owner lock alone would not serialize asynchronous calls or wrappers; the new persisted compare-and-set is the relevant protection. Production startup already reaches this store through `apps/reference-server/runtime.ts:219`.

The revision also preserves the bounded adapter contract (`design.md:72–78`): immutable verified handles/conditional creates, 25 MiB buffers, two active operations per store, immediate busy rejection, bounded connect/total deadlines and no automatic SDK retries. Releasing a local transfer slot after timeout cannot release the durable uncertainty fence. A confirmed PUT response followed by failed independent read-back remains unverified to the caller, but has no unresolved remote PUT; retaining the reservation while allowing explicit verification/delete is consistent with the invariant (`design.md:66,76`). The planned tests at `design.md:70` directly cover paused PUT/delete/switch, two wrappers, unknown PUT with missing HEAD, restart, delete retry and token rejection; they remain execution obligations under tasks 2.1–2.2.

**Remaining recovery boundary:** phase 2 deliberately offers no way to clear unknown-PUT quarantine. This can retain objects and block location replacement indefinitely; it does not silently lose their location. Provider-specific settlement/reconciliation and eventual attachment cleanup remain later design/delivery requirements. This review does not close the object-storage delta's durable-cleanup requirement (`specs/object-storage/spec.md:55–69`) or tasks 3–4, and does not authorize attachment activation. Their incompleteness is not the original unsafe phase-2 invariant.

## SR2 — Resolved in design/specification

`specs/deployment/spec.md:13–30` now **MODIFIES Operator commands**, enumerates both `storage-check` and `storage-bootstrap`, preserves all prior commands and unknown-command exit 64, and specifies each explicit storage command's scope. This reconciles the old canonical closed allowlist (`openspec/specs/deployment/spec.md:56–63`) with `design.md:54,92`. The deployed entry point still has the old list (`scripts/docker/niaro:29–40`); that is pending implementation, not an unmodified requirement contradicting the proposed implementation. The existing dependency tracer and image copy boundaries (`scripts/docker/runtime-deps.mjs:28–49`, `Dockerfile:23–31`) are explicitly assigned changes and packaged CLI checks in `design.md:105–107`.

## Evidence and limits

This is source-based design review. The planned `apps/server-storage` implementation, registry/adapter/startup tests and storage command scripts do not exist in the inspected checkout. **No project test, build, strict OpenSpec validation, model check, Docker/Compose run or storage-service operation was executed.** No dependency research or external endpoint verification was repeated. Current source, not earlier execution claims, governed the interface assessment. No new blocker was found within SR1/SR2; implementation must still demonstrate the specified rules and tests.

Only this report and `storage-fencing-review-*` evidence in the same temporary directory were written; no canonical, implementation, test or package file was edited, and nothing was staged, committed or pushed. [Read-only source evidence](storage-fencing-review-source-evidence.json) records actual provenance commands and planned-file absence. [Initial fingerprints](storage-fencing-review-input-hashes.json) and [final stability check](storage-fencing-review-final-input-hashes.json) bind the inputs; matching hashes prove byte identity, not semantic correctness or test execution.

## Exact input binding

Independently computed SHA-256 values, not copied from the prior report:

| Subject | SHA-256 |
| --- | --- |
| `openspec/changes/chat-attachments-camera-s3/proposal.md` | `32979ed43dd485d5c5409ed0a7b94bcb5d80f797d6d3b8cebc80d172021d0ab9` |
| `openspec/changes/chat-attachments-camera-s3/design.md` | `6df7aab0242ea998eda44602bf82b642815eaa9afe377d83542a39a57d33d8ff` |
| `openspec/changes/chat-attachments-camera-s3/tasks.md` | `6bc08e2cb09a5a4bf3dd86f1cd11a010b16b22ff4ad3eae020f753b75fe7e325` |
| `openspec/changes/chat-attachments-camera-s3/specs/object-storage/spec.md` | `bd9a7e317cb2b301b6be58d4c231e606c42ffb47c7392d2150cc526c7b7552e0` |
| `openspec/changes/chat-attachments-camera-s3/specs/deployment/spec.md` | `c334627c034e517a2f045cb20886764f9f167b6e3455401c0202d342147a7a04` |
| `openspec/specs/deployment/spec.md` | `f25ebe50807de268bd3f4625ec3badc9a81a2c4351abb09999d972098f4ca09f` |

Prior scoped report SHA-256: `e1a05dc89e8036d043626e29431f096f15e688d842944ed096bdec5b00b65aa8`. Full source/instruction fingerprints are in the manifests. Disposition applies only to these bytes and this scoped question; later material revisions require re-review.
