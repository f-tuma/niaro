# Tasks

## 1. Reproduce

- [x] 1.1 `tests/meeting-process-integration.test.tsx` (real server over HTTP): after the meeting run succeeds, the second snapshot answers `400` and the session is `offline`.
- [x] 1.2 Find the throw: `ProcessOutputReferenceSchema.parse` in `prepareProcessOutput`, `origin.type = "meeting"` not in `card | command`, mapped to `400 invalid_payload` without a log.

## 2. Output reference

- [x] 2.1 `ProcessOutputOriginSchema` accepts a meeting origin (conversation, request, meeting id, record digest).
- [x] 2.2 `prepareProcessOutput` maps the admission origin to it, and holds back output it cannot reference (`invalid`, logged).

## 3. Task window

- [x] 3.1 `task-projection-guard`: request-level failures still fail the read; anything else skips one task with a log line.
- [x] 3.2 Process roots and chat roots (window listing only) are projected on their own; output preparation errors keep the task.
- [x] 3.3 `syncNativeWork` skips and logs invalid, non-native and unknown-chat items and a conflicting answer message; window-level limits still throw.

## 4. Verification

- [x] 4.1 Node tests for meeting output, skipped process and chat roots, request-level failures and `syncNativeWork` skips; the integration test stays online after the run.
- [x] 4.2 Lint, typecheck, admin build, full Jest and the process, conversation, task window, process work item and mobile HTTP node suites.
