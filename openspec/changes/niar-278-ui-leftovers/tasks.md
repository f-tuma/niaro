# Tasks

Requirement references are to this change's `chat` delta.

## 1. Meeting proposal footer

- [x] 1.1 Web `ProposalReview`: effect on the left, right-aligned outline **Decline** then **Approve** (`meeting-decisions`); verify with `npx jest tests/web-chat-next.test.tsx`. (Approval card footer)
- [x] 1.2 Phone `ActionApprovalCard`: quiet **Edit** left, tonal **Decline**, primary **Approve**, right-aligned; story `ChatProposalNarrowCzech`; verify with `npx jest tests/chat-work-card.test.tsx tests/approval-card.test.tsx tests/ui-shell.test.tsx`. (Approval card footer)
- [x] 1.3 i18n: the six meeting labels removed in favour of `serviceReject` / `serviceApprove`; "declined" and "approving" in the English sentences. (Approval card footer)

## 2. Pet page

- [x] 2.1 Remove the floating "Saved" box; keep "Saved" in an `sr-only` polite status; verify with `npx jest tests/web-pet-page.test.tsx`. (Copied and Undo confirmations)

## 3. Web Send reason

- [x] 3.1 Move `attachmentSendReason` to `packages/client-core/attachment-send-reason.ts`; the phone composer imports it; verify with `npx jest tests/chat-parity-mobile.test.tsx`. (Attachments wait before sending)
- [x] 3.2 Web composer: Send's name and the `composer-send-reason` line; verify with `npx jest tests/web-chat-composer.test.tsx`. (Attachments wait before sending)

## 4. Accessibility checks

- [x] 4.1 Jest project `dom` with `tests/helpers/jsdom-environment.js`; declare `jest-environment-jsdom` and `@testing-library/dom` (already installed) as development dependencies.
- [x] 4.2 `tests/web-a11y.dom.test.tsx`: names of every control on the chat page, the header menu, code copy, composer, decisions, the "Answer ready" region; verify with `npx jest --selectProjects dom`.
- [x] 4.3 `tests/a11y-mobile.test.tsx`: roles, labels and disabled state of Copy, Edit, Again, the top bar's `…` and the meeting decisions; verify with `npx jest tests/a11y-mobile.test.tsx`.

## 5. Integration

- [x] 5.1 `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build` and `spec openspec --project . -- validate niar-278-ui-leftovers --strict` pass.
- [ ] 5.2 A screen-reader pass on a device and light/dark screenshots of the meeting footer. Not done in this run.

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
