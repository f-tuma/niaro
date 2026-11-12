# Tasks

## 1. Wave 1: foundation (NIAR-302)

- [x] 1.1 Add `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-schema` 1.5.0 (exact) to `@niaro/server-agent`; drop pi-ai's vendor SDKs with pnpm overrides; export `@niaro/server-agent/pi`.
- [x] 1.2 `PiAgentCore` over `node:sqlite` (`0600`), policy A settings, binding extension, `createConversation(scope, route)`, `close()` (design D2, D7).
- [x] 1.3 Identity lifecycle: `openAgentCore()` on start beside the identity database (`identity.sqlite.pi.sqlite` since wave 2), resume, close before the identity database; reports logged as kinds only.
- [x] 1.4 Niaro Pi provider over the integration transport: route keys as models, catalog selection per request, fallback, streaming text, tool calls with server ids, usage mapping, retryable and non-retryable error codes (D3, D4).
- [x] 1.5 Identity call plan: `selectRoute`, `budgetedInferenceTransport`, `useProvider` in the dispatch guard, `fallbackAfter`, display price (D6).
- [x] 1.6 Write tools for policy A: `idempotentWriteTool`, `interruptibleWriteTool` (D7).
- [x] 1.7 Tests with a fake transport (`tests/pi-agent-core.node.ts`): role resolution and policy change, budget refusal before dispatch, settlement, retry counted once per attempt, fallback, missing scope, no SDK or `fetch` path, private reopenable file, streaming.
- [x] 1.8 Crash harness (`tests/helpers/pi-crash.ts`) and wave 1 scenarios (`tests/pi-crash.node.ts`): killed streamed call, killed keyed write, killed unkeyed write (D8).
- [x] 1.9 Architecture note on Pi, policy A and the upgrade rule (`docs/architecture.md`).

## 2. Wave 2: processes (NIAR-303)

- [x] 2.1 Process graphs run on Pi tasks: one `niaro.process-segment` task per drive (start, resume after approval or question), each node a phase; the run checkpoint (`niaro.process-run`) stores the carry before and after every node; the Mastra workflow compiler and runner are gone (design D10).
- [x] 2.2 The passive checkpoint proof replays the stored steps over the frozen graph and asks the domain to prove every action and agent boundary (`proveProcessRunCheckpoint`); retirement proof over the same checkpoint (`proveProcessRetired`).
- [x] 2.3 Approvals and questions as durable pending entries of the run checkpoint.
- [x] 2.9 Policy A correction (wave 3 start): after a restart the server continues runs stopped mid-run by itself after proof (`process-resumer.ts`), bounded by `restartLimit`; spec "No implicit execution" updated; crash tests prove the restart alone finishes the run.
- [x] 2.4 Agent core per catalog controller (`agent-core-owner.ts`), file `identity.sqlite.pi.sqlite`; the process console, contract tests (`process-testing.ts`) and native tests drive the same engine.
- [x] 2.5 Process restore and crash tests read and corrupt the Pi checkpoint instead of Mastra snapshots; Pi-level process crash scenarios (killed inside a node after its effect, killed while waiting for approval) in the crash harness.
- [x] 2.6 Spec deltas for `process-execution` and `process-qualification`.
- [x] 2.7 Process agents (agent steps) run on Pi (step B behind the switch, design D13; the only core since 3.13); approvals and questions inside an agent step wait inside the Pi tool.
- [x] 2.8 Process agent writes on Pi follow the `interruptibleWriteTool` rule through the native tool (`niaro.started`, receipts per tool call id, D13); action steps keep the domain's receipts, which never re-run a write blindly.

## 3. Wave 3: chat (NIAR-304)

- [ ] 3.1 Chat turns as Pi conversations per thread: services listing as a prompt section, call-by-name actions as Pi tools, model presets via `provider.route("preset:<id>")` before submit.
- [ ] 3.2 Checker, answer checks and visible-reply rules as `beforeTool`, `onYield` and `afterResponse` hooks; escalation as a route.
- [ ] 3.3 Member projection: stream answers to web and phone from Pi's conversation watch; hide failed attempts, interrupted tool results, aborted partials and harness errors; sent text never returns to the composer.
- [ ] 3.4 Submissions by `requestId` for delivery retries; interruption and cancel through `abortSubmission`.
- [x] 3.5 Saved memory leaves Mastra working memory for its own table `niaro_saved_memory`, with a one-time move of existing payloads (D14); knowledge and attachments never lived in Mastra and need no move.
- [ ] 3.6 Refine route model metadata (context window per route) for compaction.
- [ ] 3.7 Crash scenarios for chat delivery; spec deltas for `chat`, `chat-delivery` and `agent-runtime`.
- [ ] 3.9 Old Mastra threads stay readable until wave 4; sending in one starts a Pi conversation in the same entry with a note (design D11).
- [x] 3.10 The single-call Mastra agents (meeting analysis, profile extraction, widget fill, catalog enrichment, quiet agent) are plain calls to our provider (`model-call.ts`, D13); saved memory is storage and moves with 3.5.
- [x] 3.11 Step A (D12): `NIARO_AGENT_CORE=mastra|pi` switch (profile `agentCore`); `createPiAgentRuntime` on the core with the `niaro-native` provider bridging every request to the bound session; approvals and questions wait inside the tool with a `niaro.pending` memo, across requests and restarts; one conversation per thread, forked when a suspension keeps it busy; `inspect` projects Pi entries without internal states; Pi runtime tests in `tests/pi-native-agent.node.ts`. The switch was removed in 3.13.
- [x] 3.12 Step B: process agent steps (`process-agent-runtime.ts`) and the designer on `createPiAgentRuntime`, with saved process agents' question proofs as Pi state; rewrite the child crash tests as Pi scenarios; `test:identity:pi` (D13).
- [x] 3.13 Step C (D14): a chat turn stopped by a restart waits for its own request and continues on Pi (policy A, `restartLimit` counts crashes, not shutdowns); a storage-level purge of forgotten and deleted threads; Pi is the only agent core and the switch is gone.
- [ ] 3.8 Port the native agent runtime contract (`NativeAgentInput`: session, tools, approvals as `beforeTool` memos, `ask_user` questions, saved memory, structured output, budget caps via `agentCoreModelHost({ caps })`) onto Pi conversations, for chat and process agent steps together; replace the child proofs (`proveSuspended`, `proveRetired`, `proveQuestionRecovery`) with Pi task and conversation state; rewrite the child crash tests (`process-question-crash`, `process-owner-crash`) as Pi scenarios.

## 4. Wave 4: remove Mastra and libSQL (NIAR-305)

- [ ] 4.1 Remove `@mastra/core`, `@mastra/memory`, `@mastra/libsql`, `@libsql/client`, `ai` and `@ai-sdk/provider` and the code that adapts them (`apps/server-agent/runtime.ts`, `recovery.ts`, `apps/server-identity/mastra-*.ts`, `apps/server-integrations/mastra-model.ts`), and the Mastra dataset and experiment stores of the contract and native test runners (`process-testing.ts`, `process-native-experiment.ts`).
- [ ] 4.2 One-time cleanup: drop `identity.sqlite.mastra.sqlite` and conversation and process rows that point into it; the server opens existing data (D9).
- [ ] 4.3 Backup, restore and legacy inventory know `identity.sqlite.pi.sqlite` instead of the Mastra store.
- [ ] 4.4 Remove the Mastra crash tests superseded by Pi scenarios; update `docs/architecture.md`, guides and specs.
- [ ] 4.5 Raise the repository `engines` to Node 22.19 (Pi's minimum).
