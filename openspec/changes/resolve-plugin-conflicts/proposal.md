## Why

The plugin can preserve divergent content, but users cannot safely review and complete a conflict from the product. Some bootstrap collision copies also lack a durable conflict record, causing the visible state to be inaccurate after restart.

## What Changes

- Present unresolved conflicts as a compact expandable list in Settings. Open a separate, on-demand Markdown review note in a dedicated vault folder for the live remote original versus preserved local copy, with detection anchors and stale warnings. Binary or oversized versions receive metadata-only comparison.
- Avoid preserving a new conflict when a stale remote revision has the same content identity as the local file, including blob-backed Markdown.
- Add deliberate per-conflict actions: **Keep remote**, **Keep local copy**, and an explicit **Mark resolved** action after the user has manually edited or deleted files. No client timestamp selects a winner automatically.
- Persist conflict creation and resolution atomically enough to survive retries, compare-and-set contention, restart, and several independent conflicts; provide bounded durable local history of conflict events and resolution decisions without note content or credentials.
- Record bootstrap-generated copies as conflicts so they appear in the same list and can be resolved through the same workflow.
- Replace the status-bar presentation with a centrally mapped, accessible static indicator. Add a Minimal icon-only setting and an Extended icon-plus-text setting; clicking either opens the same status/conflicts view.
- Show syncing as a neutral Cloud Check, success as a green Cloud Check, errors as a red Cloud Alert, disconnected as a gray Cloud Off, and unresolved conflicts as an amber File Diff with the count. Conflicts and pending work prevent a success presentation.
- Make the Advanced status-bar mode a prominent two-option control, save Advanced changes as each control commits, place Debug logging at the bottom of Advanced, and show an accessible aggregate-status dot in Overview.

## Capabilities

### New Capabilities

- `sync-status-presentation`: Accessible, configurable status-bar presentation and navigation for synchronization, error, connection, and conflict state.

### Modified Capabilities

- `conflict-resolution`: Add durable, user-directed review and completion of each preserved conflict, including bootstrap collision copies and privacy-safe audit events.

## Impact

Plugin conflict engine, IndexedDB conflict state, reconciliation/bootstrap handling, settings and status-bar UI, and focused unit/simulation tests. No server deployment, NATS configuration, or runtime operations are included.
