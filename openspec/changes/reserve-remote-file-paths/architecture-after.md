# Architecture after the three proposed changes

This is the target design after `order-delete-before-path-reuse`, `skip-path-scan-for-content-edits`, and `reserve-remote-file-paths` are implemented. It is planning state, not a description of deployed behavior. The proposals retain one KV bucket per vault and do not add a META/BLOB bucket split or reconnect cursor.

```mermaid
flowchart LR
  subgraph D1[Device 1 - Obsidian Desktop or Mobile]
    V1[Local vault files]
    I1[(IndexedDB file index and durable outbox)]
    E1[Sync engine: capture, ordered replay, CAS, conflicts]
    C1[Recoverable conflict copy and review]
    V1 --> E1
    E1 <--> I1
    E1 --> C1
  end

  subgraph N[Per-vault NATS JetStream KV over WSS]
    F[(f.fileId records: stable fileId, path, tombstone, inline content or S3 hash reference)]
    P[(p.pathHash records: canonical path, fileId, reserved or owned or released)]
  end

  subgraph S[S3-compatible blob store]
    B[(SHA-256 addressed oversized and binary blobs)]
  end

  subgraph D2[Device 2 - Obsidian Desktop or Mobile]
    V2[Local vault files]
    I2[(IndexedDB file index and durable outbox)]
    E2[Sync engine: f-record watch and full reconnect reconciliation]
    C2[Recoverable conflict copy and review]
    V2 --> E2
    E2 <--> I2
    E2 --> C2
  end

  E1 <-->|read and CAS f records| F
  E1 <-->|reserve and CAS path owner| P
  E2 <-->|watch f records; full f reconciliation on reconnect| F
  E2 <-->|read and repair path owner| P
  E1 <-->|upload or fetch verified hash blob| B
  E2 <-->|fetch verified hash blob| B
```

```mermaid
sequenceDiagram
  participant V as Local vault
  participant O as IndexedDB outbox
  participant P as NATS KV p.pathHash
  participant F as NATS KV f.fileId
  participant R as Other device

  V->>O: Queue mutation with stable fileId and dependencies
  Note over O,F: A delete must be remotely confirmed before B reuses A's path
  alt Create or rename
    O->>P: CAS reserve destination path
    P-->>O: Reservation or competing owner
    alt Competing fileId owns destination
      O->>V: Preserve local bytes as conflict copy
    else Reservation accepted
      O->>F: CAS live file record with path and inline text or S3 hash
      F-->>O: Revision or retryable CAS race
      O->>P: CAS destination to owned
      opt Rename from a different canonical path
        O->>P: CAS former path to released
      end
      O->>O: Acknowledge completed operation
    end
  else Delete
    O->>F: CAS identity-scoped tombstone
    F-->>O: Confirmed tombstone revision
    O->>P: CAS deleted file's path to released
    O->>O: Acknowledge completed delete
  end
  F-->>R: Per-vault file-record watch
  R->>R: Apply by fileId; full f-record reconciliation on reconnect
  Note over O,P: Crash recovery reads specific f and p keys and resumes missing CAS steps
  Note over O,F: Established same-path content edits CAS f directly without a path scan
```

Path ownership is authoritative for claims; `f.<fileId>` remains authoritative for file content and tombstone state. A `reserved` path blocks other identities until the originating durable operation resumes or matching `f.` evidence lets a peer finalize it. A genuine collision keeps both contents recoverable. Normal Markdown remains inline in `f.` records; only binary or oversized bytes use S3-compatible SHA-256 blobs.
