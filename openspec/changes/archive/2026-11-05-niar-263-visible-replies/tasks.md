# Tasks

## 1. Record

- [x] 1.1 `replyBasis` on the turn: the item ids that reached the model in this turn, minus the item its own change retired.
- [x] 1.2 Assistant messages stamped with the run that wrote them.

## 2. Check

- [x] 2.1 `AgentMemory.readable` over `MemoryStore.itemsReadable` and verified sources.
- [x] 2.2 Receipt access: policy revision, grant and sign-in pin of every succeeded receipt.
- [x] 2.3 Native projection asks `visibleRuns` per model call; legacy stamps keep the old rule.

## 3. Fresh thread

- [x] 3.1 Earlier messages include stored replies of this chat, withheld note when they fail, program with its reply.
- [x] 3.2 Re-checked on every step.

## 4. Tests and checks

- [x] 4.1 `tests/thread-continuity.node.ts`: number follow-up with unrelated memory, forgotten memory, revoked and valid CRM read, fresh thread with generated UI.
- [x] 4.2 Updated `mastra-history` and `native-tool-validation` expectations to the decision.
- [x] 4.3 mastra-domain, history, continuity, memory and trust suites; types, lint, boundaries.
- [x] 4.4 Dev server: the number follow-up answers with the same number.
