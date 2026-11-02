# Consolidated SPEC / EGM design review

Date: 2026-10-30. Target: `../design.md`, lines 1–134; DetailedRange: separate `../tasks.md`, lines 1–74. Preset: `uninterrupted`. Project language: English; `spec status` reported `review.mode: egm`. EGM artifact directory: `openspec/changes/chat-attachments-camera-s3/reviews`.

## Decision

**The proposed architecture is viable as a staged design, but the current artifacts are not an implementation-ready handoff under EGM's zero-decision standard.** No reviewer found a demonstrated architectural blocker requiring replacement of S3/RustFS or a new execution engine. Initial storage work needs two bounded contracts settled: A1 (configuration/persistence/adapter) and A2 (RustFS provisioning). The remaining findings belong before their later integration checkpoints; they do not require implementing conversion or UI first.

Consolidated result: **9 Major actions and 2 Nits; no Blocker-severity finding.** A Major can still prevent its checkpoint from satisfying the readiness standard. All actions below remain open; no canonical remediation or owner acceptance was performed by this review.

The design brings private documents/photos through Niaro-owned uploads, retains immutable originals, binds files to chat messages, and extracts or interprets content through existing authority and model-budget rules. Camera/UI and business-card proposals use that same path. Logical deletion revokes access immediately while durable cleanup erases external objects. These boundaries are appropriate; the missing details concern the contracts that make them enforceable.

## Actions before initial S3/RustFS implementation

### A1 — Major: Define the complete bounded storage implementation contract

**Scope:** design 28–45,57; tasks 2.1–2.2,2.4. **Sources:** C1, R1, K1, K2; supported by Stage 8.

Define exact credential-mode values, defaults/required fields, secret-file names/precedence, credential reload policy, and absent/partial/invalid outcomes. State which S3 errors make only attachments unavailable and which errors are operator-check failures. Existing `loadServerConfig()` throws on strict validation, and CLI adapter loading precedes offline check mode; simply adding ordinary schema errors or network probes can violate continued text-chat/network-free-check requirements (`apps/reference-server/config.ts:358–382`, `cli.ts:75–104,150–156`).

Select the durable location record's database/schema/migration owner and live-object/job guard. That guard is required in phase 2, while attachment migrations appear in phase 3. Either introduce minimum phase-2 persistence or define a stable interface with its integration test explicitly deferred. Define object handles, adapter input/results, safe errors and the explicit probe entry point. Map Create/Modify files and meaningful tests, including config/CLI/runtime and packaging targets. **Completion evidence:** a fresh implementer can execute tasks 2.1–2.4 without selecting these externally significant boundaries; review the revised first-slice contract before implementation.

### A2 — Major: Select RustFS credential provisioning and bootstrap lifecycle

**Scope:** design 51–55; tasks 2.3–2.4. **Source:** R2.

Private-bucket bootstrap through an S3 SDK does not by itself define how a separate application principal/policy exists. Specify the supported management mechanism or operator-provisioned prerequisite; least required application operations; secret inputs; idempotent handling of existing buckets/principals; startup ordering; failure behavior; and image pin. **Completion evidence:** an explicit profile/bootstrap contract explains how the application gets a usable bucket-scoped key without sharing admin credentials. No live Hetzner credentials are required to settle this design.

## Actions before later integration checkpoints

### A3 — Major: Define attachment wire contracts, ownership and Again/Edit reuse

**Scope:** design 61–69,97–99,117; tasks 3.x,4.1–4.2,7.3,8.3. **Sources:** C2, D3, R3, K4; K1's later file-map portion.

The linear uploaded→attached transition and uploaded-only send rule cannot express a new Again/Edit message reusing an already-attached file. Choose separate immutable content/message bindings or explicit cloning; specify states, cardinality, generation authorization, draft removal, expiry, derivative ownership, archive/clear behavior and unavailable files. Define versioned routes/DTOs/errors and capability/history negotiation, with the production transaction hook and checkpoint file/test map. Existing strict command validation and web new-message Again behavior make this a cross-client contract, not an internal helper choice. **Completion evidence:** explicit scenarios preserve earlier history and independently owned cross-chat copies without ambiguous deletion accounting.

### A4 — Major: Specify durable message acceptance, processing and inference recovery

**Scope:** design 65–69,83–85,99; tasks 3.3,4.2,5.4,6.2–6.3. **Sources:** D2, R4, K3 and R3's transaction portion.

Current native execution precedes workflow message/receipt publication (`model-service.ts:1050–1088,1165–1235`); workflow and identity/native stores are separate. The new pre-processing acceptance must select its database, schema/constraints and transaction sequence. Define durable states/identities from accepted message through conversion, dispatch and reply publication, root-budget ownership, explicit retry commands and crashes before/after dispatch/publication. Recovered dispatched attempts become unknown (`inference-budget.ts:173`); conversion/cleanup recovery must not implicitly start or repeat a paid run. **Completion evidence:** a state/transaction contract and crash/replay test cases that preserve existing explicit recovery, idempotency and deletion rules. Coordinate shared-code ownership with NIAR-240 before integration.

### A5 — Major: Bound aggregate upload, staging and converter work

**Scope:** design 63–67,77–79,107–111; upload/conversion checkpoints. **Source:** D1; supported by Stage 8.

Per-file/message caps and expiry do not bound simultaneous transfers, abandoned objects, pending work or parallel converters. Current Niaro has 512 MiB shared `/tmp` and 2 GiB RAM. Define global/per-owner reservations, concurrency/queued-work limits, timeouts and quota release, retained-capacity policy and operator visibility. Use local single-process patterns rather than a new quota service: meeting-store 247–258, meeting-processing 317–323 and speech-queue already provide relevant patterns. **Completion evidence:** deterministic admission/cleanup rules and concurrent-transfer/queue-capacity scenarios before exposing upload routes.

### A6 — Major: Choose converter isolation and resource acceptance together

**Scope:** design 77–79,107,119; tasks 1.2–1.3,5.1. **Sources:** C3, D4, Y2; supported by Stage 8.

State the pilot's target CPU/RAM/temp/image-size/latency envelope, or a recorded approval gate for that envelope before selecting a converter. Explain whether it shares the current application limits or changes deployment requirements. An ordinary child process under `node` still accesses `/data` and the network. Select a restricted container or enforceable sandbox, transfer boundaries, identities/mounts, termination and offline assets. `server-hosting/sandbox.ts` offers hardening patterns but neither current mode satisfies the converter requirements unchanged. **Completion evidence:** a deployment/resource contract that the pilot can actually pass or fail before converter integration. Engine selection itself remains the intentional pilot decision.

### A7 — Major: Make mandatory initial formats explicit

**Scope:** design 75; converter selection/release scope. **Source:** Y1.

Replace “Prefer” with the initial formats required by the attachment delta. Retain fixture-gated legacy Office/ODF/mail separately. **Completion evidence:** design and specification agree on the required release set; a failed candidate causes the stated design revision rather than silent scope reduction.

### A8 — Major: Define owned-image hydration, native history and transport bytes

**Scope:** design 83–85; tasks 5.3,6.2–6.3. **Source:** K5.

The native runtime starts from text (`server-agent/runtime.ts:274–281,1597–1603`), while provider transport defaults to 262,144 request bytes and caps all requests at 12 MiB (`transport.ts:128–142`). Specify reference→native prompt→provider payload, authorization at hydration/rehydration, native history/checkpoint persistence, aggregate derivative bytes/count and any deliberate chat transport-limit change. Token budgeting alone cannot prevent byte-limit rejection. **Completion evidence:** provider-fake cases above the current 256 KiB default, safe stored history, and current ownership/deletion checks at image use.

### A9 — Major: Bridge editable contact UI to server-owned revisions

**Scope:** design 93; tasks 9.1–9.3. **Source:** K6.

OpenUI emits explicit text follow-ups to the composer; it does not create a server contact revision. `service.resolve` approves an existing operation/work receipt, not arbitrary edited fields. Define the proposed contact/source schema, when edits become server-owned revisions, frozen CRM action inputs, retirement of old proposals and stale-card/device behavior. Preserve explicit send and existing approval/unknown-outcome machinery. **Completion evidence:** editing after a prior proposal invalidates its consent in the server state, and a stale card cannot approve old values.

## Editorial actions

- **A10 — Nit, design 117, Y3:** replace “unavailable clients” with clients lacking attachment metadata support.
- **A11 — Nit, tasks 5.2, T1:** replace “clean values” with expected field/cell values from the approved fixtures; clarify legibility if intended.

## Traceability

| Raw reviewer result | Consolidated action / disposition |
| --- | --- |
| Stage 5 zoom-out | No concrete findings; architecture/reuse baseline retained |
| C1 | A1 |
| C2 | A3 |
| C3 | A6 |
| D1 | A5 |
| D2 | A4 |
| D3 | A3 |
| D4 | A6 |
| Structural reviewer | No findings; separate OpenSpec artifacts accepted |
| Y1 | A7 |
| Y2 | A6 (subsumed by Major resource/deployment decision) |
| Y3 | A10 |
| Stage 8 zoom-out | No new defect; confirms scoped dispositions/reuse guidance |
| R1 | A1 |
| R2 | A2 |
| R3 | A3, A4 |
| R4 | A4 |
| K1 | A1 initially; checkpoint file/action/test maps within A3–A9 later |
| K2 | A1 |
| K3 | A4 |
| K4 | A3 |
| K5 | A8 |
| K6 | A9 |
| T1 | A11 |

No finding is silently dismissed. Consolidation merges duplicate observations; every action remains pending an owner fix, evidence-backed disposition or explicit decision. Stage 9's narrower readiness findings supersede any inference that Stage 5/8 architecture viability alone approves implementation.

## Evidence and review limits

Reviewed HEAD: `260b1eef413dc3e6295ef9776c2a5ea868a8ef0f`, with existing dirty/untracked working-tree files. Design SHA-256: `f0a0bc02f4d95c39fbb3ef386e8fb5c6317ddceee213bb07be4cb54bb64f6344`; tasks SHA-256: `69d056fd3f6e8550afde974be24986a9ccde3647c0c9cfe9649ff82ffb1de8d0`. The complete required context and hashes are in [review-input-manifest.json](review-input-manifest.json). Per-stage read inventories and decisive source hashes are in the reports. [source-revision-check.json](source-revision-check.json) and [additional-source-hashes.json](additional-source-hashes.json) record source binding/checks.

Nine fresh child reviewers completed sequential stages 5→6→7→8→9, with at most two persona reviewers active simultaneously. Native completion messages supplied their findings, read attestations and hashes; the coordinator did not retrieve conversation transcripts. The host did not expose a complete child tool trace to the coordinator, so the report does not claim independent replay of every child read. The final style reviewer used the newly requested `gpt-6.1-sol`/`xhigh`; earlier reviewers inherited the host model.

Required local inputs were accessible. This was a bounded static design/source review, not an exhaustive runtime audit. No implementation, tests/builds, native capture, converter benchmarks, S3 deployment, real credential use or live Hetzner/RustFS contract run occurred. Mechanical validation claims in the design were not re-executed as part of this review. Public documentation checks by the coordinator are separated in [external-source-checks.md](external-source-checks.md); they do not prove endpoint compatibility, resource fit or complete dependency/model licensing. No external people were contacted.

The coordinating parent reported tracker assignment NIAR-250 and that NIAR-240 remains unstarted; this review did not independently query the tracker. Those workflow updates do not alter the hashed canonical inputs or resolve the technical findings. No source, design, task or delta-spec file was edited by this review; only files under `reviews/` were written. Material canonical revisions need a focused fresh review tied to their new hashes; that follow-up is outside this completed pass.

## Stage reports

- [Initial zoom out](zoom_out_report.md)
- [Comprehension](comprehension_report.md)
- [Design, structure and style](critic_report.md)
- [Intermediate zoom out](intermediate_zoom_out_report.md)
- [Implementation readiness](implementation_readiness_report.md)
