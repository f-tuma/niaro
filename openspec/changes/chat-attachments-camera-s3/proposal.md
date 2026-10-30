# Proposal

## Why

People need to bring files and camera photos into the same assistant on mobile and web, including photographed text and business cards that become reviewed CRM contact proposals. Today chat accepts text, task references and mentions; it has no general file ingestion or image-model input path.

## What Changes

- Add a compact attachment menu, camera/gallery/file selection, previews, upload progress and retry on both clients; web also supports drop and paste.
- Keep original attachments in chat history and make them available to the same person on another device. Archive retains them; deleting the chat revokes access and durably removes originals and derivatives.
- Add one provider-neutral S3 adapter. Hetzner Object Storage is the primary hosted target; RustFS is the chosen local-test and self-hosted target. Custom endpoints, regions and addressing styles support other implementations of the documented S3 subset.
- Add an opt-in RustFS Compose profile, private bucket provisioning, operator configuration and storage-aware backup/restore guidance. **BREAKING deployment assumption:** attachments live outside Niaro's single data volume when enabled; existing databases and meeting audio remain where they are.
- Use FOSS document conversion for common documents and OCR, plus explicit image-capable model handling for photographs. Use the qualified Docling/MarkItDown comparison as conditional research evidence before pinning the converter, source contract, isolation and resource policy.
- Turn a business card into editable contact details and a proposed operation through an available CRM action, with duplicate checks where supported and explicit confirmation before a write.
- Preserve the existing server authority, permission checks, inference budget, idempotency and unknown-outcome semantics.

## Capabilities

### New Capabilities

- `message-attachments`: authenticated upload, immutable attachment references, conversion, camera/file UX, cross-device history, retention and business-card interpretation.
- `object-storage`: provider-neutral S3 configuration, private object access, compatibility checks and durable deletion.

### Modified Capabilities

- `chat`: attachment-only messages, edit/retry behavior, attachment-preserving archives and deletion receipts.
- `models-and-providers`: explicit image-input capability discovery and dispatch checks.
- `deployment`: external attachment storage, optional RustFS and complete backup/restore boundaries.

## Impact

Protocol and client-core, mobile `App`/composer, web `chat-next`, identity/app HTTP routes and chat lifecycle, Mastra model transport, model catalog and budget sizing, Docker/Compose and backup tooling. New dependencies will include an S3 client and native camera/gallery support; the converter and its model/dependency licenses remain a checkpoint decision.

Confirmed by the owner: mobile + web, restrained copy, broad practical file support, business-card CRM proposals with confirmation, originals retained across devices and deleted with chat, configurable S3 with Hetzner and RustFS.

Non-goals: a document-management product, automatic CRM writes, live camera/video analysis, audio-pipeline replacement, migration of existing meeting recordings to S3, generic archive execution, automatic permanent-memory indexing, or claiming every vendor-specific S3 feature works.

This is delivery planning. Stop this planning pass with coherent reviewable artifacts; implementation and external-service verification are not performed by drafting them. Main risks are extraction quality, resource use, multimodal budget accounting, upload/deletion races and orphaned or retained object versions.

The next bounded server checkpoint is specified in design decisions 3/7 and tasks 3/4: strict negotiated transfer/retention API, immutable chat-generation content with separate message bindings, durable workflow acceptance, conservative native-handoff recovery and tombstone/purge/backup boundaries. It is default-off, can truthfully expose retention-only acceptance, and implements no converter, client UI or CRM path. Unknown dispatched S3 PUTs remain quarantined and may prevent physical purge/location replacement indefinitely; no generic-S3 settlement or cleanup override is implied.

The accepted phase-2 storage foundation is refreshed separately from the lifecycle-only design delta. This remediation selects strict native pre-preparation binding under the existing owner, backward-compatible operator backup modes and explicit locked restore verification/reconciliation/activation, and a measured transfer-memory gate. These are proposed design fixes pending a bounded fresh recheck; tasks 3/4 remain unimplemented.
