## Context

See proposal.md for motivation. The plugin already preserves some divergent files and holds conflict records in local IndexedDB, but conflict presentation, resolution, bootstrap preservation, and the status bar do not yet form one durable user workflow. The remote state remains NATS JetStream KV; Markdown remains inline.

## Goals / Non-Goals

**Goals:**

- Treat every conflict-producing path, including bootstrap preservation and path reconciliation, as one durable per-conflict lifecycle.
- Give the user a reviewable decision surface that exposes remote original and preserved local copy without selecting a winner automatically.
- Keep status presentation deterministic, accessible, configurable, and driven by one icon/state mapping.

**Non-Goals:**

- Deploying, configuring, or operating NATS, storage, or other user-hosted services.
- Automatic timestamp-based conflict resolution, automatic deletion of user content, animated status indicators, or a user-selectable icon theme.
- Changing the remote store, credential storage, or the 512 KiB initial Markdown inline limit.

## Decisions

### Durable conflict lifecycle keyed by operation

Extend the local conflict record with enough lifecycle state to identify the remote original, preserved local copy, detection-time remote revision/content identity, detection-time local content identity, creation context, selected resolution action, and completion marker. The comparison renders live versions against those anchors; if an anchor no longer matches, it explicitly warns that the live version is stale rather than misrepresenting it as the detection version. For binary or oversized data, the comparison stays metadata-only (path, hash, size, identity, revision) and never snapshots or logs content. Record creation is idempotent by a stable operation identity; resolving is scoped to that identity and is idempotent. Creation/reconciliation code writes the record before publishing visible unresolved state, and restart rebuilds status from unresolved stored records.

This prevents bootstrap copies from becoming unresolvable and protects several conflicts from one another. A transient in-memory counter was rejected because it cannot represent restart-safe review state. Before preserving a stale-revision conflict, compare content identities even when the remote record is blob-backed; matching bytes require only revision reconciliation, not a second copy.

Conflict and recovery copies are local artifacts. Do not queue their creation as ordinary vault files; exclude known generated paths during reconciliation and event capture. Previously queued copies can remain on the remote until separately reviewed; this change does not delete remote data automatically.

### Compact Settings list and review notes

Render one collapsed `<details>` row per unresolved conflict, with a short path and lifecycle state in its summary. Expanded rows contain the existing confirmed actions and a Review comparison action. Do not load or display note bodies during Settings rendering. On review, create a fresh Markdown snapshot under `Flash Sync Conflict Reviews/`, with a unique filename so existing or user-edited notes are never overwritten. Include detection and current metadata, stale warnings, and a bounded line diff for text; use metadata only for binary or oversized content. Open the snapshot in Obsidian. The report is inspection output, not a resolution input.

Exclude the exact dedicated folder prefix from vault scanning, modification/rename/delete listeners, and editor capture. Do not automatically delete reports. This avoids review notes entering the outbox or creating recursive conflicts while preserving past evidence.

### Canonical-path resolution with staged completion

The expanded conflict item links to the separate anchored review note and exposes Keep remote, Keep local copy, and explicit Mark resolved after manual edits/deletions. Each action re-reads the remote revision and verifies the canonical-path identity before commit. Keep remote writes the confirmed remote version to the canonical path and retains the displaced canonical local version as a recovery backup referenced by the selected record. It resolves after the canonical local file matches that revision, with no remote write. It does not create a second unresolved conflict as a deliberate-action side effect.

Keep local copy writes the selected copy to the canonical path, retains the displaced canonical local version as a recovery backup referenced by the selected record, then queues a CAS update against the reviewed remote revision. The source record transitions to `pending-sync`, remains visible as unresolved, and resolves only after outbox confirmation. If the remote or canonical path has changed, or CAS loses the race, no displacement occurs (or recovery restores the pre-action versions) and the selected record returns to reviewable unresolved state. For manual Mark resolved, compare the live canonical path with the re-read remote record: identical content resolves; changed content queues CAS update; missing content queues CAS delete. It remains pending-sync until confirmation.

Automatic last-writer-wins and an implicit resolution after opening a copy were rejected because both can lose deliberate local edits or conceal an unfinished review.

### Compare-and-set and recovery discipline

Conflict creation and remote path correction continue to use remote revisions/CAS. Before and after CAS retries, the implementation reuses the stable conflict identity and verifies the local copy and corresponding durable record. A failed or interrupted operation is retried or recovered without duplicating records, clearing unrelated records, or treating a conflict as synchronized.

The design does not introduce distributed transactions: remote KV and local IndexedDB have no shared transaction. Idempotent records plus reconciliation are the recovery mechanism.

### Privacy-safe audit events

Persist a user-accessible local conflict history alongside the lifecycle records. Append redacted entries for detection, copy/backup preservation, choice, pending state, outcome, and completion; expose the history from the status and conflicts view. Prune it to 200 entries or 30 days, whichever removes an entry first. Entries carry operation/file identifiers, outcome, and retry/recovery metadata only. Do not place Markdown body text, credential values, passwords, connection URLs containing credentials, or SecretStorage content in event fields. Console diagnostics can supplement this history but do not replace it.

Persisting full content in an audit trail was rejected because conflict diagnostics do not require it and it would increase disclosure risk.

### Central status presentation table

Create one internal mapping from derived status state to icon, color class, accessible label, tooltip, and Extended text. Both Minimal and Extended renderers consume the mapping and attach the same click handler. Derived state precedence is: disconnected/authentication failure as applicable; unresolved conflict; error; reconciliation or pending work; synchronized. The status reducer must withhold success whenever reconciliation, outbox, or blob work remains.

Duplicated conditionals in settings and status-bar rendering were rejected because they allow icon, color, tooltip, and accessibility semantics to diverge. A different sync glyph was rejected because the requested Cloud Check can remain recognizable when neutral versus green semantics and labels distinguish it.

### Immediate Advanced controls and Overview status

Keep staged Save/Discard behavior in Connection and Attachments. Advanced is an independent section: commit a valid inline-limit edit on change/blur and reconnect once; commit status mode and Debug logging immediately on selection. Remove Advanced Save/Discard controls. Present status mode as a clearly labelled two-choice control and put Debug logging at the bottom under diagnostics. Overview derives its dot and text from the aggregate status presentation: success green, syncing/pending and conflicts yellow, errors red, disconnected gray. The text remains visible so color is supplemental.

## Risks / Trade-offs

- [A local record write succeeds while a process stops before remote correction] → Reconciliation treats the durable unresolved record and copy as authoritative for review and retries idempotently.
- [Remote CAS retry sees a changed collision] → Re-read the revision and preserve/reuse the same conflict identity; test contention and repeated delivery.
- [Live versions change during review] → Anchor the view to detection identities, show stale warnings, and re-read the remote revision before any action.
- [Generated conflict copy enters synchronization] → Keep new copies local-only and exclude known generated paths from capture and reconciliation.
- [Keep actions displace a canonical file] → Verify the reviewed canonical identity, retain the losing version as a recovery backup on the selected record, and create no routine new unresolved conflict.
- [Manual completion falsely hides work] → Represent required upload/delete as pending-sync and resolve only after confirmation.
- [Status bar color is insufficient for accessibility] → Provide a text-equivalent accessible label and tooltip in both modes; Extended includes visible text.
- [Audit logs become a disclosure path] → Restrict durable history to identifiers/outcomes, bound retention, and cover log fields with tests.

## Migration Plan

1. Add a backward-compatible IndexedDB migration for conflict lifecycle fields and preserve existing unresolved records.
2. Implement idempotent conflict creation/recovery for all current collision paths, then add resolution actions and audit events.
3. Replace status-bar rendering behind the persisted Minimal/Extended setting while retaining a default compatible with the current visible control.
4. Run focused unit tests, conflict/restart simulations, and a manual Obsidian accessibility check before release candidate work.
5. Roll back by retaining the durable conflict records and data files; a prior plugin version can ignore added lifecycle fields, while no automatic content cleanup is performed.
