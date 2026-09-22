import { createFileId, decodeRecord, encodeRecord, normalizePath, sha256Hex, type RemoteFileRecord } from "@easy-sync/protocol";
import { type KvPort, type SyncStatus } from "./connection.js";
import { type FileIndexEntry, type LocalStore, type OutboxOperation } from "./local-store.js";
import { conflictCopyId, conflictCopyPath, resolveMarkdown } from "./conflict-resolution.js";
import { blobObjectKey, chooseStorage, DEFAULT_INLINE_LIMIT, downloadVerified, type BlobPort } from "./blob-storage.js";
import { errorSummary, type PluginLogger } from "./diagnostics.js";

export interface MarkdownVault {
  read(path: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  write(path: string, content: Uint8Array): void | Promise<void>;
  rename?(from: string, to: string): void | Promise<void>;
  remove?(path: string): void | Promise<void>;
  onRename?(listener: (from: string, to: string) => void): () => void;
  onDelete?(listener: (path: string) => void): () => void;
  listMarkdown(): Array<{ path: string; content: string }> | Promise<Array<{ path: string; content: string }>>;
  listFiles?(): Array<{ path: string; bytes: Uint8Array }> | Promise<Array<{ path: string; bytes: Uint8Array }>>;
  onModify(listener: (path: string) => void): () => void;
}

export interface MarkdownSyncOptions {
  deviceId: string;
  vault: MarkdownVault;
  store: LocalStore;
  kv: KvPort;
  vaultId?: string;
  blob?: BlobPort;
  inlineLimit?: number;
  status: SyncStatus;
  debounceMs?: number;
  logger?: PluginLogger;
}

export function retryDelay(failures: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6));
}

type Watched = { key: string; value: Uint8Array; revision: number };

export class MarkdownSyncEngine {
  private stopWatch?: () => void;
  private stopVault?: () => void;
  private stopRename?: () => void;
  private stopDelete?: () => void;
  private readonly renameGuards = new Set<string>();
  private readonly deleteGuards = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly applyGuards = new Map<string, string>();
  private captureChain: Promise<void> = Promise.resolve();
  private replayChain: Promise<void> = Promise.resolve();
  private liveChain: Promise<void> = Promise.resolve();
  private reconcilePromise?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private buffering = true;
  private readonly buffered: Watched[] = [];
  private stopped = false;

  constructor(private readonly options: MarkdownSyncOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.buffering = true;
    this.options.status.connected = true;
    this.options.status.reconciled = false;
    this.options.status.refresh();
    this.stopVault = this.options.vault.onModify((path) => {
      void Promise.resolve().then(() => this.options.vault.read(path)).then((bytes) => {
        if (this.stopped || !bytes) return;
        const hash = sha256Hex(bytes);
        if (this.applyGuards.get(path) === hash) {
          this.applyGuards.delete(path);
          return;
        }
        if (path.endsWith(".md")) this.scheduleCapture(path, new TextDecoder().decode(bytes));
        else void this.captureBytes(path, bytes).catch((error: unknown) => this.backgroundError("capture.failed", error));
      }).catch((error: unknown) => this.backgroundError("vault.read_failed", error));
    });
    this.stopRename = this.options.vault.onRename?.((from, to) => {
      const marker = `${from}\0${to}`;
      if (this.renameGuards.delete(marker)) return;
      void this.rename(from, to).catch((error: unknown) => this.backgroundError("rename.failed", error));
    });
    this.stopDelete = this.options.vault.onDelete?.((path) => {
      if (this.deleteGuards.delete(path)) return;
      void this.remove(path).catch((error: unknown) => this.backgroundError("delete.failed", error));
    });
    this.options.status.onReconnect = () => { void this.reconcile().catch(() => { /* reconcileOnce logs the cause. */ }); };
    await this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    this.stopWatch?.();
    this.stopVault?.();
    this.stopRename?.();
    this.stopDelete?.();
    this.options.status.onReconnect = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async settle(): Promise<void> {
    await Promise.all([this.captureChain, this.replayChain, this.liveChain]);
  }

  scheduleCapture(path: string, content: string): void {
    if (this.stopped) return;
    const previous = this.timers.get(path);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(path);
      void this.capture(path, content).catch((error: unknown) => this.backgroundError("capture.failed", error));
    }, this.options.debounceMs ?? 250);
    this.timers.set(path, timer);
  }

  async capture(path: string, content: string): Promise<void> {
    const next = this.captureChain.catch(() => {}).then(() => this.captureOne(path, new TextEncoder().encode(content), content));
    this.captureChain = next;
    await next;
  }

  async captureBytes(path: string, bytes: Uint8Array): Promise<void> {
    const content = path.endsWith(".md") ? new TextDecoder().decode(bytes) : undefined;
    const next = this.captureChain.catch(() => {}).then(() => this.captureOne(path, bytes, content));
    this.captureChain = next;
    await next;
  }

  async rename(from: string, to: string): Promise<void> {
    from = normalizePath(from); to = normalizePath(to);
    if (from === to) return;
    const { store, vault, status } = this.options;
    const indexed = await store.getFileByPath(from);
    if (!indexed) return;
    const bytes = await vault.read(to);
    if (!bytes) throw new Error("Renamed file is missing");
    const content = to.endsWith(".md") ? new TextDecoder().decode(bytes) : undefined;
    await store.queue({ operationId: crypto.randomUUID(), fileId: indexed.fileId, type: "rename", path: to,
      basePath: from, localHash: sha256Hex(bytes), content, bytes: content === undefined ? bytes : undefined,
      kind: content === undefined ? "blob" : "text", baseContent: indexed.baseContent,
      baseHash: indexed.remoteHash, baseRevision: indexed.remoteRevision, retryCount: 0, createdAt: Date.now() });
    await store.putFile({ ...indexed, path: to, localHash: sha256Hex(bytes), state: "pending" });
    status.pending = (await store.pending()).length; status.refresh();
    await this.replayPending();
  }

  async remove(path: string): Promise<void> {
    path = normalizePath(path);
    const { store, status } = this.options;
    const indexed = await store.getFileByPath(path);
    if (!indexed) return;
    await store.queue({ operationId: crypto.randomUUID(), fileId: indexed.fileId, type: "delete", path,
      localHash: indexed.localHash, baseHash: indexed.remoteHash, baseRevision: indexed.remoteRevision,
      baseContent: indexed.baseContent, retryCount: 0, createdAt: Date.now() });
    await store.putFile({ ...indexed, deleted: true, state: "pending" });
    status.pending = (await store.pending()).length; status.refresh();
    await this.replayPending();
  }

  private async captureOne(path: string, bytes: Uint8Array, content?: string): Promise<void> {
    path = normalizePath(path);
    const hash = sha256Hex(bytes);
    const previous = await this.options.store.getFileByPath(path);
    if (previous?.localHash === hash && previous.state === "synced") return;
    const fileId = previous?.fileId ?? createFileId();
    const operation: OutboxOperation = {
      operationId: crypto.randomUUID(), fileId, type: previous ? "modify" : "create", path,
      localHash: hash, content, bytes: content === undefined ? bytes.slice() : undefined,
      kind: content === undefined ? "blob" : "text", baseContent: previous?.baseContent, baseRevision: previous?.remoteRevision,
      baseHash: previous?.remoteHash, retryCount: 0, createdAt: Date.now(),
    };
    await this.options.store.queue(operation);
    await this.options.store.putFile({ ...previous, fileId, path, localHash: hash,
      kind: operation.kind, state: "pending" });
    this.options.status.pending = (await this.options.store.pending()).length;
    this.options.status.refresh();
    await this.replayPending();
  }

  async reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.buffering = true;
    const work = this.reconcileOnce().finally(() => { this.reconcilePromise = undefined; });
    this.reconcilePromise = work;
    return work;
  }

  private async reconcileOnce(): Promise<void> {
    const { status, store, kv, vault } = this.options;
    let stage = "watch";
    status.reconciled = false;
    status.pending = (await store.pending()).length;
    status.conflictPaths = (await store.conflicts()).map((item) => item.copyPath);
    status.conflicts = status.conflictPaths.length;
    status.refresh();
    this.options.logger?.debug("reconcile.start", { pending: status.pending, conflicts: status.conflicts });
    try {
      this.stopWatch?.();
      this.stopWatch = await kv.watch((entry) => {
        if (this.buffering) this.buffered.push(entry);
        else this.queueLive(entry);
      });
      stage = "local_scan";
      const local = vault.listFiles
        ? await vault.listFiles()
        : (await vault.listMarkdown()).map((file) => ({ path: file.path, bytes: new TextEncoder().encode(file.content) }));
      const localByPath = new Map(local.map((file) => [file.path, file]));
      stage = "remote_list";
      const remote = await kv.list();
      this.options.logger?.debug("reconcile.snapshot", { localFiles: local.length, remoteFiles: remote.length });
      stage = "remote_apply";
      const remotePaths = new Set<string>();
      for (const entry of remote) {
        let record: RemoteFileRecord;
        try { record = decodeRecord(entry.value); }
        catch { this.conflict(); continue; }
        if (!record.deleted) remotePaths.add(record.path);
        if (record.deleted) { await this.applyRemote(entry.value, entry.revision); continue; }
        const indexed = await store.getFile(record.fileId);
        const existing = localByPath.get(record.path);
        if (!indexed && existing && !await store.getFileByPath(record.path)) {
          const localHash = sha256Hex(existing.bytes);
          if (localHash === record.contentHash) {
            await store.putFile(this.syncedIndex(record, entry.revision));
            continue;
          }
          if (record.kind === "text" && existing.path.endsWith(".md")) {
            if (!await this.preserveBootstrapConflict(record, new TextDecoder().decode(existing.bytes))) continue;
          } else if (!await this.preserveBootstrapBytes(record, existing.bytes)) continue;
        } else if (indexed && existing && sha256Hex(existing.bytes) !== indexed.localHash &&
          !(await store.pending()).some((item) => item.fileId === indexed.fileId)) {
          await this.captureBytes(record.path, existing.bytes);
        }
        await this.applyRemote(entry.value, entry.revision);
      }
      while (this.buffered.length) {
        const batch = this.buffered.splice(0).sort((a, b) => a.revision - b.revision);
        for (const entry of batch) await this.applyRemote(entry.value, entry.revision);
      }
      for (const file of local) {
        if (!remotePaths.has(file.path) && !await store.getFileByPath(file.path) && await vault.read(file.path)) {
          await this.captureBytes(file.path, file.bytes);
        }
      }
      await this.captureChain;
      stage = "outbox_replay";
      await this.replayPending(true);
    } catch (error) {
      const failure = new Error("Reconciliation failed; local outbox retained", { cause: error });
      status.lastError = errorSummary(failure);
      this.options.logger?.error("reconcile.failed", failure, { stage, pending: status.pending });
      status.connected = false;
      status.reconciled = false;
      status.refresh();
      throw failure;
    } finally {
      this.buffering = false;
      const remaining = this.buffered.splice(0).sort((a, b) => a.revision - b.revision);
      for (const entry of remaining) this.queueLive(entry);
      await this.liveChain;
    }
    status.pending = (await store.pending()).length;
    status.connected = true;
    status.reconciled = true;
    status.refresh();
    this.options.logger?.debug("reconcile.complete", { pending: status.pending, conflicts: status.conflicts });
  }

  private queueLive(entry: Watched): void {
    this.options.status.reconciled = false;
    this.options.status.refresh();
    this.liveChain = this.liveChain.catch(() => {}).then(async () => {
      await this.applyRemote(entry.value, entry.revision);
      if (!this.reconcilePromise) {
        this.options.status.reconciled = true;
        this.options.status.refresh();
      }
    }).catch((error: unknown) => {
      this.options.status.lastError = errorSummary(error);
      this.options.logger?.error("watch.apply", error);
      this.conflict();
    });
  }

  private async preserveBootstrapConflict(record: RemoteFileRecord, localContent: string): Promise<boolean> {
    const path = record.path.replace(/\.md$/, `.conflict-${this.options.deviceId}-${record.fileId}.md`);
    const existing = await this.options.vault.read(path);
    if (existing && new TextDecoder().decode(existing) !== localContent) {
      this.conflict();
      return false;
    }
    if (!existing) {
      const bytes = new TextEncoder().encode(localContent);
      this.applyGuards.set(path, sha256Hex(bytes));
      await this.options.vault.write(path, bytes);
      await this.capture(path, localContent);
    }
    return true;
  }

  private async preserveBootstrapBytes(record: RemoteFileRecord, bytes: Uint8Array): Promise<boolean> {
    const path = this.collisionPath(record.path, record.fileId);
    const existing = await this.options.vault.read(path);
    if (existing && sha256Hex(existing) !== sha256Hex(bytes)) { this.conflict(); return false; }
    if (!existing) {
      this.applyGuards.set(path, sha256Hex(bytes));
      await this.options.vault.write(path, bytes);
      await this.captureBytes(path, bytes);
    }
    return true;
  }

  private syncedIndex(record: RemoteFileRecord, revision: number): FileIndexEntry {
    return { fileId: record.fileId, path: record.path, localHash: record.contentHash,
      remoteHash: record.contentHash, remoteRevision: revision,
      baseContent: record.content, kind: record.kind,
      lastAppliedRemoteHash: record.contentHash, deleted: record.deleted, state: "synced" };
  }

  private replayPending(force = false): Promise<void> {
    const next = this.replayChain.catch(() => {}).then(() => this.publishPending(force));
    this.replayChain = next;
    return next;
  }

  private async publishPending(force: boolean): Promise<void> {
    const { store, status } = this.options;
    const processed = new Set<string>();
    const blockedFiles = new Set<string>();
    while (true) {
      const operation = (await store.pending()).find((item) => !processed.has(item.operationId) && !blockedFiles.has(item.fileId));
      if (!operation) break;
      processed.add(operation.operationId);
      if (operation.content === undefined && operation.bytes === undefined && operation.type !== "delete") continue;
      if (!force && operation.nextAttemptAt && operation.nextAttemptAt > Date.now()) {
        this.scheduleRetry(operation.nextAttemptAt - Date.now());
        continue;
      }
      try {
        this.options.logger?.debug("outbox.publish", { operationType: operation.type, retryCount: operation.retryCount });
        await this.publishOne(operation);
        this.options.logger?.debug("outbox.published", { operationType: operation.type });
        status.clearError(`outbox:${operation.fileId}`);
      } catch (error) {
        status.lastError = errorSummary(error);
        this.options.logger?.error("outbox.publish_failed", error, { operationType: operation.type, retryCount: operation.retryCount });
        const nextAttemptAt = Date.now() + retryDelay(operation.retryCount);
        await store.markRetry(operation.operationId, String(error), nextAttemptAt);
        this.scheduleRetry(retryDelay(operation.retryCount));
        const bytes = operation.bytes ?? (operation.content === undefined ? undefined : new TextEncoder().encode(operation.content));
        if (bytes && chooseStorage(operation.path, bytes, this.options.inlineLimit ?? DEFAULT_INLINE_LIMIT) === "blob") {
          status.markError(`outbox:${operation.fileId}`);
          blockedFiles.add(operation.fileId);
          continue;
        }
        break;
      }
    }
    status.pending = (await store.pending()).length;
    status.refresh();
  }

  private async publishOne(operation: OutboxOperation): Promise<void> {
    if (operation.type === "delete") return this.publishDelete(operation);
    if (operation.type === "rename") return this.publishRename(operation);
    const { kv, vault } = this.options;
    const key = `f.${operation.fileId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await kv.get(key);
      const remote = current ? decodeRecord(current.value) : undefined;
      const localContent = operation.content;
      if (remote?.origin.operationId === operation.operationId && remote.contentHash === operation.localHash) {
        await this.acknowledge(operation, remote, current!.revision);
        return;
      }
      let content = localContent;
      if (current?.revision !== operation.baseRevision) {
        if (remote?.deleted) {
          await this.preserveConflict(operation, remote, current!.revision);
          return;
        }
        if (remote && (remote.kind !== "text" || localContent === undefined)) {
          await this.preserveConflict(operation, remote, current!.revision);
          return;
        }
        if (!remote || remote.content === undefined || localContent === undefined) {
          this.conflict();
          throw new Error("Remote base unavailable");
        }
        const result = resolveMarkdown(operation.baseContent, localContent, remote.content);
        if (result.kind === "conflict") {
          await this.preserveConflict(operation, remote, current!.revision);
          return;
        }
        content = result.content;
      }
      const bytes = content === undefined ? operation.bytes! : new TextEncoder().encode(content);
      const path = await this.resolveOutgoingPath(operation, remote?.path ?? operation.path);
      const common = {
        schemaVersion: 1, fileId: operation.fileId, path,
        deleted: false, contentHash: sha256Hex(bytes), size: bytes.length,
        origin: { deviceId: this.options.deviceId, operationId: operation.operationId, clientTime: Date.now() },
        basedOnRevision: current?.revision,
      } as const;
      const inline: RemoteFileRecord = { ...common, kind: "text", content: content ?? "" };
      const limit = Math.max(1, Math.min(this.options.inlineLimit ?? DEFAULT_INLINE_LIMIT,
        (kv.maxValueBytes ?? Number.POSITIVE_INFINITY) - 1024));
      const useBlob = chooseStorage(path, bytes, limit) === "blob" || encodeRecord(inline).length > limit;
      let record: RemoteFileRecord;
      if (useBlob) {
        const blob = this.options.blob;
        if (!blob || !this.options.vaultId) throw new Error("S3 blob settings required");
        const key = blobObjectKey(this.options.vaultId, common.contentHash);
        this.options.status.blobsPending++;
        this.options.status.refresh();
        try { await blob.upload(key, bytes); }
        finally { this.options.status.blobsPending--; this.options.status.refresh(); }
        record = { ...common, kind: "blob", blob: { algorithm: "sha256", hash: common.contentHash,
          key, size: bytes.length } };
      } else {
        record = inline;
      }
      try {
        const revision = current
          ? await kv.update!(key, encodeRecord(record), current.revision)
          : await kv.create!(key, encodeRecord(record));
        if (content !== localContent && sha256Hex((await vault.read(path)) ?? new Uint8Array()) === operation.localHash) {
          this.applyGuards.set(path, record.contentHash);
          await vault.write(path, bytes);
        }
        await this.acknowledge(operation, record, revision);
        return;
      } catch (error) {
        const latest = await kv.get(key);
        if (latest?.revision === current?.revision) throw error;
      }
    }
    throw new Error("CAS retries exhausted");
  }

  private async publishRename(operation: OutboxOperation): Promise<void> {
    const { kv } = this.options;
    const key = `f.${operation.fileId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await kv.get(key);
      if (!current) throw new Error("Rename base unavailable");
      const remote = decodeRecord(current.value);
      if (remote.origin.operationId === operation.operationId) {
        await this.acknowledge(operation, remote, current.revision); return;
      }
      if (remote.deleted || (current.revision !== operation.baseRevision &&
        remote.path !== operation.basePath && remote.path !== operation.path)) {
        await this.preserveConflict(operation, remote, current.revision); return;
      }
      const path = await this.resolveOutgoingPath(operation, operation.path);
      let content = remote.content;
      if (remote.kind === "text" && remote.content !== undefined && operation.content !== undefined &&
        remote.contentHash !== operation.baseHash) {
        const merged = resolveMarkdown(operation.baseContent, operation.content, remote.content);
        if (merged.kind === "conflict") {
          await this.preserveConflict(operation, remote, current.revision); return;
        }
        content = merged.content;
      }
      const bytes = content === undefined ? undefined : new TextEncoder().encode(content);
      const record: RemoteFileRecord = { ...remote, path, content,
        contentHash: bytes ? sha256Hex(bytes) : remote.contentHash, size: bytes?.length ?? remote.size,
        origin: { deviceId: this.options.deviceId, operationId: operation.operationId, clientTime: Date.now() },
        basedOnRevision: current.revision };
      try {
        const revision = await kv.update!(key, encodeRecord(record), current.revision);
        await this.acknowledge(operation, record, revision);
        return;
      } catch (error) {
        const latest = await kv.get(key);
        if (latest?.revision === current.revision) throw error;
      }
    }
    throw new Error("Rename CAS retries exhausted");
  }

  private async publishDelete(operation: OutboxOperation): Promise<void> {
    const { kv } = this.options;
    const key = `f.${operation.fileId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await kv.get(key);
      if (!current) { await this.options.store.confirm(operation.operationId); return; }
      const remote = decodeRecord(current.value);
      if (remote.deleted) { await this.acknowledge(operation, remote, current.revision); return; }
      if (current.revision !== operation.baseRevision && remote.contentHash !== operation.baseHash) {
        await this.preserveRemoteEdit(operation, remote, current.revision);
      }
      const record: RemoteFileRecord = { ...remote, deleted: true, content: undefined, blob: undefined,
        origin: { deviceId: this.options.deviceId, operationId: operation.operationId, clientTime: Date.now() },
        basedOnRevision: current.revision, deletion: { reason: "local delete" } };
      try {
        const revision = await kv.update!(key, encodeRecord(record), current.revision);
        await this.acknowledge(operation, record, revision);
        return;
      } catch (error) {
        const latest = await kv.get(key);
        if (latest?.revision === current.revision) throw error;
      }
    }
    throw new Error("Delete CAS retries exhausted");
  }

  private async preserveConflict(operation: OutboxOperation, remote: RemoteFileRecord, revision: number): Promise<void> {
    const { store, vault, status } = this.options;
    const copyFileId = conflictCopyId(operation.fileId, operation.operationId);
    const copyPath = operation.path.endsWith(".md")
      ? conflictCopyPath(operation.path, this.options.deviceId, operation.createdAt, operation.operationId)
      : this.collisionPath(operation.path, copyFileId);
    const bytes = operation.bytes ?? new TextEncoder().encode(operation.content!);
    const canonical = remote.deleted ? undefined : await this.loadRecordBytes(remote);
    const existing = await vault.read(copyPath);
    if (existing && sha256Hex(existing) !== operation.localHash) throw new Error("Conflict copy path occupied");
    const alreadyQueued = (await store.pending()).some((item) => item.fileId === copyFileId);
    if (!alreadyQueued) await store.queue({
      operationId: `copy-${operation.operationId}`, fileId: copyFileId, type: "create", path: copyPath,
      localHash: operation.localHash, content: operation.content, bytes: operation.bytes,
      kind: operation.kind, retryCount: 0, createdAt: operation.createdAt,
    });
    await store.putFile({ fileId: copyFileId, path: copyPath, localHash: operation.localHash, state: "pending" });
    if (!existing) {
      this.applyGuards.set(copyPath, operation.localHash);
      await vault.write(copyPath, bytes);
    }
    await store.putConflict({ operationId: operation.operationId, originalFileId: operation.fileId,
      originalPath: operation.path, copyFileId, copyPath, remoteRevision: revision });
    status.conflictPaths = (await store.conflicts()).map((item) => item.copyPath);
    status.conflicts = status.conflictPaths.length;
    await store.confirm(operation.operationId);
    if (remote.deleted) {
      if (await vault.read(operation.path)) {
        this.deleteGuards.add(operation.path);
        await vault.remove?.(operation.path);
      }
    } else if (canonical) {
      if (operation.path !== remote.path && await vault.read(operation.path)) {
        this.deleteGuards.add(operation.path);
        await vault.remove?.(operation.path);
      }
      this.applyGuards.set(remote.path, remote.contentHash);
      await vault.write(remote.path, canonical);
    }
    await store.putFile(this.syncedIndex(remote, revision));
  }

  private async preserveRemoteEdit(operation: OutboxOperation, remote: RemoteFileRecord, revision: number): Promise<void> {
    const remoteBytes = await this.loadRecordBytes(remote);
    const { store, vault, status } = this.options;
    const copyFileId = conflictCopyId(operation.fileId, operation.operationId);
    const copyPath = remote.path.endsWith(".md")
      ? conflictCopyPath(remote.path, this.options.deviceId, operation.createdAt, operation.operationId)
      : this.collisionPath(remote.path, copyFileId);
    const existing = await vault.read(copyPath);
    if (existing && sha256Hex(existing) !== remote.contentHash) throw new Error("Conflict copy path occupied");
    if (!(await store.pending()).some((item) => item.fileId === copyFileId)) {
      await store.queue({ operationId: `copy-${operation.operationId}`, fileId: copyFileId, type: "create",
        path: copyPath, content: remote.path.endsWith(".md") ? new TextDecoder().decode(remoteBytes) : undefined,
        bytes: remote.path.endsWith(".md") ? undefined : remoteBytes,
        kind: remote.path.endsWith(".md") ? "text" : "blob", localHash: remote.contentHash,
        retryCount: 0, createdAt: operation.createdAt });
    }
    await store.putFile({ fileId: copyFileId, path: copyPath, localHash: remote.contentHash, state: "pending" });
    if (!existing) {
      this.applyGuards.set(copyPath, remote.contentHash);
      await vault.write(copyPath, remoteBytes);
    }
    await store.putConflict({ operationId: operation.operationId, originalFileId: operation.fileId,
      originalPath: remote.path, copyFileId, copyPath, remoteRevision: revision });
    status.conflictPaths = (await store.conflicts()).map((item) => item.copyPath);
    status.conflicts = status.conflictPaths.length; status.refresh();
  }

  private collisionPath(path: string, fileId: string): string {
    const dot = path.lastIndexOf(".");
    return `${path.slice(0, dot)}.conflict-${fileId}${path.slice(dot)}`;
  }

  private async resolveOutgoingPath(operation: OutboxOperation, path: string): Promise<string> {
    const { kv, store, vault, status } = this.options;
    const colliding = (await kv.list()).map((entry) => ({ ...entry, record: decodeRecord(entry.value) }))
      .find((entry) => !entry.record.deleted && entry.record.fileId !== operation.fileId &&
        entry.record.path.toLocaleLowerCase() === path.toLocaleLowerCase());
    if (!colliding) return path;
    const copyPath = this.collisionPath(path, operation.fileId);
    const local = await vault.read(path);
    if (local && !await vault.read(copyPath)) {
      if (!vault.rename) throw new Error("Vault rename unavailable");
      this.renameGuards.add(`${path}\0${copyPath}`);
      await vault.rename(path, copyPath);
    }
    const indexed = await store.getFile(operation.fileId);
    if (indexed) await store.putFile({ ...indexed, path: copyPath });
    await store.putConflict({ operationId: `path-${colliding.record.fileId}-${operation.fileId}`,
      originalFileId: colliding.record.fileId, originalPath: path,
      copyFileId: operation.fileId, copyPath, remoteRevision: colliding.revision });
    status.conflictPaths = (await store.conflicts()).map((item) => item.copyPath);
    status.conflicts = status.conflictPaths.length; status.refresh();
    return copyPath;
  }

  private async acknowledge(operation: OutboxOperation, record: RemoteFileRecord, revision: number): Promise<void> {
    const indexed = await this.options.store.getFile(operation.fileId);
    const latest = (await this.options.store.pending()).find((item) => item.operationId === operation.operationId);
    const newer = latest && (latest.localHash !== operation.localHash || latest.content !== operation.content);
    if (record.deleted) {
      const path = indexed?.path ?? operation.path;
      if (await this.options.vault.read(path)) {
        this.deleteGuards.add(path);
        await this.options.vault.remove?.(path);
      }
    } else if (indexed && indexed.path !== record.path && await this.options.vault.read(indexed.path)) {
      if (!this.options.vault.rename) throw new Error("Vault rename unavailable");
      this.renameGuards.add(`${indexed.path}\0${record.path}`);
      await this.options.vault.rename(indexed.path, record.path);
    }
    if (record.content !== undefined) {
      const current = await this.options.vault.read(record.path);
      if ((!current || sha256Hex(current) !== record.contentHash) && !newer &&
          (!current || sha256Hex(current) === operation.localHash)) {
        this.applyGuards.set(record.path, record.contentHash);
        await this.options.vault.write(record.path, new TextEncoder().encode(record.content));
      }
    }
    await this.options.store.confirmPublished(operation, this.syncedIndex(record, revision));
  }

  private scheduleRetry(delay: number): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      void this.replayPending().catch((error: unknown) => this.backgroundError("outbox.retry_failed", error));
    }, Math.max(delay, 0));
  }

  private backgroundError(event: string, error: unknown): void {
    this.options.status.lastError = errorSummary(error);
    this.options.status.refresh();
    this.options.logger?.error(event, error);
  }

  private conflict(): void {
    this.options.status.conflicts++;
    this.options.status.refresh();
  }

  private async loadRecordBytes(record: RemoteFileRecord): Promise<Uint8Array> {
    if (record.kind === "text") return new TextEncoder().encode(record.content!);
    this.options.status.blobsPending++;
    this.options.status.refresh();
    try {
      if (!record.blob || !this.options.blob) throw new Error("S3 blob settings required");
      if (this.options.vaultId && record.blob.key !== blobObjectKey(this.options.vaultId, record.blob.hash)) {
        throw new Error("Blob key outside vault scope");
      }
      const bytes = await downloadVerified(this.options.blob, record.blob);
      this.options.status.clearError(`blob:${record.fileId}`);
      return bytes;
    } catch (error) {
      this.options.status.markError(`blob:${record.fileId}`);
      this.backgroundError("blob.download_failed", error);
      throw error;
    } finally {
      this.options.status.blobsPending--;
      this.options.status.refresh();
    }
  }

  private async applyRemote(value: Uint8Array, revision: number): Promise<void> {
    let record: RemoteFileRecord;
    try { record = decodeRecord(value); } catch { this.conflict(); return; }
    const { store, vault } = this.options;
    const current = await store.getFile(record.fileId);
    if (current?.remoteRevision !== undefined && current.remoteRevision >= revision) return;
    const pending = (await store.pending()).find((item) => item.fileId === record.fileId);
    if (pending) {
      return;
    }
    if (record.deleted) {
      if (current && !current.deleted) {
        const local = await vault.read(current.path);
        if (local && sha256Hex(local) !== current.localHash) {
          await this.capture(current.path, new TextDecoder().decode(local));
          return;
        }
        if (local) {
          this.deleteGuards.add(current.path);
          await vault.remove?.(current.path);
        }
      }
      await store.putFile(this.syncedIndex(record, revision));
      return;
    }
    ({ record, revision } = await this.resolveIncomingCollision(record, revision));
    const path = normalizePath(record.path);
    const localPath = current && !current.deleted ? current.path : path;
    const local = await vault.read(localPath);
    if (local && current && !current.deleted && sha256Hex(local) !== current.localHash) {
      await this.captureBytes(localPath, local);
      if ((await store.pending()).some((item) => item.fileId === record.fileId)) {
        this.conflict();
        return;
      }
    }
    if (local && sha256Hex(local) !== record.contentHash && !current) {
      if (record.kind === "text" && path.endsWith(".md")) {
        if (!await this.preserveBootstrapConflict(record, new TextDecoder().decode(local))) return;
      } else if (!await this.preserveBootstrapBytes(record, local)) return;
    }
    let remoteBytes: Uint8Array | undefined;
    if (!local || sha256Hex(local) !== record.contentHash) {
      try { remoteBytes = await this.loadRecordBytes(record); }
      catch { return; }
    }
    if (current && localPath !== path && local) {
      if (!vault.rename) throw new Error("Vault rename unavailable");
      this.renameGuards.add(`${localPath}\0${path}`);
      await vault.rename(localPath, path);
    }
    if (!local || sha256Hex(local) !== record.contentHash) {
      this.applyGuards.set(path, record.contentHash);
      await vault.write(path, remoteBytes!);
    }
    await store.putFile(this.syncedIndex(record, revision));
  }

  private async resolveIncomingCollision(record: RemoteFileRecord, revision: number): Promise<{ record: RemoteFileRecord; revision: number }> {
    const { store, kv, vault, status } = this.options;
    const latest = await kv.get(`f.${record.fileId}`);
    if (latest && latest.revision > revision) {
      record = decodeRecord(latest.value);
      revision = latest.revision;
    }
    const other = (await store.files()).find((item) => !item.deleted && item.fileId !== record.fileId &&
      item.path.toLocaleLowerCase() === record.path.toLocaleLowerCase());
    if (!other) return { record, revision };
    const loserId = record.fileId > other.fileId ? record.fileId : other.fileId;
    const copyPath = this.collisionPath(record.path, loserId);
    const operationId = `path-${record.fileId < other.fileId ? record.fileId : other.fileId}-${loserId}`;
    await store.putConflict({ operationId, originalFileId: record.fileId, originalPath: record.path,
      copyFileId: loserId, copyPath, remoteRevision: revision });
    status.conflictPaths = (await store.conflicts()).map((item) => item.copyPath);
    status.conflicts = status.conflictPaths.length; status.refresh();
    if (loserId === record.fileId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = await kv.get(`f.${record.fileId}`);
        if (!head) throw new Error("Colliding record unavailable");
        const headRecord = decodeRecord(head.value);
        if (headRecord.path === copyPath) return { record: headRecord, revision: head.revision };
        const corrected = { ...headRecord, path: copyPath,
          origin: { deviceId: this.options.deviceId, operationId: crypto.randomUUID(), clientTime: Date.now() },
          basedOnRevision: head.revision };
        try {
          const nextRevision = await kv.update!(`f.${record.fileId}`, encodeRecord(corrected), head.revision);
          return { record: corrected, revision: nextRevision };
        } catch (error) {
          if ((await kv.get(`f.${record.fileId}`))?.revision === head.revision) throw error;
        }
      }
      throw new Error("Path correction CAS retries exhausted");
    }
    if ((await store.pending()).some((item) => item.fileId === other.fileId)) throw new Error("Path collision with pending file");
    const current = await kv.get(`f.${other.fileId}`);
    if (!current) throw new Error("Colliding record unavailable");
    const corrected = { ...decodeRecord(current.value), path: copyPath,
      origin: { deviceId: this.options.deviceId, operationId: crypto.randomUUID(), clientTime: Date.now() },
      basedOnRevision: current.revision };
    const nextRevision = await kv.update!(`f.${other.fileId}`, encodeRecord(corrected), current.revision);
    if (await vault.read(other.path)) {
      if (!vault.rename) throw new Error("Vault rename unavailable");
      this.renameGuards.add(`${other.path}\0${copyPath}`);
      await vault.rename(other.path, copyPath);
    }
    await store.putFile({ ...other, path: copyPath, remoteRevision: nextRevision });
    return { record, revision };
  }
}
