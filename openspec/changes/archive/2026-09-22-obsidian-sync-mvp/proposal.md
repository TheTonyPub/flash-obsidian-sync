## Why

Personal Obsidian vaults need low-latency, offline-safe synchronization across Desktop and Mobile without a hosted SaaS or a custom server-side sync service. The architecture baseline defines a plugin-centric model; this change turns that model into an implementable MVP plan with data-preservation guarantees.

## What Changes

- Create an Obsidian community plugin MVP for personal vaults on Desktop and Mobile; each plugin instance synchronizes its own vault independently.
- Synchronize normal Markdown through a direct WSS connection to NATS JetStream KV, with stable file identities and remote change watches.
- Authenticate each vault's devices directly with NATS using a dedicated username/password and bucket-scoped permissions.
- Persist local file identity and pending mutations in IndexedDB before network writes; reconcile after reconnect or mobile resume.
- Apply remote changes idempotently and suppress feedback loops.
- Resolve concurrent Markdown mutations with KV compare-and-set, three-way merge where safe, and recoverable conflict copies otherwise.
- Preserve rename identity and represent deletion with tombstones.
- Store binary and oversized content as SHA-256-addressed S3-compatible blobs; verify bytes before local apply.
- Provide local sync status and conflict visibility.
- Add requirement-derived tests, NATS-backed integration coverage, multi-client state-machine simulation, and GitHub Actions CI.
- Add a concise user-run NATS guide for per-vault JetStream/KV buckets, dedicated NATS users, subject permissions, WSS endpoint, and plugin settings.

## Capabilities

### New Capabilities
- `realtime-sync-core`: Defines remote record protocol, NATS KV access, connection lifecycle, and converged sync status.
- `local-durable-state`: Defines IndexedDB file index and durable outbox behavior for local mutations.
- `markdown-realtime`: Defines Markdown capture, remote apply, idempotency, and feedback-loop suppression.
- `conflict-resolution`: Defines CAS behavior, Markdown merge, conflict copies, and conflict visibility.
- `file-lifecycle-sync`: Defines stable identity across rename and safe tombstone-based deletion.
- `blob-storage`: Defines S3-compatible blob upload, content addressing, and integrity-verified download.
- `nats-connection-setup`: Defines user-facing configuration requirements for a self-hosted NATS KV endpoint.

### Modified Capabilities

- None.

## Impact

- New TypeScript monorepo packages for shared protocol and Obsidian plugin code.
- Obsidian APIs: Vault, FileManager, editor integration, IndexedDB, SecretStorage, lifecycle events, and status UI.
- Browser-compatible NATS JavaScript client over WSS and an S3-compatible client path.
- GitHub Actions CI may run unit, integration, and simulation tests. NATS and storage deployment, configuration, backup operations, and incident handling remain user-owned.
