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
The plugin SHALL represent deletion with a tombstone scoped to the deleted `fileId` and SHALL resolve delete-versus-edit races without silently discarding the edit. A tombstone SHALL NOT remove a different file that later occupies the same normalized path.

#### Scenario: Delete races with offline edit
- **WHEN** one device deletes a file while another edits it offline
- **THEN** the edit is preserved as a recoverable conflict rather than being silently removed

#### Scenario: Stale tombstone after path reuse
- **WHEN** a tombstone for A is observed after B already occupies A's former path locally
- **THEN** B remains at that path and the tombstone updates only A's identity state

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
