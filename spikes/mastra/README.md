# Niaro / Mastra prototype

An isolated, runnable evaluation of one native Mastra runtime. This package does
not change the reference server, mobile app, routing or existing Niaro data.

Requires Node 22.13+ and pnpm 12.4.2. From the repository root:

```sh
pnpm --dir spikes/mastra install --frozen-lockfile
cd spikes/mastra
npm run typecheck
npm test
npm run demo
```

`npm run` uses the installed tools without another pnpm dependency reconciliation.
The test runner and demo start new local Node processes. An execution sandbox
must permit child processes; an EPERM result is not a passing recovery test.
The demo prints its temporary fixture directory, which can be removed afterward.
Tests remove their own fixtures. Node 22 currently reports an experimental SQLite
warning. No API key, network provider, embedding model or production profile is used.

| Owner                                                | Responsibilities exercised here                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Mastra Agent + tools                                 | Native model/tool loop and typed tool suspension/resume                                                  |
| Mastra Memory + LibSQL                               | Conversation history, resource/task separation and restart persistence                                   |
| Mastra Goals (beta)                                  | Persistent objective, deterministic receipt-based completion and run budget                              |
| Mastra Workflow                                      | Independent prepare/review checkpoint fixture; completed prepare step is not repeated                    |
| Actual Niaro CatalogController / ServiceCatalogStore | Exact proposals, current actor/policy checks, durable approval/rejection and terminal operation receipts |
| Synthetic provider                                   | Persistent TEST people; response loss after dispatch; dispatch count                                     |

The model is a stateless AI SDK fixture. It emits tool calls from JSON commands
and reads their results from the actual prompt history; it is not a replacement
agent loop. `remember`/`recall` demonstrate native conversation history only.
They do not implement Niaro long-term memory edits or retrieval.

The authenticated-server facade binds actor, task and expected operation outside
model arguments. A write prepares an actual Niaro receipt, then suspends the
native Agent. A human answer resumes that exact tool call, with current Niaro
authorization checked again. Repeated pending commands reuse the existing
approval; terminal replay performs neither inference nor dispatch. A lost write
response remains `unknown`, is never resent, and can be verified read-only.
Rejecting an approval persists `rejected`. Mastra deletes the finished suspension
snapshot; the separate Niaro business receipt remains authoritative.

`mastra.sqlite` owns native history/objectives/checkpoints. `niaro.sqlite` owns
synthetic policy and actual Niaro receipts. `provider.sqlite` owns TEST provider
effects. The databases are separate because a provider effect is not a local
checkpoint transaction. No exactly-once or cross-database atomicity is claimed.

The scope fixture grants one TEST actor. Recovery tests reconstruct everything
in separate, cleanly terminated OS processes; they do not yet inject SIGKILL at
every receipt/checkpoint boundary. The standalone workflow fixture exercises
native checkpoint APIs without business writes or authenticated wire routing.
Concurrent starts, source expiry, memory revisions/opt-out, personal OAuth pins,
real model quality, streaming reconnect and mobile/HTTP integration remain for
the migration. The deterministic goal scorer evaluates the expected TEST write
receipt; it does not judge arbitrary natural-language objectives.

Pins: core 1.74.0, memory 1.35.0, libSQL 1.25.0, AI SDK 7.0.127, Zod 4.6.5;
the standalone lockfile keeps these dependencies out of Expo. Goals and durable
agent APIs are beta. This spike uses native Agent suspension plus a separate
workflow checkpoint probe, not `createDurableAgent` or Redis-backed streaming.
Observability/exporters are not configured; input/output tracing is suppressed.

See the [integration design](../../docs/mastra-integration.md) for the replacement
map, required policy transfer and cutover criteria. Prototype results do not
stand in for production acceptance.

Validation, October 2, 2026: all 19 fixture/domain/native recovery tests passed
on the host, along with standalone and application TypeScript, targeted ESLint,
formatting and package boundaries.

Primary API references: [Agent approvals](https://mastra.ai/docs/agents/human-in-the-loop),
[memory](https://mastra.ai/docs/memory/overview),
[workflow snapshots](https://mastra.ai/docs/workflows/snapshots),
[Goals](https://mastra.ai/docs/harness/goals),
[durable agents](https://mastra.ai/docs/harness/durable-agents).
