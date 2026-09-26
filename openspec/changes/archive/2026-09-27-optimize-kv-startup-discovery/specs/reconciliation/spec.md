## Purpose

Defines complete and race-safe remote-state discovery for a vault when synchronization starts or resumes after disconnection.

## ADDED Requirements

### Requirement: Complete remote snapshot begins live synchronization
For each startup or reconnect reconciliation, the plugin SHALL obtain every current record, including tombstones, from the configured vault bucket before it reports reconciliation complete. The primary discovery path SHALL use one ephemeral pull-consumer session that supplies the current snapshot and then continues to deliver live changes, without a gap between the discovered state and live delivery.

#### Scenario: Nonempty bucket starts from a complete snapshot
- **WHEN** a client starts synchronization for a vault containing current live records and tombstones
- **THEN** it processes every current record before reconciliation completes and continues receiving later changes from the same live-delivery session

#### Scenario: Empty bucket completes discovery
- **WHEN** a client starts synchronization for an empty configured vault bucket
- **THEN** it establishes that the snapshot is complete without waiting for a record and can continue to live synchronization

### Requirement: Snapshot and live delivery are idempotent
The plugin SHALL preserve events received while snapshot discovery is in progress and SHALL apply a remote revision at most once. Duplicate, delayed, or overlapping snapshot and live deliveries SHALL not create duplicate local writes, duplicate outbox work, or feedback-loop mutations.

#### Scenario: Write races with snapshot intake
- **WHEN** a peer writes a new revision while another client is still receiving its initial remote snapshot
- **THEN** the receiving client applies the current revision once and does not miss the write

#### Scenario: Duplicate revision is delivered
- **WHEN** a remote revision is delivered both while discovering state and later through live delivery
- **THEN** the client applies that revision at most once and does not enqueue a local mutation

### Requirement: Discovery preserves reconciliation safety
Remote discovery SHALL retain the existing identity-scoped handling of tombstones, remote path ownership, path reuse recovery, durable local outbox operations, revision-based CAS, and conflict preservation. It SHALL not remove a different `fileId` because an older tombstone shares its historical path, and it SHALL not discard pending local content.

#### Scenario: Reconnect observes release and reuse
- **WHEN** discovery receives a tombstone for file A and a live record for file B at A's former normalized path
- **THEN** reconciliation retains A as tombstoned, retains B at the path, and does not create a false path conflict solely from that sequence

#### Scenario: Pending local edit meets discovered remote revision
- **WHEN** a client with a durable pending edit reconnects and discovers a newer remote revision for the same `fileId`
- **THEN** the existing CAS and conflict-preservation flow handles the edit without silently losing local content

### Requirement: Complete-discovery failure remains recoverable
If the primary discovery path cannot establish a complete snapshot or loses the required completion signal, the plugin SHALL retain local state and pending operations, use the existing complete remote-discovery fallback before replaying pending work, and expose the recoverable condition through local diagnostics. It SHALL not report `SYNCED` until either discovery path has completed.

#### Scenario: Snapshot completion cannot be established
- **WHEN** the primary discovery session fails before the client can establish a complete snapshot
- **THEN** the client records a diagnostic, completes reconciliation through the fallback or remains unsynchronized on fallback failure, and preserves its local outbox

#### Scenario: Mobile resume loses the connection
- **WHEN** a mobile client is suspended during discovery and the connection is lost before completion
- **THEN** it retains local state and repeats complete reconciliation after reconnect rather than treating partial discovery as synchronized

### Requirement: Discovery is observable and benchmarkable
The plugin SHALL record local diagnostic measurements for discovery path, current-record count, snapshot-completion outcome, fallback use, and reconciliation duration. It SHALL provide a repeatable benchmark that compares the primary and fallback discovery paths on the same representative vault without claiming a fixed performance result.

#### Scenario: Successful primary discovery is measured
- **WHEN** primary discovery completes for a vault
- **THEN** local diagnostics identify the path, record count, completion outcome, and duration without logging content or credentials

#### Scenario: Fallback discovery is measured
- **WHEN** primary discovery falls back to complete retrieval
- **THEN** diagnostics identify the fallback and its duration so the outcome can be compared with the primary path
