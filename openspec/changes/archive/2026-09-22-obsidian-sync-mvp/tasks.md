Owner labels follow root `AGENTS.md`: `orchestrator` = `gpt-5.6-sol` low; `architecture` = `gpt-5.6-terra` medium; `implementation` = `gpt-5.6-terra` low; `tests` = `gpt-5.6-luna` medium. Complex design revisions, if needed, use `gpt-5.6-sol` medium. The orchestrator assigns bounded work, checks dependencies, and integrates results. Test tasks precede corresponding implementation tasks.

## 1. Repository and test foundation

- [x] 1.1 Create TypeScript workspace layout for shared protocol, Obsidian plugin, fixtures, and tests. **Owner:** implementation.
- [x] 1.2 Add unit-test runner, test doubles for Vault, SecretStorage, IndexedDB, NATS KV, and deterministic fixtures. **Owner:** tests.
- [x] 1.3 Add GitHub Actions workflow for type checking, linting, unit tests, and non-deploying integration/simulation tests. **Owner:** implementation.
- [x] 1.4 Write failing protocol tests for record schema, codec validation, normalized paths, stable IDs, and SHA-256. **Owner:** tests.
- [x] 1.5 Implement shared protocol primitives until the protocol tests pass. **Owner:** implementation.

## 2. Realtime Markdown vertical slice

- [x] 2.1 Write failing tests for WSS authentication, rejected/revoked credentials, KV put/get/watch, truthful non-SYNCED status, and two vault users selecting separate buckets without cross-vault access. **Owner:** tests.
- [x] 2.2 Implement NATS username/password connection, existing-bucket KV adapter, and local status model using SecretStorage-backed passwords; preserve the outbox on authentication failure. **Owner:** implementation.
- [x] 2.3 Write failing tests for IndexedDB file index, outbox durability across restart, coalescing, and retention before network writes. **Owner:** tests.
- [x] 2.4 Implement IndexedDB index and durable outbox; make every network mutation depend on a persisted operation. **Owner:** implementation.
- [x] 2.5 Write failing tests for two-device inline Markdown propagation and feedback suppression. **Owner:** tests.
- [x] 2.6 Implement Markdown capture, debounce, inline record publication, watched remote apply, and feedback guard. **Owner:** implementation.
- [x] 2.7 Run a disposable-NATS integration test proving bidirectional single-writer Markdown synchronization. **Owner:** tests.

## 3. Durable local state and reconciliation

- [x] 3.1 Write failing tests for retry/backoff, safe outbox retirement, startup, reconnect, mobile resume, and NATS outage reconciliation. **Owner:** tests.
- [x] 3.2 Implement retry/backoff, safe operation retirement, reconciler, and lifecycle triggers; report SYNCED only after its exit conditions hold. **Owner:** implementation.
- [x] 3.3 Write failing tests for first-device, empty-local, and existing-vault bootstrap, including same-path different-hash conflict and idempotent retry. **Owner:** tests.
- [x] 3.4 Implement the three bootstrap paths and conservative existing-vault binding. **Owner:** implementation.
- [x] 3.5 Run offline-edit, reconnect, and bootstrap integration scenarios with a real NATS container. **Owner:** tests.

## 4. Markdown conflict handling

- [x] 4.1 Write failing tests for expected-revision writes, stale-write detection, base capture, safe diff3 merge, and deterministic conflict copies. **Owner:** tests.
- [x] 4.2 Implement CAS publication and conflict resolver without clock-based winner selection. **Owner:** implementation.
- [x] 4.3 Write failing UI-state tests for unresolved conflicts and recoverable conflict-copy discovery. **Owner:** tests.
- [x] 4.4 Implement conflict visibility in the plugin status UI. **Owner:** implementation.
- [x] 4.5 Run multi-replica simulations for disjoint and overlapping offline edits; verify no acknowledged content disappears. **Owner:** tests.

## 5. File lifecycle synchronization

- [x] 5.1 Write failing tests for rename identity, tombstones, path collisions, and delete-versus-edit races. **Owner:** tests.
- [x] 5.2 Implement rename propagation and tombstone handling with stable `fileId`. **Owner:** implementation.
- [x] 5.3 Run NATS-backed integration coverage for create, rename, delete, reconnect, and lifecycle conflicts. **Owner:** tests.

## 6. Blob storage

- [x] 6.1 Write failing tests for inline threshold routing, content-addressed object keys, upload-before-publication, and download hash verification. **Owner:** tests.
- [x] 6.2 Implement S3-compatible blob adapter and SecretStorage-backed settings. **Owner:** implementation.
- [x] 6.3 Implement binary and oversized-Markdown routing without adding S3 to ordinary Markdown realtime delivery. **Owner:** implementation.
- [x] 6.4 Run integration tests with disposable S3-compatible storage, including corrupted download and S3 outage cases. **Owner:** tests.

## 7. User NATS configuration guide

- [x] 7.1 Research and write the concise user-run guide for JetStream enablement, one KV bucket and dedicated NATS username/password per vault, WSS endpoint, bucket-scoped KV/JetStream permissions, password hashing, credentials, and plugin settings. **Owner:** architecture.
- [x] 7.2 Add separate `put/get/watch` checks for two buckets; verify valid, absent, incorrect, and revoked credentials plus cross-vault denial against disposable test NATS. **Owner:** tests.
- [x] 7.3 Confirm the guide contains no deployment automation, provisioning steps, or incident-troubleshooting commitment. **Owner:** orchestrator.

## 8. Hardening and acceptance evidence

- [x] 8.1 Expand state-machine/property simulations for duplicate delivery, delayed events, client crash, NATS restart with persisted state, and path collisions. **Owner:** tests.
- [x] 8.2 Owner accepted Desktop and Mobile end-to-end behavior on 2026-09-22. Scope and unverified individual scenarios are recorded in acceptance evidence. **Owner:** tests.

8.3 Community plugin release review was cancelled by the owner on 2026-09-22; it is no longer an implementation task.

- [x] 8.4 Record executed test and acceptance evidence; identify unverified runtime claims. **Owner:** orchestrator.
