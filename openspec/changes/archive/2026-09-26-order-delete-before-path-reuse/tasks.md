## 1. Reproduce lifecycle ordering

- [x] 1.1 Add failing sender tests for A delete followed by B rename to A's path, rename callback before delete callback, crash before event capture, failed delete retry, and restart after remote success before local acknowledgement.
- [x] 1.2 Add failing receiver tests for live event orders, full reconnect, stale A tombstone after B, genuine third-file collision, and delete-versus-edit preservation.

## 2. Persist and replay the dependency

- [x] 2.1 Derive path-release dependency from live and tombstoned indexed entries, queued deletes, and actual vault state; synthesize a missing A delete when needed, then atomically persist predecessor lookup and dependent operation within IndexedDB.
- [x] 2.2 Make replay gate B on verified remote acknowledgement of A, recover acknowledgement after a crash, and keep unrelated file operations progressing.

## 3. Apply by identity and verify

- [x] 3.1 Scope live and reconnect tombstone removal to A's indexed identity, then converge B at the freed path while preserving real collisions and divergent edits.
- [x] 3.2 Run targeted lifecycle, outbox, and recovery tests plus relevant typecheck/build checks; record that the A/B scenario converges without a false conflict.

Verification evidence: both live callback orders and the restart recovery case converge with B at A's former path and no unresolved conflict. The focused unit/simulation run passed 46 tests; typecheck and plugin build passed. The NATS-backed recovery integration was attempted but requires `NATS_SERVER_BIN` or `NATS_TEST_DOCKER=1`, neither of which was configured.
