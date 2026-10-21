# ADR 018 — Native saved Memory and durable public chat identity

Date: 2026-10-07. Status: implemented; isolated acceptance passed. Live cutover and physical acceptance are separate.

## Native saved Memory

The `memory` plugin keeps its explicit remember, revise, forget and inspection
contract. Mastra Memory now owns the canonical saved payload, including content,
source and trust. Niaro identity storage owns scope, policy, lifecycle, revision,
generation, references and the existing request receipts. It no longer stores a
second plaintext canonical payload. This extends ADR 016; its authorization,
explicit intent, source lifetime and context invalidation rules remain applicable.

A separate Memory instance uses the existing native LibSQL storage and
thread-scoped working memory. It is not attached to an Agent. Each immutable
item payload has a distinct thread and resource, a constant title and an
authenticated encrypted envelope. AES-GCM binds the item, organization,
workspace, user, sharing scope, resource, thread, creation and expiry; HKDF uses
the original identity secret with a distinct saved-memory context. The server
identity is also bound by that original secret. Semantic recall, observational
memory, automatic title generation and model-managed updates are disabled here.
Authorized Niaro tools supply decrypted, attributed data to the native agent.

Native payload I/O occurs outside the identity mutation queue. Existing request
receipts stage an immutable reference, native write/readback proves the payload,
and a fresh synchronous policy check publishes the row and domain checkpoint
atomically. Interrupted preparation remains unpublished and is reused only by
an exact request retry. Reference-level serialization prevents preparation from
recreating an erased payload. Erasure first revokes the whole revision lineage,
then verifies native removal before returning success. Durable pending erasure
can be resumed. Minimal tombstones preserve retry identity; they cannot recreate
content. Deleting saved Memory does not delete independently retained chat or
execution transcripts.

Populated legacy plaintext storage refuses ordinary startup before schema
changes. The explicit copied-tuple tool checks, migrates or exports the current
native state into a fresh private output. Input bytes and modes remain unchanged.
Original IDs, dates, policy, generation and request receipts are preserved.
Reverse export represents current facts and deletions, including changes made
after migration. It is a Memory-format export, not proof that an old server
binary can operate the whole new tuple. Complete physical-schema and bounded
row/metadata checks precede SDK parsing. Manifest owner-lock fields are carried
but do not certify that a live owner stopped or that databases share a checkpoint.

## Public chats and native continuation

The public chat directory and paginated display transcript live in workflow
storage under the full authenticated Scope. They are distinct from raw Mastra
threads: one public chat may accumulate several native segments as authority
changes. Server catalog continuation and domain locks are per public chat;
A → B → A preserves the original authorized context instead of sharing one
workspace-wide continuation cursor. Each tool still checks current permission.

Creating a chat is an explicit idempotent command through the existing outbox.
Opening history, choosing a chat, pinning it and reading old text invoke no
model or business operation. A read-only archive of legacy `session:new` keeps
stable display IDs and cannot rebind a pending native task. Historical pages
contain public text, not replayable action controls. Current interactive cards
come from fresh authorized task/snapshot projections.

The working projection has an explicit negotiated profile; the directory is
paginated independently of the old 50-conversation snapshot bound. Unsupported
clients receive a clear protocol response instead of a silently truncated
projection. Mobile pins are local presentation preferences scoped by connection
identity. Drafts, history requests and audio callbacks are owned by the selected
chat and generation, so late work in A cannot overwrite B.

## Framework references

The implementation uses the installed pinned SDK and its public Memory APIs.
Mastra documents [thread/resource identity](https://mastra.ai/docs/memory/overview)
and [working-memory scope](https://mastra.ai/docs/memory/working-memory).
The dependency versions are unchanged by this work.
