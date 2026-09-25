## Context

See [proposal.md](proposal.md). `f.<fileId>` stores remote file state; IndexedDB stores file identities and outbox operations. Existing replay orders pending operations by timestamp but can skip a failed operation and continue with a different `fileId`. Remote apply must distinguish identity from path occupancy.

## Goals / Non-Goals

**Goals:** Preserve causal ordering for a path released by A and reused by B; make sender replay and receiver live/reconnect application idempotent.

**Non-Goals:** Global serialization of unrelated edits, a new remote path index, and infrastructure operations.

## Decisions

1. **Record an explicit predecessor operation ID on B's queued rename.** Determine the dependency from local indexed ownership, including tombstoned file entries, queued delete operations, and the current vault state, not event arrival order. The current `getFileByPath` excludes deleted entries, so it cannot be the sole lookup: inspect the complete identity index and outbox for A's former path. If A has been removed locally but its delete is not queued, durably queue A's delete before B even when the rename callback arrived first. Capture predecessor lookup, any missing delete, and B's dependent operation in one IndexedDB transaction. Replay only considers B ready after A's tombstone is confirmed by remote read/write and the predecessor outbox entry is acknowledged. This avoids relying on `createdAt`, which can tie or change across devices. Alternative: stop all replay on any failure; that blocks unrelated files and does not encode causality after restart.
2. **Use remote identity for acknowledgement.** If publishing A succeeded but the client crashed before local acknowledgement, recognize A's tombstone by `fileId` and operation ID/revision, acknowledge it, and unblock B. A retry must never infer release merely from the local deletion event. Alternative: acknowledge on send; this loses ordering if the send fails.
3. **Apply tombstones by `fileId`, not by historical path.** On live watch and full reconnect, compare local indexed identity before removing a vault path. A later B at A's former path is left intact. Process remote snapshot so live owners and tombstones are resolved by identity and actual current ownership, independent of KV listing order. Alternative: path-only removal can erase B.
4. **Keep true collisions.** Before B takes the destination, check whether a different live identity still owns its normalized path; use the existing conflict preservation flow when it does. Path release by A is not a conflict once A's tombstone is confirmed.

## Risks / Trade-offs

- [The client crashes between an Obsidian filesystem mutation and IndexedDB capture] → The filesystem and IndexedDB cannot share a transaction. On restart, reconcile actual local paths against indexed A/B identities before replay; infer B from its known identity and hash when possible, synthesize A's missing delete and B's dependency, and preserve content for conflict review if identity is ambiguous. Atomically persist the predecessor lookup and dependent operation within IndexedDB.
- [A remote tombstone arrives after B's rename] → Scope local removal to A's current indexed path and identity; test both event orders and full reconnect.
- [Delete versus offline edit] → Keep existing recoverable conflict behavior; a confirmed tombstone does not discard divergent content.

## Migration Plan

Plugin-only change. In development, reset/rebootstrap of local state is acceptable if the outbox schema cannot be upgraded safely; a reset must not discard unacknowledged local changes. No production migration or compatibility layer is required. Runtime crash recovery remains required.
