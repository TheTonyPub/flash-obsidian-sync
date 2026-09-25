## Why

Deleting `Notes/todo.md` (`fileId` A) and renaming `Notes/todo_diff.md` (`fileId` B) into the freed path can be replayed out of order. A delayed delete then appears as a path collision or can remove B's new path on another device. The outbox and receiver need to preserve the causal order across retries, live watch, and reconnect.

## What Changes

- Persist a cross-file dependency from the path-reusing rename to the delete tombstone; publish the rename only after the delete is durably acknowledged remotely.
- Retry the dependency chain after failure or restart without dropping either operation.
- Apply a tombstone only to its `fileId`; let a later record with a different `fileId` claim the freed path during live watch and reconnect.
- Keep a genuine collision when another live `fileId` still owns the destination.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `file-lifecycle-sync`: Ordered path reuse and identity-scoped tombstone application.
- `local-durable-state`: Durable cross-file outbox dependency and retry.

## Impact

Plugin IndexedDB outbox, sender replay, remote watch/reconciliation, and lifecycle tests. Remote records remain `f.<fileId>`; no infrastructure deployment is part of this change.
