# Proposal

Tracker: **NIAR-287** (after a process run the server answers the snapshot and events reads with `400 invalid_payload`)

## Why

While working on NIAR-284 an agent saw `tests/meeting-process-integration.test.tsx` (a real server over HTTP) answer `400 invalid_payload` to the session's snapshot read after a process run. Reproduced and traced:

1. A person starts a process from a meeting (MeetingLibrary → ProcessLaunch, admission origin `meeting`). The run succeeds and has output.
2. Every snapshot, events, commands and voice transcription request first builds the person's task window (`catalog-runtime` `taskWindow` → `createProcessTaskProjection` → `prepareProcessOutput`).
3. `prepareProcessOutput` builds the output reference with `origin: admission.origin`. `ProcessOutputOriginSchema` accepts only `card` and `command`, so `ProcessOutputReferenceSchema.parse` throws a `ZodError` (`origin.type`: "Invalid discriminator value").
4. The HTTP layer maps any `ZodError` to `400 invalid_payload` and does not log it. The whole request fails.
5. The phone shows "Offline · last known state" and retries with back-off. Nothing changes until that run leaves the 400-root task window, so the person cannot read their chats or send a message either.

The query parameter `tasks=agent-process-work/3` is not the cause. The window is built before the profile filter, so every profile fails. This happens in production: the reference server uses the same code, and starting a process from a meeting ships in the phone app. It needs a process with an output schema that succeeds with output the person may see, which is the normal success path.

This is the same kind of bug as NIAR-279: one bad reference among the person's tasks failed every read. NIAR-279 fixed that path (`ConversationHistory.shell`), and its proposal named the remaining risk: `syncNativeWork` still fails closed on any other chat reference it cannot find.

## What Changes

- The output reference can name a meeting origin: conversation, request, meeting id and record digest. The selected task and source bindings stay in the admission. A succeeded meeting run shows its output preview, and full output can be read, like any other run.
- If a run's output reference still cannot be built (an origin the reference has no shape for), the task shows with its output marked unavailable (`invalid`). The read never fails because of this, and an operator log line `process_output_unreferenced` is written.
- The task window projects each task on its own. A process task or chat task that cannot be projected is skipped. The server writes an operator log line `task_projection_skipped` with the task kind, run id and error class or code, never content. The other tasks are still published.
- `syncNativeWork` publishes the valid items of a window. An item that fails the WorkItem schema, is not native work, or names a chat the person does not have is skipped and logged (`native_work_skipped`). A different message already stored under a process answer's message id stays as it is, is logged, and no longer fails the read.
- Failures of the whole request still fail it as before: a sign-in or access change (`401`, `identity_forbidden`), a server that cannot answer (`503`, including `task_projection_changed`), a cancelled request, and window-level limits (more than 400 items, duplicate ids, a delta that would evict).

## Non-goals

- Changing the HTTP error mapping. Any `ZodError` thrown while serving a request still answers `400 invalid_payload` without a log line, even when the server's own data caused it. That is reported as a risk, not changed here.
- Client changes. The phone already comes back online on the next successful poll.
- Repairing stored data. An account already in this state recovers on the next read after the update.

## Risk

- A skipped task disappears from the person's Tasks until it can be projected again. That is better than losing all reads, and the operator log line names it.
- In an authoritative window a skipped task that was shown before is removed, and the client takes a new snapshot. This is the same as a task leaving the window.
- Operators still see a server bug in its own data as `400 invalid_payload` in the access log on routes this change does not touch.
