# file-lifecycle-sync Specification

## Purpose

Synchronizes rename and deletion events without turning a rename into an unrelated file or silently losing an edit.

## Requirements

### Requirement: Rename preserves logical identity
The plugin SHALL retain the same `fileId` when an included file is renamed and SHALL propagate the new path as the current path for that remote record.

#### Scenario: Peer observes a rename
- **WHEN** a synchronized file is renamed on one device
- **THEN** the peer receives the same `fileId` at the new path rather than a second logical file

### Requirement: Deletion uses tombstones safely
The plugin SHALL represent deletion with a tombstone and SHALL resolve delete-versus-edit races without silently discarding the edit.

#### Scenario: Delete races with offline edit
- **WHEN** one device deletes a file while another edits it offline
- **THEN** the edit is preserved as a recoverable conflict rather than being silently removed
