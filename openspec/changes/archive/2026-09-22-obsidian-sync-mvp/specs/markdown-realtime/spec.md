## Purpose

Synchronizes ordinary Markdown content in realtime while preventing repeated local and remote mutation loops.

## ADDED Requirements

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
