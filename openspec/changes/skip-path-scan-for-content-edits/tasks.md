## 1. Establish scan behavior

- [ ] 1.1 Add failing tests asserting repeated established same-path content edits do not call `kv.list()` and still publish correct content via CAS.
- [ ] 1.2 Add failing cases requiring checked collision behavior for create, rename, remote/local path drift, missing record, and tombstone.

## 2. Implement the narrow fast path

- [ ] 2.1 Gate direct path reuse on matching operation, local index, and current live `f.<fileId>` identity/normalized path; retain checked path resolution otherwise.
- [ ] 2.2 Preserve existing merge, retry, blob selection, and conflict behavior on the fast path.

## 3. Verify

- [ ] 3.1 Run targeted sender and lifecycle tests plus relevant typecheck/build checks; confirm zero vault-wide lists for qualifying edits and checked claims for changed paths.
