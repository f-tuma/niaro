## MODIFIED Requirements

### Requirement: One image, one data directory

The system SHALL ship as one container image that serves the app API, the web app at `/`, the administration at `/admin/` and the agent runtime, and SHALL keep all local persistent data under one data directory (`NIARO_DATA`, default `/data`): the workflow store in `workflow/`, the identity, agent memory, credential key, meeting audio, hosted connectors and operator plugins in `identity/`, and the recovery key digest in `admin-key.json`.

#### Scenario: Fresh container on an empty volume

- **WHEN** the image starts with an empty volume mounted at `/data` and `NIARO_PUBLIC_URL` set
- **THEN** the web app answers at `/` and the administration at `/admin/` on port 8793
- **AND** every file the server creates is inside `/data` or the temporary directory

### Requirement: Operator commands

The image entry point SHALL provide `start` (default), `check`, `admin-key`, `admin-rotate-key`, `backup`, `restore`, `healthcheck`, `storage-check`, `storage-bootstrap` and `attachment-restore-verify`, and SHALL reject any other command with exit code 64 and a list of the valid ones. `storage-check` SHALL explicitly test the configured S3 contract without changing the live workflow registry. `storage-bootstrap` SHALL explicitly provision and verify only the selected local RustFS bucket/application principal using separate bootstrap credentials; ordinary server startup SHALL NOT invoke it or inherit its credentials.

#### Scenario: Explicit storage connectivity check

- **WHEN** an operator runs `niaro storage-check` (`npm run server:storage-check` outside a container)
- **THEN** it checks the configured remote contract, cleans up its unique objects, exits nonzero on contract or cleanup failure, and makes no change to the live workflow database

#### Scenario: Explicit local storage bootstrap

- **WHEN** an operator runs `niaro storage-bootstrap` (`npm run server:storage-bootstrap` outside a container) with the local bootstrap and separate application credentials
- **THEN** it establishes or verifies the specified scoped principal and private bucket, exits nonzero on conflict/readiness/contract failure, and does not start Niaro or change another bucket/principal

#### Scenario: Explicit attachment restore verification

- **WHEN** an operator runs `niaro attachment-restore-verify [--reconcile FILE] [--activate]`
- **THEN** it forwards the selected profile and every flag to the offline reference CLI without starting the server; verification alone cannot release the restore barrier

#### Scenario: Unknown command

- **WHEN** an operator runs `niaro migrate`
- **THEN** the command exits 64 and names the supported commands

### Requirement: Optional diarization service

Both compose files SHALL start the speaker-diarization service only with the `diarization` profile and pass `DIARIZER_TOKEN` to the server as `NIARO_DIARIZATION_TOKEN`; without the profile no diarizer is built or started (behavior in `meetings`).

#### Scenario: Profile not enabled

- **WHEN** an operator starts compose without the `diarization` profile
- **THEN** the diarizer does not run; the server and independently selected optional profiles still run

## ADDED Requirements

### Requirement: External attachment object storage

When attachments are enabled, their originals and derivatives SHALL live in the configured private S3-compatible service, while ownership metadata and durable lifecycle jobs remain in Niaro's data directory. Existing meeting audio SHALL retain its current storage and retention. Deployment guidance SHALL identify the extra persistence and backup dependency.

#### Scenario: Hosted Hetzner deployment
- **WHEN** an operator configures Hetzner as attachment storage
- **THEN** original files persist in that bucket and restarting Niaro with its same data volume preserves their metadata and ownership

### Requirement: Optional RustFS service

The Compose deployments SHALL offer an opt-in object-storage profile using a pinned RustFS image, persistent data, explicit credentials and private bucket provisioning. RustFS SHALL remain absent for external-S3 installations. Local development ports SHALL bind loopback and the administrative console SHALL NOT be publicly exposed by default.

#### Scenario: Local storage profile
- **WHEN** an operator starts the object-storage profile with its required settings
- **THEN** RustFS starts with a private bucket usable by Niaro and its objects survive container recreation

#### Scenario: External storage only
- **WHEN** the operator configures external S3 without the object-storage profile
- **THEN** no RustFS container or local storage bucket is started

### Requirement: Storage configuration checks

Offline configuration checking SHALL validate storage syntax and secret presence without network access. A separate explicit connectivity check SHALL verify required operations against a unique probe object and remove it. Missing storage SHALL disable attachments without disabling text chat. Configured but invalid storage SHALL be reported distinctly.

#### Scenario: Offline configuration validation
- **WHEN** the operator runs the existing configuration checker with an S3 endpoint configured
- **THEN** it makes no S3 request and does not claim that the bucket is reachable

### Requirement: Attachment-aware backup scope

A backup containing attachment metadata SHALL identify its external object dependency and include an object identity/digest manifest. A data-directory-only backup SHALL NOT be described as containing those originals. Documented complete backup SHALL coordinate the database and bucket/RustFS snapshot while attachment mutations and cleanup are quiesced.

#### Scenario: Database backup with external objects
- **WHEN** the operator backs up the Niaro volume while originals are stored on Hetzner
- **THEN** the backup declares the external-object dependency and the documented complete procedure includes a matching object backup

### Requirement: Attachment-aware restore

Restoring attachment metadata SHALL keep attachment cleanup and serving disabled until its storage location and object manifest are verified. Missing originals SHALL be reported as unavailable, never silently recreated from extracted text. Recovery instructions SHALL cover coordinated database/object restoration and the retention consequences of restoring older backups.

#### Scenario: Incomplete restore
- **WHEN** a database backup is restored without its referenced object set
- **THEN** the restore does not report attachments as fully recovered and cannot delete unrelated objects in a replacement bucket

### Requirement: Bounded attachment resources

Operators SHALL configure bounded upload/staging/retained/queue admission independently of existing meeting limits. Effective limits and content-free pending/blocked cleanup counts SHALL be inspectable. Temporary upload spools SHALL avoid the existing shared tmpfs budget and be excluded from backups. Converter resources or a new host service SHALL NOT be implied by storage activation.

#### Scenario: Upload quota exhausted
- **WHEN** retained or quarantined objects consume the configured attachment reservation ceiling
- **THEN** new uploads are refused with a capacity result while text chat remains usable and no chat is silently evicted

### Requirement: Coordinated backup uncertainty

A complete attachment backup SHALL require stopped application owners and a matching database/native/object set with no unresolved dispatched mutation. Metadata-only backups SHALL disclose incomplete originals and uncertainty. Aborting a local request or observing an absent object SHALL NOT establish settlement.

#### Scenario: Unknown PUT at backup time
- **WHEN** a dispatched PUT remains quarantined after the application stops
- **THEN** metadata may be backed up with an explicit uncertainty boundary but no coordinated-complete attachment backup is claimed

### Requirement: Restore deletion boundary

Attachment restore SHALL persist a serving/cleanup barrier until location and streamed object hashes match its manifest. An older backup SHALL disclose loss of later deletion tombstones; serving SHALL wait for reconciliation of that deletion gap. Independently retained backups and approved business records SHALL remain under their own retention policy.

#### Scenario: Older snapshot restores a deleted original
- **WHEN** a coordinated snapshot predates a later deletion
- **THEN** the restore reports the deletion gap and does not enable attachment serving while claiming those later deletions were preserved

### Requirement: Backward-compatible attachment backup modes

Existing two-operand backup/restore and text-only archives SHALL remain supported. Backup SHALL default to metadata-only, accept explicit coordinated mode with a secret-free snapshot ID, and never imply an external copy. Usage errors SHALL exit 64; local failures SHALL exit 1. Backup stdout SHALL remain archive-safe.

#### Scenario: Metadata-only default
- **WHEN** `node scripts/backup.mjs D OUTPUT` copies a store with attachment metadata
- **THEN** it exits 0 only for a successful local copy and reports attachments metadata-only, using object inventory from the copied workflow database

#### Scenario: Explicit coordinated backup
- **WHEN** `node scripts/backup.mjs D OUTPUT --attachments coordinated --object-snapshot-id ID` runs after the documented matching external snapshot procedure
- **THEN** it requires stopped-owner locks and no unresolved mutation, records ID and the exact object/location set, and reports coordinated only when these predicates pass

#### Scenario: Container wrapper retains arguments
- **WHEN** `niaro backup OUTPUT --attachments coordinated --object-snapshot-id ID` is invoked
- **THEN** the wrapper forwards OUTPUT, all flags and NIARO_DATA exactly; an invalid or duplicate flag is rejected instead of discarded

### Requirement: Explicit restore verification and activation

Attachment restore SHALL create a fresh durable unverified instance. The offline verification command SHALL support repeatable object checks and explicit activation under existing owner locks. It SHALL return secret-free JSON with counts, barrier and gap status, using exit 0 for success, 2 for blocked, 1 for local failure and 64 for usage. Startup SHALL NOT activate it.

#### Scenario: Restore performs only local recovery
- **WHEN** `node scripts/restore.mjs INPUT EMPTY_TARGET` successfully restores an attachment-bearing archive
- **THEN** it reports unverified even for a coordinated archive, discards archived activation state, and does not serve, hydrate, mutate or clean up attachments

#### Scenario: Storage repaired after a failed check
- **WHEN** `niaro attachment-restore-verify` reports a missing object and the matching storage is later repaired
- **THEN** another invocation reads and hashes the required bytes again; verified status leaves the barrier in place until `--activate` passes fresh checks and commits release

#### Scenario: Activation interrupted
- **WHEN** activation dies before or after its durable release commit
- **THEN** restart observes respectively unverified or serving; a repeated activation reports already-serving only for the same pinned restore instance

### Requirement: Restore deletion reconciliation evidence

Every attachment restore SHALL require scoped deletion evidence covering its durable recovery cutoff before activation, even with exact hashes. Evidence SHALL bind restore, manifest and cutoff, attest completeness and continuous old-owner quiescence through activation, and apply exact-generation deletion/native fences. Unknown/stale history SHALL remain blocked/deletion_gap. Completeness/quiescence are operator attestations, not machine proof or an external ledger. Command replay is forbidden.

#### Scenario: Recovery cutoff is pinned before copying
- **WHEN** restore creates its fresh durable marker before copying any payload
- **THEN** marker and workflow barrier pin that creation time as recoveryCutoff, evidence must match it, and verification requires `snapshot.createdAt <= recoveryCutoff <= reviewedThrough <= invocation time` without substituting an archived or evidence-selected cutoff

#### Scenario: Operator attests the stopped-writer boundary
- **WHEN** the operator supplies deletion evidence for activation
- **THEN** it explicitly attests all original/old authoritative owners and lineage writers stopped before the cutoff and remaining stopped continuously through activation, covering the full deletion set from snapshot time through cutoff; machine checks validate identity, schema, coverage and applied fences without claiming to prove those attestations true

#### Scenario: Exact hashes with unknown later deletions
- **WHEN** an older snapshot matches every object hash but lacks reviewed post-snapshot deletion evidence
- **THEN** verification reports an unreconciled gap and activation remains blocked

#### Scenario: Stale empty evidence after a later deletion
- **WHEN** a T0 backup contains generation G, G is deleted at T1>T0, and restore pins cutoff T2>T1 but otherwise valid evidence has `reviewedThrough=T0`, `complete:true` and `deletions:[]`
- **THEN** exact object hashes cannot release the unverified barrier and activation reports blocked/deletion_gap

#### Scenario: Accurate nonempty evidence has a stale horizon
- **WHEN** a T0 backup contains G/H, H is deleted at T1, G is deleted at T3>T1, restore pins cutoff T4>T3, and accurate evidence through T1 lists only H
- **THEN** activation remains blocked/deletion_gap because that nonempty set does not cover the required recovery cutoff

#### Scenario: Reconcile an old fixed-chat generation
- **WHEN** the operator supplies cutoff-covering complete evidence listing every deleted restored generation under continuous old-owner quiescence
- **THEN** reconciliation durably tombstones/scrubs those exact generations and retires/read-fences their native bindings before release, retains physical purge work, preserves a newer fixed-chat generation and its objects/native context, and makes zero provider/action calls

#### Scenario: Old-owner quiescence cannot be established
- **WHEN** the cutoff is missing/mismatched, evidence coverage is unknown/stale, or an original/old lineage writer resumed before restored activation
- **THEN** this restore remains unverified with blocked/deletion_gap and a new stopped-owner restore/cutoff/evidence is required for broken quiescence

#### Scenario: Restored text deletion follows evidence review
- **WHEN** a permitted restored-owner text directory deletion commits after reconciliation and before activation
- **THEN** its local tombstone/outbox increments the reconciliation revision and activation waits for reconciliation of its exact native fences under both owner locks

### Requirement: Sole locked restore release

Only explicit activation SHALL atomically release an unverified restore under workflow and identity owner locks after fresh object/location verification, cutoff-covering deletion reconciliation and native generation fences. Pending settled purge MAY resume afterward. Unresolved PUTs SHALL retain quarantine and block release; manual settings and matching HEAD metadata SHALL NOT release it.

#### Scenario: Activation binds cutoff and current reconciliation
- **WHEN** the offline command requests activation under both owner locks
- **THEN** its CAS matches marker/evidence recovery cutoff, reviewedThrough coverage, quiescence attestation and current reconciliation revision including restored-owner local deletions, with no uncovered old-owner interval through activation

#### Scenario: Quarantined write during activation
- **WHEN** the restored registry retains an unknown PUT even if its object is currently absent
- **THEN** activation, quota release and location replacement remain blocked without clearing quarantine

#### Scenario: Restore dies before barrier persistence
- **WHEN** restore copies the workflow database and dies before its unverified database barrier commits
- **THEN** its durable restore-instance marker keeps attachment access, native hydration and cleanup disabled on startup

### Requirement: Optional isolated conversion service

Both Compose variants SHALL offer one default-off converter using decision 4's PID1/gate and bounded IPC/state without app data, credentials, network or runtime socket. App 2 GiB/512 MiB tmpfs and meeting limits SHALL remain. Readiness SHALL require freshness, retained-slot resolution and ten seconds uptime. Busy/restart/backoff SHALL be visible. Activation SHALL require notices and measured app/meeting/storage coexistence.

#### Scenario: Default installation
- **WHEN** an operator starts either Compose deployment without the conversion profile
- **THEN** no converter starts and storage configuration alone does not advertise processing

#### Scenario: Gate or cgroup admission fails
- **WHEN** the configured environment cannot install the required confinement or hard bounds
- **THEN** conversion is unavailable and no in-app parser or weaker boundary is used

#### Scenario: Worker is restarting
- **WHEN** a completed attempt causes PID1 recycle
- **THEN** the parent reports restarting/busy until fresh-epoch and readiness conditions hold and keeps bounded queued work without dispatching inference

#### Scenario: Aggregate capacity is unqualified
- **WHEN** isolated conversion succeeds but intended app/meeting/RustFS coexistence has not passed
- **THEN** production activation remains unavailable and no smaller app/meeting/page allocation is silently substituted

### Requirement: Finite startup qualification

Decision 4.2a SHALL carry bounded trusted qualification across disposable probe and clean serving epochs, bound to exact build/policy/assets/probes/platform/deployment identities. Every boot SHALL repeat hardening checks. Matching passed proof SHALL permit a clean later epoch without repeating probes. Interrupted probes SHALL have finite retry/block behavior; stale proof SHALL NOT overwrite retained outcomes or admit bytes.

#### Scenario: Successful probes hand off to a clean boot
- **WHEN** disposable epoch E1 durably records a passed identity-bound suite then exits PID1
- **THEN** E2 with a greater counter reruns per-boot hardening, reuses that matching proof, and may become ready after the uptime floor without repeating parser probes

#### Scenario: Identity changes while an outcome is retained
- **WHEN** a clean boot has a retained user outcome and a changed qualification key
- **THEN** exact status/ACK may reconcile that outcome after hardening checks, no user bytes or replacement probes overwrite it, and only an empty-slot disposable probe followed by another clean boot can restore readiness

#### Scenario: Qualification key is calculated in different runtimes
- **WHEN** Go and TypeScript validate the same admitted manifest
- **THEN** they hash decision 4.3's identical ordered ASCII bytes without escaping or trailing newline; a Processor outside its safe token alphabet fails qualification instead of selecting runtime-specific bytes

### Requirement: Authenticated conversion peer

Parent IPC SHALL use decision 4.6's fixed unprivileged in-app bridge and both-end SO_PEERCRED checks with the admitted Linux UID mapping. No public Node peer-credential API SHALL be assumed. Missing/mismatched credentials SHALL fail processing closed without weakening the boundary or granting runtime privileges.

#### Scenario: Socket peer has the wrong UID
- **WHEN** the bridge or supervisor observes a peer outside the admitted mapping
- **THEN** it closes before transferring job bytes and conversion remains unavailable
