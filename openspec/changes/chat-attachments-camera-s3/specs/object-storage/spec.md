## Purpose

Store private attachment originals and derivatives through a configurable S3-compatible service, with portable access, verified transfers and durable deletion.

## ADDED Requirements

### Requirement: Configurable S3 service

The server SHALL support an explicit endpoint, signing region, bucket, deployment prefix, credentials and path-style or virtual-host addressing. Hetzner Object Storage and RustFS SHALL use the same application contract. Other providers SHALL be supported when they pass the documented required-operation suite, without requiring AWS-only features.

#### Scenario: Local and hosted configurations
- **WHEN** the operator selects RustFS locally or Hetzner in a hosted installation
- **THEN** the clients use the same attachment API and require no storage-provider setting

### Requirement: Server-only storage credentials

Storage credentials SHALL remain server-side and absent from member responses, logs, model input and ordinary settings exports. Configuration SHALL support mounted secrets and credential rotation. HTTPS with certificate validation SHALL be the default; plain HTTP SHALL require an explicit loopback/private-network exception.

#### Scenario: Private RustFS endpoint
- **WHEN** the operator explicitly enables HTTP for the private Compose RustFS endpoint
- **THEN** Niaro can use it without disabling HTTPS certificate validation for other endpoints

### Requirement: Authenticated private object access

Buckets SHALL be private. Original and preview downloads SHALL pass through current Niaro authentication and ownership/deletion checks; clients SHALL receive neither public object URLs nor reusable storage credentials. Unsafe original types SHALL download as attachments and SHALL NOT execute as same-origin application content.

#### Scenario: Link reused after chat deletion
- **WHEN** a client reuses an earlier Niaro attachment download address after chat deletion
- **THEN** access is refused even if physical object deletion is still pending

### Requirement: Required storage operations

The compatibility suite SHALL verify object write, metadata read, whole and range read, byte/hash integrity, deletion and not-found behavior, plus bucket properties required for erasure. Connection probes SHALL operate only on unique test objects in the configured namespace and clean them up. Provider errors SHALL expose safe codes without credentials.

#### Scenario: Write succeeds but read is forbidden
- **WHEN** a connection probe can write its test object but cannot read it back
- **THEN** the attachment storage check fails and does not claim a working connection

### Requirement: Immutable scoped object identities

Objects SHALL use server-generated names scoped to the deployment and attachment owner. User filenames SHALL NOT determine paths. Existing objects and deletion jobs SHALL remain bound to their original storage location when credentials rotate; replacing that location SHALL require explicit migration rather than silent reinterpretation.

#### Scenario: Endpoint changed with retained objects
- **WHEN** an operator attempts to replace the active storage location while objects remain
- **THEN** configuration refuses the replacement and identifies migration as required

### Requirement: Erasable bucket configuration

The initial attachment contract SHALL require a dedicated non-versioned bucket without Object Lock or retention that prevents erasure. Setup SHALL verify this prerequisite. Unexpected versions or retention failures SHALL be reported and retained for cleanup; a delete marker SHALL NOT count as physical erasure.

#### Scenario: Versioned bucket selected
- **WHEN** the configured bucket has versioning enabled or suspended
- **THEN** setup refuses to activate attachment writes under the initial erasure contract

### Requirement: Durable storage cleanup

Abandoned uploads, deleted originals and generated derivatives SHALL be tracked for idempotent cleanup across crashes and outages. Cleanup SHALL retry with bounds/backoff and expose pending/failure counts. It SHALL NOT require opening the deleted chat, and SHALL NOT execute inference or an external business action.

#### Scenario: Restart after logical deletion
- **WHEN** the server restarts after tombstoning a chat but before object deletion completes
- **THEN** cleanup continues from durable records without restoring access to the chat

### Requirement: No silent storage fallback

Without configured storage, attachments SHALL be unavailable while text chat remains usable. A configured store failure SHALL preserve retryable state and SHALL NOT silently move data to local files, another bucket, a public URL or another provider.

#### Scenario: Object service unreachable
- **WHEN** RustFS or Hetzner is unreachable during an upload
- **THEN** the client gets a safe failure and no uploaded success is shown; a settled transient failure may be retried, while an unknown dispatched PUT remains quarantined

### Requirement: Unresolved write cleanup boundary

An unknown dispatched PUT SHALL retain its durable quarantine, registry location reference and capacity reservation. Tombstones SHALL revoke access, but generic S3 HEAD/DELETE observations SHALL NOT clear quarantine or prove remote settlement. Cleanup SHALL expose this as blocked physical erasure, requiring a separately defined provider-specific recovery procedure.

#### Scenario: Delayed write after missing HEAD
- **WHEN** a quarantined write is not visible to HEAD and may still arrive later
- **THEN** neither location replacement nor successful physical-purge status is permitted, and its retained reference remains after restart

### Requirement: Restore verification preserves storage fences

Restore verification SHALL read only the pinned original object identities and verify actual byte size and SHA-256. It SHALL NOT clear mutation uncertainty, release quota/location references, delete foreign objects or reinterpret handles in a replacement store. A successful read SHALL NOT establish settlement of an unknown PUT.

#### Scenario: Object matches while an earlier PUT is uncertain
- **WHEN** verification reads matching bytes for a handle that still has an unresolved dispatched PUT
- **THEN** the write remains quarantined and verification cannot activate serving, delete that handle or replace its location

#### Scenario: Settled pending purge after restore
- **WHEN** an exact tombstoned handle is absent with no unresolved PUT
- **THEN** verification may preserve it as pending settled cleanup, while only the normal registered delete completion can release its retained reference
