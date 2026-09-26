# file-lifecycle-sync Specification

## Purpose

Synchronizes rename and deletion events without turning a rename into an unrelated file or silently losing an edit.

## Requirements

### Requirement: Rename preserves logical identity
The plugin SHALL retain the same `fileId` when an included file is renamed and SHALL propagate the new path as the current path for that remote record. It SHALL reserve the destination path for that `fileId` before publishing the rename and release the former path only after the remote file record no longer points to it.

#### Scenario: Peer observes a rename
- **WHEN** a synchronized file is renamed on one device
- **THEN** the peer receives the same `fileId` at the new path rather than a second logical file

#### Scenario: Destination is already owned
- **WHEN** another live `fileId` owns the normalized destination path
- **THEN** the rename does not replace that owner and both contents remain recoverable through the conflict flow

### Requirement: Deletion uses tombstones safely
The plugin SHALL represent deletion with a tombstone scoped to the deleted `fileId` and SHALL resolve delete-versus-edit races without silently discarding the edit. It SHALL release that file's path ownership only after its tombstone is confirmed, and a tombstone SHALL NOT remove a different `fileId` that later occupies the same normalized path.

#### Scenario: Delete races with offline edit
- **WHEN** one device deletes a file while another edits it offline
- **THEN** the edit is preserved as a recoverable conflict rather than being silently removed

#### Scenario: Stale tombstone after path reuse
- **WHEN** a tombstone for A is observed after B already occupies A's former path locally
- **THEN** B remains at that path and the tombstone updates only A's identity state

#### Scenario: Delete then reuse
- **WHEN** A is tombstoned and B claims A's former path
- **THEN** A's ownership is released before B claims it, and a later observation of A's tombstone does not remove B

#### Scenario: Interrupted ownership release
- **WHEN** A's tombstone is confirmed but its ownership entry still appears occupied after a crash
- **THEN** recovery releases only A's obsolete entry and allows a later file to claim that path

### Requirement: Freed path reuse follows the releasing tombstone
When a local delete of one file releases a path for another file's rename, the plugin SHALL publish the delete tombstone before the rename. A peer SHALL treat the tombstone as removal of its named `fileId` only and SHALL accept the later different `fileId` at the same path if no other live owner remains.

#### Scenario: Live delete then rename
- **WHEN** device one deletes `Notes/todo.md` with `fileId` A and renames `Notes/todo_diff.md` with `fileId` B to `Notes/todo.md`
- **THEN** an online peer eventually has B at `Notes/todo.md`, A remains tombstoned, and neither device reports a path conflict solely from this sequence

#### Scenario: Reconnect sees both records
- **WHEN** a peer reconnects after A's tombstone and B's rename were published
- **THEN** reconciliation converges to B at `Notes/todo.md` without deleting B or creating a false conflict from A's old path

#### Scenario: Real destination collision
- **WHEN** B is renamed to a path still owned by a different live `fileId`
- **THEN** the plugin preserves both contents and reports a path conflict
