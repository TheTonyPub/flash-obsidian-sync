## MODIFIED Requirements

### Requirement: Rename preserves logical identity
The plugin SHALL retain the same `fileId` when an included file is renamed and SHALL propagate the new path as the current path for that remote record. It SHALL reserve the destination path for that `fileId` before publishing the rename and release the former path only after the remote file record no longer points to it.

#### Scenario: Peer observes a rename
- **WHEN** a synchronized file is renamed on one device
- **THEN** the peer receives the same `fileId` at the new path rather than a second logical file

#### Scenario: Destination is already owned
- **WHEN** another live `fileId` owns the normalized destination path
- **THEN** the rename does not replace that owner and both contents remain recoverable through the conflict flow

### Requirement: Deletion uses tombstones safely
The plugin SHALL represent deletion with a tombstone scoped to the deleted `fileId` and SHALL resolve delete-versus-edit races without silently discarding the edit. It SHALL release that file's path ownership only after its tombstone is confirmed, and a tombstone SHALL NOT remove a different `fileId` that later occupies the path.

#### Scenario: Delete races with offline edit
- **WHEN** one device deletes a file while another edits it offline
- **THEN** the edit is preserved as a recoverable conflict rather than being silently removed

#### Scenario: Delete then reuse
- **WHEN** A is tombstoned and B claims A's former path
- **THEN** A's ownership is released before B claims it, and a later observation of A's tombstone does not remove B

#### Scenario: Stale tombstone after path reuse
- **WHEN** a tombstone for A is observed after B already occupies A's former path locally
- **THEN** B remains at that path and the tombstone updates only A's identity state

#### Scenario: Interrupted ownership release
- **WHEN** A's tombstone is confirmed but its ownership entry still appears occupied after a crash
- **THEN** recovery releases only A's obsolete entry and allows a later file to claim that path
