# Tasks

## 1. Recorded per run

- [x] 1.1 `DomainCommand`: `preset`, `answerModel`, `meetingReads`; the native runtime's `model-start` carries the catalog model id and preset name (Run records for the receipt).
- [x] 1.2 `meeting_read` records its meeting; the last finished model step records its model, route and reason.

## 2. Receipt API

- [x] 2.1 `packages/protocol/answer-receipts.ts` and `apps/server-identity/answer-receipts.ts`: receipt from stored turns with per-item access checks (Answer receipt contents, Receipt access).
- [x] 2.2 `GET /v1/:workspace/receipts?conversationId=` with the person's files from the chat ledger (Receipt API).

## 3. Presets

- [x] 3.1 `PresetOptions` in the model policy, `offeredPresets`, `preset:<id>` routes, validation, budget reach (Member model presets, Presets stay within the policy, Prices for routed models).
- [x] 3.2 `GET /v1/:workspace/chat-presets`; `message.send.preset`; the run answers with an offered preset only (Preset at use).
- [x] 3.3 Runs show the preset on the model step (Run steps name their model).
- [x] 3.4 Configuration bundle carries presets (Presets in the configuration bundle).

## 4. Clients and console

- [x] 4.1 Shared wording in `packages/client-core/answer-receipts.ts`; i18n en/cs.
- [x] 4.2 Web: receipt line under answers, preset select in the composer (Answer receipt line, Preset picker in the chat).
- [x] 4.3 Phone: receipt line with `Disclosure`, preset radio row above the composer.
- [x] 4.4 Models page: Member presets section; Runs translate "Preset" (Member presets on the Models page).

## 5. Verification

- [x] 5.1 `tests/answer-receipts.node.ts`, `tests/answer-receipts-http.node.ts`, presets in `tests/model-policy.node.ts`, `tests/mastra-domain.node.ts`, `tests/config-bundle.node.ts`.
- [x] 5.2 `tests/web-answer-receipt.dom.test.tsx` (roles, names, expanded state), preset sending in `tests/web-chat-next.test.tsx` and `tests/chat-parity-mobile.test.tsx`, `tests/mobile-answer-receipt.test.tsx`.
- [x] 5.3 `npx tsc --noEmit -p .`, eslint on the changed files, full jest, `spec openspec validate --all --strict`.
