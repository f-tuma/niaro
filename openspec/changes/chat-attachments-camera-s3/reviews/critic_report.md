# EGM Stage 7 — Design, structure and style

Target: `../design.md:1–134`. Three fresh-context reviewers completed: `stage7_design`, `stage7_structure`, and `stage7_style` under `/root/attachment_design_review/`, each created with `fork_turns: none`. At most two ran simultaneously. They read their respective EGM 0.1.0 personas; design and structural reviewers also read the feature-spec standard. This uninterrupted review reports findings without remediation; canonical sources remain unchanged.

Design SHA-256: `f0a0bc02f4d95c39fbb3ef386e8fb5c6317ddceee213bb07be4cb54bb64f6344` for all three. Required context is bound in `review-input-manifest.json`.

No demonstrated architectural blocker to a standalone S3 adapter/RustFS checkpoint. Five raw Major findings and two Nits are recorded below; D3 duplicates comprehension C2 and Y2 overlaps C3. Structure review found no issues.

## D1 — Major: Aggregate upload and conversion resources are unbounded

- **Location:** `design.md:63–67,77–79,107–111`.
- **Evidence:** There are file/message limits, staging expiry and per-worker limits, but no concurrent-upload admission, pending-upload byte allowance, aggregate staging quota, converter concurrency or queue capacity. Niaro shares 512 MiB `/tmp` and 2 GiB RAM (`compose.yml:51–60`, `compose.dokploy.yml:70–79`). Inference concurrency is bounded separately; uploading happens before inference.
- **Impact:** Parallel individually valid transfers can exhaust temporary storage. Abandoned drafts can accumulate unbounded objects during their retention window, and multiple bounded conversions can still exhaust the host.
- **Next step:** Define global/per-owner admission and reservations for transfers, staging bytes and queued/running conversions; include timeout/disconnect cleanup, release rules, retained-storage capacity policy and operator visibility.
- **Checkpoint:** Before exposing uploads or integrating conversion. Not a standalone storage-suite blocker.

## D2 — Major: Durable ingestion-to-inference transition is unspecified

- **Location:** `design.md:67–69,83–85,99`; tasks 3.3, 5.4, 6.3.
- **Evidence:** The design accepts a message/receipt before processing and inference. Today `apps/fixture-server/model-service.ts:1163–1237` invokes `access.integrations.message(...)` before publishing via `storage.execute(...)` at 1050–1090. Workflow receipt commits belong to `storage.ts:653–686`, while model admission/attempt state is in identity storage. Restarted dispatched attempts become `unknown` (`apps/server-identity/inference-budget.ts:161–174`); architecture forbids implicit boot/poll run recovery.
- **Impact:** An accepted message could stay pending forever, a recovery worker could repeat paid inference, or background conversion recovery could implicitly resume a run. An ingestion-accepted receipt must be distinguished from completion of the existing command.
- **Next step:** Specify owner/store and durable states for accepted message, conversion, inference eligibility, dispatch and publication. Define recovery before dispatch, after dispatch and before publication; identify local work allowed to retry automatically and retain the original request/root-budget identity.
- **Checkpoint:** Before ingestion/model integration. Not a standalone S3/RustFS blocker.

## D3 — Major: Attachment ownership cannot yet express Again/Edit

- **Location:** `design.md:63,67,69,97`; chat delta 14–24; tasks 4.1, 7.3, 8.3.
- **Evidence:** A linear uploaded-to-attached state and exact-message binding conflict with reusable references and unchanged history. Again is a new request; existing web handlers distinguish it from Edit (`chat-next-page.tsx:749–765`). Only cross-chat copying has an explicit ownership rule.
- **Impact:** A literal implementation rejects reused attached files or moves them away from earlier history; unrestricted reuse risks incorrect cleanup after archive/generation changes.
- **Next step:** Select an immutable attachment/object plus separate message bindings, or explicit cloning with new identities. Define permitted generation/scope, draft removal, expiry, derivative reuse and archive/clear behavior.
- **Checkpoint:** Before attachment schema/protocol and clients. Duplicate of C2.

## D4 — Major: Converter isolation lacks an enforceable deployment mechanism

- **Location:** `design.md:75–79,107,119`; deployment delta 3–11; task 5.1.
- **Evidence:** Conversion promises no application credentials/network and resource limits but only specifies a process boundary. Current runtime user `node` owns `/data` (`Dockerfile:54–72`); the container mounts application state and has network access (`compose.dokploy.yml:61–79`). A child process still inherits that identity's filesystem privileges even with a scrubbed environment.
- **Impact:** The stated security boundary does not follow from a subprocess. A converter could meet quality criteria yet fail the deployment constraints.
- **Next step:** Choose a restricted worker/container without the application volume/network, or a specified sandbox with restricted identity/mounts and enforceable limits. Define input/output transfer, termination, offline assets and pilot feasibility checks.
- **Checkpoint:** Before converter integration; not initial RustFS.

## Y1 — Major: “Prefer” weakens required formats

- **Location:** `design.md:75`.
- **Evidence:** “Prefer” describes Office/PDF/images/text formats that the attachment delta requires for the initial supported set.
- **Impact:** The design appears to permit a narrower release than its behavioral specification.
- **Next step:** State the required initial format set directly; keep legacy Office, ODF and mail conditional.
- **Checkpoint:** Before converter selection and release scope acceptance.

## Y2 — Nit: Pilot acceptance wording has no referenced envelope

- **Location:** `design.md:79`.
- **Evidence/impact:** Measurements alone do not distinguish acceptable results from merely measured candidates.
- **Next step:** Define and reference the resource acceptance criteria before selection. Subsumed by C3 at Major severity.

## Y3 — Nit: Compatibility wording names the wrong condition

- **Location:** `design.md:117`.
- **Evidence/impact:** “Unavailable clients” suggests disconnected clients, whereas the delta concerns clients lacking attachment metadata support.
- **Next step:** Name clients that do not support attachment metadata explicitly.

## Structural result

No structural findings. Heading levels, seven sequential decision headings, Markdown, settings table and links are well formed. The standard's subjects are covered, including linked motivation, alternatives and risks. It does not require exact header wording. OpenSpec's separate proposal/tasks/spec artifacts satisfy the requested organization; an embedded plan is unnecessary.

## Read inventories and limitations

All three reviewers read the complete target, proposal, tasks, five delta specs, CONTRIBUTING and architecture, plus their assigned persona. Design/structure read the feature-spec standard.

Design critic inspected focused source excerpts/searches in `apps/fixture-server/{model-service,storage}.ts`, `packages/protocol/index.ts`, `packages/client-core/session.ts`, web `chat-next-page.tsx`, `apps/server-integrations/mastra-model.ts`, `apps/server-identity/inference-budget.ts`, identity service/catalog files, both Compose files, Dockerfile and backup script. These were bounded checks, not an exhaustive runtime audit.

Structure and style did not inspect implementation or verify external sources. No reviewer ran builds, tests, converter trials, live endpoint calls or device checks. All required local inputs were accessible. No files were edited, no people contacted and no conversation transcripts accessed. Existing explicit disclosures of missing converter/live Hetzner evidence were not treated as defects.
