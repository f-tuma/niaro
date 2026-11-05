# Design

## D1 Cause

`begin()` in `apps/server-identity/mastra-domain.ts` reused the prior turn's thread only after `validateThreadLocked`, whose memory step calls `memory.validate(version, metadata)` → `MemoryStore.isCurrent`, an equality check against `agent_memory_version`. That row is per workspace and advanced by every remember, revise, forget, observe (learner refresh included), classify, opt-out, personal-things change and erase of anyone in the workspace. The learner (`profile-learner.ts`) runs every 60 s over chats with new messages, so in practice the version moved between almost every pair of turns. A test reproduced it: one learner observation between two turns gave the second turn a new thread id.

## D2 Item pins

`AgentMemoryMetadata.items` lists the ids of items that reached the model: the explicit items returned by the turn's context and by `memory_search` (and its replays), and the observations of the turn's context. Absent means unknown (an older pin or more than 500 ids), never empty; `mergeMetadata` keeps the list only while every merged pin has one, and a pin with a version but no metadata counts as unknown.

`AgentMemory.continuation(version, metadata)` (memory runtime) passes when `isCurrent` holds, or else when `MemoryStore.itemsReadable` finds every id active, published, unexpired and readable (own private, or shared with sharing on), the person not opted out, and the pin's earliest expiry not passed; verified-operation sources must still be accessible. It returns the current version, which the continued thread pins together with the merged item list, so the turn's own strict checks run against the current version.

Content changes only under a new id: `revise` and observation `update` insert a new row and mark the old one `superseded`; `forget`, erase and opt-out remove or hide it; learner `refresh` and `classify` bump the revision of the same id with the same words. So "same id still active" means "same words".

## D3 What stays strict

`validateThreadLocked` (every model step, dispatch, approval, resume, pending question) is unchanged: exact version and expiry. The new lenient check runs only in `begin()` when choosing whether a new turn continues a thread. A thread with a legacy question keeps the strict check.

## D4 Other breakers

- Policy epoch: a source-free thread (no reads in `sourceDependencies`) continues after an organisation policy change; sources keep the exact policy revision check.
- Retry: the retry gate on reuse was removed. `retryParentLocked` already refuses parents with pending work, unknown write outcomes, memory or task receipts. The failed attempt's text is unstamped and therefore withheld; its calls collapse into the earlier-calls note.
- Kept: separate task while another question is pending, attachment generation, legacy question, 224-source budget. All log their reason as `native_thread_fresh`.

## D5 The projection rule (reported, not changed)

`projectProviderHistory` in `apps/server-agent/runtime.ts` replaces an earlier answer with "[Prior private response withheld]" unless it was stamped `privateContext: false`. `prepareModel` sets `privateContext` whenever `memoryContainsFacts` is true, which is true as soon as the person has one saved item, one observation or a confirmed position, whatever the question. Checked with the trust harness: the same public answer ("a triangle has three sides") is visible on the next turn without memory and withheld with one unrelated saved preference. With the learner on, every person soon has observations, so a continued thread still hides the assistant's own replies. This follows the spec's wording ("built on private service or memory data") read broadly; narrowing it (for example to answers whose memory was actually cited or searched) needs a product decision and is left open.

## D6 Fresh thread context

A fresh thread keeps only the person's last eight messages. Assistant replies are not added: the visible history carries no privacy stamp, and by D5 almost every reply of a person with memory would have to be withheld anyway.
