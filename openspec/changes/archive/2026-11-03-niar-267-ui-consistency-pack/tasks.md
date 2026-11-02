# Tasks

Requirement references are to this change's `chat` delta.

## 1. Approval footer

- [x] 1.1 Web `ServiceActionView`: effect and "Don't ask next time" left, Decline (outline) then Approve right; tests in `tests/web-chat-next.test.tsx`. (Approval in chat)
- [x] 1.2 Phone `ServiceActionCard`: right-aligned Decline then Approve; `serviceReject` / `serviceRejected` "Decline" / "Odmítnout", "Declined" / "Odmítnuto"; stories and `tests/service-action-card.test.tsx`. (Approval in chat)

## 2. Chat header

- [x] 2.1 Shared `useChatActions`, `ChatMenuItems` and `chatNameField` in `app/chat-history.tsx`; the sidebar row uses them. (Chat header)
- [x] 2.2 `ChatHeader` on the chat page (name, pet, `…`), the phone sidebar button moved into it on chat pages; `tests/web-chat-header.test.tsx`. (Chat header)

## 3. UI system

- [x] 3.1 Tooltip delays in `components/ui/tooltip.tsx`; message time as a name. (DESIGN.md)
- [x] 3.2 `size` on `DialogContent` and `SheetContent`; every call site named after a look at it; `tests/web-ui-system.test.tsx`. (DESIGN.md)
- [x] 3.3 `components/ui/toast.tsx` in the shell; Copied from message and code copy; "Chat archived" with Undo. (Copied and Undo confirmations)
- [x] 3.4 `apps/server-admin/DESIGN.md`: widths, toast, tooltips, approval footer, chat header.

## 4. Integration

- [x] 4.1 `npm run lint`, `npm run typecheck`, `npm test`, `npm run admin:build`.
- [ ] 4.2 Browser check: the header menu with the sidebar collapsed and at 360 px; light and dark screenshots of the approval card and the toast.
- [ ] 4.3 Phone top bar `…` and New chat in the drawer header (separate change, `apps/mobile/*`).
