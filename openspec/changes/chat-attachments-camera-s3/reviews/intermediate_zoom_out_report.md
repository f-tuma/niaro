# EGM Stage 8 — Intermediate Zoom Out

Target: `../design.md:1–134`. Reviewer `/root/attachment_design_review/stage8_zoom_out` completed with `fork_turns: none`, reading the EGM zoom-out persona/standard, canonical context and the three prior stage reports. Design SHA-256 remained `f0a0bc02f4d95c39fbb3ef386e8fb5c6317ddceee213bb07be4cb54bb64f6344`.

## Result and dispositions

No new independent defect; no I IDs assigned. No reason to replace the S3/RustFS architecture. Existing findings need targeted revisions before their respective checkpoints rather than a second ingestion product or execution engine.

- **C1, Major — before task 2.1:** settle observable configuration values/defaults, secret precedence and absent/partial/invalid behavior. Keep one adapter/configuration path.
- **D2, Major — before ingestion/runtime integration:** define the durable handoff and recovery between accepted attachment processing and the existing run. Source confirms model execution before publication (`model-service.ts:1163`, commit at 1063) and unknown restarted attempts (`inference-budget.ts:173`). Reuse request identity, receipts, budget and explicit recovery. Cleanup/conversion must not become another agent scheduler.
- **D4 and C3/Y2, Major — before converter selection/integration:** choose sandbox and resource envelope together. Current application deployment exposes `/data`, network, 2 GiB RAM and 512 MiB shared temporary storage. `apps/server-hosting/sandbox.ts` provides hardening patterns, but its Docker mode has network/writable mounts; its process mode has network and is Node-only. Neither meets the converter contract unchanged. Avoid coupling conversion to the hosted-connector product abstraction.
- **D1, Major — before exposed uploads/conversion:** bound aggregate resource admission locally. Existing `meeting-store.ts:247–258` has owner/global storage checks; `meeting-processing.ts:317–323` and `speech-queue.ts` provide admission/cancellation patterns. Reuse patterns while maintaining separate ownership. No distributed quota or queue service is justified.
- **C2/D3, Major — before schema/protocol integration:** select same-chat attachment ownership/bindings or explicit cloning. Existing Again/Edit handlers confirm distinct new-send/composer behavior (`chat-next-page.tsx:749–765`). Define generation cleanup without cross-chat deduplication or document-management infrastructure.
- **Y1, Major — before converter selection:** align mandatory initial formats; this does not justify additional engines.
- **Y3, Nit:** clarify unsupported-client wording; no architecture consequence.

The standalone storage checkpoint remains architecturally feasible after C1 and existing workflow prerequisites are settled. This stage does not replace Stage 9's implementation-readiness test. No remediation has been applied to the canonical sources.

## Reads and limits

Full reads: assigned persona/standard, target, proposal/tasks, all five deltas, CONTRIBUTING, architecture, `zoom_out_report.md`, `comprehension_report.md`, `critic_report.md`; `apps/server-hosting/sandbox.ts`; `apps/fixture-server/speech-queue.ts`. Additional reads: README 1–90; focused excerpts/searches in model-service, workflow storage, inference budget, meeting processing/store/HTTP, web Again/Edit, Dockerfile and Compose. Searches found no existing S3 adapter/general converter within searched application/package/script paths.

All required local inputs were accessible. Bounded static review only: no tests/builds, runtime/provider checks, external documentation verification, edits, transcript access, people contact or child delegation. Canonical hashes are recorded in `review-input-manifest.json`.
