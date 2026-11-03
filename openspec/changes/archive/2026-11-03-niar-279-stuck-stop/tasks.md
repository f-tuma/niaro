# Tasks

## 1. Reproduce

- [x] 1.1 Client-core test: after each model 503, a 500 and a dropped connection the request is kept, is not running, and Stop's interrupt is refused `not_running` (the stuck loop).
- [x] 1.2 Phone test: a failed message still shows Stop and no Dismiss; other screens show "Retry same command" (fails before the fix).
- [x] 1.3 Web test: a failed message still shows Stop and offers no Dismiss (fails before the fix).

## 2. Dismiss in client-core

- [x] 2.1 `discardPending()` asks `commands/interrupt` about the exact command; `settled` shows the receipt, `not_running` clears the outbox and the request, anything else keeps it with `requestInterruptFailed`.
- [x] 2.2 A known outcome whose save failed is cleared locally; a running, submitting, offline or process command is refused.

## 3. Clients

- [x] 3.1 Phone: Stop only while running; the progress card offers Retry and Dismiss; Dismiss returns an unrecorded message to an empty composer.
- [x] 3.2 Phone: the global Retry no longer offers a chat message.
- [x] 3.3 Web: Stop and Esc only while running; the progress line offers Retry and Dismiss; Dismiss returns an unrecorded message to an empty composer.
- [x] 3.4 Phone: a meeting recording interrupts a chat request only while it runs; test that a failed one neither blocks nor is interrupted (D4).
- [x] 3.5 Phone: another chat holding the request is named with Open, and Stop only while it runs, in English and Czech; test both states and Open.

## 4. Verification

- [x] 4.1 New suites pass and fail without the fix; lint, typecheck, full Jest and the interruption, answer stream, work cancel and chat delivery node suites pass.
