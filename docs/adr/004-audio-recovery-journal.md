# ADR 004 — Explicit recovery of interrupted local recordings

Date: 2026-09-23. Status: accepted for the isolated audio spike. Extends [ADR 003](003-audio-emulator-spike.md).

## Decision

Persist one versioned JSON journal under `agent-client.audio.journal.v1`. It contains optional last-saved metadata and entries `{uri, status, startedAt}`, where status is `pending`, `finished` or `ignored`. A single AsyncStorage `setItem` commits the saved pointer and entry status together, avoiding separate writes for finalization and pending-entry removal. This is not a filesystem transaction or a guarantee against device power loss.

After native preparation supplies the URI, await the pending-entry write **before** calling record. Failure prevents capture and requests native cleanup. A permission/preparation/journal write completing after backgrounding cannot start capture. Failed cleanup retains an explicit Stop path. Successful Stop commits the finalized metadata and finished entry together. If that commit fails, the file remains visible for the current session and the pending entry supports discovery on restart.

Read the legacy `agent-client.audio.last-recording.v1` only when the new journal is absent. Its last file becomes a finished entry in memory, persisted on the next mutation; the old key is left untouched. Invalid JSON, unknown versions, invalid schemas, unsafe paths or a storage read failure block recording and recovery mutations rather than overwriting existing details. A retry control handles transient read failures.

On startup, inspect pending entries plus files directly in the private document `Audio` directory matching the native `recording-UUID.m4a` name. Reject remote paths, traversal, encoded path components, nested children and foreign roots. Finished/ignored files and the last saved recording are excluded. Legacy orphan files are labeled unindexed because their recording history is unknown. Missing/empty pending files remain visible with an explanation. Startup never requests microphone permission or plays a file.

Recovery requires explicit Check file, then Keep recovered portion. The check creates a temporary native player, waits at most five seconds for a finite positive duration and loaded state, and always releases it without calling play. This establishes player readiness, **not full decoding or completeness**. Recovery rechecks the file size and native readiness, then commits it as interrupted. A failed commit preserves the candidate and previous saved recording. Operations are serialized; repeated clicks cannot start concurrent capture or recovery. Hide persists an ignored entry and never deletes the file. Playback remains a separate manual action.

## Evidence and limits

See the [audio runbook](../../spikes/audio/README.md) for reproduced force-stop recovery, external full decoding of the recovered portion, playback, restart, unreadable-file and hide checks on one Android emulator. Recovery cards have EN/CS text, state stories, component tests and native visual inspection. Session tests cover storage failures, schema/path rejection, interruption races, changed files and repeated actions. Native adapter tests cover timeout, resource release and absence of playback.

No native dependency or app package changed in this step; the existing audio development build ran the updated JS. The main Meetings tab is still a placeholder. Physical phones, iOS, real speech, long recordings, route changes and power-loss durability are unverified. Journal/files are not encrypted; automatic deletion, retention limits, recording history, upload and transcription remain outside this slice. Pending entries and retained files currently grow until a future retention policy is implemented.
