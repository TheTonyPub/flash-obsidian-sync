## Purpose

Detects concurrent Markdown changes and preserves every acknowledged local version when automatic merging is unsafe.

## ADDED Requirements

### Requirement: Concurrent writes use remote revision checks
The plugin SHALL write a mutation against its observed remote revision and SHALL treat a revision mismatch as a conflict requiring resolution, never as permission to overwrite newer remote content.

#### Scenario: Stale edit cannot overwrite newer content
- **WHEN** two devices modify the same base revision while offline and reconnect
- **THEN** a stale remote write does not replace the newer remote revision without conflict processing

### Requirement: Conflicts preserve content
The plugin SHALL three-way merge disjoint Markdown edits. If a merge is unsafe, it SHALL preserve both versions as recoverable conflict copies and show an unresolved conflict locally.

#### Scenario: Overlapping edits remain recoverable
- **WHEN** concurrent Markdown edits overlap and cannot be merged safely
- **THEN** neither version is silently discarded and the user can locate the conflict copies
