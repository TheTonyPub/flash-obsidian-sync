## Why

Startup and reconnect reconciliation currently enumerates KV names and then fetches each value, producing one remote read per file after the key listing. A measured 144-key vault spent 3,796 ms in that list phase of a 4,093 ms reconciliation while remote apply took 40 ms, so discovery is the useful first optimization target.

## What Changes

- Replace reconciliation's vault-wide `kv.keys()` plus per-key reads with one ephemeral JetStream `LastPerSubject` pull consumer that supplies the complete current-state snapshot and then continues live delivery.
- Define an explicit completion barrier for both nonempty and empty buckets using a stable public JetStream consumer signal, because the installed KV watch API does not expose an empty-snapshot completion event.
- Preserve events arriving during snapshot intake, process each revision idempotently, and avoid a snapshot-to-live gap or duplicate remote application.
- Preserve identity-scoped tombstone, remote path-ownership, `recoverPathReuse`, local IndexedDB outbox, CAS, and conflict behavior while applying the discovered snapshot.
- Fall back safely to the existing complete-list discovery path if the pull snapshot or its completion barrier cannot be established; surface diagnostic metrics and a repeatable benchmark without promising a fixed speedup.
- Keep inline Markdown, optional S3 blob handling, existing per-vault bucket permissions, and user-owned server operations unchanged.

## Capabilities

### New Capabilities

- `reconciliation`: Establishes complete, race-safe remote-state discovery and continuation into live synchronization for startup and reconnect.

### Modified Capabilities

- `realtime-sync-core`: Defines truthful convergence when snapshot discovery completes through the primary pull path or its safe fallback.

## Impact

- Affected plugin code: NATS KV adapter and startup/reconnect reconciliation in `packages/plugin/src/connection.ts` and `packages/plugin/src/markdown-sync.ts`.
- Affected plugin diagnostics and test/benchmark coverage for snapshot completion, empty buckets, reconnects, duplicate revisions, fallback, and existing conflict/path-reuse behavior.
- No NATS server configuration, permissions, bucket layout, protocol/data migration, S3 behavior, deployment, or durable cursor/log redesign is in scope.
