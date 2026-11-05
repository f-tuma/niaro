# Design

## D1 What an answer drew on

`DomainCommand.replyBasis` (a memory pin: item ids, verified-operation sources, earliest expiry) collects `memory.metadata()` each time the turn's memory context or a `memory_search` reaches the model. Unlike `memoryMetadata` it never takes the thread's inherited pins: after the chat's own memory change it only drops the changed item, since that change is the person's request. Older turns without it fall back to `memoryMetadata`, and a version without metadata counts as unknown. Service provenance is the turn's `sources` (results carried into it) and `operations` (its own actions); both are persisted already. Only ids are stored; saved content stays in encrypted memory.

## D2 Native thread

`apps/server-agent/runtime.ts` stamps each assistant message with `niaroNativePrivacy.runId` (the domain turn key) next to `privateContext`. `processLLMRequest` collects the stamped runs of the thread and asks `NativeAgentSession.visibleRuns` once per model call; a segment whose answers' runs all pass keeps its text, including after guarded tool calls (their calls still collapse into the note). A failing check withholds everything. Messages without a run id, and sessions without `visibleRuns` (process runtimes), keep the old `privateContext` rule.

## D3 The check

`replyVisibleLocked` (mastra-domain, under the identity queue) passes when the turn belongs to the same chat, every succeeded receipt of `sources ∪ operations` has the current policy revision and still passes `authorize` and the execution (sign-in) pin, and the basis is empty or `AgentMemory.readable` holds: `MemoryStore.itemsReadable` for every id (own private or shared with sharing on, active, published, unexpired, not opted out) and every verified source still accessible. Failed, rejected, unknown and pending receipts carried no data and are skipped. A missing turn, a different chat or unknown items withhold.

## D4 Fresh thread

`begin()` matches the history's assistant messages against the latest 40 stored turns of this chat by `answer.reply`, so only replies the server itself stored enter. A matched reply that fails the check is stored as the withheld note; one that passes carries its run id and, when it fits in 4,000 characters, its program as an `openui-lang` fence. `prepareModel` checks the run ids again on every step and shows the note for any that no longer pass. The list holds up to 16 messages.

## D5 Thread continuity

Unchanged: the continuation check still decides whether a thread is reused. Because a forgotten item or revoked read usually rotates the thread, the fresh thread's earlier messages are where most withholding now happens; the native projection withholds after the chat's own memory change, which keeps the thread.
