# Tasks

## 1. Shared

- [x] 1.1 `followUpScope`: a form as a whole, or a button outside a form by its label, so each sends once.
- [x] 1.2 The model's instructions and the `Form` description say a pressed follow-up is sent as the person's message.

## 2. Web

- [x] 2.1 `GeneratedUi` sends through the chat's `followUp`, which uses the composer's send path detached (no draft, reply, task or mentions); it marks the form or button answered only when the session took the message.
- [x] 2.2 Follow-up buttons wait while the chat cannot send (offline, busy, read-only, files in the composer); an answered form's fields and buttons are disabled.

## 3. Phone

- [x] 3.1 The runtime and `GenerativeUiView` do the same; the full-screen answer closes once the message is taken.
- [x] 3.2 `followUp` sends with `submitMessage` owning no draft; a detached send never takes the composer's files.

## 4. Verification

- [x] 4.1 Jest: `tests/web-generative-ui.test.tsx`, `tests/web-chat.test.tsx`, `tests/mobile-generative-ui.test.tsx`, `tests/mobile-generative-canvas.test.tsx` (sent at once, composer untouched, single use, not taken, offline, read-only).
