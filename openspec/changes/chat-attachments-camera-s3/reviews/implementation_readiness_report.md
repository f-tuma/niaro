# EGM Stage 9 — Implementation Readiness

DetailedRange: `../tasks.md:1–74`; design context: `../design.md:1–134`. Three independent reviewers completed: `/root/attachment_design_review/stage9_readiness`, `stage9_codebase`, and `stage9_style`. Each used `fork_turns: none`, read its assigned EGM persona, and read the complete canonical context. Readiness/codebase also read the implementation-readiness standard. The style reviewer used `gpt-6.1-sol`, `xhigh`, following the updated owner instruction; earlier reviewers inherited the host model. At most two reviewers ran simultaneously.

## Verdict

The plan does not yet meet the supplied zero-decision implementation standard. Tasks 1.1–1.3 are actionable preparation/pilot work. Initial storage tasks 2.1–2.4 require bounded decisions R1/R2 and K1/K2. Later ingestion, model and UI findings do not require implementing the whole feature before that storage checkpoint.

There are no verified false current-state claims warranting Blocker severity. The raw reviewer output contains ten Major findings with overlap, and one Nit. Absent proposed code is not treated as a defect. Canonical inputs were unchanged; no remediation occurred.

## Initial storage findings

### R1 — Major: Persistence and interface contract missing

- **Location:** tasks 2.1, 2.2, 2.4 (`tasks.md:13–16`); `design.md:28–45,57`.
- **Evidence:** Location identity must persist and reject replacement while objects/jobs remain, but no durable store/schema or guard lookup is selected. Attachment migrations first appear in task 3.1. The adapter has operation names and an internal handle without concrete types/results/errors. Startup/check targets exist in `apps/reference-server/config.ts:358–392` and `cli.ts:32,75–94`; workflow storage has a version guard and transaction boundary (`storage.ts:95–141,653–686`).
- **Impact:** Implementers must choose persistence ownership and server-module contracts that constrain later atomic attachment/job operations.
- **Next step:** Add a compact first-slice contract: named Create/Modify files, configuration type, secret precedence, location schema/migration owner, guard interface, handle/adapter types, error taxonomy and probe entry point. Introduce minimum phase-2 schema, or explicitly defer phase-3 integration behind a stable phase-2 boundary.

### R2 — Major: RustFS principal/bootstrap mechanism unspecified

- **Location:** tasks 2.3–2.4 (`tasks.md:15–16`); `design.md:51–55`.
- **Evidence:** The profile promises private-bucket bootstrap, distinct bucket-scoped application credentials and a one-shot task using the same SDK, but does not select principal/policy provisioning, management dependency/operator prerequisite or rerun behavior. Existing Compose files offer no object-store provisioning contract.
- **Impact:** The usable deployment profile depends on an unchosen credential-management mechanism; an image pin alone cannot complete it.
- **Next step:** Specify principal/policy provisioning, application permissions, secret inputs, idempotent reruns, startup ordering and failure behavior. If credentials are externally provisioned, make that prerequisite explicit. Record the chosen image when this storage decision is finalized.

### K1 — Major: No file/action/test map

- **Location:** `tasks.md:13–69`; integration inventory `design.md:7–16`.
- **Evidence:** Behavior/check descriptions omit Create/Modify/Delete assignments and production/test entry points. Relevant existing targets include reference-server config/CLI/runtime, `scripts/docker/niaro`, and dependency tracing at `scripts/docker/runtime-deps.mjs:30–49`.
- **Impact:** Placement, ownership, packaging and test infrastructure remain choices, including for the first storage slice.
- **Next step:** Add a bounded file/action/contract/test map per checkpoint, including docs and shared HTTP/provider helpers. This is one map finding, not separate defects for every absent proposed file.

### K2 — Major: S3 failure boundary conflicts with ordinary startup behavior unless selected explicitly

- **Location:** `tasks.md:13,16`; `design.md:30–45`.
- **Evidence:** `loadServerConfig()` uses a strict profile schema and throws (`config.ts:358–382`); CLI config errors abort startup (`cli.ts:150–156`). The offline checker loads adapters before check mode (`cli.ts:75–94`), while identity opens only in start mode (`100–104`). The design promises attachment unavailability, continued text chat, network-free checking and durable location checks without locating these boundaries. Secret reload/restart semantics also remain unspecified.
- **Impact:** A direct addition to strict profile validation can disable text chat; probing in adapter loading can add network calls to offline checking.
- **Next step:** Define S3 status/result type, exact env/file rules, offline-check behavior, activation hook, location-record owner and credential reload semantics. Test invalid S3 separately from fatal whole-server configuration.

## Later integration findings

### R3 — Major: Wire/schema and reuse choices remain open

- **Location:** `tasks.md:20–30`; `design.md:61–69,97–99,117`; chat delta 14,44–50.
- **Evidence:** Routes lack method/path/DTO/error definitions; capability/history negotiation lacks a wire contract. Attachment rows are informal without binding/job schema or transaction owner. Uploaded-only claim rules do not explain Again/Edit reuse of attached IDs. Existing command validation is strict (`protocol/index.ts:652–681`).
- **Impact:** Server/client implementers can produce incompatible APIs and different ownership/deletion semantics.
- **Next step:** Before phase 3, define versioned DTOs, endpoints/statuses, capability/history response, table constraints, transaction hook, same-chat reuse and independent cross-chat copying. Overlaps C2/D3/K4.

### R4 — Major: Conversion-to-inference scheduling/recovery undefined

- **Location:** `tasks.md:39,43–45`; `design.md:67,77,83–85,99`.
- **Evidence:** Durable conversion, explicit retry and budget admission do not identify when the original turn waits/finishes, the connecting record, or the command that resumes interpretation. Current native dispatch receives text/history directly (`model-service.ts:1163–1195`), and architecture prohibits implicit boot/read/poll inference recovery.
- **Impact:** Duplicate inference, incorrect visible state and unbound budget reservations remain possible implementation choices.
- **Next step:** Before 5.4/6.2, define processing/dispatch states, identities, explicit retry/idempotency, partial/failure outcomes, crash boundaries and root-budget ownership. Test conversion-complete/pre-dispatch crashes and repeated explicit retry. Overlaps D2/K3.

### K3 — Major: Atomic acceptance/deletion have no selected transaction sequence

- **Location:** `tasks.md:20–22,29,39`; `design.md:65–69,99`.
- **Evidence:** Production uses the shared workflow server (`runtime.ts:219`). Messages/receipts/directory changes commit in `workflow.sqlite` via `FixtureStorage.execute()` (`storage.ts:94–123,653–686`). Native work is separate (`model-service.ts:788–790`), and native execution precedes publication (`1050–1088,1165–1235`). No store is selected for attachment/staging/jobs, nor a pre-processing acceptance transaction.
- **Impact:** The implementer must redesign admission or assume cross-database atomicity.
- **Next step:** Select the database, schema/constraints, acceptance/handoff/replay/deletion sequence and behavior between native/identity and workflow commits. Settle NIAR-240 ownership coordination before these checkpoints. Overlaps D2/R4 and the transaction portion of R3.

### K4 — Major: Again/Edit contradict uploaded-only admission

- **Location:** `tasks.md:22,28,51,58`; `design.md:67–69`; chat delta 14–24.
- **Evidence:** Existing web Again passes request text (`chat-next-page.tsx:1514–1517`) and has no attachment identity/clone mechanism. Planned attached IDs cannot satisfy an uploaded-only admission rule without additional semantics.
- **Impact:** Literal behavior rejects reuse; a loose relaxation can break immutable ownership/deletion accounting.
- **Next step:** Define reuse/clone operations, binding cardinality, derivative ownership and generation checks. Include file-only Again, edited resend, unavailable-file and deletion/clear cases. Duplicate of C2/D3.

### K5 — Major: Native input and transport byte limits are omitted

- **Location:** `tasks.md:38,44–45`; `design.md:83–85`.
- **Evidence:** `NativeAgentInput` has `text?: string` (`apps/server-agent/runtime.ts:274–281`) and invokes `agent.stream(input.text!)` (1597–1603). Chat does not override request size (`mastra-model.ts:342–350`). Shared transport defaults to 262,144 bytes, with a 12 MiB absolute ceiling (`transport.ts:128–142`); budget estimation separately counts serialized bytes (`inference-budget.ts:56–60,554`).
- **Impact:** Capability and token admission can succeed while an ordinary encoded photo fails transport. Hydration and native history/checkpoint choices can introduce untracked copies or skip ownership rechecks.
- **Next step:** Define owned reference → native prompt → provider payload, hydration/rehydration and persistence rules, aggregate image-byte limit and any explicit chat transport adjustment. Test requests exceeding the current 256 KiB default.

### K6 — Major: Editable OpenUI does not itself create server proposal revisions

- **Location:** `tasks.md:62–64`; `design.md:93`.
- **Evidence:** OpenUI provides `onFollowUp(text)` (`GenerativeUiView.tsx:43–58`); answers become visible composer text capped at 4,000 characters (`packages/openui-library/follow-up.ts`). `service.resolve` carries operation/work IDs plus an approval boolean (`protocol/index.ts:634–642`), not edited contact fields. Catalog invocation prepares server operations before approval (`catalog-controller.ts:1545–1579`).
- **Impact:** Local form edits alone cannot ensure approval binds exactly the reviewed values across stale cards/devices.
- **Next step:** Define contact/source schema, server revision transition, frozen action input and mapping to existing receipts; specify when the old proposal becomes unusable. Preserve explicit-send OpenUI behavior and test stale edits/approvals.

### T1 — Nit: “Clean values” is ambiguous

- **Location:** `tasks.md:37`, task 5.2.
- **Evidence/impact:** “Clean” could mean legible, normalized or sanitized values, weakening fixture verification precision.
- **Next step:** Say “expected field/cell values from the approved fixtures,” with a legibility qualifier if intended.

## Deliberately gated evidence

Converter choice, OCR assets/licenses, measured limits, supported-format fixtures and native HEIC evidence are explicitly gated before integration. The unselected engine is not an initial-storage defect. Live Hetzner testing correctly depends on a designated test bucket. Existing backup guidance already distinguishes individual database consistency from a stopped-server coordinated snapshot; no separate contradiction was raised solely over attachment quiescence wording.

## Revision, source inventory and limits

HEAD: `260b1eef413dc3e6295ef9776c2a5ea868a8ef0f`; working tree includes existing tracked/untracked changes. Codebase reviewer reported tracked diff SHA-256 `221e93707768cf219fae5f5f38e79c00541b2be47e325f445072ddb5fad7700e`, excluding untracked files. The authoritative planning-input hashes are in `review-input-manifest.json`:

- tasks: `69d056fd3f6e8550afde974be24986a9ccde3647c0c9cfe9649ff82ffb1de8d0`
- design: `f0a0bc02f4d95c39fbb3ef386e8fb5c6317ddceee213bb07be4cb54bb64f6344`
- proposal: `32979ed43dd485d5c5409ed0a7b94bcb5d80f797d6d3b8cebc80d172021d0ab9`

All reviewers fully read persona, target, design/proposal, five deltas, CONTRIBUTING and architecture. Readiness/codebase inspected focused config/CLI/runtime, Compose/env, workflow schema/HTTP/model service, protocol/client delivery, meeting routes, model/native/transport/budget, mobile document/composer, web Again, OpenUI/catalog, packaging and backup/restore sources. Codebase also inspected shared test infrastructure `tests/helpers/process-pipeline-http.ts:1–145` and `process-pipeline-http-worker.ts:1–55`. The style reviewer performed editorial review only.

Decisive additional fingerprints from the codebase reviewer:

```text
8b8c79167d2c4b11394907e0f974a3263319bed10eb2365773d61e3e9b154d7d  apps/reference-server/config.ts
781e478594ced735454048a642dc8cc1223e2d58d44f8159d72f2f771abc8972  apps/reference-server/cli.ts
73da64ca6347e00541656af1cf6d26b0de5b79f84b1cc3917df84d21123b0358  apps/fixture-server/storage.ts
194693a870bd1db5b51d37de54fd47dd87bf2cc41bbf8122aacf6f5bfff66240  apps/fixture-server/model-service.ts
9a73a383935d30a306dd9d01748f3346bfd6af163660893ff0f2709c974f2f6b  apps/server-agent/runtime.ts
daae07327c1f3cfaae0e2662156b34c8dd699caebd55cea2d13ed9475b51901d  apps/server-integrations/transport.ts
b4d01f7074dc547c12b16452cf2303d3c6b242eb2aee9240ba46e3402cbbe4f3  apps/server-integrations/mastra-model.ts
facaf635226fddc42b44f8d97b04aa127895557bef765b69a021bb00a9f9424a  packages/ui-catalog/GenerativeUiView.tsx
1e15b3754c62809c52e7060509770f2d3decd2c1443b068e0b0a7f719ee54d09  packages/openui-library/follow-up.ts
```

Bounded static review; not an exhaustive runtime audit. All required local inputs were accessible. No edits, tests, builds, converter execution, live service checks or people contact occurred; no conversation transcripts were accessed. Vendor capabilities and external-library behavior were not validated by these reviewers. Findings are plan-readiness gaps, not claims of newly observed runtime defects.
