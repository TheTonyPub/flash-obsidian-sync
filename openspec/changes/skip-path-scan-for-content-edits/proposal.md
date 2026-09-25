## Why

Every ordinary content edit currently lists all remote KV records to check for a path collision, even when its stable `fileId` and path are already established. This makes edit publication scale with total vault size and adds unnecessary network work.

## What Changes

- Publish ordinary modifications of an established `fileId` at its unchanged normalized path without a full remote path-collision scan.
- Keep collision checks for creation, rename, and detected local or remote path drift.
- Preserve the existing conflict behavior when a different live file genuinely owns the destination.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `markdown-realtime`: Established same-path content edits avoid a vault-wide remote listing while retaining safety checks on path changes.

## Impact

Plugin sender path resolution and tests. Remote `f.<fileId>` records, NATS configuration, and deployment remain unchanged and user-owned.
