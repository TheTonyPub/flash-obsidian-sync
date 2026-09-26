## Context

See [proposal.md](proposal.md) for the measured motivation. `MarkdownSync.reconcileOnce` currently starts a buffered live watch, scans local files, calls `KvPort.list()`, applies the resulting records, drains the buffered watch, then replays the durable outbox. `NatsKvAdapter.list()` obtains names through `kv.keys()` and performs one `get()` per name with up to eight workers.

`@nats-io/kv` 3.4 creates an ephemeral `LastValue` watch consumer and internally derives `isUpdate` from `ConsumerInfo.num_pending`, but its public `watch()` iterator has no completion signal when the snapshot has zero values. The installed public JetStream API exposes ephemeral pull consumers and `ConsumerInfo.num_pending`; those APIs provide the required empty-bucket barrier without reading the KV library's private iterator fields.

## Goals / Non-Goals

**Goals:**

- Make one ephemeral JetStream consumer the primary source of both the current `f.>` snapshot and subsequent live delivery.
- Establish a safe snapshot boundary for empty and nonempty buckets, preserve every event received during initialization, and keep revision handling idempotent.
- Retain the present fallback and all reconciliation domain semantics while making outcome and timing measurable.

**Non-Goals:**

- Persistent watch cursors, a replay log, an S3/blob redesign, data migration, NATS bucket or permission changes, or server-side deployment work.
- A fixed startup-time target or performance claim; the benchmark reports observed results only.

## Decisions

### Add a snapshot-and-live session to the remote port

Extend the plugin's remote port with a session abstraction that exposes current entries, subsequent entries, a snapshot-complete barrier, and a stop operation. The reconciliation layer consumes that session rather than separately starting a generic watch and calling `list()`.

The NATS adapter will create one uniquely named ephemeral pull consumer using public JetStream APIs, scoped to the current vault bucket's `f.>` subjects with `LastPerSubject` delivery. It will read `ConsumerInfo.num_pending` immediately after consumer creation. That count defines the snapshot boundary: zero completes immediately; otherwise the session marks the boundary immediately after it has delivered that many initial values. The same consumer's continuous `consume()` flow supplies later live values.

This avoids private `QueuedIterator` internals and preserves the existing no-gap property. A generic KV `watch()` alone was rejected because an empty bucket produces no entry from which its public API can signal that initial state is complete. Push delivery was rejected because creating the consumer before attaching the SDK subscription leaves a delivery-timing question that the pull consumer avoids: pending messages remain on the consumer until requested. A durable consumer/cursor or a second catch-up consumer was rejected because the user selected an ephemeral one-consumer startup path and does not require retained history.

### Buffer the session until reconciliation can apply it

`MarkdownSync` will retain its initialization buffering model, but the primary session's snapshot entries become the remote discovery input and its post-boundary entries remain buffered until snapshot application completes. The reconciliation sequence remains: establish session; scan local state; process tombstones before live records; run `recoverPathReuse`; apply discovered records; drain buffered entries in revision order; capture local-only files; wait for capture; replay pending operations; mark reconciled.

Deduplicate at the remote revision boundary before queuing or applying an entry. Existing `applyRemote` revision guards, apply guards, conflict handling, and feedback suppression remain the final protection. Do not use client timestamps to decide which delivery wins.

### Keep the legacy discovery path as a scoped fallback

If the primary consumer cannot be created, queried for its initial pending count, consumed, or completed, stop that session and restart reconciliation through the current buffered KV watch plus complete `keys()`/`get()` list path. Do not replay outbox operations or report reconciliation complete before either path has completed.

The fallback is deliberately limited to discovery failure. It preserves current behavior while compatibility with an older/incompatible JetStream server is confirmed. If fallback also fails, retain the IndexedDB outbox, set a recoverable error, and leave the client unreconciled.

### Preserve protocol and domain boundaries

The consumer remains limited to the configured vault bucket and `f.>` file records. Snapshot handling continues to include tombstones so delete-before-reuse ordering, `p.` ownership records, and `recoverPathReuse` retain their present contracts. Inline Markdown, optional S3 blobs, stable `fileId`, local outbox persistence, CAS, diff3/conflict copies, SecretStorage credentials, and NATS authorization stay unchanged.

### Measure paths without logging content

Add structured local diagnostics for discovery mode (`snapshot-pull` or `legacy-list`), initial-entry count, snapshot completion, fallback reason/class, and phase/total durations. A benchmark fixture will seed the same representative vault for both modes and report count and timings. It must not include note contents, credentials, or a hard performance assertion.

## Risks / Trade-offs

- [JetStream consumer API behavior differs on a supported server] → Cover the adapter against the configured NATS version and trigger the legacy fallback on consumer creation, info, or consume failure.
- [An update arrives between consumer creation and snapshot processing] → Capture the initial `num_pending` from that same consumer and keep consuming it, treating subsequent deliveries as live and deduplicating revisions.
- [A malformed record or local conflict delays snapshot application] → Keep the existing recoverable-record and conflict-preservation flows; do not let discovery optimization bypass them.
- [Fallback masks an intermittent primary failure] → Emit an explicit fallback diagnostic and benchmark both paths while retaining a correct result.
- [Mobile suspension closes the iterator during reconciliation] → Stop the session, keep durable local state, and require a new complete session after reconnect before `SYNCED`.

## Migration Plan

1. Ship the adapter and reconciliation change behind the normal plugin update path; no remote data or settings migration is required.
2. Run targeted unit, integration, and fault/reconnect simulations, then the repeatable benchmark against the same seeded vault.
3. If a regression is found, restore the legacy buffered-watch-plus-list discovery path in a patch release; existing KV records, IndexedDB data, and permissions remain compatible.

## Verification Results

- The repository's lowest supported upstream NATS version is 2.10.7 (Ubuntu 24.04 package lock `2.10.7-1ubuntu0.3`). The adapter integration passed 2/2 tests against an isolated NATS 2.10.7 server, covering nonempty snapshot values and tombstones, post-snapshot live delivery, empty-snapshot completion, and ephemeral consumer cleanup. A consumer-setup or snapshot failure still selects the existing buffered-watch-plus-list fallback; fallback failure leaves reconciliation incomplete and preserves the outbox.
- The benchmark used one temporary bucket with 144 synthetic 1 KiB values over three alternating rounds on that NATS 2.10.7 instance. Primary snapshot samples were 714.09, 579.55, and 677.20 ms (median 677.20 ms); legacy list samples were 2538.36, 1766.87, and 1697.40 ms (median 1766.87 ms). These are observed timings, not a performance guarantee.
- Compatibility was exercised with the test administrator connection. The exact scoped-user permission integration was not repeated on NATS 2.10.7; no server permissions or production configuration were changed.
