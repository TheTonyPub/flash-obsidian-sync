# realtime-sync-core Specification

## Purpose

Defines durable remote synchronization state and live delivery for independent personal vaults without a custom sync backend.

## Requirements

### Requirement: Secure realtime remote state
The plugin SHALL authenticate to NATS over WSS with the configured vault's username and password stored in Obsidian SecretStorage. It SHALL open only that vault's existing KV bucket and expose connection, pending-work, and convergence state locally. It SHALL NOT treat `vaultId` or the bucket name as authorization.

#### Scenario: Independent vaults share one NATS server
- **WHEN** two local vaults use different configured vault IDs and KV buckets on the same NATS server
- **THEN** each plugin instance reads, watches, and writes only records in its configured bucket

#### Scenario: Active devices receive a Markdown update
- **WHEN** two active devices connect to the same configured vault and one publishes an eligible Markdown update
- **THEN** the other device receives the remote record through its watch and normally applies it within one second after local debounce completes

#### Scenario: Credentials are persisted
- **WHEN** a user saves NATS credentials
- **THEN** the plugin stores the password in SecretStorage and does not write it to plugin `data.json`, a connection URL, or logs

#### Scenario: Credentials are rejected or revoked
- **WHEN** NATS rejects authentication during connection or reconnection
- **THEN** the plugin reports an authentication error, retains local files and outbox operations, and does not replay them until valid credentials are configured

### Requirement: Converged status is truthful
The plugin SHALL report `SYNCED` only when connected, complete startup or reconnect reconciliation has established a current remote snapshot and live delivery, no applicable outbox work remains, no unresolved conflict exists, and required blob transfers are complete. If primary discovery uses a recoverable fallback, `SYNCED` SHALL remain withheld until that fallback completes.

#### Scenario: Connected does not mean synchronized
- **WHEN** the WSS connection is open but reconciliation is still running
- **THEN** the status is not reported as `SYNCED`

#### Scenario: Discovery fallback is in progress
- **WHEN** primary remote discovery cannot establish completion and its complete-discovery fallback is running
- **THEN** the status is not reported as `SYNCED` until the fallback has completed and all other convergence conditions hold
