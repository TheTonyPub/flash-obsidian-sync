# local-durable-state Specification

## Purpose

Preserves local file identity and unsynchronized mutations across offline operation, crashes, and reconnects.

## Requirements

### Requirement: Stable local identity and durable outbox
The plugin SHALL maintain a local file index with a stable `fileId` independent of path. It SHALL durably record each local synchronized mutation in IndexedDB before attempting its remote write.

#### Scenario: Offline mutation survives restart
- **WHEN** a device edits an included file while disconnected and Obsidian restarts before reconnection
- **THEN** the mutation remains in the outbox and is eligible for later synchronization

### Requirement: Pending work is retained safely
The plugin SHALL retain an outbox mutation until its remote write succeeds or its content is preserved as a conflict copy. It SHALL retry pending work with bounded backoff after connectivity returns.

#### Scenario: NATS outage does not destroy local content
- **WHEN** NATS becomes unavailable during a local edit
- **THEN** the local file remains usable and the pending mutation is not discarded
