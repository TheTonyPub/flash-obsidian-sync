## Context

See `proposal.md` for motivation. The repository has an architecture baseline but no implementation. This change extends its single-vault target to several independent vaults on one NATS server. The MVP must work in Obsidian Desktop and Mobile, where a plugin cannot keep a guaranteed background connection while the mobile OS suspends the app.

## Goals / Non-Goals

**Goals:**
- Build a plugin-owned synchronization state machine around NATS JetStream KV.
- Preserve local mutations before network I/O and avoid silent data loss.
- Deliver a narrow vertical path first, then add offline recovery, conflicts, lifecycle operations, and blobs.
- Give a self-hosting user a short NATS KV configuration reference.

**Non-Goals:**
- NATS, Caddy, S3, server deployment, production operations, backup automation, or incident handling.
- CRDT editing, background mobile sync, `.obsidian` synchronization, SaaS tenancy, and hosted sharing.

## Decisions

### Shared protocol, plugin adapters

Create a shared TypeScript protocol package for record schema, codecs, IDs, hashing, and fixtures. Keep Obsidian APIs, IndexedDB, NATS, S3, and UI adapters in the plugin package. This permits deterministic unit and simulation tests without an Obsidian runtime. A plugin-only monolith is rejected because protocol behavior must be exercised by multiple simulated replicas.

### NATS KV holds current remote file state

Each remote record contains stable `fileId`, normalized path, content reference, content hash, tombstone state, and version metadata. NATS KV supplies persistence, watch delivery, and expected-revision updates; no custom WebSocket hub, database, or server-side merge service is introduced. Normal Markdown is inline up to configurable 512 KiB; blob references hold all binary and oversized content.

### Local durable state precedes writes

IndexedDB contains file index, base record needed for conflict handling, and outbox operations. The engine persists and coalesces a local mutation before publishing. A successful KV write or recoverable conflict copy can retire it. In-memory queues are rejected because crashes and mobile suspension would lose pending intent.

### Reconciliation and apply ownership

On startup, resume, and reconnect, reconcile local index/outbox with remote KV before reporting `SYNCED`. Remote applies carry revision/source markers through a feedback guard. Vault events remain the completeness path; editor debounce is the low-latency Markdown path. Applying only editor events is rejected because external and mobile-originated vault changes would be missed.

### Conflict strategy is conservative

Use expected KV revision for write races. Capture base, local, and remote Markdown. Apply diff3 only for safe disjoint edits; otherwise materialize deterministic conflict copies and retain both contents. Do not use timestamps as conflict authority or last-write-wins because clocks and reconnect timing are not reliable.

### Blob publication is two-phase

Hash bytes, upload immutable content-addressed object, then publish its KV record. A peer downloads and hashes bytes before local apply. This makes a watched record refer only to available content. S3 is deliberately excluded from ordinary Markdown realtime delivery.

### Secrets and setup boundary

Persist NATS and S3 secrets only in Obsidian SecretStorage. Write a short documentation guide with parameterized NATS commands/configuration examples, but do not provision, deploy, or diagnose user infrastructure. GitHub Actions creates disposable test dependencies only.

### Authentication and authorization at NATS

Use NATS authentication on the WSS connection. MVP credentials are a distinct NATS username and strong password for each vault; every device joining that vault receives its vault's credential. NATS checks credentials at connect and on reconnect. Do not introduce a separate HTTP/WebSocket authentication API or a server-wide shared token. `vaultId` and bucket name identify data; neither is a secret or proof of access.

Configure NATS publish/subscribe permissions so each vault user can perform the plugin's required JetStream/KV operations only for that vault's bucket. Include the required `_INBOX.>` reply subscriptions and bucket-specific `$JS.API...` operations in the tested allowlist; never grant blanket `$JS.API.>` or `>` access. The exact API subjects depend on the chosen server/client versions and must be derived from integration tests before the user guide provides a copyable example. A user who knows another `vaultId` but lacks its credential must fail to connect as that vault or access its bucket. Keep administrative bucket-creation rights separate from plugin credentials: the user creates buckets, and the plugin opens an existing bucket.

Store the password in Obsidian SecretStorage, not `data.json`, a connection URL, logs, or Git. The guide should recommend a bcrypt hash for the server-side stored password and TLS for the WSS connection. On rejected or revoked credentials, keep the local vault and outbox intact, show an authentication error, and wait for corrected settings before replay. Rotating one vault's password affects only devices bound to that vault. S3 uses separate credentials and the existing vault-prefix scope.

### Concrete KV topology and record format

Support multiple independent vaults on one NATS server. Each plugin instance binds its local vault to one immutable `vaultId` and one file-backed KV bucket. Use `OBS_<vaultIdNormalized>_FILES`, history 10, replicas 1; verify bucket-name constraints against the selected NATS version. Generate the ID once and persist it; never derive it from a vault display name or folder path. Joining an existing vault requires its existing ID and bucket.

NATS subject layout for two example vaults:

```text
vaultId A: 01J8V9Y6H5KX
bucket A:  OBS_01J8V9Y6H5KX_FILES
file key:  f.<fileId>
subject:   $KV.OBS_01J8V9Y6H5KX_FILES.f.<fileId>

vaultId B: 01J9ABCDEF12
bucket B:  OBS_01J9ABCDEF12_FILES
file key:  f.<fileId>
subject:   $KV.OBS_01J9ABCDEF12_FILES.f.<fileId>
```

`$KV.<bucket>.f.>` is the file-subject pattern for one vault. These are KV backing subjects, not extra application topics. Create one KV bucket per vault, not one topic per file. JetStream API subjects for bucket access, reads, and watch consumers also require permissions; granting `$KV.<bucket>.f.>` alone is insufficient. Verify the exact allowlist with the selected NATS server and JS client versions. The MVP uses a distinct bucket-scoped NATS user per vault; each plugin instance selects only its configured bucket.

One key `f.<fileId>` holds each logical file. Rename changes its record, not its key. Do not maintain a remote path index: KV CAS is atomic per key, so a second index would require a distributed two-key transaction. Detect duplicate paths during reconciliation.

Encode values as UTF-8 JSON with `schemaVersion: 1`. The logical `RemoteFileRecord` contains `fileId`, normalized `path`, `kind: text|blob`, `deleted`, `contentHash`, `size`, optional `mime`, inline `content` only for live text, or `blob` metadata (`algorithm`, `hash`, `key`, `size`, optional `etag`) only for live blobs. `origin` contains `deviceId`, `operationId`, and diagnostic client time. Optional `basedOnRevision` and `deletion` metadata support reconstruction and tombstones. The NATS `KvEntry.revision` is authoritative; client timestamps never choose a winner. Validate schema and field combinations before local apply. Hash exact UTF-8 text content or raw binary bytes; do not normalize line endings before hashing.

### Local storage schema and mutation order

Index local files by `fileId` and path. Track remote revision/hash, local hash, file kind, last applied remote hash, and state (`synced`, `pending`, `conflict`, `remote-applying`, `error`). Keep low-volume nonsecret settings and vault/device IDs outside IndexedDB; store NATS and S3 secrets only in SecretStorage.

Each outbox operation has `operationId`, `fileId`, type (`create`, `modify`, `rename`, `delete`), desired path, base revision/hash, local hash, retry count/error, and text content or blob upload state. Dirty text operations retain exact `baseContent` for diff3; KV history is not the sole conflict-base store. Persist an operation before network I/O. Coalesce edits only while original base and all unsynchronized user content remain recoverable. Replay in creation order per file. Retire an operation only after confirmed KV success or durable preservation of its losing content as a conflict copy. Do not duplicate the whole vault in IndexedDB.

### Capture, feedback, and path rules

Register a CodeMirror 6 extension for active Markdown editors. After approximately 200–300 ms without edits, capture and hash the current document, then durably queue a changed value. Observe Vault create/modify/rename/delete after `workspace.onLayoutReady()` to catch inactive files, external changes, and attachments. Deduplicate editor and Vault events by identity, hash, and local state. Never publish every keystroke.

Install a narrow guard before each remote Vault write, rename, or delete: `fileId`, target path, expected hash, operation. Consume only the matching Vault echo; unrelated user edits must still enter the outbox. Use Obsidian APIs, create parent directories when needed, and prefer recoverable trash semantics for remote deletion. Include normal visible Markdown and attachments. Exclude `.obsidian/**`, `.trash/**`, plugin operational data, and hidden/config paths outside normal Vault APIs. Normalize paths with Obsidian rules and `/`; reject leading `/` and `..`, normalize Unicode consistently, and detect case-insensitive collisions.

### KV write, watch, and reconciliation sequence

Use `kv.create(f.<fileId>, record)` for a new file and `kv.update(key, record, expectedRevision)` for an existing file. On success, persist returned revision/hash before acknowledging the outbox entry. On CAS failure, fetch current remote state and resolve; never overwrite with a stale revision. Ignore watch entries whose revision is no newer than the last applied revision. Distinguish initial watch snapshot from live updates using the selected NATS client's supported API; verify its behavior in integration tests.

At startup, reconnect, app visibility return, network return, or mobile resume: open WSS, establish watch, reconcile its current snapshot with local index and vault, buffer concurrent live events, process them in revision order per file, then replay the outbox in creation order per file. On disconnect, continue accepting local edits. Status follows `Initializing`, `Offline`, `Reconciling`, `Live`, `Pending`, and `Conflict`. Report `SYNCED` only when connected, current remote entries processed, reconciliation complete, no ordinary outbox work or unresolved conflicts remain, and required blob transfers have finished. A connected socket alone is insufficient.

### Bootstrap existing vaults

For an empty remote bucket, enumerate included local files, assign stable random IDs, queue creates, upload blobs first, then call `kv.create`. For an empty local vault, consume remote records, create parent folders, apply inline text or verified blobs, and build the local index. If both sides have files: same normalized path and hash binds the local file to remote `fileId`; same path but different hash preserves the local content as a conflict copy and keeps the remote canonical file; local-only files become creates; remote-only files download. Without a trustworthy common base, do not auto-merge. Repeated bootstrap must be idempotent.

### Conflict and lifecycle decision matrix

Make resolution a pure function of base, local, remote, and remote revision. Diff3 merges disjoint Markdown edits; overlapping edits keep both. Retry merged content against the newest revision at most three immediate times; further races retain the outbox operation and show conflict/error with backoff. Derive conflict-copy `fileId` from original `fileId` plus losing `operationId` to prevent duplicates. Give copies readable names containing device/time; timestamps are labels, never ordering authority.

| Local / remote | Result |
| --- | --- |
| edit / edit | Diff3 if safe; otherwise keep both. |
| rename / edit | Combine path and content if only one side renamed. |
| rename / different rename | Keep canonical record and a recoverable conflict copy. |
| delete / unchanged | CAS tombstone. |
| delete / edit | Preserve edit and report conflict. |
| binary edit / binary edit | Keep both. |
| create same path / different `fileId` | Preserve both through path conflict handling. |

Rename and delete use CAS on the same `f.<fileId>` key. Retain compact tombstones indefinitely during MVP; do not purge them. For two live records with the same normalized path, never overwrite one: move one deterministically to a conflict path and publish the correction through CAS. Empty directories are not synchronized; folder rename becomes per-file path updates.

### Blob pipeline and failure behavior

Keep ordinary Markdown inline. Start with configurable 512 KiB maximum, checking encoded record size against the server's actual payload and KV value limits. Route binary and oversized Markdown to immutable keys `vaults/<vaultId>/blobs/sha256/<first-2>/<hash>`. Persist outbox, hash bytes, upload blob, then commit KV metadata. An orphan blob after failed CAS is acceptable; garbage collection is deferred. Peers download only when local hash differs, verify size and SHA-256, then apply. A failed upload leaves old remote metadata and the local operation pending. A failed or corrupt download leaves the previous local file untouched and reports an error after bounded retries. S3 outage does not stop inline text sync.

If NATS is unavailable or KV is full, retain outbox and show offline/pending or storage error. Invalid remote schema blocks destructive apply and marks sync incompatible. All error paths preserve local content and conflict bases. WSS and HTTPS are required. Scope a dedicated S3 key to the vault prefix. The short user guide must show two distinct vault IDs, their buckets and backing subjects, separate NATS users/passwords, matching plugin settings, actual JetStream permissions, server limits, and separate `put/get/watch` checks. Include a negative unauthenticated and cross-vault access check.

### Verification boundaries

Write requirement-derived failing tests first. Unit tests cover schema/hash/path, outbox coalescing and retention, apply guards, diff3, conflict matrix, and tombstones. Disposable NATS/S3 integration tests cover watch/CAS, reconnect, rejected credentials, per-vault permissions, password rotation, server restart with persisted JetStream, upload ordering, hash mismatch, and outages. Multi-client simulation injects duplicate/delayed events, disconnects, crashes, and races; assert no acknowledged content disappears, stale writes do not overwrite, replicas converge, hashes match, and rename retains `fileId`. Verify user guide commands against disposable test NATS. Desktop/Mobile latency and resume behavior require manual evidence; unit tests alone do not establish them.

## Risks / Trade-offs

- [Mobile suspension breaks live watches] → Reconnect and reconcile on activation, visibility, and network restoration; do not promise background sync.
- [KV payload growth] → Enforce configurable 512 KiB inline limit and move larger content to blob mode.
- [Conflict merge can be unsafe] → Preserve conflict copies rather than force a merge.
- [Path collisions and lifecycle races] → Treat them as explicit state-machine cases and cover them with simulations before release.
- [User NATS setup errors] → Keep documented required values concise; infrastructure remains out of scope.
- [Snapshot and live watch events interleave] → Buffer live events during reconciliation and apply only increasing revisions per file.
- [Local state and Vault diverge after a crash] → Compare index, outbox, Vault, and KV before replay; keep pending operations until confirmed or preserved.
- [One VPS loses JetStream state] → Backup and restore remain user-owned; do not claim recovery acceptance without a tested restore.
- [Wrong vault ID binds a device to another dataset] → Show vault ID and bucket together in settings and require explicit binding; never infer either from a display name.
- [Credential leaks or is revoked] → Keep it in SecretStorage, avoid URL/log exposure, rotate per vault, retain pending work, and show an authentication error.

## Migration Plan

1. Ship an empty plugin state with settings and SecretStorage-backed credentials.
2. Introduce the KV protocol and durable outbox before any one-file Markdown network write.
3. Add the Markdown vertical slice and reconciliation before enabling offline claims.
4. Add CAS/conflicts, rename/delete, and blobs in separately testable increments.
5. On incompatible future format changes, stop destructive apply, mark sync incompatible, and require an explicit plugin upgrade or migration.

Rollback consists of disabling the plugin: local vault files remain untouched, outbox and index are retained for a later compatible restart, and remote KV data is not deleted.

## Open Questions

- Exact NATS permission syntax and accepted bucket-name characters must be verified against the selected NATS version when writing and testing the user guide. The logical bucket/key contract above does not depend on that syntax.
