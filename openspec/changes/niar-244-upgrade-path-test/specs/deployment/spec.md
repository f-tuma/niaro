# Spec Delta

## MODIFIED Requirements

### Requirement: Restore

The system SHALL restore a backup with `niaro restore -` (or `node scripts/restore.mjs <backup> <dir>`) only into an empty target, SHALL accept backups written by the previous release, SHALL reject unknown formats and unsafe paths, SHALL verify every file's checksum and run `integrity_check` on every database, and SHALL report success only when all checks pass.

#### Scenario: Round trip into a new volume

- **WHEN** an operator restores a backup into a new empty volume and starts the server on it
- **THEN** the same organization, workspaces, accounts, conversations, recovery key and server identity are present

#### Scenario: Backup from the previous release

- **WHEN** an operator restores a backup written by the previous release into a new empty volume with the current version
- **THEN** the restore passes every checksum and integrity check
- **AND** the current server starts on the restored volume and upgrades it in place

#### Scenario: Non-empty target

- **WHEN** the restore target already contains files
- **THEN** restore fails with "Target is not empty" and changes nothing

#### Scenario: Corrupted archive

- **WHEN** a file's checksum does not match the manifest
- **THEN** restore fails with "Checksum mismatch" and says the target may be partial

### Requirement: Upgrade in place

The system SHALL migrate its database schemas at startup, so that a newer server on a data directory written by the previous release or later upgrades it in place and keeps every record readable: accounts, sessions, workspaces, conversations, memory, catalog entries, processes and their versions, meetings with audio, the recovery key and server identity. Older data is upgraded one release at a time. Downgrading is not supported; rollback is restoring a pre-upgrade backup into a new volume.

#### Scenario: Newer image on an old volume

- **WHEN** a newer image starts on a volume written by the previous release
- **THEN** it becomes healthy with existing accounts, workspaces, conversations and their messages, memory, catalog entries, processes with their versions, meetings with their audio, the recovery key and the server identity preserved

#### Scenario: Signed in across the upgrade

- **WHEN** a person signed in to the web app, or an app holding a refresh credential, uses the server after the upgrade, within the session lifetime
- **THEN** the session still works without signing in again
- **AND** a request without a session is still refused with 401

#### Scenario: Restart after the upgrade

- **WHEN** the upgraded server is stopped and started again on the same volume
- **THEN** it becomes healthy and no record is added, lost or changed by the second start

#### Scenario: Workflow store from a newer version

- **WHEN** the server starts on a workflow store whose schema version is newer than it supports
- **THEN** it refuses to start with "Server setup failed. Check the profile, private files and whether its data directory is already in use." and exits non-zero

#### Scenario: Identity database without its secret

- **WHEN** the server starts on a volume whose identity database exists but whose identity `secret` file is missing
- **THEN** it refuses to start, exits non-zero and leaves the identity database unchanged

## ADDED Requirements

### Requirement: Upgrade baseline check

The repository SHALL keep an upgrade baseline: a backup written by the previous release's server through its public API, with the source commit, test-only credentials and the expected readings. CI SHALL restore it, start the current server on it and fail when restore or startup fails, a database fails its integrity check, a table loses rows or a stored file changes without a reason declared in the test, or a seeded record, session or credential no longer reads back.

#### Scenario: A change silently loses rows

- **WHEN** a change makes startup delete rows from a table, or drop the table, and the test declares no reason for it
- **THEN** the upgrade check fails and names the database and table

#### Scenario: A declared drop

- **WHEN** a change deliberately drops records and the upgrade test lists that table with a reason that names the change's issue
- **THEN** the upgrade check passes for that table and still checks every other table

#### Scenario: Stored data no longer readable

- **WHEN** a change makes a seeded conversation, memory, process version or meeting unreadable through the API, or a session, refresh credential or the recovery key from before the upgrade stops working
- **THEN** the upgrade check fails and names the reading that differs

#### Scenario: Baseline older than its sessions

- **WHEN** the baseline is older than the session lifetime or the meeting audio retention
- **THEN** the check still passes, because the upgraded server runs with "now" set a few minutes after the baseline was written

#### Scenario: Refreshing the baseline at a release

- **WHEN** a maintainer runs the baseline generator on a clean checkout of the release commit
- **THEN** it writes a new baseline that records that commit
- **AND** it refuses to run on a working tree with uncommitted changes

#### Scenario: Generator kept working

- **WHEN** CI runs the upgrade check
- **THEN** it also seeds a fresh current server with the generator's journey and runs the same checks on the backup it writes, so a journey that no longer works fails before the next release
