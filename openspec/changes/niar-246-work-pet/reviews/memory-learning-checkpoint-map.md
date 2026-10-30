# Authoritative memory learning checkpoint action map

Status: accepted by the coordinator after fresh review and focused closure; production implementation is in progress. This map supersedes the historical preimplementation inventory. No files are deleted. Any additional production path requires coordinator notice.

Effective seed is `/tmp/niaro-orchestration-20261030/niaro-memory-learning-dependency-baseline.json`; accepted S3 provenance is `memory-s3-dependency-refresh.json`. Original reviewer reports/manifests under `reviews/memory-review-20261030/` are immutable coordinator-owned inputs and are excluded from worker-only source delta accounting.

| Action | Exact path | Tasks | Responsibility |
| --- | --- | --- | --- |
| Modify | `packages/protocol/memory.ts` | 1.1 | Strict encrypted/public source, item/view/query and owner-command contracts |
| Modify | `apps/server-identity/memory.ts` | 1.1–1.3, 2.1 | Upgrade, observed batches/stages, origin-aware erasure, private list/control, retrieval |
| Modify | `apps/server-identity/memory-copied-tuple.ts` | 1.1 compatibility | Coordinator-approved named-column forward migration and explicit refusal of observed reverse migration |
| Modify | `apps/server-identity/memory-payload-crypto.ts` | 1.1 | Validate observed payload invariants at actual encrypted decode/seal boundary |
| Modify | `apps/server-identity/memory-runtime.ts` | 2.1 | Separate automatic/direct search, observed context and expiry/version metadata |
| Modify | `apps/server-identity/service.ts` | 1.3, 3.1–3.3 | Owner HTTP commands, narrow source/model/scheduler wiring, authority and lifecycle |
| Modify | `apps/fixture-server/storage.ts` | 3.1 | Transaction-bound refs, owner-only source port, stable archive relocation |
| Modify | `apps/fixture-server/http.ts` | 3.1 | Attach source port/notification through existing server runtime; preserve S3 initialization |
| Modify | `apps/server-identity/meeting-store.ts` | 3.1–3.2 | Publish-index transaction and bounded owned source resolution |
| Modify | `apps/server-identity/meeting-processing.ts` | 3.1 | Best-effort post-publication notification |
| Modify | `apps/server-identity/service-catalog.ts` | 3.2 | Names-only projection of owned bound succeeded/completed receipts |
| Create | `apps/server-identity/profile-cursor.ts` | 3.1, 3.3 | Persistent offsets/lease CAS, bounded stages and stable paid batch/root/call/encrypted response states |
| Create | `apps/server-identity/profile-material.ts` | 3.2 | Eligible source projection, quotes/sensitive filtering, byte bounds and continuation |
| Create | `apps/server-identity/profile-learner.ts` | 3.3 | Single-flight bounded scheduler and failure/no-op/commit transitions |
| Create | `apps/server-identity/profile-inference.ts` | 3.3 | Closed adapter, enforce/priced admission and durable same-root received/unknown recovery |
| Modify | `apps/server-identity/inference-budget.ts` | 3.3 residual closure | Optional trusted synchronous profile checkpoint hook and owner-checked attempt-state lookup; existing defaults/accounting unchanged |
| Create | `apps/server-agent/profile-extraction.ts` | 3.3–3.4 | Quiet no-tool structured agent, strict envelope/prompt and one bounded repair |
| Modify | `apps/server-agent/runtime.ts` | 3.3 | Export the new closed agent via existing server package |
| Modify | `apps/server-admin/web/memory-panel.tsx` | 1.1 compatibility | Explicit typed observed label before generic inference branch; no redesign |
| Modify | `apps/server-admin/web/plugins-copy.ts` | 1.1 compatibility | Observed source label EN/CS |
| Modify | `package.json` | 3.3, 6.2 | Register all four new node suites in test:identity and test:saved-memory only |
| Modify | `tests/memory.node.ts` | 1.1–2.1 | Schemas, upgrade, ownership, batch/lineage/control and context behavior |
| Modify | `tests/memory-http.node.ts` | 1.1–1.3 | Actual authenticated owner controls/list/replay with plugin off and opt-out |
| Modify | `tests/saved-memory-native.node.ts` | 1.2–1.3 | Real native stage interruption, mixed-origin erasure, restart and late-result guards |
| Modify | `tests/memory-runtime.node.ts` | 2.1 | Immediate bounded observed context and common version/expiry validation |
| Modify | `tests/memory-chat.node.ts` | 1.3, 2.1 | Actual chat correction and next-turn/private context wiring |
| Create | `tests/profile-sources.node.ts` | 3.1 | Real workflow/meeting source transaction, archive relocation/deletion and missed marks |
| Create | `tests/profile-material.node.ts` | 3.2 | Actual builder negative ownership/quote/service-result cases and UTF-8 continuation |
| Create | `tests/profile-learner.node.ts` | 3.3 | Actual persistent scheduler/cursor/stage and authority/deadline/lease races |
| Create | `tests/profile-extraction.node.ts` | 3.3–3.4 | Actual closed agent/adapter/ledger and full-capacity first/repair admission |
| Create | `tests/admin-memory-observed.test.tsx` | 1.1 compatibility | Actual panel rendering of a strict observed API variant (model_inference trust), proving source-branch precedence in EN/CS |
| Create | `tests/fixtures/profile-extraction.json` | 3.4 | Approximately 12 synthetic EN/CS snippets/expected and forbidden outputs |
| Create | `scripts/profile-extraction-eval.ts` | 3.4 | Synthetic logic evaluation with live result explicitly conditional/separate |
| Create | `docs/guides/memory.md` | 6.1 observation portion | Implemented observations and owner controls, no claim of later pages |
| Modify | `docs/guides/deployment.md` | 6.1 observation portion | Allowlist/opt-out and enforce/priced learner admission with no auto-enable |
| Modify | `docs/architecture.md` | 6.1 observation portion | Private observed origin beside explicit memory; untrusted/non-authority context |
| Modify | `openspec/changes/niar-246-work-pet/design.md` | Planning | Canonical source-backed MR1–MR9 resolutions |
| Modify | `openspec/changes/niar-246-work-pet/tasks.md` | Planning | Exact focused tests, script registration and incomplete later work |
| Modify | `openspec/changes/niar-246-work-pet/specs/memory/spec.md` | Planning | Accepted intent clarified for archive, mixed origin and enforceable budget |
| Create | `openspec/changes/niar-246-work-pet/reviews/memory-learning-checkpoint-map.md` | Planning | This authoritative action map |
| Create | `openspec/changes/niar-246-work-pet/reviews/memory-learning-review-dispositions.md` | Planning | MR1–MR9 dispositions, evidence/limits and changed-contract recheck request |

Existing `reviews/memory-learning-preimplementation.md` is retained as historical intake evidence; its earlier map and hashes do not override this action map or the refreshed seed. Additional execution reports/patch/hash manifests may be created under this change’s `reviews/` and `/tmp/niaro-orchestration-20261030/memory-learning*`, with exact input binding and no edits to independent original reports.

Focused commands:

- Protocol/store/context: `node --import tsx --test tests/memory.node.ts tests/saved-memory-native.node.ts tests/memory-runtime.node.ts tests/memory-http.node.ts tests/memory-chat.node.ts`.
- Source transaction/archive: `node --import tsx --test tests/profile-sources.node.ts tests/profile-learner.node.ts`.
- Material/ownership: `node --import tsx --test tests/profile-material.node.ts tests/profile-sources.node.ts tests/profile-learner.node.ts`.
- Actual closed agent/budget: `node --import tsx --test tests/profile-extraction.node.ts tests/profile-learner.node.ts tests/inference-budget.node.ts`.
- Existing admin compatibility: `pnpm exec jest --runInBand tests/admin-memory-observed.test.tsx`, `npm run typecheck`, and the required admin build.
- Final normal gate: `npm run check` (registers all four node suites in test:identity), `npm run test:saved-memory`, `npm run admin:build`, pinned OpenSpec strict validation. Compare full identity failures by exact name to recorded baseline; do not repair unrelated failures.
- Synthetic evaluation: `node --import tsx scripts/profile-extraction-eval.ts`; deterministic logic and any authorized live quality run are separately labeled, with live not executed when no designated model is supplied.

No new member/pet page, router/sidebar, Graph, weather, renderer, original provider session, tracker, plugin activation, credential/account, service/emulator, main-worktree, commit or deployment changes are in this map. The optional confirmed-position port remains empty until later task 4.2.

The new admin regression must parse an actual `MemoryViewSchema` response into the real existing panel and exercise the observed source branch ahead of generic model inference. A static string/source-file assertion is insufficient. No UI restyling is planned.

Crypto decoder before hash (accepted S3 baseline, production not modified): `d2d88e6fa21f7d794774ea2c3086b354ccac26af73521bc0f7eed6129e4a56f4` for `apps/server-identity/memory-payload-crypto.ts`. Existing explicit payloads retain their original source/trust/schema behavior; production tests must exercise real seal/open and migrated native storage.

Residual closure adds exact D3b profile batch/root/dispatch/response persistence and controlled real-ledger recovery tests in the already-mapped learner/extraction suites. The ledger transport optional hook uses only the existing identity queue/database: reserve+bind and dispatch+marker commit before network start, response settle+encrypted checkpoint commit before SDK parse. No generic engine, reconciliation endpoint, ordinary policy change or automatic unknown reset is authorized. Ledger source before hash: `1b55bfc8e1933c567ed7e12a5e9a11d62d8d4a3c5bf73a485cd64ca13ef289c2`.
