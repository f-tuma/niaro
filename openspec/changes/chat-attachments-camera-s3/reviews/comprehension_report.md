# EGM Stage 6 — Comprehension

Target: `../design.md:1–134` (FeatureRange) and `../tasks.md:1–74` (DetailedRange). Reviewer: `/root/attachment_design_review/stage6_comprehension`, created with `fork_turns: none`. Completed after reading `agents/comprehension.md` and `resources/document_standards/re-implementation-standard.md` from EGM 0.1.0.

Three Major findings; no Blockers. C1 affects initial storage configuration. C2–C3 apply to later work and do not prevent isolated S3/RustFS development after its configuration contract is settled.

## C1 — Major: Startup configuration is underspecified

- **Location:** `design.md:30–43`; `tasks.md:13–16`.
- **Evidence:** The settings table gives purposes without complete required/default behavior. Credential mode names `static` without the literal value selecting the SDK default chain. Mounted secret variants have no names or direct/file precedence. Missing configuration disables attachments, but wholly absent and partially configured settings are not distinguished. Existing `.env.example` and the offline checker provide no S3 convention resolving these choices.
- **Impact:** Implementers must choose observable behavior and could disagree whether partial configuration means disabled or invalid.
- **Next step:** Define exact mode values, required/default fields, secret-file names and precedence, and absent/partial/invalid outcomes. Actual operator endpoint values and credentials are unnecessary for this contract.
- **Checkpoint:** Before initial task 2.1.

## C2 — Major: Again/Edit reuse conflicts with single-message binding language

- **Location:** `design.md:63–69`; `tasks.md:28,51,58`; `specs/chat/spec.md:14–24`.
- **Evidence:** The lifecycle advances `uploaded` to `attached`; send references only uploaded IDs/digests and binds them to the exact message. The chat delta requires Again/Edit to preserve attachment references and earlier history. Cross-chat copying has an independent-ownership rule, while same-chat reuse is unspecified. Existing web Again sends a new request; Edit returns the request to the composer.
- **Impact:** Implementations could reject these actions or transfer an attachment away from the previous message.
- **Next step:** Define accepted reuse states, identity versus binding behavior, preservation of the original message, and unavailable-file handling. Align lifecycle and action scenarios.
- **Checkpoint:** Before protocol/lifecycle and client integration, not before isolated storage work.

## C3 — Major: Converter selection lacks a resource acceptance boundary

- **Location:** `design.md:77–79,107`; `tasks.md:8–9,36`.
- **Evidence:** Selection depends on fitting a resource/deployment envelope, but no target envelope is given. Existing guidance assumes one or two cores and 2 GB for Niaro; both Compose variants enforce 2 GB with 512 MB temporary storage. It is unclear whether conversion must share those limits or may change deployment requirements.
- **Impact:** Measurements alone cannot produce a reproducible selection decision; an implementer must independently choose acceptable memory, packaging and latency.
- **Next step:** State the target deployment and acceptance boundaries, or record an explicit resource-envelope decision before engine selection. Include converter memory/temp use relative to existing limits.
- **Checkpoint:** Converter selection, not initial S3/RustFS.

## Evidence and limitations

Design SHA-256: `f0a0bc02f4d95c39fbb3ef386e8fb5c6317ddceee213bb07be4cb54bb64f6344`. Tasks SHA-256: `69d056fd3f6e8550afde974be24986a9ccde3647c0c9cfe9649ff82ffb1de8d0`. Both were unchanged at the reviewer's final check. Canonical input hashes are in `review-input-manifest.json`.

Full reads: design/proposal/tasks; all five delta specs; CONTRIBUTING; architecture; `openspec/changes/niar-240-remove-fixture-interpreter/proposal.md`; assigned persona and standard.

Relevant excerpts: `.env.example`, both Compose files, deployment guide, package.json, `apps/reference-server/cli.ts`, `packages/protocol/{index,service-catalog}.ts`, `packages/client-core/session.ts`, web `chat-next-page.tsx`, `apps/server-integrations/{models,mastra-model}.ts`.

Search-only context: Dockerfile, `scripts/docker/niaro`, and matching declarations in `apps/server-identity/{workspace-calendar,hub-fill,meeting-diarization,hub-store,service-oauth,service-oauth-controller,server-settings,service,hub,mastra-domain}.ts`. These did not determine findings.

The supplied context explained fixture/production ownership, image-capability states, OpenUI, root-run budget and approval/replay semantics sufficiently; no undefined-term findings were invented for them. No inaccessible required files were reported. No implementation audit, tests, compilation, runtime/provider checks, external documentation checks, transcript access or edits occurred.
