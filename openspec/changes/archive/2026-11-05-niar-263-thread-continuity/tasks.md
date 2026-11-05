# Tasks

## 1. Reproduce

- [x] 1.1 Node test: a learner observation between two turns gave the second turn a new thread.

## 2. Item pins

- [x] 2.1 Memory metadata lists the ids of items that reached the model; unknown stays unknown when merged.
- [x] 2.2 `MemoryStore.itemsReadable` and `AgentMemory.continuation`; the continued thread pins the current version.
- [x] 2.3 Facts saved from this chat's own words are not recorded; the chat's own change keeps the list minus the retired item.

## 3. Other breakers

- [x] 3.1 Policy change keeps a source-free thread.
- [x] 3.2 A retry continues the chat's thread.
- [x] 3.3 `native_thread_fresh` operator log line with the reason.

## 4. Tests and checks

- [x] 4.1 `tests/thread-continuity.node.ts`: learner, refresh, save and own save deleted, forget, revise, another member, policy with and without a source, retry.
- [x] 4.2 Memory, mastra-domain, history, continuity and profile learner suites; types, lint, boundaries.
- [x] 4.3 Dev server: a multi-turn chat with the learner on keeps one thread (log shows no `native_thread_fresh`).
- [x] 4.4 Decide on the projection rule (design D5).
