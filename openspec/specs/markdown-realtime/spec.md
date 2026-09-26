# markdown-realtime Specification

## Purpose

Synchronizes ordinary Markdown content in realtime while preventing repeated local and remote mutation loops.

## Requirements

### Requirement: Inline Markdown propagation
The plugin SHALL publish included Markdown at or below the configurable inline limit as remote state and SHALL apply a newer remote record to the corresponding local file.

#### Scenario: Bidirectional single-writer synchronization
- **WHEN** either active device edits an included Markdown file and no concurrent edit exists
- **THEN** the peer receives the resulting content and path without manual synchronization

### Requirement: Idempotent remote apply and feedback suppression
The plugin SHALL apply the same remote revision at most once and SHALL not publish a remote-applied mutation back as a new local mutation.

#### Scenario: Remote apply does not create a loop
- **WHEN** a watched remote update is applied to a local vault
- **THEN** the plugin does not create a new outbox operation solely because of that apply

### Requirement: Established content edits do not enumerate the vault
For an ordinary content modification whose local indexed identity and normalized path match the current remote record for the same `fileId`, the plugin SHALL publish without enumerating all remote file records for path collision. Creation, rename, or detected path drift SHALL still perform a collision check before claiming a destination.

#### Scenario: Repeated edits of an established note
- **WHEN** an included note with the same indexed and remote `fileId` and normalized path is edited repeatedly
- **THEN** each edit can publish without a vault-wide remote listing and retains the same `fileId` and path

#### Scenario: New or moved path
- **WHEN** a file is created, renamed, or its local and remote path disagree
- **THEN** the plugin checks the destination against other live identities and preserves a genuine collision

#### Scenario: Edit with a changed remote path
- **WHEN** a pending content edit finds that its `fileId` has a different current remote path
- **THEN** the fast path is not used and existing path drift or conflict handling applies without silently overwriting another file
