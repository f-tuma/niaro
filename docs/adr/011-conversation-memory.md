# 011 — Scoped short-term meeting context

Date: 2026-09-25. The user accepted the improved Gemini transcript and requested better context and short-term memory. Transcription is unchanged; this extends the server-side text interpreter used by typed and transcribed messages.

## Decision

Keep one bounded focus for `conversation-1` inside the authenticated account/workspace workflow record. It contains contact identity/name, local date, local time, duration, optional explicit title, optional work ID, timezone, history boundary and activity timestamp. Partial requests survive subsequent turns and server restart. Thirty minutes without relevant activity, a timezone change or a backwards clock makes implicit focus unavailable. Expiry is a retrieval boundary, not physical deletion of stored conversation history.

The contextual model wire contract is exactly `{kind, patch, reply}`. A strict `meeting_patch` uses `new` or `continue`; null fields mean omitted information, not deletion or a guessed default. The server merges fields, validates future dates/DST and supported contacts, and asks for missing facts. Only a complete request defaults an omitted duration to 30 minutes. Relative language is interpreted by the model against the current structured facts and server time. This remains model-dependent interpretation, not guaranteed recognition of every Czech or English phrase.

Explicit creation wording resets context before inference and again before merging. A fresh bare Peter/Petr remains ambiguous even if the model invents one of the two supported surnames. These are narrow deterministic guards for the current synthetic directory, not a general entity resolver. Other unsupported names remain unresolved. Ordinal contact choices are interpreted from the current ordered options. `new_topic` and successful CRM results clear meeting focus; they do not cancel work. Up to six bounded recent messages supplement structured facts; they cannot recreate expired focus.

Current proposal/input/draft data is authoritative. A continuation updates the same unapproved proposal and increments its revision, invalidating approval of older details. Manual card edits are projected before inference. An ambiguous requested participant correction can retain a requested time separately while the visible proposal stays unchanged; this pending correction is valid only for the captured proposal revision. Approved, executing, completed, cancelled or otherwise locked work cannot be changed conversationally. Chat cannot authorize a calendar write.

An immediately preceding unfinished future card can supply compatibility context when older storage has no memory field. Automatic recovery does not scan past newer replies or completed work. An explicit `poslední schůzka` / `last/latest/most recent meeting` reference can select the most recently created work in the same conversation even after clarification, a topic reset or expiry. It selects the latest work even when locked; it never silently chooses an older editable one. This is a specific reference resolver, not arbitrary historical task search.

## Persistence and concurrency

`conversationMemory` is an optional private field in the existing version-2 SQLite workflow state; public `agent-client/0.4-fixture` and snapshots are unchanged. It is scoped with the existing workflow record, never accepted as client scope/identity. Inference holds no transaction. Authentication/cancellation and the captured cursor are checked before one atomic workflow/memory/receipt commit. Replayed commands do not reapply relative changes or consume another model call. Conflicts leave memory unchanged. No new dependency, client bundle change or native rebuild is needed.

Back up the entire data directory while stopped before upgrade. Older stored records load without conversion. An older binary does not understand extended private state; use the matching backup for rollback rather than opening new state with old code.

## Validation and limits

- `npm run check`: 327 tests / 43 suites, clean lint/types. Focused coverage includes partial facts, restart, bounded history, scope isolation, manual edits, pending corrections, locked work, expiry/timezone, explicit latest references, concurrent approval, revocation and exact replay.
- `npm run test:memory`: opt-in real GPT-4.1 mini via the existing OpenRouter configuration and shared cap, an isolated synthetic account and no calendar/CRM adapter. Final sequence passed all 13 CS/EN turns, including two-hour rollover past midnight; 13 paid calls, API-reported $0.003410, zero external operations. Replay made no inference call. Earlier exploratory runs exposed prompt/schema conflicts and surname guessing; fixes preceded this final sequence. A single successful sequence is not a broad quality benchmark.
- Browser QA used bundled Playwright because the Browser plugin is unavailable. CS 393×852 and EN 1001×1037 verified the actual client with a controlled model and real local workflow API: one proposal/card, revised 15:00 and 45-minute details, zero operations, no overflow or application errors. No native or physical microphone retest was performed for this server change.

Memory currently covers one working meeting with the two synthetic contacts. Real CRM participant matching, long-term preferences, multiple concurrent conversational focuses and edits to existing calendar events remain outside this change. The OpenRouter expiry/cap and expired Twenty configuration are unchanged.
