# Tasks

## 1. Wave 1: foundation (NIAR-302)

- [x] 1.1 Add `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-schema` 1.5.0 (exact) to `@niaro/server-agent`; drop pi-ai's vendor SDKs with pnpm overrides; export `@niaro/server-agent/pi`.
- [x] 1.2 `PiAgentCore` over `node:sqlite` (`0600`), policy A settings, binding extension, `createConversation(scope, route)`, `close()` (design D2, D7).
- [x] 1.3 Identity lifecycle: `openAgentCore()` on start at `<identity directory>/agent-core.sqlite`, resume, close before the identity database; reports logged as kinds only.
- [x] 1.4 Niaro Pi provider over the integration transport: route keys as models, catalog selection per request, fallback, streaming text, tool calls with server ids, usage mapping, retryable and non-retryable error codes (D3, D4).
- [x] 1.5 Identity call plan: `selectRoute`, `budgetedInferenceTransport`, `useProvider` in the dispatch guard, `fallbackAfter`, display price (D6).
- [x] 1.6 Write tools for policy A: `idempotentWriteTool`, `interruptibleWriteTool` (D7).
- [x] 1.7 Tests with a fake transport (`tests/pi-agent-core.node.ts`): role resolution and policy change, budget refusal before dispatch, settlement, retry counted once per attempt, fallback, missing scope, no SDK or `fetch` path, private reopenable file, streaming.
- [x] 1.8 Crash harness (`tests/helpers/pi-crash.ts`) and wave 1 scenarios (`tests/pi-crash.node.ts`): killed streamed call, killed keyed write, killed unkeyed write (D8).
- [x] 1.9 Architecture note on Pi, policy A and the upgrade rule (`docs/architecture.md`).

## 2. Wave 2: processes (NIAR-303)

- [ ] 2.1 Compile frozen process definitions to Pi tasks (`defineTask` phases, child tasks with `failFast`/`allSettled`, `sleepUntil`) instead of Mastra workflows; keep the compiler's validation.
- [ ] 2.2 Process agents as Pi conversations with scope `niaro.scope` and the process's frozen caps (`agentCoreModelHost` `caps`), one budget root run per process run.
- [ ] 2.3 Approvals and human tasks as durable memos plus a decisions document (spike Q2/Q3c); expiry as a hook timeout; pending approvals listed from `harness.inspect()`.
- [ ] 2.4 Every process write through `idempotentWriteTool` where the service supports a key, otherwise `interruptibleWriteTool`.
- [ ] 2.5 Process history, console, detail and work items read from Pi task records and documents.
- [ ] 2.6 Rewrite the process crash tests as Pi crash harness scenarios (killed in a phase, in an approval wait, between child tasks).
- [ ] 2.7 Spec deltas for `process-execution` and `process-qualification`.

## 3. Wave 3: chat (NIAR-304)

- [ ] 3.1 Chat turns as Pi conversations per thread: services listing as a prompt section, call-by-name actions as Pi tools, model presets via `provider.route("preset:<id>")` before submit.
- [ ] 3.2 Checker, answer checks and visible-reply rules as `beforeTool`, `onYield` and `afterResponse` hooks; escalation as a route.
- [ ] 3.3 Member projection: stream answers to web and phone from Pi's conversation watch; hide failed attempts, interrupted tool results, aborted partials and harness errors; sent text never returns to the composer.
- [ ] 3.4 Submissions by `requestId` for delivery retries; interruption and cancel through `abortSubmission`.
- [ ] 3.5 Saved memory, knowledge and attachments re-homed as Pi tools and documents.
- [ ] 3.6 Refine route model metadata (context window per route) for compaction.
- [ ] 3.7 Crash scenarios for chat delivery; spec deltas for `chat`, `chat-delivery` and `agent-runtime`.

## 4. Wave 4: remove Mastra and libSQL (NIAR-305)

- [ ] 4.1 Remove `@mastra/core`, `@mastra/memory`, `@mastra/libsql`, `@libsql/client`, `ai` and `@ai-sdk/provider` and the code that adapts them (`apps/server-agent/runtime.ts`, `recovery.ts`, process workflow and checkpoint code, `apps/server-identity/mastra-*.ts`, `apps/server-integrations/mastra-model.ts`).
- [ ] 4.2 One-time cleanup: drop `identity.sqlite.mastra.sqlite` and conversation and process rows that point into it; the server opens existing data (D9).
- [ ] 4.3 Backup, restore and legacy inventory know `agent-core.sqlite` instead of the Mastra store.
- [ ] 4.4 Remove the Mastra crash tests superseded by Pi scenarios; update `docs/architecture.md`, guides and specs.
- [ ] 4.5 Raise the repository `engines` to Node 22.19 (Pi's minimum).
