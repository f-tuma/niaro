# Tasks

## 1. Client core

- [x] 1.1 `ClientSession` keeps a check for a kept chat request with an unknown outcome and publishes `deliveryCheck`.
- [x] 1.2 Checks post the identical command once each, from the poll tick and on foreground, only online, spaced out, reset on reconnect; five failures while reachable end failed.
- [x] 1.3 A model error, an unconfirmed Stop or a Dismiss sets failed; a restored outbox command starts checking.
- [x] 1.4 `canRetryPending` offers no Retry while checking; `chatRequestFailed` for the clients.

## 2. Clients

- [x] 2.1 `RequestProgressCard` without the unconfirmed state; Thinking unless failed.
- [x] 2.2 Phone `ChatThread` and `App` show Retry and Dismiss only for a failed request.
- [x] 2.3 Web chat-next shows Thinking while checking and the failed line only for a failed request.
- [x] 2.4 Copy: remove the unconfirmed strings (EN, CS); Retry reads Try again / Zkusit znovu.

## 3. Verification

- [x] 3.1 Client-core tests with a fake server (lost, recorded or not, offline for minutes, broken reads, model failure, repeated failures, restart, background).
- [x] 3.2 Phone and web tests: no card or copy while checking, online and offline; the answer appears; failed shows Try again and Dismiss.
- [x] 3.3 Lint, typecheck, admin build, full Jest and the interruption, answer stream and conversation node suites.
- [x] 3.4 Emulator: server stopped mid-answer and restarted, with screenshots.
