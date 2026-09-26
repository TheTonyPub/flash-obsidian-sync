## Why

Create and rename currently enumerate every remote file to detect a destination collision. That O(N) check becomes costly as a vault grows and cannot atomically prevent two devices from claiming the same path. A per-path remote ownership record can make claims bounded and race safe.

## What Changes

- Add a normalized, case-folded path-to-`fileId` ownership and reservation index in each vault's NATS KV bucket.
- Claim paths with KV compare-and-swap before create or rename; report a real collision when another live identity owns the destination.
- Coordinate ownership records with `f.<fileId>` updates and recover after interruption between the multiple KV writes.
- Release ownership after delete tombstones or completed renames, and handle case-only renames without claiming a second identity.
- Replace create/rename/path-drift O(N) collision listings with bounded key reads and CAS. Update the user-run NATS permission reference for the new key prefix.

## Capabilities

### New Capabilities

- `remote-path-ownership`: Authoritative per-vault normalized path reservation and crash-recoverable ownership.

### Modified Capabilities

- `file-lifecycle-sync`: Create, rename, and delete obey remote path ownership, including case-folded collisions and tombstone release.

## Impact

Plugin sender, receiver, NATS KV adapter/permissions reference, IndexedDB retry state, and lifecycle/concurrency tests. This is a development-mode storage contract: selected development vaults can be reset and rebootstrap only after backup/export and verified clean sync state; pending outbox operations or unresolved conflicts block local state clearing. Explicitly disposable test vaults can be discarded. No production migration or compatibility layer is required. Server deployment and runtime operations remain user-owned.
