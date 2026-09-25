## 1. Conflict lifecycle contracts and focused failing tests (gpt-5.6-luna medium)

- [x] 1.1 Add focused unit tests that define durable conflict creation for merge, path-collision, and bootstrap-copy paths, including no timestamp-based winner.
- [x] 1.2 Add focused unit tests for anchored live comparisons, stale warnings, and metadata-only binary/oversized comparison without content logging.
- [x] 1.3 Add focused unit tests for canonical-path Keep remote and Keep local copy semantics, selected-record recovery backups, no routine second unresolved record, manual edit/delete, and isolation among multiple conflicts.
- [x] 1.4 Add focused tests that stale or unexpected canonical-path changes block completion and preserve the selected record for refreshed review.
- [x] 1.5 Add focused tests for durable user-visible conflict history, bounded retention, and exclusion of note content, credentials, and secret-storage data.
- [x] 1.6 Add restart and CAS-retry simulation coverage for idempotent records, recovery backups, pending-sync state, and independent unresolved conflicts.

## 2. Durable conflict implementation (gpt-5.6-terra low)

- [x] 2.1 Extend IndexedDB conflict storage with backward-compatible detection anchors, lifecycle states, selected-record recovery backups, and idempotent completion.
- [x] 2.2 Update bootstrap and path-collision reconciliation so every preserved copy has the same durable conflict record before unresolved status is published.
- [x] 2.3 Implement canonical-path winner application: verify the expected local and remote versions, retain the loser as a selected-record backup, and create no routine new unresolved record.
- [x] 2.4 Preserve CAS/revision behavior through retries and recovery without duplicate records, discarded content, false completion, unexpected displacement, or accidental resolution of another conflict.
- [x] 2.5 Persist bounded, redacted, user-accessible conflict history for detection, backups, choices, pending state, and outcomes.

## 3. Conflict review and completion UI (gpt-5.6-terra low)

- [x] 3.1 Render each unresolved conflict as a labelled live remote-original versus preserved-local-copy comparison with detection anchors, stale warnings, and metadata-only binary/oversized handling.
- [x] 3.2 Implement confirmed Keep remote and Keep local copy canonical-path actions scoped to the selected conflict, including selected-record recovery backups and stale-state blocking.
- [x] 3.3 Implement explicit Mark resolved after manual edit/delete with pending-sync state and confirmation-gated completion.
- [x] 3.4 Show bounded durable conflict history from the status and conflicts view.
- [x] 3.5 Run the conflict lifecycle unit tests and targeted restart/CAS simulations; fix only failures within this change.

## 4. Status-bar presentation contracts and implementation (gpt-5.6-terra low)

- [x] 4.1 Add focused failing UI/status tests for Minimal and Extended modes, shared click navigation, state precedence, colors/icons/count, and syncing-versus-success accessible text.
- [x] 4.2 Add the persisted Minimal/Extended setting and one central state-to-icon/color/label/tooltip/text mapping.
- [x] 4.3 Render the static status indicator from that mapping, including neutral versus green Cloud Check semantics and the shared status/conflicts click target.
- [x] 4.4 Ensure conflicts, queued work, reconciliation, and blob transfers suppress success; ensure conflicts take precedence over ordinary errors.
- [ ] 4.5 Run targeted status/UI tests and perform a manual Obsidian accessibility check of labels, tooltips, contrast, count, and click behavior.

## 5. Release evidence (gpt-5.6-luna medium)

- [x] 5.1 Verify the user-run NATS KV configuration reference remains accurate before MVP release candidate work; update only plugin-facing configuration documentation if evidence identifies a gap.
- [x] 5.2 Run the focused unit tests before relevant conflict/restart simulations and record executed evidence for every acceptance scenario.
- [x] 5.3 Review persisted-state migration compatibility and confirm no deployment, server configuration, or credential migration is required.

## 6. Manual acceptance corrections

- [x] 6.1 Add regression tests and fix stale-revision equal-hash blob conflicts and recursive synchronization of generated conflict copies.
- [x] 6.2 Replace eager Settings comparisons with a collapsed expandable conflict list and readable actions.
- [x] 6.3 Create and open an on-demand Markdown review snapshot with a text diff or metadata-only view; keep reports out of synchronization and preserve existing reports.
- [x] 6.4 Run focused tests, build and OpenSpec validation; record the screenshot findings and executed evidence without claiming manual accessibility acceptance.

## 7. Settings acceptance refinements

- [x] 7.1 Make Advanced controls save on committed change, remove its Save/Discard buttons, validate and reconnect once for inline-limit edits, and preserve staged behavior elsewhere.
- [x] 7.2 Move Debug logging to the bottom of Advanced and replace status mode dropdown with a visible accessible Minimal/Extended choice.
- [x] 7.3 Add an accessible Overview status dot driven by aggregate state with green/yellow/red/gray semantics and no false green while work or conflicts remain.
- [x] 7.4 Run focused settings/status tests, typecheck, lint, build, strict OpenSpec validation, and update acceptance evidence.
