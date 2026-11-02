# Tasks

Requirement references are to this change's `chat` and `chat-search` deltas.

## 1. Shared days

- [x] 1.1 Add `packages/client-core/chat-days.ts` (`groupChatsByDay`, `messageDays`, `dayLabel`, `messageTime`, `messageMoment`) and point the web's `chat-history.tsx` and `chat-message-actions.tsx` at it; verify with `npx jest tests/chat-days.test.ts tests/web-chat.test.tsx`. (Days in chats)
- [x] 1.2 Use `groupChatsByDay` in the phone drawer instead of `groupByDay`; verify with `npx jest tests/conversation-history-mobile.test.tsx`. (Days in chats)

## 2. Phone message actions

- [x] 2.1 Ask for message times (`messageTimes`), add `day`, `editable` and `again` to the thread projection and the `MessageMeta` row (time, Copy, Edit, Again) and day dividers to the parts; add `expo-clipboard` behind `apps/mobile/clipboard.ts`; verify with `npx jest tests/chat-parity-mobile.test.tsx`. (Message actions, Days in chats)
- [x] 2.2 Edit and Again through the workspace (`detached` send that owns no draft, mentions from the text, files through `reuseAttachmentMessage`); verify Again leaves a typed draft and read-only chats offer neither, with `npx jest tests/chat-parity-mobile.test.tsx`. (Message actions)

## 3. Phone search

- [x] 3.1 Meetings group under **All** and the message id of each hit in `ChatSearch.tsx`; verify with `npx jest tests/chat-search-mobile.test.tsx tests/chat-parity-mobile.test.tsx`. (Search screen)
- [x] 3.2 Open at the message: read older pages until it shows, scroll to it and outline it; verify with `npx jest tests/chat-parity-mobile.test.tsx`. (Opening a search result)

## 4. Names and attachments

- [x] 4.1 "Work" becomes **Tasks** / **Úkoly** on the tab and the screen title; update the suites that named the tab; verify with `npm test`.
- [x] 4.2 `attachmentSendReason` and `sendBlockedReason` in the phone composer from the attachment runtime's states; verify with `npx jest tests/chat-parity-mobile.test.tsx tests/attachment-client-ui.test.tsx`. (Attachments wait before sending)

## 5. Integration

- [x] 5.1 `npm run lint`, `npm run typecheck`, `npm test` and `spec openspec --project . -- validate niar-269-chat-parity-pack --strict` pass.
- [ ] 5.2 Internal phone build (new native module `expo-clipboard`) smoke-tested on a device: copy, edit, again, search jump, a screen-reader pass over the meta row. Not done in this change's implementation run.

## Workflow follow-up

- Archive the change after review; archive is not proof of deployment.
