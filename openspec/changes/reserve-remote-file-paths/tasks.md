## 1. Define and test ownership contract

- [ ] 1.1 Add failing canonicalization vectors for Unicode NFC, case folding, separators, case-only rename, and Desktop/Mobile equivalence.
- [ ] 1.2 Add failing concurrent-claim tests: same path, case-equivalent paths, real collision preservation, and bounded KV operations without `kv.list()`.
- [ ] 1.3 Add failing fault-injection tests after each reservation, `f.` CAS, ownership finalization, old-path release, and delete-tombstone boundary; cover competing operations and retry after restart.

## 2. Implement path ownership

- [ ] 2.1 Add shared canonical path key derivation and validated `p.<hash>` record codec with CAS create/update and released-key reuse.
- [ ] 2.2 Integrate reservation-before-`f.` publication for create, rename, and path drift; serialize later operations for that `fileId` until finalization.
- [ ] 2.3 Finalize ownership, release old ownership after rename or tombstone, and keep case-only rename on the same owner key.
- [ ] 2.4 Recover interrupted operations from the durable outbox and matching KV evidence; keep uncertain reservations blocked and surface actionable status.
- [ ] 2.5 Filter `f.` entries in live watch and full reconnect, reconcile identity-scoped tombstones, and preserve conflict copies and feedback suppression.

## 3. Development rollout and verification

- [ ] 3.1 Update the user-run NATS setup reference with `p.>` permissions and a selected-vault development reset/rebootstrap procedure requiring file export/backup, verified reconciled state, zero pending outbox operations, and zero unresolved conflicts before any local sync-state clear; document disposable-vault deletion separately.
- [ ] 3.2 Run targeted concurrency/recovery/lifecycle tests, NATS integration tests, typecheck/build, and strict OpenSpec validation; verify create/rename no longer enumerate all remote records.
