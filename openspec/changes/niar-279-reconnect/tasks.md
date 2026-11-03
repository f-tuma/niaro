# Tasks

## 1. Reproduce

- [x] 1.1 Emulator: with a service task in the main chat, the first message after a launch makes every snapshot answer 500 (`Unknown native public conversation`). The phone stays offline after a server restart, and the sent text is back in the composer.
- [x] 1.2 Storage test: a task of the earlier session naming the session archive fails `syncNativeWork`.
- [x] 1.3 Phone test: a lost answer puts the text back into the composer; Stop is shown while offline.

## 2. Server

- [x] 2.1 `ConversationHistory.shell` returns an empty reference for a session archive too.

## 3. Clients

- [x] 3.1 `heldForRecovery` in client-core; the phone and the web keep a kept command's text out of the composer.
- [x] 3.2 Stop (and Esc on the web) only while running and online.

## 4. Verification

- [x] 4.1 Client-core: the server dies mid-answer and comes back (recorded and not); 500 on every read, then fixed; foreground retries at once.
- [x] 4.2 Lint, typecheck, full Jest and the interruption, answer stream, conversation and Mastra crash node suites.
- [x] 4.3 Emulator: offline → server back → Check result / Dismiss, with screenshots.
