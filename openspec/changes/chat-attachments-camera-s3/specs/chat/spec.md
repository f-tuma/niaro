## MODIFIED Requirements

### Requirement: Deleted chat receipts

Receipts of a deleted chat SHALL stay for idempotency without what the person wrote: the request text SHALL become `[deleted]` and tags, attached tasks and file references/content SHALL be dropped, so a replay is `idempotency_conflict`, never a new turn. A tombstone SHALL keep the id so it is never reused.

#### Scenario: Delete then replay

- **WHEN** a deleted chat's earlier `message.send` is replayed with its original ids
- **THEN** the server answers `idempotency_conflict` and starts no turn

### Requirement: Message actions

Each message SHALL offer copy (an answer as its Markdown); the latest answer SHALL offer **Again**, which resends the request before it as a new message, and the latest request SHALL offer **Edit**, which puts it back in the composer. History SHALL never change. Read-only chats SHALL offer no edit. Again and Edit SHALL select available owned files through a new draft/binding without modifying the earlier request; unavailable files SHALL require resolution before sending.

#### Scenario: Again

- **WHEN** the person presses **Again** on the latest answer
- **THEN** the request before it is sent again as a new message and the earlier answer stays

#### Scenario: Edit with a file

- **WHEN** the person edits the latest request containing a file
- **THEN** its text and attachment selection return to the composer without modifying the earlier message

## ADDED Requirements

### Requirement: Attachment-only messages

A chat request SHALL be accepted with empty text when it contains an uploaded attachment set. A request with neither text nor files SHALL remain invalid. Files SHALL NOT consume the 4,000-character typed-text allowance. The message SHALL show its file metadata even when there is no caption; an unspecified intended action SHALL be clarified before any business write.

#### Scenario: Business card without caption
- **WHEN** the person sends only a readable business-card photo
- **THEN** the assistant can show proposed details or a short clarification, but cannot save a contact without approval

### Requirement: Attachment-preserving session movement

Archive and main-chat session rollover SHALL move file bindings with their source messages, preserving access in the resulting archive. Restoring SHALL retain those bindings. Clearing a fixed chat SHALL tombstone the old generation's files without making them accessible to a later generation that reuses the chat ID.

#### Scenario: Main chat rollover
- **WHEN** a new mobile session archives an earlier request with an attachment
- **THEN** the file remains readable in that archive and is not implicitly included in the new session's model context

### Requirement: Negotiated attachment history

Clients SHALL negotiate attachment metadata support. An attachment-bearing history SHALL not be projected as empty text to a client that cannot render it; that client SHALL receive an upgrade-required result. Stored text-only histories SHALL remain readable without the new capability.

#### Scenario: Older client opens file-only history
- **WHEN** a client lacking attachment support opens a chat containing a file-only message
- **THEN** it receives an upgrade-required result rather than a misleading empty message

### Requirement: Attachment acceptance and completion

A negotiated attachment send SHALL acknowledge durable acceptance separately from processing completion. A deliberate native retry SHALL keep the original logical user message and immutable file intent; Again SHALL create a new message. Polling or transport replay SHALL NOT initiate processing or paid work.

#### Scenario: Native retry of a file request
- **WHEN** a person deliberately retries a failed attachment request under existing native retirement/retry rules
- **THEN** it adds an attempt with the same logical message and frozen file intent, preserves old action receipts, and does not append a duplicate user request

### Requirement: Upgrade refusal before effects

A client lacking `agent-attachments/1` metadata support SHALL receive `406 attachment_profile_required` for attachment-bearing snapshot/history/event delivery. A command whose response would contain such metadata SHALL be refused before mutation or inference. Refused event delivery SHALL NOT advance its cursor; unaffected text-only delivery SHALL remain compatible.

#### Scenario: Older client sends into an affected projection
- **WHEN** an older client sends a command whose result snapshot includes a retained file
- **THEN** the server refuses before recording the command or starting any model work, so retry cannot create an unseen effect

### Requirement: Positive first-run retry proof

A deliberate retry of a never-dispatched attachment request SHALL require a sealed owner-produced proof bound to immutable intent and consumed by one retry command. It SHALL create its first real native root under the retry identity, without inventing an earlier native run. Missing rows SHALL NOT constitute proof.

#### Scenario: Concurrent retry of a pre-native request
- **WHEN** two distinct retry commands attempt to consume the same sealed never-prepared proof
- **THEN** at most one receives a new admission, exact replay recovers it, and no synthetic parent or duplicate paid work is created

#### Scenario: Preparation started without a native root
- **WHEN** an interrupted admission may have spent preparation inference but has no provable native root to retire
- **THEN** passive recovery and native retry preserve unknown status and cannot manufacture a never-dispatched proof
