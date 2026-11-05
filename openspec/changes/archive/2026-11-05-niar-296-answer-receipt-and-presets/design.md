# Design

## D1 Receipt from server records only

`packages/protocol/answer-receipts.ts` defines `AnswerReceipt {commandId, read, changed, memories, skills, meetings, files, model?, preset?}`; each item is `{kind, id, title, detail?}`. `apps/server-identity/answer-receipts.ts` builds it from the stored native turn (`DomainCommand`) of each request, never from the reply text:

- `read` / `changed`: the turn's `operations` resolved to stored invocations; only `succeeded` ones, reads vs writes by effect. A waiting approval, a refusal or an unknown outcome is neither (members see no internal states). `changed` adds memory saves (`memoryReceipts`), open items created and closed (`humanTaskReceipts`, `humanTaskClosures`).
- `memories`: `replyBasis.items` (NIAR-263), the saved items that reached the model in this turn.
- `skills`: `skillLoads`; `meetings`: meeting `@` tags plus `meetingReads` (new: a successful `meeting_read` records its meeting); `files`: the person's attachments on the request's user message in the chat ledger.
- `model`: `answerModel` (new): the catalog model id, route and reason of the last model step that finished, captured from the native runtime's `model-start` / `model-end` events (`model-start` now carries `modelId` and the preset name). The member sees `CatalogModel.name`; `reason` maps `fallback: …` to `fallback` and `escalated …` to `escalation`.

Access is re-checked for the person asking at read time: services must still be usable by them (enabled with an action allowed to them), skills usable, meetings and open items theirs, memories readable through `MemoryStore.find` with the workspace's settings and source access. Anything else is left out; a removed model leaves no model part.

## D2 API

`GET /v1/:workspace/receipts?conversationId=` (`apps/fixture-server/http.ts` → `IdentityService.mobileAnswerReceipts`) authenticates like the other app reads, reads the person's latest 40 turns of that chat (`conversationTurns`, scoped by user), and returns `AnswerReceiptPage`. The files come from the chat ledger after the person is known. Clients key receipts by `replyToCommandId` and read them again whenever the newest stored answer changes. 404/405 means a server without receipts: no line.

## D3 The line

`packages/client-core/answer-receipts.ts` shares the wording: counts per kind ("Read 2 · Memories 3 · Answered by Thorough · GPT Luna, fallback model") and the expanded sections. Web: `AnswerReceiptLine` under `MemorySaveLines` in the stored assistant message, a Radix collapsible trigger with an `sr-only` prefix "What this answer used", `aria-expanded` and `aria-controls`. Phone: the existing `Disclosure` component in `AnswerBody`. Both hide an empty receipt.

## D4 Presets in the policy

`PresetOptions {enabled=false, items: ModelPreset{id, name, tier}[≤4]}` in `PolicyOptions` (organization) and optional in workspace options, merged by `effectiveOptions`. `offeredPresets(policies)` is empty while off. The route key `preset:<id>` resolves to the preset's tier models with the chat role's fallback flag, only while offered; `selectRoute` attaches `{id, name}` to the route choice. Validation on save: preset tiers count as referenced tiers (must exist, cannot be removed), offered preset routes are fit-checked as chat, and `budgetedReach` includes them so enforce mode needs their prices.

Alternative rejected: presets as free model lists. A tier is already the administrator's named model list; reusing it keeps models in one place and the bundle needs no new model references.

## D5 Preset at use

`message.send.preset` (tier id syntax) flows to `DomainMessageContext.preset`. At the start of the request (and on a reply to a question) the server keeps it in `state.preset` only if `store.preset()` offers it now; otherwise the request uses the chat role. A preset changes the request hash so a retry with another preset is another request. `prepareModel` order: escalation (once, after a checker rejection) → preset → chat role; unavailable preset models fall back to the chat role as escalation does. The step is an ordinary model call: allowance, caps and the ledger apply. Runs show `Role: chat`, `Preset: <name>`.

## D6 Clients

`ClientSession.readAnswerReceipts` and `readChatPresets`. Web: a `NativeSelect` labelled "Model preset" in the composer's tools, remembered per identity in `localStorage` (guarded); phone: the `Segmented` radio group above the composer. Only offered presets show; a withdrawn one falls back to Default quietly. Sent text never returns to the composer.
