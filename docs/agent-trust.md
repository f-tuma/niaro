# Agent loop trust scenarios

The local runner exercises complete conversations against the current public command, native Mastra Agent/Memory/checkpoints, Niaro catalog and long-term memory code. It reports assertions, observable effects and known capability gaps separately. It uses a scripted model and decision checker: it measures application mechanics, not the quality of a live model.

```sh
pnpm eval:trust --list
pnpm eval:trust --json /tmp/agent-trust-report.json
pnpm eval:trust --scenario loop.clarification-after-restart
```

The full run on October 3, 2026 returns **exit 0 / PASSED** after the native Tasks
and explicit goal-return implementation. Exit 1 means an assertion, setup, cleanup
or scenario deadline failed; exit 2 means a recorded capability gap remains.
`--allow-known-gaps` changes only the latter exit policy and preserves the report's
verdict. Passing this synthetic runner measures application mechanics, not real
model quality or beta acceptance.

The October 4 native tool boundary adds strict original-JSON validation and
crash-safe rejection markers. Its separate regressions cover corrective failures,
checkpoint privacy, backed plugin references and approval/question resume.
Terminal replies cover known provider/protocol/native execution failures,
including syntactically invalid provider tool JSON. Safe EN/CS prose distinguishes
these causes from the step limit; arbitrary exception messages and provider bodies
are never public diagnostic text. Submitted text and reply correlation survive
delivery/replay, and a zero-operation failure is still a native task.

Finalization requires exact run/thread/resource retirement evidence in native
storage, together with the current owner's cleanup and memory tail. A missing
in-memory owner after restart is insufficient. A bounded terminal candidate
quarantines an answer prepared before a later fatal error; current policy, memory,
source and card guards still apply to publication. Unproved candidates hold the
scope reservation across restart, expose no resumable question or approval, and
permit only passive settlement of the exact command. Both command and idempotency
identities are checked before new inference or a public receipt. Confirmed writes
and memory changes survive; unknown writes remain unknown and take precedence in
the final summary. Interruption cannot turn that known failure into a fabricated
successful cancellation.

Retirement can release a reservation even when the captured actor no longer has
permission to publish the old result. A fresh authorized request uses only the exact
server-owned retirement binding for this cleanup; it does not read old prose or
dispatch the old task. Diagnostic holds update the current persisted journal and
preserve committed receipts and memory, without restoring a deleted turn. Native
approval replies update the existing canonical card and correlate its message to
the decision command, so foreground speech can read the final result once.

The dedicated regressions are `tests/mastra-native-fatal.node.ts` and
`tests/mastra-native-fatal-crash.node.ts`. Two actual SIGKILL cuts cover a native
answer before the public workflow commit and a held candidate with a real suspended
SDK checkpoint. The latter remains blocked after reopen without inference or
dispatch. These are application-mechanics tests with scripted providers, not a
claim that every infrastructure failure can produce an immediate final answer.
Native business parameters that collide with Mastra's reserved root fields are
preserved inside the `niaroBusinessInput` envelope and verified across stream
conversion, process Agent approval/reopen, and SIGKILL checkpoint recovery. See
[reload and compatibility details](self-hosting.md#loop-evidence-and-recording-interruption-4-october-2026).

Each scenario has a 15-second deadline, an abort signal, registered cleanup and an isolated temporary directory. Native owners and file-backed Niaro stores are actually closed and reopened for restart probes. In the default scripted mode, the runner does not read a server profile, API key or existing account database. All model and service requests are handled in memory with synthetic `.example.test` data; it makes no network requests, paid inference or real service writes. A synthetic POST count measures whether the application would dispatch a write, not a real business result.

### Explicit live-model mode

`pnpm eval:trust:live` is a separate OpenRouter-only mode. It requires `--confirm-live`, an exact `--model`, one or more explicit `--scenario` values, numeric request/token/cost reservations, caller-supplied token prices and `NIARO_TRUST_MODEL_API_KEY`. It does not inherit provider credentials from the server profile. Chat-completion requests go to the selected model; the decision checker and CRM/calendar services remain synthetic, so the run cannot write to a real business service. The report stores the requested and response-verified model ID, scenario outcomes, usage and latency, with mode `live-model`, and is written with owner-only permissions. API-key values are scrubbed from report and failure output.

Live token and cost controls are local reservations, not provider-enforced spending limits. Input tokens are estimated from serialized request bytes rather than the selected model's tokenizer. `max_tokens` is sent as the requested output ceiling and usage is checked after each response. Cost is reserved using caller-provided rates and reconciled against provider-reported cost when available; either source may differ from the final provider invoice. Missing usage, transport failure, model substitution or any detected overrun stops later live requests and makes the report incomplete or failed. A provider-side account limit is still the only firm spending ceiling.

The live quality matrix has paired EN/CS cases for inflected contact names, repeated lookup, topic detours, ambiguous identities, stale memory conflicting with a current read, and malicious instructions in untrusted memory. Select both language variants of every selected `quality.*` case; an incomplete pair is rejected before provider setup. Each run is scored with deterministic checks against its synthetic contacts, tool receipts, visible reply and requested contact card. Reports include per-language totals, per-dimension totals for recorded checks, and a separate list for early failures that lack dimension evidence, plus model replies and observed cards needed for review. No second model acts as judge, and these fixed fixtures do not establish general language coverage.

## Scenarios and observed result

A full repeat on **2026-10-07** passed all **18 scenarios / 86 checks**, with
exit 0, zero failures and zero known gaps. The standalone CLI ran without a
scenario filter or `--allow-known-gaps`. An independent audit verified the actual
native Agent/tools/processors and durable invocation path, the exact original
run/thread after a detour and reopen, and no repeated unknown write. This closes
the synthetic mechanical suite; live quality, engine cutover and physical-device
acceptance remain separate. No new runtime
implementation was needed; the planner's earlier 17-pass/one-gap status was stale.

The native-runtime run on **2026-10-03 contains 18 scenarios / 86 probes: 18 passing
scenarios, 0 failed scenarios and 0 known gaps**. Separate authenticated HTTP,
concurrent answer and UI coverage is documented in [native Tasks](native-tasks.md).
An earlier runtime run covered actual SIGKILL.

| Area                       | Observed behavior                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Short-term context         | Clarification after restart keeps the original goal, open question and authorized read without another dispatch. A fresh session drops prior context.                                                                                                  |
| Topic detour               | An unrelated request leaves the original goal suspended. Explicit selection after restart and a bound answer resume its exact native run without writing.                                                                                              |
| User cancellation          | Cancellation before a read receipt permits explicit retry. A committed read and exact command replay do not dispatch again. Native terminal cancellation removes its checkpoint, so an explicit pre-effect retry may receive a new native call ID.     |
| Concurrency and bounds     | A busy new-session request preserves the running chat. Unsupported tool loops terminate at the inference budget.                                                                                                                                       |
| Long-term memory           | Explicit Czech save, new-session retrieval, restart, explicit chat correction, forgetting a revised lineage and retry without resurrection pass.                                                                                                       |
| Memory correction          | Exact old/new JSON strings bind one private record, expected revision and user provenance. Ambiguous, altered, foreign and stale requests cannot change it. The replacement survives restart and invalidates an older pending approval.                |
| Correction interruption    | The correction, mutation receipt and domain projection commit together. A failed checkpoint rolls back the correction; reopening after commit preserves one correction and replans with fresh memory. Native checkpoints use a separate database.      |
| Scope and trust            | Another user/workspace cannot retrieve or delete private memory. Candidates are excluded; user assertions keep their attribution. Verified read sources are checked against the scoped catalog receipt and become unavailable on revocation or expiry. |
| Memory changes during work | Forgetting or opting out after inference dispatch rejects stale arguments before service I/O. An approval saved before a memory change cannot execute after restart.                                                                                   |
| Action lifecycle           | A proposal performs no write. Explicit approval performs one matching synthetic write; rejection performs none. Replay and restart remain passive.                                                                                                     |
| Unknown outcome            | A write with a lost response stays `unknown`, with no verified result or success badge. Another confirmation and restart cannot resend it.                                                                                                             |
| Cards                      | Visible form labels produce the exact user text; hidden values, foreign scopes, stale revisions and a concurrent topic change before dispatch are refused.                                                                                             |
| Claims checking            | Readable claims of the answer's generated UI reach the checker. A scripted rejection removes the unsupported UI before repair. This checks the wiring, not the checker's judgment accuracy.                                                            |

The concurrency probe found and fixed a real bug in `ModelService`: `session: "new"` previously archived the chat before checking whether another request was active. The busy request could erase the running request's context. The server now reserves the request before clearing the session; refusal leaves the snapshot and archives unchanged.

A September 30 phone report exposed a separate lookup failure: an exact search used an inflected Czech name and returned zero records, then later replies claimed a repeated CRM check without a new service call. Contact lookup instructions now normalize inflections, broaden a failed exact query conservatively and distinguish a query's empty result from proof that a person does not exist. A bounded guard requires a current successful contact read for recognized explicit lookup/recheck requests, allows one repair and otherwise returns an unverified result. The reply checker receives current read inputs paired with results; discovery, historical assistant prose and unrelated reads cannot stand in for that evidence. The guard recognizes a limited set of Czech/English requests and obvious name mismatches; it is not a general semantic verifier or a measured guarantee of live model search quality.

An October 1 create failure exposed another distinction: an email-only lookup found an older record with a different surname, which did not verify the new creation. The checker chose `incomplete` below its confidence threshold and the old runtime accepted the reply. Unresolved failed/unknown writes now require an affirmative sufficiently confident check, with bounded canonical write inputs for identity comparison. One persisted repair is followed by a new check; another uncertain/rejected answer returns the server's canonical failure reply and card. The write receipt remains unconfirmed and cannot be automatically resent. A successful retry of the same action/input still supersedes a known earlier failure; this rule does not merge different people. Synthetic regressions test these mechanics, without claiming that the live checker's judgments are always correct.

Explicit correction uses the entire authenticated message, such as `Oprav paměť: "Odpovídej podrobně." na "Odpovídej stručně."` or `Revise memory: "Give detailed answers." to "Keep answers concise."`. The corresponding optional `Prosím` / `Please` prefix and `→` / `->` separators are supported. Both values are JSON strings with exact decoded content and no edge whitespace; extra instructions or identical values are refused. The model searches for the old record and calls `memory_revise` with its ID, expected revision and replacement. Ordinary remember requests remain additive, without semantic deduplication or implicit correction. See [memory usage](internal-plugins.md#correct-a-saved-memory-from-chat).

## Durable goal return

The former single-active-goal gap is now a passing regression. Original run,
thread, question and source authority survive a side task and restart. Selection
is passive and the exact question-bound answer resumes the original goal. Multiple
pending goals require selection; expired/revoked context fails closed. This is
not automatic scheduling, background resumption or reconciliation of an interrupted
running write. Public custom-process invocation remains separate roadmap work.

## Measurement limits

These results do not establish how a real planner or Jev checker handles ambiguous Czech/English, contradictions, misleading service text, unsupported claims or useful card layouts. The live runner now has bounded local request/token reservations and a paired English/Czech synthetic quality matrix, but no live-model result has been collected. The remaining evidence work is to run it with an explicitly selected model and budget, repeat conversations to measure variation, and independently review replies against authoritative records. Each matrix case is one fixed sample per language; its pass rate is not a statistical estimate or a general measure of Czech fluency. Reports retain prompts, model tool calls, synthetic service requests, receipts and correlated replies to make review possible. The runner records actual failures and uncertainty instead of using another unconstrained model as the sole judge.

This runner enters at `ModelService.execute`. Authenticated actors are synthetic; HTTP login/membership and rendered UI are covered by separate regression and browser checks. No physical phone or operating-system process kill was used in this runner; actual SIGKILL tests are a separate native runtime suite. Cancelled calls use injected boundaries; restart closes and reopens files. The memory retention clock is advanced for expiry probes, while native conversation state and catalog receipts use wall time. This runner does not measure native conversation retention expiry or latency.

Implementation: `tests/agent-trust/` contains the shared harness, scenarios and report types; `scripts/evaluate-agent-trust.ts` is the scripted CLI and `scripts/evaluate-agent-trust-live.ts` is the explicit live-model CLI. To add a scenario, use observable assertions through `probe.check`, register the harness cleanup with `probe.defer`, and retain explicit gaps through `probe.gap`. A thrown error is a failure and does not prevent the remaining independent scenarios from running. Live runs must preserve the distinct mode, record requested and response-verified model identity and budget evidence, and keep the existing permission and synthetic-service boundaries.
