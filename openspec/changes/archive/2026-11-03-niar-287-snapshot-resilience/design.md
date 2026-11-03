# Design

## The failing sequence (before)

1. `POST /processes/commands` admits a start with origin `{type: "meeting", conversationId, requestId, meetingId, recordDigest, selectedTask?, sourceBindings}` (`ProcessStartOriginSchema`).
2. The native run succeeds with output.
3. The next snapshot (`GET /v1/{ws}/snapshot?…&tasks=agent-process-work/3`) runs `bridge.integrations.taskWindow` → `createProcessTaskProjection.project` → `projectOne` → `prepareProcessOutput`.
4. `ProcessOutputReferenceSchema.parse({…, origin: admission.origin})` throws a `ZodError`, because `ProcessOutputOriginSchema` is `card | command`.
5. `failure()` in `apps/fixture-server/http.ts` maps a `ZodError` to `400 invalid_payload` and does not log it. The snapshot, events, commands and voice routes all build the window first, so they all fail.
6. `ClientSession` → `offline`, retried with back-off. The run stays in the window (at most 400 roots, pending first, then newest), so the person stays offline.

## Decisions

### D1. The output reference names a meeting origin

`ProcessOutputOriginSchema` gains `{type: "meeting", conversationId, requestId, meetingId, recordDigest}`. `prepareProcessOutput` maps the admission origin to this shape (`outputOrigin`). The selected task and the source bindings are left out: the reference only says where the run came from. The admission still holds them, and the reference digest binds the run anyway.

Alternative considered: mark every meeting run's output unavailable. Rejected, because the person could then never see the output of a meeting run.

Alternative considered: copy the full meeting origin into the reference. Rejected, because the reference then depends on start-form details (field names in `sourceBindings`) that output reading does not need.

Breaking change: older phone builds parse `WorkItem` with the old reference schema. They only receive output references with `tasks=agent-process-work/4`, and the pilot needs no compatibility with old builds.

### D2. Output that cannot be referenced is held back, not the task

`prepareProcessOutput` uses `safeParse`. If it fails, it returns `{available: false, reason: "invalid"}` and logs `process_output_unreferenced` (run id, origin type). `readProcessOutput` then answers `403 process_output_unavailable`, as it does for other invalid output. `projectOne` also guards the call: an unexpected error that does not belong to the whole request gives `outputUnavailable: "invalid"` and logs `process_output_skipped`.

### D3. One task never fails the window

`apps/server-identity/task-projection-guard.ts`:

- `requestLevelFailure(error)` is true for `IdentityError` 401 or 503, `identity_forbidden`, and an `AbortError`. These still fail the read. A changed actor or a revoked device must not look like an empty task list, and `task_projection_changed` / `identity_unavailable` stay retryable.
- `projectOrSkip(kind, id, fn)` returns `null` and logs `task_projection_skipped` {kind, runId, error} for anything else.

It is applied in two places:

- Process roots in `createProcessTaskProjection.project`.
- Chat roots in `mastra-runtime` `projectTasks`, only for the window listing. A stored run that fails `DomainCommandSchema` is skipped, and per-state projection uses `Promise.allSettled` so the existing body is unchanged. `readTask` (one task by command id) still fails as before.

The window's `validate()` still observes all roots, so a skipped task does not make the window look stale.

### D4. `syncNativeWork` publishes what it can

Window-level checks still throw: more than 400 items, duplicate ids, and a non-authoritative delta over budget. The engine then filters the items before choosing which to keep:

- WorkItem schema failure → `invalid_work_item`.
- Not native, or demo → `not_native_work`.
- Its chat cannot be found as live, stored, deleted or archived (`loadConversation`, then `deletedConversations.shell`) → `unknown_conversation`. The resolved shells are cached and pushed when the item is published, as before.

Each skip logs `native_work_skipped` {runId, reason}. A skipped item is not in `keep`: an authoritative window removes an earlier copy, and a delta leaves an earlier copy unchanged.

A process answer whose message id is already used by a different message no longer throws `process_answer_history_conflict`. The existing message stays, the conflict is logged, and the task is still published.

Alternative considered: keep the last good copy of a skipped task in an authoritative window. Rejected, because it would show a task state the server can no longer prove. Skipping matches a task leaving the window, which clients already handle.

### D5. Logging

All new lines go through `operatorLog` (enabled with `NIARO_LOG=1`). They contain only fixed event names, a task kind, the run id (an opaque server id), a fixed reason, or an error class or `IdentityError` code. They never contain messages, output, prompts or credentials.

## Verification

- `tests/meeting-process-integration.test.tsx`: after a reviewed meeting run succeeds, the session receives the succeeded process work item. No snapshot or events read answers ≥ 400, and the session stays online. This fails before D1 to D3.
- `tests/process-output.node.ts`: a meeting origin gives an available output with the five-field meeting origin. An origin the reference cannot name gives `{available: false, reason: "invalid"}`. This fails before D1 with a `ZodError`.
- `tests/process-work-items.node.ts`: a process root whose projection throws, and a stored chat run its schema rejects, are skipped and logged. The healthy process still publishes through `taskWindow`, and `validate()` holds. `identity_unavailable` (503) and `identity_forbidden` still fail the read. This fails before D3.
- `tests/native-task-window.node.ts`: invalid, non-native and unknown-chat items are skipped and logged while the rest publishes, a delta keeps the earlier copy, and a conflicting answer message is kept and logged while the task publishes. This fails before D4.
