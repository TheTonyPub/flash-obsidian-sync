## 1. Discovery-session contracts and tests

- [x] 1.1 Add failing remote-port and test-double contracts for a complete snapshot-plus-live session, including nonempty and empty snapshots, initial-count completion, stop behavior, and revision metadata.
- [x] 1.2 Add focused tests for snapshot/live races, duplicate or delayed revisions, and preserving tombstones in the discovered state without creating feedback-loop outbox work.
- [x] 1.3 Add focused reconciliation tests for path ownership, `recoverPathReuse`, durable pending edits, CAS/conflict preservation, and mobile/reconnect interruption under the new discovery contract.

## 2. Primary NATS discovery session

- [x] 2.1 Implement the NATS adapter's ephemeral public JetStream `LastPerSubject` pull-consumer session for the configured vault's `f.>` records, using the same consumer's initial `num_pending` as the empty and nonempty snapshot-completion barrier.
- [x] 2.2 Expose snapshot entries and continuing live entries through `KvPort` without private KV iterator fields, persistent cursors, or a second primary catch-up consumer; stop the ephemeral consumer on session shutdown.
- [x] 2.3 Add adapter-level tests against the supported NATS environment for nonempty and empty completion, values and tombstones, post-snapshot live delivery, and consumer/session cleanup.

## 3. Reconciliation integration and fallback

- [x] 3.1 Refactor `MarkdownSync.reconcileOnce` to consume the complete snapshot from the primary session, preserve current tombstone-first apply and path-reuse recovery ordering, then drain live entries before local capture and outbox replay.
- [x] 3.2 Add revision-boundary deduplication across snapshot buffering and live delivery while retaining existing apply guards, durable IndexedDB outbox, CAS, conflict copies, and truthful `SYNCED` gating.
- [x] 3.3 Implement scoped fallback to the existing buffered KV watch plus complete `keys()`/`get()` listing when primary consumer creation, pending-count query, consumption, or completion fails; retain the outbox and remain unreconciled if fallback fails.
- [x] 3.4 Add integration and fault/reconnect tests for fallback, connection loss during discovery, an empty bucket, a concurrent remote write, stale tombstone after path reuse, and a pending local edit meeting a newer remote revision.

## 4. Diagnostics and verification

- [x] 4.1 Add content-safe local diagnostics for discovery path, entry count, snapshot completion, fallback reason, and reconciliation phase/total timings.
- [x] 4.2 Add a repeatable benchmark that seeds one representative vault and records primary and legacy-list discovery timings without asserting a fixed speedup or logging content/credentials.
- [x] 4.3 Confirm the lowest supported NATS server accepts the public ephemeral-consumer configuration; document the compatibility result and fallback behavior without changing NATS permissions or deployment configuration.
- [x] 4.4 Run targeted unit, integration, and simulation coverage; run plugin typecheck/build and the relevant benchmark; record observed timings and unresolved compatibility limits.
