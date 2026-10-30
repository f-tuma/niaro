## MODIFIED Requirements

### Requirement: One image, one data directory

The system SHALL ship as one container image that serves the app API, the web app at `/`, the administration at `/admin/` and the agent runtime, and SHALL keep all local persistent data under one data directory (`NIARO_DATA`, default `/data`): the workflow store in `workflow/`, the identity, agent memory, credential key, meeting audio, hosted connectors and operator plugins in `identity/`, and the recovery key digest in `admin-key.json`.

#### Scenario: Fresh container on an empty volume

- **WHEN** the image starts with an empty volume mounted at `/data` and `NIARO_PUBLIC_URL` set
- **THEN** the web app answers at `/` and the administration at `/admin/` on port 8793
- **AND** every file the server creates is inside `/data` or the temporary directory

### Requirement: Operator commands

The image entry point SHALL provide `start` (default), `check`, `admin-key`, `admin-rotate-key`, `backup`, `restore`, `healthcheck`, `storage-check` and `storage-bootstrap`, and SHALL reject any other command with exit code 64 and a list of the valid ones. `storage-check` SHALL explicitly test the configured S3 contract without changing the live workflow registry. `storage-bootstrap` SHALL explicitly provision and verify only the selected local RustFS bucket/application principal using separate bootstrap credentials; ordinary server startup SHALL NOT invoke it or inherit its credentials.

#### Scenario: Explicit storage connectivity check

- **WHEN** an operator runs `niaro storage-check` (`npm run server:storage-check` outside a container)
- **THEN** it checks the configured remote contract, cleans up its unique objects, exits nonzero on contract or cleanup failure, and makes no change to the live workflow database

#### Scenario: Explicit local storage bootstrap

- **WHEN** an operator runs `niaro storage-bootstrap` (`npm run server:storage-bootstrap` outside a container) with the local bootstrap and separate application credentials
- **THEN** it establishes or verifies the specified scoped principal and private bucket, exits nonzero on conflict/readiness/contract failure, and does not start Niaro or change another bucket/principal

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
