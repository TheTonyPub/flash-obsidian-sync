export interface FileIndexEntry {
  fileId: string;
  path: string;
  localHash: string;
  remoteHash?: string;
  baseContent?: string;
  deleted?: boolean;
  kind?: "text" | "blob";
  remoteRevision?: number;
  lastAppliedRemoteHash?: string;
  state: "synced" | "pending" | "conflict" | "remote-applying" | "error";
}

export interface OutboxOperation {
  operationId: string;
  fileId: string;
  type: "create" | "modify" | "rename" | "delete";
  path: string;
  localHash: string;
  content?: string;
  bytes?: Uint8Array;
  kind?: "text" | "blob";
  baseContent?: string;
  baseRevision?: number;
  baseHash?: string;
  basePath?: string;
  predecessorOperationId?: string;
  retryCount: number;
  lastError?: string;
  nextAttemptAt?: number;
  createdAt: number;
}

export interface ConflictRecord {
  operationId: string;
  originalFileId: string;
  originalPath: string;
  copyFileId: string;
  copyPath: string;
  remoteRevision: number;
  /** Fields added in v3 are optional so records written by older plugin versions remain readable. */
  lifecycle?: "unresolved" | "pending-sync" | "resolved";
  context?: "merge" | "path-collision" | "bootstrap";
  canonicalPath?: string;
  remotePath?: string;
  detectionRemoteHash?: string;
  detectionRemoteDeleted?: boolean;
  detectionLocalHash?: string;
  detectionCopyHash?: string;
  kind?: "text" | "blob";
  size?: number;
  mime?: string;
  recoveryBackup?: { path: string; hash: string; size: number };
}

export interface ConflictHistoryEntry {
  operationId?: string;
  event?: string;
  outcome?: string;
  context?: string;
  createdAt: number;
  [key: string]: string | number | boolean | undefined;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export class LocalStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(name: string, factory: IDBFactory = indexedDB): Promise<LocalStore> {
    const opening = factory.open(name, 3);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains("files")) {
        const files = database.createObjectStore("files", { keyPath: "fileId" });
        files.createIndex("path", "path");
      }
      if (!database.objectStoreNames.contains("outbox")) {
        const outbox = database.createObjectStore("outbox", { keyPath: "operationId" });
        outbox.createIndex("fileId", "fileId");
      }
      if (!database.objectStoreNames.contains("conflicts")) {
        database.createObjectStore("conflicts", { keyPath: "operationId" });
      }
      if (!database.objectStoreNames.contains("conflict-history")) {
        database.createObjectStore("conflict-history", { keyPath: "id", autoIncrement: true });
      }
    };
    return new LocalStore(await request(opening));
  }

  close(): void {
    this.database.close();
  }

  async putFile(entry: FileIndexEntry): Promise<void> {
    const transaction = this.database.transaction("files", "readwrite");
    const done = complete(transaction);
    transaction.objectStore("files").put(entry);
    await done;
  }

  async getFile(fileId: string): Promise<FileIndexEntry | undefined> {
    return request(this.database.transaction("files").objectStore("files").get(fileId));
  }

  async getFileByPath(path: string): Promise<FileIndexEntry | undefined> {
    const entries = await request<FileIndexEntry[]>(this.database.transaction("files").objectStore("files").index("path").getAll(path));
    return entries.find((entry) => !entry.deleted);
  }

  async files(): Promise<FileIndexEntry[]> {
    return request<FileIndexEntry[]>(this.database.transaction("files").objectStore("files").getAll());
  }

  async conflicts(): Promise<ConflictRecord[]> {
    return request<ConflictRecord[]>(this.database.transaction("conflicts").objectStore("conflicts").getAll());
  }

  async unresolvedConflicts(): Promise<ConflictRecord[]> {
    return (await this.conflicts()).filter((entry) => entry.lifecycle !== "resolved");
  }

  async getConflict(operationId: string): Promise<ConflictRecord | undefined> {
    return request<ConflictRecord | undefined>(this.database.transaction("conflicts").objectStore("conflicts").get(operationId));
  }

  async putConflict(entry: ConflictRecord): Promise<void> {
    const transaction = this.database.transaction("conflicts", "readwrite");
    const done = complete(transaction);
    const store = transaction.objectStore("conflicts");
    const existing = await request<ConflictRecord | undefined>(store.get(entry.operationId));
    // Creation can be retried after restart. A completed record is terminal unless an
    // explicit lifecycle update is supplied by the resolution operation itself.
    const lifecycle = entry.lifecycle ?? existing?.lifecycle ?? "unresolved";
    store.put({ ...existing, ...entry, lifecycle });
    await done;
  }

  async updateConflict(operationId: string, update: Partial<ConflictRecord>): Promise<ConflictRecord> {
    const transaction = this.database.transaction("conflicts", "readwrite");
    const done = complete(transaction);
    const store = transaction.objectStore("conflicts");
    const current = await request<ConflictRecord | undefined>(store.get(operationId));
    if (!current) throw new Error(`Unknown conflict: ${operationId}`);
    const next = { ...current, ...update };
    store.put(next);
    await done;
    return next;
  }

  async appendConflictHistory(input: Record<string, unknown>): Promise<void> {
    const transaction = this.database.transaction("conflict-history", "readwrite");
    const done = complete(transaction);
    const store = transaction.objectStore("conflict-history");
    // Keep an allow-list: history is operational metadata, never note or credential data.
    const entry: ConflictHistoryEntry = { createdAt: Date.now() };
    for (const key of ["operationId", "event", "outcome", "context", "path", "retryCount", "lifecycle"] as const) {
      const value = input[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        (entry as Record<string, string | number | boolean | undefined>)[key] = value;
      }
    }
    store.add(entry);
    const entries = await request<Array<ConflictHistoryEntry & { id: number }>>(store.getAll());
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const retained = entries.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
      .filter((entry, index, all) => entry.createdAt >= cutoff && index >= Math.max(0, all.length - 200));
    const ids = new Set(retained.map((entry) => entry.id));
    for (const entry of entries) if (!ids.has(entry.id)) store.delete(entry.id);
    await done;
  }

  async conflictHistory(): Promise<ConflictHistoryEntry[]> {
    const entries = await request<Array<ConflictHistoryEntry & { id: number }>>(this.database.transaction("conflict-history").objectStore("conflict-history").getAll());
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).map((item) => {
      const { id, ...entry } = item;
      void id;
      return entry;
    });
  }

  async pending(): Promise<OutboxOperation[]> {
    const entries = await request<OutboxOperation[]>(this.database.transaction("outbox").objectStore("outbox").getAll());
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId));
  }

  async queue(operation: OutboxOperation): Promise<void> {
    const transaction = this.database.transaction("outbox", "readwrite");
    const done = complete(transaction);
    const store = transaction.objectStore("outbox");
    const sameFile = await request<OutboxOperation[]>(store.index("fileId").getAll(operation.fileId));
    const previous = sameFile.find((item) =>
      (item.type === "modify" || item.type === "create") && operation.type === "modify" &&
      item.baseRevision === operation.baseRevision && item.baseHash === operation.baseHash &&
      item.retryCount === 0,
    );
    if (previous) {
      store.put({ ...previous, content: operation.content, bytes: operation.bytes,
        kind: operation.kind, path: operation.path, localHash: operation.localHash });
    } else {
      store.add(operation);
    }
    await done;
  }

  async queuePathReuse(operation: OutboxOperation, entry: FileIndexEntry, releasedFileId?: string): Promise<void> {
    const transaction = this.database.transaction(["files", "outbox"], "readwrite");
    const done = complete(transaction);
    const files = transaction.objectStore("files");
    const outbox = transaction.objectStore("outbox");
    const pathEntries = await request<FileIndexEntry[]>(files.index("path").getAll(operation.path));
    const owner = releasedFileId
      ? pathEntries.find((item) => item.fileId === releasedFileId && item.fileId !== operation.fileId)
      : undefined;
    let predecessor = owner
      ? (await request<OutboxOperation[]>(outbox.index("fileId").getAll(owner.fileId)))
        .find((item) => item.type === "delete")
      : undefined;
    if (owner && !predecessor && !(owner.deleted && owner.state === "synced")) {
      predecessor = {
        operationId: crypto.randomUUID(), fileId: owner.fileId, type: "delete", path: owner.path,
        localHash: owner.localHash, baseHash: owner.remoteHash, baseRevision: owner.remoteRevision,
        baseContent: owner.baseContent, retryCount: 0, createdAt: Date.now(),
      };
      outbox.add(predecessor);
      files.put({ ...owner, deleted: true, state: "pending" });
    }

    const dependent = predecessor
      ? { ...operation, predecessorOperationId: predecessor.operationId }
      : operation;
    outbox.add(dependent);
    files.put(entry);
    await done;
  }

  async confirm(operationId: string): Promise<void> {
    const transaction = this.database.transaction("outbox", "readwrite");
    const done = complete(transaction);
    transaction.objectStore("outbox").delete(operationId);
    await done;
  }

  async confirmPublished(operation: OutboxOperation, entry: FileIndexEntry): Promise<boolean> {
    const transaction = this.database.transaction(["files", "outbox"], "readwrite");
    const done = complete(transaction);
    const outbox = transaction.objectStore("outbox");
    const current = await request<OutboxOperation | undefined>(outbox.get(operation.operationId));
    const newer = current && (current.localHash !== operation.localHash || current.content !== operation.content);
    if (newer) {
      outbox.put({ ...current, baseRevision: entry.remoteRevision, baseHash: entry.remoteHash,
        baseContent: entry.baseContent, retryCount: 0, lastError: undefined, nextAttemptAt: undefined });
      transaction.objectStore("files").put({ ...entry, localHash: current.localHash, state: "pending" });
    } else {
      outbox.delete(operation.operationId);
      transaction.objectStore("files").put(entry);
    }
    await done;
    return !!newer;
  }

  async markRetry(operationId: string, error: string, nextAttemptAt: number): Promise<void> {
    const transaction = this.database.transaction("outbox", "readwrite");
    const done = complete(transaction);
    const store = transaction.objectStore("outbox");
    const operation = await request<OutboxOperation | undefined>(store.get(operationId));
    if (operation) store.put({ ...operation, retryCount: operation.retryCount + 1, lastError: error, nextAttemptAt });
    await done;
  }
}
