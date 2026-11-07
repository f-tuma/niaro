# NIAR-301 results: Pi Durable as Niaro's durable agent core

Date: 2026-11-07. Versions: `@earendil-works/pi-durable` 1.5.0, `pi-ai` 1.5.0 (both released 2026-11-02), Node 22.23.4.
All four questions have runnable evidence; every check in the captured runs passed (Q1 7/7, Q2 13/13, Q3 25/25;
Q3 was run 4 times with the same result). Items marked **(unverified)** were read from docs or code, not run.

**Recommendation: adopt later, with conditions** (see the end). Pi covers what our hand-written durability layer does,
with much less code, and our policy fits its hooks. Against adopting now: its API is still breaking every release,
its recovery policy differs from ours, and the port is large.

---

## Q1 — Providers and model roles

**Finding: yes.** A Pi harness takes its provider and model from a runtime config object. Nothing is hardcoded.

- `src/niaro-provider.ts` turns a Niaro-shaped provider row into a pi-ai `Provider` with `createProvider()`.
  The row carries a base URL, an auth type (`none` / `bearer` / `header:<name>`), a dialect, the unsealed key, extra
  headers and catalog models. It speaks pi-ai's `openai-completions` API. The model's pi id is the Niaro catalog id,
  so a role-policy entry maps 1:1 to a Pi `ModelRef`. A small stream wrapper renames it to the upstream model name on
  the wire.
- Auth styles work: bearer; the key in a named header with `Authorization` suppressed (Azure's `api-key`); and no
  auth for local servers. Custom headers reach the server (`x-niaro-workspace`), and `max_tokens` follows the
  catalog's ceiling. The stub server checked each of these.
- Model choice per conversation is `conversation.configure({ model })`. The change applies from the next request:
  run 1 went to gateway/`vendor/model-a`, run 2 to azure/`deployment-b`. Role calls outside the chat loop
  (checker, selector) resolve the role in our code, here through Niaro's real `ROLE_DEFAULTS` (checker → selector),
  and call `models.completeSimple(model, …)` directly.
- **Real round trip through OpenRouter:**
  - The provider, its key and the model came from the dev identity DB. The key was unsealed in-process
    (HKDF + AES-GCM, the same scheme as `service-catalog.ts`) and never printed.
  - The model is the organization's `roles.chat.models[0]`, which resolves to `openai/gpt-6-luna`.
  - The model called `get_weather` once and answered "Prague is 12°C and cloudy." in about 2 s.
  - Usage: 149 input / 32 output tokens. pi-ai computed a cost of **$0.000031** from its OpenRouter price catalog.
- Pi sends OpenRouter attribution headers naming "pi" by default. Set `HarnessOptions.identity` to override them
  (done in the spike).

Gaps and notes:
- Prices. Niaro's price table is the source of truth. The spike borrowed pi-ai's built-in OpenRouter prices for the
  real run. In production our provider factory would set `model.cost` from `agent_inference_policy`.
- Not tested **(unverified)**: audio roles (voice_input, speech, transcription), embeddings, the OpenRouter decisions
  API (Jev) and the web plugin. pi-ai lists a `typesafe` classifier provider and image models, but Niaro calls those
  through its own transports. Expect them to stay outside Pi.
- The real call did not go through `useProvider()`, so the provider's daily request counter was not incremented.
  Production would call our quota check inside the provider wrapper, like the budget gate.

<details><summary>Q1 output (<code>pnpm q1</code>)</summary>

```text
$ pnpm q1   # 2026-11-07T09:53:22+01:00

=== Q1-A: arbitrary OpenAI-compatible base URLs, auth styles, custom headers, per-run model ===
  pi.user [user] "Find Ada"
  pi.assistant [assistant] toolCall lookup_contact({"name":"Ada"}) stop=toolUse
  pi.tool-result [toolResult:lookup_contact] "Ada Lovelace, ada@example.test"
  pi.assistant [assistant] "Stub answer from vendor/model-a: Ada Lovelace, ada@example.test" stop=stop
  pi.user [user] "Find Ada again"
  pi.assistant [assistant] toolCall lookup_contact({"name":"Ada"}) stop=toolUse
  pi.tool-result [toolResult:lookup_contact] "Ada Lovelace, ada@example.test"
  pi.assistant [assistant] "Stub answer from deployment-b: Ada Lovelace, ada@example.test" stop=stop
  stub saw:
    /gateway/v1/chat/completions model=vendor/model-a authorization=Bearer <redacted> api-key=- x-niaro-workspace=ws-123 tools=lookup_contact max_tokens=256
    /gateway/v1/chat/completions model=vendor/model-a authorization=Bearer <redacted> api-key=- x-niaro-workspace=ws-123 tools=lookup_contact max_tokens=256
    /azure/openai/v1/chat/completions model=deployment-b authorization=- api-key=<set> x-niaro-workspace=- tools=lookup_contact max_tokens=128
    /azure/openai/v1/chat/completions model=deployment-b authorization=- api-key=<set> x-niaro-workspace=- tools=lookup_contact max_tokens=128
PASS run 1 answered
PASS run 2 answered
PASS gateway: bearer key + custom header + wire model name
PASS azure-style: key in api-key header, bearer suppressed — authorization=absent,authorization=absent
  checker role -> cat-model-c (chat) path=/local/v1/chat/completions model=llama-local authorization=- stop=toolUse
PASS keyless local provider: no Authorization header

=== Q1-B: real OpenRouter tool-calling round trip from the dev identity DB ===
  provider: OpenRouter url=https://openrouter.ai/api/v1 dialect=openrouter auth=bearer key=<loaded, 73 chars>
  chat model: catalog c372e421-f47d-4cd3-9197-81d8d143876c -> openai/gpt-6-luna (model chosen by the organization's role policy: roles.chat.models[0]) price/Mtok in=0.1 out=0.5
  settled: done in 1965 ms
  pi.user [user] "Call get_weather for Prague, then answer in one short sentence."
  pi.assistant [assistant] toolCall get_weather({"city":"Prague"}) stop=toolUse
  pi.tool-result [toolResult:get_weather] "Prague: 12 °C, cloudy"
  pi.assistant [assistant] "Prague is 12°C and cloudy." stop=stop
  pi.usage 22323dab-0732-4e6a-8eae-6f9b9eb204f5/openai/gpt-6-luna: input=149 output=32 cacheRead=0 cost.total=$0.000031
PASS real OpenRouter run answered
PASS tool executed exactly once — calls=1
```
</details>

---

## Q2 — Hooks for our policy

All of it is implemented in `src/policy.ts` on a fake notes service: `read_contact` reads and `write_note` writes
a side effect into our own SQLite file.

| Policy | How it maps onto Pi | Result |
|---|---|---|
| Approval before a write | A `ToolTask.beforeTool` hook runs before Pi records the call's intent. It stores the request as a durable task memo (`api.memo("niaro.approval", …)`, first writer wins), then waits until a decision appears in our conversation document `niaro.approvals`. A rejection returns `{ block }`. | Approve: the write runs once, after the decision. Reject: the model gets an error result `Tool call blocked: rejected by user-ada: not now`, and the write never runs. Pending approvals can be listed from storage alone through `harness.inspect()` → `record.memos` (also after a restart, Q3c). |
| Service access | The same `beforeTool` hook reads the member from the conversation document `niaro.member` and checks our access table. | An administrator revoked `notes.read` mid-conversation. The next call was refused before `execute()` (execute count stayed 1), and the model saw `access_denied …`. The production setup would also narrow `configure({ tools })` so the model never sees tools it cannot use. The hook is the authoritative check. |
| Hard budget per run | No Pi hook can stop a model request: a throwing `beforeRequest` is only reported and skipped. So the gate wraps the provider's `stream`/`streamSimple`. Before each call it reserves a conservative estimate (serialized bytes + 1024 tokens of input, plus the full output ceiling, priced per token) against the run's cap. Over the cap, it returns an assistant error `budget_exhausted: …`. After the response it settles the actual usage, or marks the attempt `unknown` so its hold stays. The run key is the run's first submission id (`pi.live.run.inputs[0]`). A `beforeRequest` hook records it per provider `sessionId`, because the provider only receives `sessionId`. | Call 1: reserved 2404 µ$, settled 28 µ$. Call 2: 28 + 3071 > 3000 → refused before dispatch. The run ended `unanswered` with `model_error`, with no retry (the message matches no retryable pattern). `pi.live.runFailure` carries the detail. Q3a shows a request killed mid-stream keeping its hold. |

**What Pi's own usage tracking gives us:**
- Per-conversation totals in `pi.usage`, keyed by provider/model and by tool, updated in the same commit as the
  response.
- Failed and aborted attempts count too, and `harness.usage()` gives the session total.
- pi-ai computes cost from `model.cost`, as seen in the real OpenRouter run.

**What we must keep ourselves**, i.e. `inference-budget.ts`:
- Reservations and holds, caps, and enforce mode.
- Price revisions per model and provider, and per-run accounting.
- "Unknown usage keeps its hold", and positive proof that a call was never dispatched.

Pi has none of these. Also, a stream killed within its first ~1 s may leave no usage record at all, because progress
is stored deferred: 1.5.0 changelog and `persistWithinMs`.

Two smaller findings:
- The faux provider reports zero cost. pi-ai's `calculateCost()` fills `message.usage.cost` in place, and our settle
  callback runs before Pi records the message, so `pi.usage` showed our tariff cost (28 µ$ in both places).
- **Member UI:** Pi writes internal states into the transcript. Examples: `<harness>[error] Tool call blocked: …`
  tool results, a `stopReason=error` assistant entry for the refused call, and `stopReason=aborted` partials (Q3a).
  Under our "no internal states in member UI" rule, the projection to clients must filter or translate them.

<details><summary>Q2 output (<code>pnpm q2</code>)</summary>

```text
$ pnpm q2   # 2026-11-07T09:59:35+01:00

=== Q2.1 approval: write waits for a durable decision, approve ===
  pending approval: {"callId":"call_324051_1","tool":"write_note","arguments":{"text":"buy milk"},"requestedAt":1794041976090}
  durable memo on the tool task (harness.inspect): {"niaro.approval":{"callId":"call_324051_1","tool":"write_note","arguments":{"text":"buy milk"},"requestedAt":1794041976090}}
  write executed before decision: 0
PASS write does not run while waiting
  pi.user [user] "write buy milk"
  pi.assistant [assistant] toolCall write_note({"text":"buy milk"}) stop=toolUse
  pi.tool-result [toolResult:write_note] "Saved note \"buy milk\"."
  pi.assistant [assistant] "Done: Saved note \"buy milk\"." stop=stop
PASS approved write executed once
PASS run answered once

=== Q2.2 approval: reject ===
  pi.user [user] "write delete everything"
  pi.assistant [assistant] toolCall write_note({"text":"delete everything"}) stop=toolUse
  pi.tool-result [toolResult:write_note] "<harness>\n[error] Tool call blocked: rejected by user-ada: not now\n</harness>" isError
  pi.assistant [assistant] "The tool failed: <harness>\n[error] Tool call blocked: rejected by user-ada: not now\n</harn" stop=stop
PASS rejected write not executed
PASS model got an error result naming the rejection

=== Q2.3 access: member loses access to a service mid-conversation ===
  pi.user [user] "read Ada"
  pi.assistant [assistant] toolCall read_contact({"name":"Ada"}) stop=toolUse
  pi.tool-result [toolResult:read_contact] "Ada: ada@example.test"
  pi.assistant [assistant] "Done: Ada: ada@example.test" stop=stop
  pi.user [user] "read Bob"
  pi.assistant [assistant] toolCall read_contact({"name":"Bob"}) stop=toolUse
  pi.tool-result [toolResult:read_contact] "<harness>\n[error] Tool call blocked: access_denied: user-ada may not use notes.read\n</harn" isError
  pi.assistant [assistant] "The tool failed: <harness>\n[error] Tool call blocked: access_denied: user-ada may not use " stop=stop
PASS first read executed, second refused before execute()
PASS refusal reported to the model as a blocked tool result

=== Q2.4 hard budget: reserve before each call, refuse over the cap, settle after ===
  pi.user [user] "read Ada"
  pi.assistant [assistant] toolCall read_contact({"name":"Ada"}) stop=toolUse
  pi.tool-result [toolResult:read_contact] "Ada: ada@example.test"
  pi.assistant [assistant]  stop=error error="budget_exhausted: accounted 28 + reservation 3071 > cap 3000 micro-USD"
  settled: unanswered reason=model_error
  pi.live.runFailure: {"taskId":15,"inputs":[9],"reason":"model_error","detail":"budget_exhausted: accounted 28 + reservation 3071 > cap 3000 micro-USD","first":8}
  our ledger (attempt rows):
    {"id":1,"run_key":"9","model":"faux/scripted","status":"settled","reserved_micros":2404,"cost_micros":28,"input_tokens":116,"output_tokens":7}
    {"id":2,"run_key":"9","model":"faux/scripted","status":"refused","reserved_micros":3071,"cost_micros":null,"input_tokens":null,"output_tokens":null}
  pi.usage: {"faux/scripted":{"input":0,"output":7,"cacheRead":0,"cacheWrite":116,"totalTokens":123,"cost":{"input":0,"output":0.000028,"cacheRead":0,"cacheWrite":0,"total":0.000028,"totalFromProvider":false}}}
PASS first call reserved+settled with actual cost
PASS second call refused before dispatch
PASS tool still ran once (the refused call was the follow-up model call)
PASS run ends unanswered with model_error, not retried
PASS Pi usage counts the settled call's tokens — pi=123 ours=123
PASS Pi usage cost equals our settled cost — pi=28.0 ours=28
```
</details>

---

## Q3 — Crash scenarios (real SIGKILL, fresh process on the same SQLite storage)

`scripts/q3-crash.ts` spawns `node --import tsx scripts/q3-child.ts <scenario> start`, waits for a `MARK` line,
sends **SIGKILL** to that child, then starts `resume` in a new process on the same `pi.sqlite`, opened with
`openNodeSqliteStorage`. The model is pi-ai's faux provider with a response factory that decides only from the
context, so runs are deterministic and a resumed process continues where the old one stopped.

| Scenario | What happened after the restart | Verdict |
|---|---|---|
| **a) killed during a model request**, 1.5 s into a slow stream | Pi counted the interrupted request as a failed attempt. The partial answer was kept as an `aborted` assistant entry and left out of the model context. Pi retried after the backoff, and the run completed. | ✅ One final reply and one user entry. ⚠️ The aborted partial is a transcript entry, so our UI must hide it or mark it. Our ledger kept the killed attempt's reservation as a hold (`dispatched`), and the retry settled. |
| **b) killed after the write's side effect, before its result was committed**, default `replay: "unsafe"` | Pi did not run the tool again. It wrote the error result `Tool write_note was interrupted and may have partially run`. The scripted model, like a real one, then retried with a **new** tool call, which went through approval again. | ✅ With an idempotency key derived from the call content (conversation + tool + arguments), the retry found the existing effect: **side effect executed once**. |
| b′) same crash, no stable key (control) | Same flow. | ❌ by design: **two side effects**. This shows the key is ours to provide; Pi only says "may have partially run". |
| b″) same crash, `replay: "safe"` + key = Pi task id | Pi ran `execute()` again with the same task id, and our store deduplicated it. The model saw the normal result, with no interruption. | ✅ Side effect executed once. This is the better pattern for writes whose provider supports idempotency. |
| **c) killed while waiting for approval** | Before scheduling anything, `harness.inspect()` showed the tool task as `pending` with its `niaro.approval` memo, straight from storage. After `resume()` the hook ran again and got the **same** memo (same `requestedAt`), and nothing executed. Approving continued the run. | ✅ Approval still pending after the restart; the write ran exactly once after approval. |
| **d) duplicate submission, same `requestId`** | Two concurrent submits returned the same submission id. After the SIGKILL, the client resubmitted with the same id and got the original submission. | ✅ One user entry, one final answer. |

<details><summary>Q3 output (<code>pnpm q3</code>)</summary>

```text
$ pnpm q3   # 2026-11-07T09:59:36+01:00

=== Q3 a) killed during a model request (streaming) ===
  [start pid 324148] MARK submitted {"id":9}
  [start pid 324148] MARK streaming {}
  [parent] SIGKILL pid 324148 (1500 ms after "streaming")
  [parent] start process ended: code=null signal=SIGKILL
  [resume pid 324237]   ledger before resume: [{"id":1,"run_key":"9","model":"faux/scripted","status":"dispatched","reserved_micros":2413,"cost_micros":null,"input_tokens":null,"output_tokens":null}]
  [resume pid 324237]   submission 9: done
  [resume pid 324237]   pi.user [user] "tell a long story"
  [resume pid 324237]   pi.assistant [assistant] "word0 word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 wo" stop=aborted
  [resume pid 324237]   pi.assistant [assistant] "word0 word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 wo" stop=stop
  [resume pid 324237]   ledger after: [{"id":1,"run_key":"9","model":"faux/scripted","status":"dispatched","reserved_micros":2413,"cost_micros":null,"input_tokens":null,"output_tokens":null},{"id":2,"run_key":"9","model":"faux/scripted","status":"settled","reserved_micros":2413,"cost_micros":412,"input_tokens":119,"output_tokens":103}]
  [resume pid 324237] PASS a: resumed run completes
  [resume pid 324237] PASS a: exactly one final reply — assistant stops=aborted,stop
  [resume pid 324237] PASS a: partial answer kept as an aborted entry (the UI must hide or mark it) — aborted=1
  [resume pid 324237] PASS a: one user entry
  [resume pid 324237] PASS a: the killed request's reservation stays as a hold (status dispatched), the retry settles
  [parent] resume process ended: code=0

=== Q3 b) killed after write side effect, before result commit — replay unsafe (Pi default) + content idempotency key ===
  [start pid 324249] MARK submitted {"id":9}
  [start pid 324249] MARK side_effect_done {}
  [parent] SIGKILL pid 324249 (1300 ms after "side_effect_done")
  [parent] start process ended: code=null signal=SIGKILL
  [resume pid 324282]   side effects before resume: [{"idempotency_key":"content:dbe798a9be82ebb4","text":"pay invoice 42","executions":1}]
  [resume pid 324282]   submission 9: done
  [resume pid 324282]   pi.user [user] "write pay invoice 42"
  [resume pid 324282]   pi.assistant [assistant] toolCall write_note({"text":"pay invoice 42"}) stop=toolUse
  [resume pid 324282]   pi.tool-result [toolResult:write_note] "<harness>\n[error] Tool write_note was interrupted and may have partially run\n</harness>" isError
  [resume pid 324282]   pi.assistant [assistant] "That was interrupted; trying again." toolCall write_note({"text":"pay invoice 42"}) stop=toolUse
  [resume pid 324282]   pi.tool-result [toolResult:write_note] "Note \"pay invoice 42\" was already saved (idempotent replay)."
  [resume pid 324282]   pi.assistant [assistant] "Done: Note \"pay invoice 42\" was already saved (idempotent replay)." stop=stop
  [resume pid 324282]   side effects after: [{"idempotency_key":"content:dbe798a9be82ebb4","text":"pay invoice 42","executions":1}]
  [resume pid 324282]   our log:
  [resume pid 324282]     approval call_324249_1 approved
  [resume pid 324282]     write_note execute key=content:dbe798a9be82ebb4 executed=true
  [resume pid 324282]     approval call_324282_1 approved
  [resume pid 324282]     write_note execute key=content:dbe798a9be82ebb4 executed=false
  [resume pid 324282] PASS b-unsafe: run completes
  [resume pid 324282] PASS b-unsafe: model was told the write was interrupted
  [resume pid 324282] PASS b-unsafe: the model retried the write (new tool call)
  [resume pid 324282] PASS b-unsafe: content idempotency key: side effect executed once
  [parent] resume process ended: code=0

=== Q3 b') same crash, replay unsafe, NO stable idempotency key (control) ===
  [start pid 324294] MARK submitted {"id":9}
  [start pid 324294] MARK side_effect_done {}
  [parent] SIGKILL pid 324294 (1300 ms after "side_effect_done")
  [parent] start process ended: code=null signal=SIGKILL
  [resume pid 324355]   side effects before resume: [{"idempotency_key":"call:call_324294_1:0.06144084495702096","text":"pay invoice 42","executions":1}]
  [resume pid 324355]   submission 9: done
  [resume pid 324355]   pi.user [user] "write pay invoice 42"
  [resume pid 324355]   pi.assistant [assistant] toolCall write_note({"text":"pay invoice 42"}) stop=toolUse
  [resume pid 324355]   pi.tool-result [toolResult:write_note] "<harness>\n[error] Tool write_note was interrupted and may have partially run\n</harness>" isError
  [resume pid 324355]   pi.assistant [assistant] "That was interrupted; trying again." toolCall write_note({"text":"pay invoice 42"}) stop=toolUse
  [resume pid 324355]   pi.tool-result [toolResult:write_note] "Saved note \"pay invoice 42\"."
  [resume pid 324355]   pi.assistant [assistant] "Done: Saved note \"pay invoice 42\"." stop=stop
  [resume pid 324355]   side effects after: [{"idempotency_key":"call:call_324294_1:0.06144084495702096","text":"pay invoice 42","executions":1},{"idempotency_key":"call:call_324355_1:0.015435717169710816","text":"pay invoice 42","executions":1}]
  [resume pid 324355]   our log:
  [resume pid 324355]     approval call_324294_1 approved
  [resume pid 324355]     write_note execute key=call:call_324294_1:0.06144084495702096 executed=true
  [resume pid 324355]     approval call_324355_1 approved
  [resume pid 324355]     write_note execute key=call:call_324355_1:0.015435717169710816 executed=true
  [resume pid 324355] PASS b-none: run completes
  [resume pid 324355] PASS b-none: model was told the write was interrupted
  [resume pid 324355] PASS b-none: the model retried the write (new tool call)
  [resume pid 324355] PASS b-none: without a stable key the retry duplicates the side effect (the failure we must prevent) — effects=2
  [parent] resume process ended: code=0

=== Q3 b'') same crash, replay safe + per-task idempotency key ===
  [start pid 324406] MARK submitted {"id":9}
  [start pid 324406] MARK side_effect_done {}
  [parent] SIGKILL pid 324406 (1300 ms after "side_effect_done")
  [parent] start process ended: code=null signal=SIGKILL
  [resume pid 324467]   side effects before resume: [{"idempotency_key":"task:13","text":"pay invoice 42","executions":1}]
  [resume pid 324467]   submission 9: done
  [resume pid 324467]   pi.user [user] "write pay invoice 42"
  [resume pid 324467]   pi.assistant [assistant] toolCall write_note({"text":"pay invoice 42"}) stop=toolUse
  [resume pid 324467]   pi.tool-result [toolResult:write_note] "Note \"pay invoice 42\" was already saved (idempotent replay)."
  [resume pid 324467]   pi.assistant [assistant] "Done: Note \"pay invoice 42\" was already saved (idempotent replay)." stop=stop
  [resume pid 324467]   side effects after: [{"idempotency_key":"task:13","text":"pay invoice 42","executions":1}]
  [resume pid 324467]   our log:
  [resume pid 324467]     approval call_324406_1 approved
  [resume pid 324467]     write_note execute key=task:13 executed=true
  [resume pid 324467]     write_note execute key=task:13 executed=false
  [resume pid 324467] PASS b-safe: run completes
  [resume pid 324467] PASS b-safe: Pi re-ran execute() after restart (replay: safe)
  [resume pid 324467] PASS b-safe: no interrupted result; model sees the idempotent result
  [resume pid 324467] PASS b-safe: side effect executed once
  [parent] resume process ended: code=0

=== Q3 c) killed while waiting for approval ===
  [start pid 324481] MARK approval_pending {"callId":"call_324481_1","tool":"write_note","arguments":{"text":"transfer 100 EUR"},"requestedAt":1794041985576}
  [parent] SIGKILL pid 324481 (300 ms after "approval_pending")
  [parent] start process ended: code=null signal=SIGKILL
  [resume pid 324523]   scheduling=paused; pending approvals from storage: [{"task":13,"status":"pending","memo":{"callId":"call_324481_1","tool":"write_note","arguments":{"text":"transfer 100 EUR"},"requestedAt":1794041985576}}]
  [resume pid 324523] PASS c: approval still pending after restart
  [resume pid 324523] PASS c: still waiting after resume, nothing executed
  [resume pid 324523] PASS c: re-run hook got the same durable request (memo first-writer-wins)
  [resume pid 324523]   submission 9: done
  [resume pid 324523]   pi.user [user] "write transfer 100 EUR"
  [resume pid 324523]   pi.assistant [assistant] toolCall write_note({"text":"transfer 100 EUR"}) stop=toolUse
  [resume pid 324523]   pi.tool-result [toolResult:write_note] "Saved note \"transfer 100 EUR\"."
  [resume pid 324523]   pi.assistant [assistant] "Done: Saved note \"transfer 100 EUR\"." stop=stop
  [resume pid 324523] PASS c: approving continues the run
  [resume pid 324523] PASS c: write executed exactly once
  [parent] resume process ended: code=0

=== Q3 d) duplicate submission with the same requestId (concurrent, then again after a crash) ===
  [start pid 324553] MARK submitted {"first":9,"concurrentDuplicate":9}
  [parent] SIGKILL pid 324553 (400 ms after "submitted")
  [parent] start process ended: code=null signal=SIGKILL
  [resume pid 324565]   resubmitted after restart -> submission 9 (original 9)
  [resume pid 324565]   submission 9: done
  [resume pid 324565]   pi.user [user] "read Ada"
  [resume pid 324565]   pi.assistant [assistant] toolCall read_contact({"name":"Ada"}) stop=toolUse
  [resume pid 324565]   pi.tool-result [toolResult:read_contact] "Ada: ada@example.test"
  [resume pid 324565]   pi.assistant [assistant] "Done: Ada: ada@example.test" stop=stop
  [resume pid 324565] PASS d: same requestId returns the original submission
  [resume pid 324565] PASS d: processed once (one user entry, one final answer)
  [resume pid 324565] PASS d: run done
  [resume pid 324565]   read_contact executions in this process: 1
  [parent] resume process ended: code=0

Q3 done: all checks passed
```
</details>

---

## Q4 — Migration estimate

Read: `mastra-domain.ts` (7,446 lines), `server-agent/runtime.ts` (2,294), `recovery.ts` (1,199), `process-runtime.ts`
(364), `inference-budget.ts` (918), and the related `server-identity/mastra-runtime.ts` (1,871),
`process-workflow.ts` + `process-checkpoint.ts` (829), `mastra-model.ts` (498), `process-agent-runtime.ts` +
`process-approval.ts` (1,051), and the crash tests (8 files, 3,138 lines). Line counts below are **rough estimates from
reading the structure**, not from a port.

### Pi replaces vs. we keep

| Area (today) | Lines | With Pi | Delete | Port / new |
|---|---:|---|---:|---:|
| Mastra `Agent`/`DurableAgent` wiring, tool-input envelopes and reserved keys, opaque transcript projection, checkpoint observation (`server-agent/runtime.ts`) | 2,294 | Pi `Harness`, the generation/tool tasks and the transcript | ~1,500 | ~600: `call_action` dispatch as a `beforeRequest`/`beforeProviderRequest` hook or a provider wrapper (unverified), route and fallback receipts, mapping `watch()` to our draft/tool events |
| Proofs over Mastra snapshots: retirement, question suspension, orphan recovery (`recovery.ts`) | 1,199 | Pi task states, memos, `inspect()`, submissions by `requestId` | ~1,000 | ~200: run binding and retirement record |
| Native owner, store lifecycle, inspection, interruption (`server-identity/mastra-runtime.ts`) | 1,871 | Harness open/close/`closed`, abort, `onReport` | ~1,100 | ~700: publication rules, interruption reasons, attachment purge |
| Processes as Mastra workflows + checkpoint proofs (`process-runtime.ts`, `process-workflow.ts`, `process-checkpoint.ts`) | 1,193 | `defineTask` phases, child tasks (`failFast`/`allSettled`), `sleepUntil`; the DAG compiles to tasks | ~300 | ~500 new task definitions; ~400 compile logic kept |
| Model selection over Mastra models (`mastra-model.ts`) | 498 | pi-ai providers built from the catalog (`src/niaro-provider.ts` is ~100 lines) | ~300 | ~200 kept: route choice, receipts |
| Approvals: process agent and process approval (`process-agent-runtime.ts`, `process-approval.ts`) | 1,051 | `beforeTool` + memo + approvals document (Q2/Q3c) | ~500 | ~200 |
| Business domain (`mastra-domain.ts`): service selector, checker/decisions, finalize and visible-reply rules, human tasks, hubs, skills, memory tools, attachments, threads | 7,446 | Stays ours, re-homed as `defineTool`s and hooks: `beforeTool` for the write checker; `onYield`/`afterResponse` for answer checks and visible replies (unverified); `afterRun` for after-run work | ~2,000: Mastra state persistence and checkpoint authority, legacy question and continuation paths | ~1,000 of tool definitions moved; ~4,500 kept as is |
| Budget ledger (`inference-budget.ts`) | 918 | **Keep entirely**; it gets called from a provider wrapper (Q2) | 0 | ~80 |
| Saved memory / memory runtime | — | **Keep**. Pi has conversations and compaction, not semantic memory; Mastra memory threads become Pi conversations | small | small |
| Crash tests (`tests/*crash*.node.ts`) | 3,138 | Most of them prove Mastra snapshot behaviour; rewrite them as Pi-level scenarios (`scripts/q3-*.ts` is a ~240-line template) | ~2,000 | ~900 |
| **Total (rough)** | | | **~8,700** | **~4,300 new/changed**; ~6,000 kept |

The integration surface is 13 non-test files that import `@niaro/server-agent`.

### Blockers and risks

1. **Experimental API.** The README says "The API changes without notice between releases."
   - 18 versions since 2026-09-19.
   - Breaking changes in 6 of the 10 changelogged releases, **34 of them in 1.5.0** (2026-11-02), e.g. `Storage.commit`,
     watches and the shape of the conversation view.
   - We would pin exact versions and absorb churn on every upgrade, or freeze on one version.
2. **Recovery policy differs.**
   - Niaro does passive recovery on purpose: it proves the state and fails closed, with no inference on recovery and
     no unscoped boot-time recovery (`recovery.ts`, `mastra-native-fatal-crash`).
   - Pi's `resume()` is session-wide. It runs every pending task and **retries interrupted model requests**, which
     costs money again.
   - Matching our policy needs `retry`/`restartLimit` settings or aborting orphaned runs at open. This is a product
     decision, not a technical blocker.
3. **One process per storage, with no cross-process locking.** Today we run one server with `server-lock.sqlite`, so
   this fits. Horizontal scaling would need storage sharded per organization or workspace, i.e. several Harnesses.
4. **No shared transaction with our DB.**
   - Pi's node storage is `node:sqlite` (through Chord), the same driver as the identity DB. It would replace
     `@mastra/libsql`/`@libsql/client`.
   - It still uses its own connection, so our receipts and ledger never commit atomically with Pi's transcript.
   - Pi supports a table `prefix` for sharing one file, but only if every host query goes through its async adapter.
     Our synchronous `DatabaseSync` code does not.
   - So either business state moves into Pi documents and memos, which commit atomically, or every write needs an
     idempotency key (b/b′/b″ show why).
5. **The budget relies on a side channel.** The provider sees only `sessionId`; the run key goes through a map filled
   by a `beforeRequest` hook. It works because a conversation has one run at a time, but it is not a Pi contract.
   Pi's usage record has no holds or caps.
6. **Approvals hold a live invocation.** Each pending approval keeps a polling hook and keeps the conversation busy;
   follow-ups queue. This is correct across restarts (Q3c). How it behaves with many approvals left open for hours
   (`NATIVE_TASK_EXPIRY_MS`) is **unverified**. An expiry would be a timeout in the hook.
7. **Internal states in the transcript.** Aborted partials, harness error results and budget errors must be filtered
   in our client projection.
8. **Provider gaps (unverified):** audio, embeddings, the decisions API and the web plugin stay on our own transports.
9. **Node and dependencies.**
   - Pi requires Node ≥ 22.19. The Docker image is 22.23.3, but the repo `engines` (≥ 22.13) needs a bump.
   - pi-ai pulls the SDKs of every vendor it supports (openai, anthropic, google-genai, aws bedrock; 100 packages and
     150 MB in this spike). They load lazily but are installed.
   - The build scripts of `@google/genai` and `protobufjs` were denied here.

---

## Recommendation: **adopt later, with conditions**

**For Pi:**
- Every crash scenario we care about worked with little code on our side: a killed request, a killed write, a killed
  approval wait, and duplicate submission.
- Our policy maps onto documented extension points: the approval memo, the access check, and the budget gate around
  the provider.
- About 8–9k lines of Mastra adaptation and snapshot-proof code could go.
- Providers and roles stay fully configuration-driven.

**Against adopting now:**
- The upstream API is still volatile (34 breaking changes in the release from five days ago).
- Its recovery model resumes and retries by default, while Niaro's is passive and fail-closed.
- The port touches the most delicate parts: visible replies, the checker, threads, and processes.

Doing that in the pilot alongside product work is a large bet on an experimental dependency.

**Conditions for adopting:**
1. **API stability.** Pi publishes a stability commitment, or several consecutive releases pass without breaking
   changes. Until then we pin exact versions.
2. **The owner decides the recovery policy:** keep passive and fail-closed, using Pi settings and aborting orphans at
   open, or accept Pi's automatic resume with charged retries.
3. **A time-boxed chat-path prototype in a branch:**
   - `call_action` dispatch with prompt-cache behaviour kept;
   - streaming the conversation view to the web and mobile clients;
   - visible-reply and answer-check rules in `onYield`/`afterResponse`.
   These are the main unverified parts.
4. **Business state with an atomic home.** Business receipts that must commit with the transcript move into Pi
   documents. Every external write gets an idempotency key, using the `replay: "safe"` + task-id pattern (b″) where
   the provider allows it.

If the owner wants to move sooner, the lowest-risk first step is **processes**. They are self-contained Mastra
workflows that map directly onto `defineTask` and child tasks. The chat path would stay on Mastra until the
conditions above are met.
