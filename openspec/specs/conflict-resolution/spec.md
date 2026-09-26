# conflict-resolution Specification

## Purpose

Detects concurrent Markdown changes and preserves every acknowledged local version when automatic merging is unsafe.

## Requirements

### Requirement: Concurrent writes use remote revision checks
The plugin SHALL write a mutation against its observed remote revision and SHALL treat a revision mismatch as a conflict requiring resolution, never as permission to overwrite newer remote content.

#### Scenario: Stale edit cannot overwrite newer content
- **WHEN** two devices modify the same base revision while offline and reconnect
- **THEN** a stale remote write does not replace the newer remote revision without conflict processing

### Requirement: Conflicts preserve content
The plugin SHALL three-way merge disjoint Markdown edits. If a merge is unsafe, it SHALL preserve both versions as recoverable conflict copies and record each unresolved conflict locally. A preserved copy created during bootstrap or path-collision reconciliation SHALL be recorded under the same rule. The plugin MUST NOT use client timestamps to choose a winning version.

#### Scenario: Overlapping edits remain recoverable
- **WHEN** concurrent Markdown edits overlap and cannot be merged safely
- **THEN** neither version is silently discarded, a durable unresolved conflict records both versions, and the user can locate the original and copy

#### Scenario: Bootstrap preservation becomes a conflict
- **WHEN** initial reconciliation preserves local bytes at a collision-copy path
- **THEN** the plugin records that copy as an unresolved conflict before reporting it as ready for review

#### Scenario: Stale revision has identical content
- **WHEN** a local operation sees a newer remote revision whose content hash equals the local bytes, including a blob-backed Markdown record
- **THEN** the plugin reconciles the revision without creating a conflict copy or unresolved record

#### Scenario: Generated copy remains local
- **WHEN** the plugin writes a conflict or recovery copy
- **THEN** that generated artifact remains local and is not queued as an ordinary synchronized file or used to create a conflict of the copy

### Requirement: Users resolve conflicts deliberately
The plugin SHALL show every unresolved conflict as a collapsed, expandable item in Settings. The expanded item SHALL provide resolution actions and an on-demand action that creates and opens a separate Markdown review note in a dedicated, visible vault folder. Settings SHALL NOT render the comparison body. The note SHALL label the live remote original and preserved local copy with paths, detection-time remote revision and content identities, current identities, snapshot time, and stale warnings. For text versions, it SHALL show their line differences. Binary or oversized versions SHALL be compared by metadata only and SHALL NOT be loaded into the comparison or audit event as content. Review notes SHALL be excluded from synchronization, SHALL NOT be overwritten or deleted automatically, and SHALL NOT themselves resolve a conflict. Resolving one conflict SHALL NOT resolve, delete, overwrite, or discard the files or pending work of another conflict.

#### Scenario: User opens a conflict review
- **WHEN** the user expands one conflict and selects Review comparison
- **THEN** the plugin creates a new Markdown snapshot in the dedicated review folder and opens it in Obsidian, while Settings remains a compact list without inline comparison content

#### Scenario: Review note remains local
- **WHEN** the plugin writes or the user edits a review note
- **THEN** the note is not captured, queued, uploaded, or used as a resolution input

#### Scenario: Live comparison has changed after detection
- **WHEN** the remote original or preserved local copy changes after conflict detection
- **THEN** the comparison identifies the changed live version as stale against its detection metadata and does not present the stale view as the detected version

#### Scenario: Binary or oversized version is reviewed
- **WHEN** either side of a conflict is binary or exceeds the inline comparison limit
- **THEN** the comparison shows only its path, identity, size, hash, and remote revision when applicable, without reading or logging its content

#### Scenario: User keeps the remote original
- **WHEN** the user selects Keep remote for one unresolved conflict
- **THEN** after confirming the live remote revision and expected canonical-path identity, the plugin makes that remote version the canonical-path local result, retains any displaced local canonical content as a recoverable backup referenced by the selected record, and marks the selected record resolved only after the canonical local file matches that remote revision

#### Scenario: User keeps the preserved local copy
- **WHEN** the user selects Keep local copy for one unresolved conflict
- **THEN** after confirming the live remote revision and expected canonical-path identity, the plugin makes that copy the canonical-path local result, retains any displaced local canonical content as a recoverable backup referenced by the selected record, and queues a compare-and-set update against the reviewed remote revision

#### Scenario: User resolves after manual edits
- **WHEN** the user edits or deletes files to resolve one conflict and explicitly marks it resolved
- **THEN** the plugin rechecks the live remote revision and canonical-path state, queues a compare-and-set update or deletion when synchronization is required, and does not mark the selected record resolved until that work is confirmed

#### Scenario: A reviewed version becomes stale before action
- **WHEN** the remote revision changes after the user reviewed a conflict and before an action is committed
- **THEN** the plugin does not overwrite the newer remote version, retains the selected conflict as unresolved, and requires refreshed review

#### Scenario: Canonical path changes unexpectedly before action
- **WHEN** the canonical-path local version differs from the reviewed identity before an action is committed
- **THEN** the plugin does not displace it, retains the selected conflict as unresolved, and requires refreshed review

### Requirement: Resolution state represents synchronization completion
The plugin SHALL distinguish an unresolved conflict from a selected conflict with pending synchronization. A deliberate Keep remote or Keep local copy action SHALL retain its losing version as a recoverable backup referenced by the selected record and SHALL NOT create another unresolved conflict as a routine action side effect. A Keep local copy action or manual canonical-path change that requires remote mutation SHALL remain unresolved and contribute to conflict status until its compare-and-set operation is confirmed. A Keep remote action SHALL resolve only after the canonical-path local content is aligned with the confirmed remote revision. A failed compare-and-set, stale version, or unexpected canonical-path displacement SHALL retain recoverable versions and return the selected record to reviewable unresolved state.

#### Scenario: Keep local copy waits for confirmation
- **WHEN** Keep local copy queues an update of the canonical path
- **THEN** the selected conflict remains visible as pending synchronization and does not present success before the update is confirmed

#### Scenario: Manual deletion waits for confirmation
- **WHEN** a user deletes the canonical-path file and marks the conflict resolved
- **THEN** the selected conflict remains unresolved while the deletion is queued and becomes resolved only after the remote deletion is confirmed

#### Scenario: Compare-and-set loses a resolution race
- **WHEN** the remote revision changes while a local winner or manual change is pending
- **THEN** the plugin retains the involved versions, does not mark the selected record resolved, and returns it to refreshed review

#### Scenario: Deliberate winner does not create another conflict
- **WHEN** the user completes a Keep remote or Keep local copy action against unchanged reviewed versions
- **THEN** the selected record retains the losing version as its recovery backup and no new unresolved conflict record is created

### Requirement: Conflict records survive retries and restart
The plugin SHALL persist conflict creation and resolution so that compare-and-set retries, restart, and multiple simultaneous conflicts do not leave a copied file without an unresolved record or clear an unrelated record. Retrying an already completed creation or resolution SHALL be idempotent.

#### Scenario: Restart retains unresolved conflicts
- **WHEN** the plugin restarts after preserving a conflict copy and before the user resolves it
- **THEN** the conflict list and unresolved-conflict state include that conflict after restart

#### Scenario: One of several conflicts is resolved
- **WHEN** the user resolves one of multiple unresolved conflicts
- **THEN** only the selected record stops contributing to unresolved-conflict state and every other record remains reviewable

#### Scenario: Compare-and-set retry repeats conflict handling
- **WHEN** a remote conflict or path correction requires a compare-and-set retry
- **THEN** retrying does not create duplicate unresolved records or lose the copy associated with the conflict

### Requirement: Conflict handling is auditable without content disclosure
The plugin SHALL persist a bounded, durable local conflict history and show it to the user from the status and conflicts view. The history SHALL record detection, preserved-copy or backup creation, selected action, pending synchronization, outcome, and explicit resolution completion. History entries MUST include only identifiers and operational metadata needed to diagnose the event, and MUST NOT include note content, credential values, connection secrets, or secret-storage data. Console-only events SHALL NOT satisfy this requirement. The plugin SHALL retain at most 200 history entries or 30 days of entries, whichever limit removes an entry first.

#### Scenario: Conflict audit event is emitted
- **WHEN** the plugin detects a conflict and preserves or records a copy
- **THEN** it emits a diagnostic event that identifies the operation without including note content or credentials

#### Scenario: Resolution audit event is emitted
- **WHEN** the user completes a Keep remote, Keep local copy, or explicit mark-resolved action
- **THEN** the user can view a durable local history entry for that selected action and outcome without note content or credentials

#### Scenario: History retention is bounded
- **WHEN** adding an entry would exceed 200 entries or an entry is older than 30 days
- **THEN** the plugin removes the oldest eligible local history entry while retaining newer entries
