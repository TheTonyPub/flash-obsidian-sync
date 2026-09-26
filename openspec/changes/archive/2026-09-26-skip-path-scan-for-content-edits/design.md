## Context

See [proposal.md](proposal.md). `publishOne` fetches `f.<fileId>` and always calls `resolveOutgoingPath`, which invokes `kv.list()` even for a same-path content modification. `kv.list()` enumerates keys and fetches each value; the cost grows with the vault. The first change in this sequence handles path reuse ordering.

## Goals / Non-Goals

**Goals:** Make the usual established content-edit publish path independent of vault size while preserving identity, CAS conflict checks, and path-change safety.

**Non-Goals:** Accelerating create or rename, changing reconnect's full reconciliation, or adding a remote path index (the third change handles that).

## Decisions

1. **Gate the fast path on a verified remote record.** Use it only for `modify` when the local IndexedDB file entry, pending operation, and current `f.<fileId>` record agree on stable `fileId` and normalized path and the remote record is live. Continue normal content CAS and merge logic. A missing/tombstoned record or any path drift goes through the collision path. Alternative: trust the operation's `type` alone; that can miss a rename or stale local index.
2. **Leave path claims on the existing collision path.** Create, rename, and drift continue their current full listing and conflict preservation until the third change supplies a path ownership index. This yields a small, independently testable edit optimization.
3. **Measure calls rather than only elapsed time.** Tests assert no `kv.list()` on repeated established edits and require collision checks for path claims, along with content convergence. A latency benchmark alone would be environment-dependent.

## Risks / Trade-offs

- [A second live identity is created at the same path after the established record was observed] → This change relies on the preexisting invariant that new path claims are checked; the third change strengthens concurrent claims with CAS reservations. Keep genuine collision tests for create/rename/drift.
- [Local index or remote record is stale] → Fail closed into the existing checked path when any identity/path precondition is absent.

## Migration Plan

Plugin-only behavior change with no storage format change. No production migration or compatibility layer is required in this development environment; runtime retry and recovery behavior remains required.
