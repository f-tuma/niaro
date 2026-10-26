# ADR 020 — The web chat on assistant-ui

Date: 2026-10-25. Status: implemented; since 2026-10-26 the only chat, the classic page and the switch are removed (NIAR-228).

## Context

The web chat page grew its own thread, composer, progress, draft and card rendering (2,000 lines in `chat-page.tsx`) while the answer stream (NIAR-226/227) made the server speak the AI SDK UI message stream and the model work its tools directly (NIAR-225). The owner wants the chat core on standards so the app stops reinventing what agent chats share, and wants the production chat to feel like one: an answer that appears as it is written, tool steps named in one line each, nothing shown that the person cannot read.

## Decision

Rebuild the web chat on [assistant-ui](https://github.com/assistant-ui/assistant-ui) (`@assistant-ui/react` 0.15, MIT), shipped next to the classic chat behind a switch until it carries everything.

- **The session stays the source of truth.** The thread is `useExternalStoreRuntime` over the `ClientSession`: its stored messages, the pending message and the live answer are the thread's messages, and every send is a session command. Nothing about idempotency, outbox, retry, offline or the server's authority (scope, receipts, approvals) changes. The AI SDK adapter (`@assistant-ui/react-ai-sdk`) was not used: its current release pins an `ai` version the registry does not have, and client-core already reads our stream.
- **System UI as tool parts.** Every system view is a tool-call part with a `niaro.*` name rendered by a tool UI: the generated answer, an approval, the assistant's work with its question, a sign-in, a process offer, a skill or process draft, contacts, an old card. A streamed tool step is a part too, shown as one line in the Runs page's words. Reasoning is never a part.
- **assistant-ui owns the thread, the viewport and the message parts; the app owns the composer.** The composer's text lives in assistant-ui's composer and sends through it, but the field, the `@` picker, the attached task, the limit and the IME keys are the app's, because the design system's `InputGroup` and the picker's keyboard rules would not survive `ComposerPrimitive.Input`.
- **Nothing leaves the server.** No CDN-loaded code; assistant-cloud is a dependency of the package but is never configured and does not reach the bundle (no cloud host in `dist-admin/app.js`).
- **The switch** (`localStorage["niaro.chat"]`, `?chat=next|classic`, an account-menu item) carried the new chat next to the classic one for one day; both are gone since October 26.

## Consequences

The bundle grows by about 109 kB gzip (assistant-ui and its store, plus the `radix-ui` bump to 1.8 that both now share). The classic chat's tests run against the next chat (`tests/web-chat-next.test.tsx`), so a difference is a failure, not a surprise.

Typed replies to a process question, the recovery of an unconfirmed process answer and the process notice moved into this chat on October 26, when `chat-page.tsx` was retired; its tests now run against this chat.

assistant-ui's external store treats a running thread whose last message is the person's as having an "optimistic" empty answer; the next chat always shows its own live answer message while a request runs, so the two never meet. The thread message ids are the server's; the live answer is `live:<commandId>` and the pending message `pending:<commandId>`, so a settled turn replaces them in place.
