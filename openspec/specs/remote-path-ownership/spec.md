# remote-path-ownership Specification

## Purpose

Provides authoritative per-vault ownership of normalized file paths so concurrent devices can claim paths safely without enumerating every remote file.

## Requirements

### Requirement: One live identity owns a normalized path
The plugin SHALL use one authoritative remote ownership entry per normalized, case-folded path. Create, rename, and path drift SHALL reserve the destination before publishing a live file record, and competing different `fileId` claims SHALL not both succeed. The check SHALL use bounded remote key operations rather than a vault-wide file listing.

#### Scenario: Two devices create the same path
- **WHEN** two devices concurrently create different files at paths that normalize and case-fold to the same value
- **THEN** at most one `fileId` owns that path and the other content is preserved as a recoverable path conflict

#### Scenario: Case-only rename
- **WHEN** a file is renamed only in case and its normalized ownership key remains the same
- **THEN** its `fileId` keeps ownership and the display path changes without a false collision

#### Scenario: Ordinary path claim cost
- **WHEN** a new file or rename claims an unoccupied path in a vault of any size
- **THEN** collision validation reads or updates a bounded number of remote keys rather than listing all files

### Requirement: Interrupted ownership changes recover safely
The plugin SHALL retain enough durable information to retry or reconcile an interrupted create, rename, or delete across the ownership entry and file record. It SHALL not silently transfer a reserved path to another `fileId` while the first operation's outcome is uncertain.

#### Scenario: Crash after reservation
- **WHEN** a client restarts after reserving a new path but before updating its file record
- **THEN** its durable operation can resume or safely release its own reservation without losing local content

#### Scenario: Crash after file record update
- **WHEN** a client or observer finds a file record updated but ownership finalization or old-path release incomplete
- **THEN** recovery can finalize the matching owner and release only the obsolete ownership entry

#### Scenario: Uncertain competing reservation
- **WHEN** another `fileId` encounters a pending reservation whose creator has not recovered
- **THEN** it does not seize the path based on time alone and reports a recoverable blocked or conflict state
