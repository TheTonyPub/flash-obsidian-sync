## ADDED Requirements

### Requirement: Durable path-release dependency
The plugin SHALL durably retain the dependency between a path-releasing delete and a path-reusing operation across retries and restarts. It SHALL keep the dependent operation pending until the release is confirmed remotely, then retry it without requiring another local edit.

#### Scenario: Delete publish fails
- **WHEN** the remote delete of A fails before B's rename can use A's path
- **THEN** B's rename remains pending and is not published ahead of A's tombstone

#### Scenario: Restart between release and reuse
- **WHEN** the plugin restarts after A's tombstone reaches remote state but before B's rename is confirmed
- **THEN** replay recognizes the confirmed release and completes B's rename without duplicating or losing either mutation

#### Scenario: Rename callback arrives before delete callback
- **WHEN** the local vault has removed A and moved B to A's path but the rename is captured before A's delete event
- **THEN** the durable outbox still records A's delete as B's predecessor and never publishes B ahead of A

#### Scenario: Crash before local event capture
- **WHEN** Obsidian has removed A and moved B but the plugin restarts before either event is durably queued
- **THEN** local reconciliation recovers the identity-scoped delete and dependent rename when B can be identified, or preserves the changed content for conflict review when identity is ambiguous
