# Independent phase-2 storage design readiness review

**Verdict: needs-work on one bounded storage lifecycle contract; the architecture and production integration path are implementable.** A smaller command/spec consistency correction is also required before the checkpoint closes. This review does not require ingestion, converter, model, CRM or client decisions to begin storage work.

Date: 2026-10-30. Checkout: `/home/flamendrin/orca/workspaces/niaro/niaro-s3-rustfs`; HEAD `260b1eef413dc3e6295ef9776c2a5ea868a8ef0f`, with pre-existing dirty/untracked files. Review subject: tasks **2.1–2.4** and design decisions **1–2**, especially lines 32–100. This is a fresh dispatched Codex review (task `task_d5c5d2fee561`, dispatch `ctx_bf9e36c5e818`), without the author's conversation, historical provider-session resumption or helper delegation. The previous main-checkout consolidated EGM report was read for requirements and finding scope; its conclusions were not treated as source inspection or test evidence. This is the requested scoped re-review, not a new five-stage EGM cycle.

## Proposed behavior and actual boundaries

The server loads optional S3 settings outside its strict ordinary profile, distinguishes disabled/invalid/configured storage, and keeps text service running when storage is inadmissible. The offline checker checks syntax and local secrets; a separate explicit command exercises the remote contract without opening or changing the live workflow DB. A registry in the existing workflow SQLite transaction owns locations and object reservations. Immutable, server-created handles pass through a bounded adapter with conditional puts, independent byte hashing, exact range validation, safe errors and conservative unknown outcomes. Optional RustFS deployment uses a separate persistent volume and a root-only bootstrap process to establish a narrowly scoped application principal; ordinary Niaro never receives root credentials.

These boundaries fit the source inspected independently:

- `apps/reference-server/config.ts:358–412`, `cli.ts:75–111`, and `runtime.ts:153–227`: the existing profile throws on validation errors; keeping storage configuration separate and wiring through `createReferenceServer()` avoids changing that profile contract or making the offline branch contact S3.
- `apps/fixture-server/http.ts:307–345` opens the production workflow store; `storage.ts:94–164,183–200` owns the synchronous SQLite connection, initialization transaction and `user_version=1`. Module-owned additive tables fit the existing history/search migration precedent. The design correctly selects this DB rather than an independent identity or storage database.
- `Dockerfile:23–31`, `scripts/docker/runtime-deps.mjs:28–49`, and `scripts/docker/niaro:37–52` currently copy selected scripts, trace only the server CLI, and reject unknown operator commands. The revised file/action map explicitly includes these packaging boundaries, package/lock updates, boundary checks and packaged-command verification; there is no missing packaging owner in the plan.
- Both existing Compose variants support independent optional profiles; the Dokploy server is on default and external proxy networks. Keeping RustFS on default only, publishing development API ports on loopback, disabling its console, and using explicit bootstrap-before-Niaro commands are feasible without tying external-S3 installations to RustFS.

## Findings and disposition

### SR1 — Major, blocks complete phase-2 lifecycle readiness: define same-handle mutation fencing

**Location:** `openspec/changes/chat-attachments-camera-s3/design.md:60–66`; tasks 2.1–2.2. **Expected:** the object-storage delta's “Immutable scoped object identities” and the revised registry contract require every potentially live object, including an uncertain write or pending delete, to keep the old location bound until confirmed deletion.

**Evidence:** the design checks registry state before each operation, permits two active operations per store, and retires the reference after DELETE plus a missing HEAD. It does not define per-handle PUT/DELETE admission, reservation transitions while I/O is pending, or the condition for retiring a handle with an outstanding PUT. The existing SQLite transaction helper ends synchronously (`storage.ts:183–200`); it cannot keep an asynchronous S3 PUT inside that transaction. The single-server lock prevents a second HTTP owner, but not interleaving asynchronous operations in that owner.

**Counterexample permitted by the written contract:** reserve H; a PUT of H passes its registry check but its request is delayed; DELETE H completes while the key is absent, HEAD confirms absence, and H is marked deleted; activation of another location is now allowed; the already admitted PUT reaches the original store and creates H. Rejecting the PUT's later local completion cannot undo the object already written. The original location has been released despite a live object. A timed-out/unknown earlier PUT must likewise not be treated as settled merely because a subsequent HEAD is missing.

**Impact/confidence:** high-confidence missing storage-layer concurrency contract, allowing orphaning and premature location replacement under an ordinary async interleaving. This concerns the phase-2 `RegisteredObjectStore` and location guard themselves; it is separate from later chat tombstones, upload routes or converter commit guards.

**Next step/disposition:** open, return to the author. Specify the minimal per-handle mutation admission/state transitions that prevent DELETE from retiring a reservation while an admitted PUT can still write; preserve the reference/location guard on unresolved mutation outcomes. Define the post-I/O registry check and make late completion unable to restore a deleted/changed-location handle. Add a production registry/adapter test that pauses a PUT, attempts deletion and location activation, then releases the PUT, plus the corresponding unknown-outcome case. This needs no new service or client protocol.

### SR2 — Minor canonical consistency correction, required before phase 2 closes

**Location:** revised `design.md:54,95–97` and `specs/deployment/spec.md:1–50`, against canonical `openspec/specs/deployment/spec.md:56–63`. **Evidence:** the design adds `niaro storage-check`, but the canonical “Operator commands” requirement enumerates the old commands and requires rejecting every other command with exit 64. The deployment delta adds storage checks without modifying that command requirement. The current entry point implements that closed allowlist.

**Impact/confidence:** high-confidence spec/design inconsistency. An implementation following the new command design would violate the unchanged command requirement; this does not prevent implementing the adapter modules.

**Next step/disposition:** open, return to the author. Add a MODIFIED “Operator commands” delta admitting `storage-check` and whichever explicit entry-point command is selected for packaged bootstrap, retaining unknown-command exit 64. Reuse the planned packaged CLI test to cover the supported commands and rejection. No production change was made by this review.

## Other readiness conclusions

Configuration now supplies the externally significant choices raised by A1/C1/K2: opt-in/invalid behavior, credential modes and file alternatives, local-only offline checks, restart-based rotation, redaction, TLS validation, private HTTP socket lookup, redirect refusal and no fallback. The workflow registry placement and additive migration ownership resolve the former database-location ambiguity. Conditional writes plus actual-byte hashing, bounded response consumption, whole/range integrity distinctions and explicit safe outcomes form an implementable adapter contract, subject to SR1.

The RustFS bootstrap contract settles A2/R2's principal provisioning, policy scope, rerun/conflict behavior, startup ordering and application-credential readiness check. Independently fetched public registry metadata confirms the stated `rustfs/rustfs:1.0.4` digest is `sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2`. The pinned tag resolves to commit `46337942d55f3a8e6a97b147ca98d9ea8115555d`; its [service-account handlers](https://github.com/rustfs/rustfs/blob/46337942d55f3a8e6a97b147ca98d9ea8115555d/rustfs/src/admin/handlers/service_account.rs) contain the proposed add/info routes and missing-account handling. This is static feasibility evidence; it does not reproduce the author's pilot or verify a built bootstrap.

The public [SDK package metadata](https://registry.npmjs.org/@aws-sdk/client-s3/3.1160.0) confirms version `3.1160.0` exists and requires Node >=20, compatible with the project's Node 22 image. Explicit direct dependency pins plus the committed lockfile, runtime tracing/copy updates and packaged-command checks are appropriate; installing dependencies or building the image was outside this review.

The verification plan is appropriately split between offline production configuration/registry/adapter/startup tests and isolated RustFS bootstrap, permission, persistence and contract tests. It includes negative errors, cleanup failures, non-versioned/unlocked prerequisites, mounted secrets and continuing text startup. Include SR1's interleaving cases and SR2's command assertions. Broader hosted compatibility remains conditional on the same suite: for example, [AWS HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html) can return 403 for a missing key without `s3:ListBucket`, whereas the pinned RustFS HEAD handler returns `NoSuchKey` on a missing object. The RustFS bootstrap policy is not evidence of a portable least-privilege policy for every endpoint; failing the suite safely is consistent with the design's conditional provider support.

## Scope exclusions and evidence limits

The previous EGM report's A3–A9 and A10–A11 remain pending at their respective later checkpoints: attachment bindings and Again/Edit, durable message/inference acceptance, aggregate upload/converter admission, converter isolation/resources/formats, native image transport, contact revisions and editorial wording. Their absence is not a new phase-2 blocker. Attachment-serving activation, durable feature cleanup workers, full backup/restore integration, public upload APIs, camera/UI behavior, model ingestion and CRM writes were not assessed for readiness here.

No production phase-2 module or tests exist in the checkout. **No project tests, builds, strict OpenSpec validation, Docker/Compose execution, RustFS deployment/contract test or live Hetzner request ran in this review.** Only static repository inspection, read-only public source/registry retrieval and hash computation were performed. No designated hosted test bucket or credentials were supplied. Neither the author's pilot claim nor any previous test/validation claim is adopted as new execution evidence. `spec status --project ...` returned `not-installed`, so it supplied no review-mode configuration; the explicit scoped re-review instruction governed this pass. No applicable ancestor/local `AGENTS.md` was found; CONTRIBUTING, the review skill and development guidance were read.

Only this report and `storage-review-*` evidence under `/tmp/niaro-orchestration-20261030/` were written. Canonical planning files, source, tests, packages, other workers' artifacts and the main checkout were not edited; nothing was staged, committed or pushed.

## Exact input binding

All hashes are independently computed SHA-256, not copied from the prior review. Paths below are relative to `openspec/changes/chat-attachments-camera-s3/`:

| Input | SHA-256 |
| --- | --- |
| `proposal.md` | `32979ed43dd485d5c5409ed0a7b94bcb5d80f797d6d3b8cebc80d172021d0ab9` |
| `design.md` | `655e9e47035177b967514ee70581a07187f1419020a44463810018eb376d9862` |
| `tasks.md` | `6bc08e2cb09a5a4bf3dd86f1cd11a010b16b22ff4ad3eae020f753b75fe7e325` |
| `specs/object-storage/spec.md` | `bd9a7e317cb2b301b6be58d4c231e606c42ffb47c7392d2150cc526c7b7552e0` |
| `specs/deployment/spec.md` | `fcc5e257dfeee7964be09b1d58fdb828130050472efc751d5d03d6aa52a6427d` |
| `specs/message-attachments/spec.md` | `4b8e23ceab5964a5dcb77281b5bc87575ac8b473c210cc95f326b210628687b7` |
| `specs/models-and-providers/spec.md` | `8fe258048e92806d06ee0d580afb8601446c106895f3bb9fdac979975b006099` |
| `specs/chat/spec.md` | `b594cfe8f5be2a4803e941919040b2c0c21c067a7648d341ccdac8e88d4b7094` |

[Initial input hashes](storage-review-input-hashes.json) and [final hashes/read inventory and stability check](storage-review-final-input-hashes.json) bind repository source, instructions, the prior report and external evidence. Public-source files saved beside this report use only the `storage-review-*` prefix. The final manifest records whether initially hashed inputs remained identical at completion; hash agreement authenticates bytes only, not semantic correctness or test execution.

**Disposition:** SR1 and SR2 are open for author revision; re-review materially changed phase-2 contracts. No later feature finding is closed, implementation task accepted, or deployment authorized by this report.
