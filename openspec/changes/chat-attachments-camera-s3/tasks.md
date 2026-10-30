# Tasks

These checkpoints implement the design after acceptance and independent review. Tasks 2.1–2.4 are implemented, verified against isolated RustFS and accepted by independent final review; later implementation, converter and hosted-provider evidence remain pending. Keep evidence tied to the tested revision and use synthetic documents/contacts.

## 1. Review and bounded converter selection

- [ ] 1.1 Link the change to a project tracker issue, reconcile integration ownership with `niar-240-remove-fixture-interpreter`, and obtain the required fresh SPEC/EGM design review; verify that `reviews/` records findings, dispositions and the exact reviewed design before implementation starts.
- [ ] 1.2 Build the bounded synthetic Czech/English document corpus described in the design and compare Docling with MarkItDown locally; verify a results artifact records field/table accuracy, omissions, source references, unreadable-input behavior, latency, peak RAM and packaged size for each candidate.
- [ ] 1.3 Select and pin one converter plus required local OCR assets, record code/model licenses and supported formats, and update the design with measured limits; verify fixtures meet the stated fidelity criteria and review any resulting design change before converter integration. If neither candidate fits, revise the design instead of silently reducing required support.

## 2. Portable S3 storage and RustFS deployment

Phase-2 placement, interfaces and evidence targets are specified in design decisions 1–2 (C1/R1/R2/K1/K2 remediation cleared before code; final phase-2 acceptance in `reviews/storage-final-review.md`). No later ingestion/conversion review finding is resolved by this checkpoint.

- [x] 2.1 Add server-only S3 startup configuration and secret-file loading with explicit credential mode, TLS/private-HTTP policy and stable storage-location identity; verify production configuration tests cover missing/invalid settings, secret redaction, credential rotation and refused location replacement with retained objects/jobs. Document the settings in `.env.example` and deployment guidance.
- [x] 2.2 Implement the narrow put/head/get/range/delete adapter with immutable opaque keys, independent SHA-256 checks and safe error mapping; verify adapter tests cover checksum mismatch, partial reads, not-found, denied access and network uncertainty without leaking secrets or silently choosing another store.
- [x] 2.3 Add the opt-in RustFS Compose profile to both deployment variants, pin the image, persist its data and bootstrap a private bucket with separate application credentials; verify default Compose starts no RustFS, the selected profile survives container recreation and development ports/console are not publicly exposed. Document local and self-hosted startup commands.
- [x] 2.4 Add an explicit connection probe and reusable S3 contract suite, including bucket versioning/retention prerequisites and isolated probe cleanup; verify the suite against RustFS and verify the existing offline configuration checker makes no network calls. Document invocation for Hetzner/custom endpoints and record live results only when a designated test bucket is supplied.

## 3. Attachment protocol, ownership and transfer

- [ ] 3.1 Add versioned attachment metadata, advertised capabilities/limits and message attachment references to the protocol and storage migrations; verify old text-only data still loads, file-only requests validate, binary bodies stay outside command JSON and unsupported clients receive the specified attachment-history result. Document the negotiated contract.
- [ ] 3.2 Implement durable staging identities and authenticated creation/upload/status/draft-removal routes with bounded temporary spooling, byte inspection and digest binding; verify production route tests cover foreign scopes, renamed executables, oversized inputs, matching retries, changed bytes and a lost upload response.
- [ ] 3.3 Bind uploaded attachment sets atomically with accepted messages and receipts in the production path; verify concurrent sends, repeated transport IDs, failed transactions and stale account/workspace/draft generations cannot duplicate messages or claim another draft's files. Keep selection/upload free of inference.
- [ ] 3.4 Implement authorized original/preview streaming through Niaro with safe response headers and current tombstone checks; verify revoked sessions, foreign IDs, deleted chats, range reads and active-content downloads. Document the routes without exposing storage keys or credentials.
- [ ] 3.5 Expose upload and interpretation states independently through client-core, including explicit retry and cancel/remove; verify state tests preserve successful files after a sibling failure and reconnect never resubmits a chat request.

## 4. Retention, deletion and recovery

- [ ] 4.1 Preserve message/file bindings through archive, restore and main-chat rollover, and scope fixed-chat clearing by generation; verify lifecycle tests also cover Again/Edit attachment reuse and independent ownership when copying into another chat.
- [ ] 4.2 Add transactional tombstones, receipt/context scrubbing and durable deletion jobs for originals and all derivatives; verify chat deletion immediately blocks reads/model use while preserving existing deletion conflicts and replay rejection.
- [ ] 4.3 Implement bounded cleanup retries, abandoned-upload expiry and guards around in-flight upload/converter commits; verify crash/outage/race tests recover pending work without orphan resurrection, extra inference or CRM actions. Document staging retention and operator-visible pending/failed deletion states.
- [ ] 4.4 Extend backup metadata with external-object locations and manifests plus a quiescence mechanism for attachment mutation/cleanup; verify a backup taken under the documented procedure has a consistent object set and a database-only backup is clearly identified as incomplete for originals.
- [ ] 4.5 Implement restore verification before attachment serving/cleanup resumes; verify a coordinated RustFS/database round trip, missing-object detection and rejection of a replacement bucket. Document Hetzner and RustFS backup/restore procedures, older-backup retention consequences and rollback boundaries.

## 5. Local document and image processing

- [ ] 5.1 Add a bounded conversion worker with a versioned result contract and pinned offline assets, outside request handling and without application credentials/network access; verify timeout, memory/output limits, termination and malicious embedded-resource fixtures. Document packaging and runtime resource requirements.
- [ ] 5.2 Integrate the selected converter for PDF text/scans, DOCX/XLSX/PPTX, CSV/TSV, TXT/Markdown and supported raster images; verify the approved corpus preserves page/sheet/slide references, clean values, units and table relationships. Publish only fixture-verified formats and explicit protected/unsupported/partial outcomes.
- [ ] 5.3 Generate safe image previews/model derivatives with correct orientation, readable detail and no location metadata while retaining the uploaded original; verify rotated/large/malformed image fixtures and derivative lineage cleanup. Document picker conversion semantics, including HEIC/HEIF.
- [ ] 5.4 Connect durable processing jobs to accepted messages, bounded source-addressable excerpts and user-visible retry/failure states; verify processing is never triggered merely by selecting/uploading, a failed extraction keeps its original, and retries/late results respect deletion and budget admission.

## 6. Image-aware model routing and budgeting

- [ ] 6.1 Extend provider discovery, stored model capabilities and admin controls with explicit image-input support; verify unknown/missing modality metadata, explicit exclusion, manual configuration and old-catalog migration without model-name heuristics. Document capability configuration and text-only limitations.
- [ ] 6.2 Extend the production model-message and Mastra serialization path to accept owned image derivatives while preserving text history; verify multipart payloads, ownership checks and unsupported-model handling with provider fakes, without silently switching providers or dropping image evidence.
- [ ] 6.3 Add conservative image-aware admission to the existing root-run budget and bounded extracted-text accounting; verify budget exhaustion, unknown image-cost fallback, repeated processing and long-document cases. Demonstrate that base64 size is not treated as image tokens and no converter/provider plugin bypasses the configured inference path.

## 7. Mobile composer and camera

- [ ] 7.1 Extend the paperclip sheet with Camera, Photos and File while preserving the task action, and connect system pickers to client-core attachment drafts; verify cancellation, denial, permission recovery and account/workspace switching preserve the correct draft. Add concise Czech/English labels and accessible control names.
- [ ] 7.2 Add preview/retake/rotation, compact file chips, upload progress and remove/retry states to the existing composer; verify file-only send, long filenames, large text, keyboard/safe-area layout and processing pet states at narrow and normal phone widths without obstructing text or OpenUI.
- [ ] 7.3 Render persisted attachments and original downloads in mobile history, including archive and Again/Edit behavior; verify reload, reconnect, unavailable files and generation clearing with production client state tests and the existing mobile journey checks.
- [ ] 7.4 Exercise native capture/import and interruption behavior on Android and iOS, including HEIC conversion and release of any camera resources on dismissal/background; record device evidence separately from emulator-only checks and document remaining platform limitations before marking mobile capture complete.

## 8. Web composer and camera

- [ ] 8.1 Add file chooser, drag/drop and image paste to the web draft using the shared upload contract; verify duplicate selections, failed transfers, stale callbacks and existing in-memory draft ownership with web composer tests. Keep the existing text allowance and explicit-send behavior.
- [ ] 8.2 Add mobile-browser capture and an explicitly opened camera preview where supported, with file-selection fallback; verify secure-context requirements, denied permission, cancel/background cleanup and retained draft text. Document supported capture paths and use concise localized copy.
- [ ] 8.3 Render compact draft chips and persisted attachment previews/downloads with appropriate accessible states; verify keyboard navigation, large text, 320/390/520 px layouts and desktop layout, including file-only messages, archive and Again/Edit. Record browser evidence for the integrated composer.

## 9. Reviewed business-card contacts

- [ ] 9.1 Produce source-linked proposed contact fields from card images and render an editable OpenUI contact proposal; verify synthetic Czech/English and unreadable-card cases leave uncertain values unresolved and do not invent missing fields. Document extraction limitations without adding permanent explanatory UI text.
- [ ] 9.2 Connect duplicate lookup and proposal submission to the existing permitted CRM catalog/actions; verify duplicate, unknown lookup, disconnected/read-only CRM and missing-action cases with test adapters. Do not use the legacy TEST-contact fixture as the production writer.
- [ ] 9.3 Bind CRM approval to the reviewed proposal revision and reuse existing idempotency/unknown-outcome handling; verify an edited phone number invalidates consent, no write occurs before approval, and a lost response does not cause an automatic duplicate contact. Document that deleting the source chat does not delete an approved CRM record.

## 10. Integrated release evidence

- [ ] 10.1 Run a cross-device journey against RustFS: mobile capture, explicit send, web original download, reviewed CRM proposal using a test adapter, archive/restore, and deletion during a storage outage; verify access revocation immediately and physical cleanup after recovery/restart with matching hashes and no duplicate actions.
- [ ] 10.2 Run the existing required project checks/builds and strict OpenSpec validation, then obtain independent checkpoint/final-diff review tied to the tested revision; verify all findings are resolved or explicitly dispositioned and report actual RustFS/Hetzner evidence separately. A missing live Hetzner run must remain an explicit verification gap.

## Workflow follow-up

- Sync and archive the accepted change only after implementation and review requirements are satisfied; archive is not evidence of deployment.
- Keep real endpoint credentials and private files outside review artifacts and fixtures. Live hosted verification uses a designated test bucket.
