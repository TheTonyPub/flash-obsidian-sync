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
    const opening = factory.open(name, 2);
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

  async getConflict(operationId: string): Promise<ConflictRecord | undefined> {
    return request<ConflictRecord | undefined>(this.database.transaction("conflicts").objectStore("conflicts").get(operationId));
  }

  async putConflict(entry: ConflictRecord): Promise<void> {
    const transaction = this.database.transaction("conflicts", "readwrite");
    const done = complete(transaction);
    transaction.objectStore("conflicts").put(entry);
    await done;
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
