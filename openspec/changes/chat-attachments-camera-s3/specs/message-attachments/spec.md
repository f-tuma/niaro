## Purpose

Let a person send documents and camera photos to the assistant, retain their originals across devices, and use their content without bypassing existing action permissions.

## ADDED Requirements

### Requirement: Mobile and web selection

Both clients SHALL offer file selection and image capture/import from the composer. The web SHALL also support file drop and image paste. Selecting, capturing or uploading SHALL NOT send a message or start inference. Camera denial or cancellation SHALL preserve the draft and provide a file-selection alternative.

#### Scenario: Camera cancelled
- **WHEN** the person cancels camera capture after writing a draft
- **THEN** the draft remains and no message or model request is created

### Requirement: Compact attachment draft

Selected files SHALL appear as compact previews or filename chips with remove, upload progress, failure and explicit retry. Sending SHALL remain disabled while any included file is not uploaded. Limits and unavailable capabilities SHALL be supplied by the server; both clients SHALL keep the composer usable with long names and large text.

#### Scenario: One upload fails
- **WHEN** one of three selected files fails to upload
- **THEN** the draft and successful files remain, and the person can retry or remove the failed file before sending

### Requirement: Authenticated upload and ownership

Upload, status, draft removal and original/preview download SHALL require the current workspace app credential and matching owner scope. Clients SHALL reference server-issued attachment IDs, never storage keys or arbitrary URLs. An attachment from another person, workspace or deleted chat SHALL be unavailable without revealing its metadata.

#### Scenario: Foreign attachment ID
- **WHEN** a member submits or downloads another member's attachment ID
- **THEN** the request is refused and no file, metadata or model input is returned

### Requirement: Bounded and verified input

The server SHALL validate actual file content, size, supported type and independently computed digest before marking an upload complete. It SHALL enforce separate file/message, decoded-image, page, processing-time and extracted-output limits. Filenames SHALL be display data only. Unsupported or protected content SHALL have an explicit outcome, not an empty successful interpretation.

#### Scenario: A renamed executable
- **WHEN** an executable is uploaded with a PDF name and MIME type
- **THEN** it is refused without being interpreted or executed

### Requirement: Immutable upload retries

An upload identity SHALL bind immutable bytes by size and digest. A repeated identity with the same bytes SHALL resolve to the same result; different bytes SHALL conflict. Network uncertainty SHALL remain recoverable without a duplicate message, and automatic reconnection SHALL NOT resend a chat request.

#### Scenario: Upload response lost
- **WHEN** the object was stored but the upload response was lost
- **THEN** status or an explicit retry recovers the same attachment identity without starting inference

### Requirement: Atomic message attachment binding

Sending SHALL atomically bind available immutable content to one accepted message and receipt in its chat generation. A stale draft/account/workspace SHALL NOT claim files. Bytes SHALL travel outside the unchanged 64 KiB command limit. Empty text SHALL require at least one file; files SHALL NOT reduce the 4,000-character text allowance.

#### Scenario: Account changed during upload
- **WHEN** an upload callback arrives after the person switched accounts
- **THEN** it cannot attach the old account's file to the new account's draft

### Requirement: Practical document support

The initial supported set SHALL include common raster photos, PDF text/scans, DOCX, XLSX, PPTX, CSV/TSV, TXT and Markdown. Conversion SHALL preserve source page/sheet/slide references and table relationships where present. Additional formats SHALL be advertised only after fixture verification. Partial extraction SHALL be identified as partial.

#### Scenario: Multi-sheet spreadsheet
- **WHEN** the person asks about a supported workbook
- **THEN** extracted values retain sheet and header context, and any omitted content is explicitly identified

### Requirement: Original and derivative separation

The system SHALL keep the uploaded original distinct from previews, normalized images and extracted content. Model images SHALL retain readable detail and correct orientation while omitting location metadata. The client SHALL disclose format conversion by the picker when it cannot preserve the source file's original bytes.

#### Scenario: Rotated camera photo
- **WHEN** a photo has orientation metadata
- **THEN** its preview/model derivative is correctly oriented and the uploaded original remains available

### Requirement: Untrusted conversion

Document content SHALL remain untrusted source material. Conversion SHALL NOT execute macros/formulas, fetch embedded resources or grant action authority. Local conversion SHALL use resource limits and no application credentials; a model-based step SHALL use the existing configured model path and inference budget.

#### Scenario: Instructions embedded in a PDF
- **WHEN** a PDF contains text asking the assistant to bypass approval and send company data
- **THEN** that text grants no authority and existing action validation and approval remain enforced

### Requirement: Visible processing and bounded inference

Original upload completion and successful interpretation SHALL be distinct states. Failed conversion SHALL preserve the original and offer an explicit retry when possible. Model dispatch SHALL account for document and image input within the existing root budget, without treating base64 byte length as image token usage or silently switching providers.

#### Scenario: Extraction worker times out
- **WHEN** processing exceeds its configured limit
- **THEN** the original remains downloadable, the chat reports processing failure and no unsupported success is inferred

### Requirement: Cross-device retention and archive

Attached originals and derivatives SHALL remain available to the same authorized person from both clients while their chat exists. Archive and main-chat session rollover SHALL preserve bindings with the archived messages. Unattached abandoned uploads SHALL expire under the published staging retention policy.

#### Scenario: Phone upload opened on web
- **WHEN** the person opens on web a chat containing a file sent from mobile
- **THEN** its filename, status, preview and original download are available under current permissions

### Requirement: Chat deletion erases attachment lineage

Accepted chat deletion SHALL immediately revoke attachment access and model use, remove extracted context, and durably queue deletion of originals and all derivatives. Cleanup SHALL survive storage outages/restarts without resurrecting the chat. Fixed-chat clearing SHALL affect only the cleared generation. Pending physical deletion SHALL be visible to the operator.

#### Scenario: Storage offline during deletion
- **WHEN** the person deletes a chat while object storage is unavailable
- **THEN** neither client can read its attachments and physical deletion remains queued until it succeeds

#### Scenario: Late conversion result
- **WHEN** conversion finishes after its chat was deleted
- **THEN** its result cannot restore content and any newly produced object is queued for deletion

### Requirement: Reviewed business-card contact

A business-card image SHALL be usable to prepare editable contact details with missing/uncertain fields left unresolved. A CRM write SHALL require an available permitted action and explicit approval bound to the reviewed values. Duplicate lookup SHALL use a current permitted CRM read; unavailable lookup SHALL NOT imply uniqueness.

#### Scenario: Correcting a recognized phone number
- **WHEN** the person edits a proposed contact's phone number
- **THEN** any previous approval is invalidated and only the newly reviewed values can be submitted

#### Scenario: CRM unavailable
- **WHEN** the image is readable but no permitted CRM write exists
- **THEN** the person can read/copy the proposed details and no successful save is claimed

### Requirement: Separate content and message bindings

One immutable original SHALL have independent message bindings within its owning chat generation. Again SHALL create a new request/binding; Edit SHALL change only a draft. Cross-generation copies SHALL use a new upload identity and independent object ownership, even for equal bytes.

#### Scenario: Remove a reused file from Edit
- **WHEN** a person removes a file from a draft created by editing an earlier request
- **THEN** the earlier message and every other live binding retain access to the original

#### Scenario: Equal files in separate chats
- **WHEN** equal bytes are independently uploaded into two chats and one chat is deleted
- **THEN** cleanup of that chat cannot remove or authorize the other chat's original

### Requirement: Draft ownership and absolute expiry

Drafts SHALL have server identities, revisions, generation ownership and published absolute expiry. Only available files selected in a current unexpired draft SHALL be bound on send. Removing/expiring a draft SHALL release its pins, preserve accepted bindings and durably track unreferenced originals for cleanup.

#### Scenario: Expiry races acceptance
- **WHEN** a draft expires while send and cleanup race
- **THEN** exactly one atomic decision wins, with either accepted bindings or an expired-draft refusal and no partial message

### Requirement: Strict versioned transfer contract

Attachment routes and references SHALL implement `agent-attachments/1`, reject unknown keys/versions and use authenticated binary upload outside JSON. They SHALL advertise effective upload/retention limits separately from processing availability. Unsafe originals SHALL download as attachments with no public object URL.

#### Scenario: Raw original exceeds command envelope
- **WHEN** an allowed original is larger than 64 KiB
- **THEN** its raw body can use the bounded upload route while the reference-only command remains below the unchanged command ceiling

### Requirement: Current download authorization

Every original read SHALL check current session, membership, owner, generation, binding or unexpired draft pin, and tombstones. It SHALL recheck before delivery and stop further bounded output after revocation/deletion. Foreign and tombstoned files SHALL both be unavailable; possession of an ID or hash SHALL grant no access.

#### Scenario: Revocation during a download
- **WHEN** permission is revoked after an object read starts
- **THEN** further output is stopped once the revocation is observed, while bytes already delivered cannot be recalled

### Requirement: Durable acceptance before interpretation

An attachment message SHALL receive a durable user message, immutable bindings, processing state and accepted receipt before local processing or native handoff. Accepted SHALL NOT mean interpreted. Receipt replay SHALL return the recorded state without scheduling another job, model call or business action.

#### Scenario: Acceptance response lost
- **WHEN** acceptance commits and the response is lost
- **THEN** exact replay returns that message/receipt without a duplicate user message or new paid work

### Requirement: Honest processing availability

Storage-only support SHALL report processing unavailable and an accepted original SHALL remain downloadable with blocked processing. It SHALL NOT invoke a model on the caption while silently omitting file evidence, or advertise converter/image understanding. General client activation SHALL wait for verified processing and client support.

#### Scenario: No processor installed
- **WHEN** a capability-aware client sends a file to a retention-only server
- **THEN** acceptance is visible as blocked processing with the retained original and no model request

### Requirement: Conservative native handoff recovery

The entire native handoff, including paid preparation, SHALL be durably fenced before it starts. Restart, polling and local retry SHALL NOT repeat paid work. Recorded results MAY be republished under current ownership without dispatch. Unproved outcomes SHALL stay unknown and use existing deliberate retry, budget, retirement and action approval rules.

#### Scenario: Crash before a native turn is recorded
- **WHEN** the handoff began but preparation may have spent inference before a native turn record exists
- **THEN** its absence does not authorize an automatic rerun or claim that nothing was dispatched

#### Scenario: Result exists before workflow reply
- **WHEN** the exact native result is durable but reply publication did not commit
- **THEN** it may publish once after current ownership/token checks without another provider or action call

### Requirement: Aggregate reservation admission

The server SHALL bound per-person/global drafts, staged and retained bytes/counts, active transfers and pending accepted work before accepting it. Whole declared bytes SHALL be reserved before I/O. Capacity/busy refusals SHALL be explicit, with no unbounded memory queue or automatic history eviction. Deleting/quarantined objects SHALL retain capacity until safe settlement.

#### Scenario: Last capacity slot races
- **WHEN** two uploads concurrently request the last available reservation
- **THEN** at most one succeeds and the refused upload creates no partial ownership or unaccounted object

### Requirement: Generation-fenced lineage cleanup

Accepted deletion/clear SHALL atomically revoke the affected generation, invalidate late work and durably queue object and native-context erasure. Purge SHALL never erase a fresh fixed-chat generation, restore source content, infer, or perform a business action. Physical erasure SHALL be reported separately from logical deletion, including blocked uncertainty.

#### Scenario: Late purge after fixed-chat reuse
- **WHEN** cleanup for an old fixed-chat generation runs after a fresh turn exists
- **THEN** only the old generation's objects/context are eligible and the new turn remains intact

#### Scenario: Unknown PUT after draft removal
- **WHEN** a removed draft has a dispatched PUT with unproved outcome
- **THEN** reads remain denied and purge, capacity release and location replacement remain blocked even after a missing HEAD

### Requirement: Durable native admission identity

Before native preparation, attachment admission SHALL durably bind the exact owner, generation, command, handoff and evidence fingerprint. Incomplete admissions SHALL remain distinct from complete native turns. Changed fingerprints SHALL conflict; old complete text journals SHALL remain readable.

#### Scenario: Reopen during continuity preparation
- **WHEN** the process dies during paid preparation before a complete native turn exists
- **THEN** inventory, passive outcome and retirement/retry reads remain valid, preserve uncertainty and make no new provider or action call

#### Scenario: Evidence changed on exact replay
- **WHEN** the same admission identity is presented with changed evidence or generation
- **THEN** it conflicts before preparation and cannot link to a new or continued native root

### Requirement: Exact native alias outcome

A continued request SHALL bind its exact admission to the real native root and alias atomically. Passive recovery SHALL return only that alias's durable validated outcome. Retirement SHALL prevent late linking and retain content-free replay protection after deletion.

#### Scenario: Later alias changes the root answer
- **WHEN** an earlier attachment alias has a durable result and the same root later answers another request
- **THEN** passive lookup returns only the earlier alias's bound result or an unknown outcome, never the later answer

### Requirement: Measured transfer coexistence

Logical payload arithmetic SHALL NOT be reported as peak memory. Activation SHALL require measured maximum upload/read-back and stalled-download coexistence with current meeting/model traffic, including application copies and usable headroom under deployment limits.

#### Scenario: Transfer peak has not been measured
- **WHEN** object and concurrency caps are finite but only logical byte arithmetic is available
- **THEN** no resource-fit pass is claimed and production attachment activation remains off

### Requirement: Fixed bounded conversion contract

Conversion SHALL accept only decision 4's closed v1 descriptor and independently length/hash-verified original byte stream over bounded IPC. It SHALL NOT accept commands, paths or parser-selected files. Trusted receiver and parent SHALL enforce encoded-byte/depth/count/index limits and source/cell identity; invalid or oversized output SHALL fail without successful truncation. Formula literals SHALL remain unevaluated.

#### Scenario: Parser supplies an output path
- **WHEN** a parser emits a path instead of the closed source-addressable result
- **THEN** the result is invalid, no file is opened and no evidence is published

#### Scenario: Wrong sheet or numeric value
- **WHEN** a workbook fixture contains 12.5 kg on one sheet and 112.5 m2 on another
- **THEN** source/cell assertions distinguish the exact values and units and reject a value attributed to the wrong sheet

### Requirement: Terminated conversion wire

Conversion SHALL use decision 4.3's literal request/response unions, format and omitted-reason enums, unsigned 4-byte framing and exact body/hash/EOF checks. A connection SHALL carry one request. Submit SHALL require write-half-close after exactly N bytes before gate launch; controls SHALL have no body. Missing EOF, truncation or delayed extra bytes SHALL NOT launch the gate.

#### Scenario: Extra byte arrives after a valid prefix
- **WHEN** a sender delivers N declared bytes and delays an extra byte without half-closing
- **THEN** the gate has not launched; the extra byte rejects the attempt and retained failure/recycle cannot be mistaken for completion

### Requirement: Idempotent conversion controls

Readiness, pending/outcome/failure, cancel, absent/last-ACK, repeated ACK and error/retry-after responses SHALL follow decision 4.3 and its wire fixtures. ACK SHALL bind exact Job/outcome hash and fresh-epoch proof. Parent durable history SHALL govern uncertainty and SHALL NOT resubmit settled identities.

#### Scenario: Empty slot after a lost ACK reply
- **WHEN** the exact retained result was durably observed and ACK cleared the slot but its reply was lost
- **THEN** exact status/ACK returns the defined last-ACK variant or absent history, the durable parent observation governs reconciliation, and no fresh submit resolves uncertainty

#### Scenario: Pending response comes from a later boot
- **WHEN** a job-pending or requested/already_requested cancellation response has origin epoch or counter different from its response boot
- **THEN** the parent rejects the response; prior-boot receiving/running work must be terminal interrupted/resource_unknown and cannot authorize pending continuation or publication

### Requirement: Exact conversion hash bytes

Qualification and outcome hashes SHALL use decision 4.3's exact ordered ASCII serialization after closed, bounded validation, with no escaping, whitespace, BOM or trailing newline. Processor SHALL match the whole ASCII token `[A-Za-z0-9][A-Za-z0-9._+-]{0,127}` everywhere it occurs. Other hash fields SHALL retain their alphabet, enum and integer bounds. Duplicate and unknown keys SHALL be rejected before hashing.

#### Scenario: Encoder escaping would change a hash
- **WHEN** an identity or job uses a Processor value containing an angle bracket, ampersand, backslash or quote
- **THEN** both implementations reject it before hashing; accepted tokens, legal input escape spellings and reordered input keys reconstruct identical preimage bytes and SHA-256 values in Go and TypeScript

#### Scenario: Corrected fixtures replace acceptance inputs
- **WHEN** corrected v2 wire/hash fixtures are adopted
- **THEN** the original fixtures, review reports and historical hashes remain unchanged and retain their original review-time limitations

### Requirement: Explicit conversion coverage

PDF support SHALL retain the 100-page feature limit with independent resource/output ceilings. A nonempty text layer SHALL NOT imply raster coverage. OCR SHALL remain partial/review-required; evidence SHALL identify known omissions or unknown coverage. Complete SHALL require verified coverage. Protected, malformed, empty and limited inputs SHALL have explicit outcomes retaining the original.

#### Scenario: Mixed text and scan on one page
- **WHEN** a PDF page has a native header and a scanned business card
- **THEN** the card receives OCR coverage or an explicit partial omission and the header alone is never complete reading

#### Scenario: Hundred-page document exceeds resources
- **WHEN** a document within the 100-page feature limit exceeds another enforced processing ceiling
- **THEN** the original remains available and processing reports that ceiling without silently changing the page limit or claiming every page was read

### Requirement: Retained outcome and namespace freshness

The worker SHALL retain one bounded outcome until durable parent observation and matching ACK. Every attempt SHALL recycle its full PID namespace. Publication/reuse SHALL require an advanced durable epoch counter and different boot epoch. Terminal/cancel/ACK replies alone SHALL NOT prove teardown. Missing/corrupt/uncertain state SHALL NOT imply success or inference; parent fences SHALL survive ACK.

#### Scenario: Terminal result precedes teardown
- **WHEN** the old supervisor exposes a terminal result before exiting PID 1
- **THEN** the parent keeps it provisional until the fresh epoch proves recycle and the durable parent outcome is fenced

#### Scenario: ACK response is lost
- **WHEN** the parent durably recorded an outcome but cannot tell whether ACK cleared the slot
- **THEN** it reconciles status with the same identity and does not execute another attempt to resolve uncertainty

### Requirement: Parent-owned conversion publication

Only accepted content SHALL enter the bounded queue. The existing workflow owner SHALL reserve queue/spool/result capacity and fence publication by current scope, generation, digest, processor/attempt/version, authorization, binding and tombstones. Stale output SHALL be refused and reserved derivatives queued for deletion. Conversion/retry/recovery SHALL NOT invoke models, provider-image hydration or CRM, or replace native budget/idempotency authority.

#### Scenario: Deletion or processor replacement races conversion
- **WHEN** an older conversion returns after chat deletion or replacement by a newer attempt/processor revision
- **THEN** it cannot publish into the new state, resurrect content or trigger a provider/action call

### Requirement: Conversion persistence ownership

Decision 4.6 SHALL add content/processor jobs and immutable extraction/outcome revisions in the existing workflow connection, with separate ingestion/native-attempt/preparation links. Sharing evidence SHALL NOT transfer authority. Reservations, durable observation/discard before ACK and fenced publication SHALL use its transactions; the registered storage API/allocation accounting SHALL remain unchanged.

#### Scenario: One content has two accepted consumers
- **WHEN** two ingestion preparations share an immutable content/processor extraction and one becomes stale
- **THEN** each link is checked independently, stale authority cannot publish, and the other consumer acquires no native entitlement from conversion
