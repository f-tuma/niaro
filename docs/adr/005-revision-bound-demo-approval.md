# ADR 005 — Revision-bound approval in the synthetic meeting flow

Date: 2026-09-24. Status: implemented for the fixture profile only.

## Decision

Resolving a contact question now prepares an `ActionProposal`; it does not finish the work or authorize an operation. The proposal exposes the meeting title, synthetic recipient name/address, start/end time and UTC zone. The client supplies the effect explanation, trusted source frame, revision and explicit confirmation control in shared Chat/Tasks UI.

The server accepts a strict `proposal.decide` command with proposal/work/conversation IDs, the expected proposal revision and `approve` or `reject`. It validates current state and future start time before creating an `Operation`. That operation retains an immutable copy of the approved parameters, the accepted proposal revision and the command's idempotency key. Proposal status changes increment its entity revision; the approval retains the _prior_ reviewed revision. This status-only acknowledgment must not be displayed as a change to the approved content.

The fixture advances operation `pending → executing → succeeded` on separate worker ticks, persisting each transition. Success has only a `simulated` result. No external API, calendar invitation or email is called. Unknown/failed result states can be displayed but are not a production execution/reconciliation implementation.

## Edits, races and replay

- A visible proposal revision changing while under review disables confirmation until the user reviews the current details. Local edits remain visible while a server update arrives; an explicit review resets the edit view.
- `proposal.revise` carries an expected revision, a listed contact ID and a UTC start time. The server derives the recipient and a 30-minute end time; arbitrary recipients or undeclared parameters are not accepted.
- Revising an awaiting proposal increases its revision. Revising an approved _pending_ operation cancels that attempt, removes its queued start and clears consent. A fresh explicit approval is necessary for the new revision. The old attempt and its original parameters remain in history.
- Once an operation is executing or terminal, edits/revocation are rejected. This fixture makes no promise to undo an effect that has already started.
- Duplicate command IDs/keys with the same payload return the existing outcome. Different commands cannot create another operation for the same reviewed revision, even with a fresh idempotency key. Reusing an ID/key for different content is rejected.
- A lost response keeps the exact command locally for manual retry. Reconnect, render, event replay and ambiguous chat text such as “yes” never grant approval or automatically send a new operation.
- Snapshot validation checks proposal/work/operation references and the approved parameter copy. Event batches are validated after applying the complete batch and before publishing it to UI.

## Compatibility and persistence

The wire profile is now `agent-client/0.2-fixture` because snapshots, events and commands gain new entity types and fields. Client and fixture server must be updated together. Old cached snapshots are rejected and refreshed; valid existing pending input/message commands remain supported.

Fixture database version 2 migrates validated version 1 data: existing conversations, contacts, receipts and completed work remain, while unfinished contact work progresses into the new proposal stage. The HTTP server retains an original `.v1.bak` before loading a legacy file. The next successful state commit stores version 2. Migration does not retroactively authorize an operation for older work.

This remains one-process JSON persistence with bounded receipts/events, not a production transaction store. The endpoint supplies synthetic scope, not authenticated identity. Before a real integration, implement authenticated scope, durable transaction/outbox storage, authorization, consent audit and effect reconciliation. No general exactly-once external-effect guarantee is made.

## Verification

Engine, session, schema and component tests cover stale revisions, duplicate confirmations, pending edits, execution-time conflicts, persistence rollback, legacy migration, lost receipt/manual retry, passive rendering and EN/CS controls. Shared Storybook states include awaiting, changed, offline, uncertain delivery, pending, executing, success, rejected, failed and unknown result.
