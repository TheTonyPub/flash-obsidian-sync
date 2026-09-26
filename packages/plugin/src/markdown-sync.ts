import { createFileId, decodeRecord, encodeRecord, normalizePath, sha256Hex, type RemoteFileRecord } from "@flash-osidian-sync/protocol";
import { type KvPort, type SyncStatus } from "./connection.js";
import { type ConflictRecord, type FileIndexEntry, type LocalStore, type OutboxOperation } from "./local-store.js";
import { conflictCopyId, conflictCopyPath, resolveMarkdown } from "./conflict-resolution.js";
import { blobObjectKey, chooseStorage, DEFAULT_INLINE_LIMIT, downloadVerified, type BlobPort } from "./blob-storage.js";
import { errorSummary, type PluginLogger } from "./diagnostics.js";

/** Local-only notes created by the conflict review UI. */
export const CONFLICT_REVIEW_FOLDER = "Flash Sync Conflict Reviews";

function isConflictReviewPath(path: string): boolean {
  return path === CONFLICT_REVIEW_FOLDER || path.startsWith(`${CONFLICT_REVIEW_FOLDER}/`);
}

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

class BlobStorageUnavailableError extends Error {
  constructor() { super("S3 storage is not configured; large files remain local and pending"); }
}

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

  private async isLocalOnlyArtifactPath(path: string): Promise<boolean> {
    if (isConflictReviewPath(path)) return true;
    return (await this.options.store.conflicts()).some((conflict) =>
      conflict.copyPath === path || conflict.recoveryBackup?.path === path);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.buffering = true;
    this.options.status.connected = true;
    this.options.status.reconciled = false;
    this.options.status.refresh();
    this.stopVault = this.options.vault.onModify((path) => {
      void Promise.resolve().then(() => this.options.vault.read(path)).then(async (bytes) => {
        if (this.stopped || !bytes || await this.isLocalOnlyArtifactPath(path)) return;
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
    if (this.stopped || isConflictReviewPath(path)) return;
    const previous = this.timers.get(path);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(path);
      void this.capture(path, content).catch((error: unknown) => this.backgroundError("capture.failed", error));
    }, this.options.debounceMs ?? 250);
    this.timers.set(path, timer);
  }

  async capture(path: string, content: string): Promise<void> {
    if (await this.isLocalOnlyArtifactPath(path)) return;
    const next = this.captureChain.catch(() => {}).then(() => this.captureOne(path, new TextEncoder().encode(content), content));
    this.captureChain = next;
    await next;
  }

  async captureBytes(path: string, bytes: Uint8Array): Promise<void> {
    if (await this.isLocalOnlyArtifactPath(path)) return;
    const content = path.endsWith(".md") ? new TextDecoder().decode(bytes) : undefined;
    const next = this.captureChain.catch(() => {}).then(() => this.captureOne(path, bytes, content));
    this.captureChain = next;
    await next;
  }

  async rename(from: string, to: string): Promise<void> {
    from = normalizePath(from); to = normalizePath(to);
    if (from === to || await this.isLocalOnlyArtifactPath(from) || isConflictReviewPath(to)) return;
    const { store, vault, status } = this.options;
    const indexed = await store.getFileByPath(from);
    if (!indexed) return;
    if (await vault.read(from)) {
      this.conflict();
      return;
    }
    const bytes = await vault.read(to);
    if (!bytes) throw new Error("Renamed file is missing");
    const content = to.endsWith(".md") ? new TextDecoder().decode(bytes) : undefined;
    const pathEntries = (await store.files()).filter((item) => item.fileId !== indexed.fileId && item.path === to);
    const releasedFileId = !await vault.read(from) && pathEntries.length === 1 ? pathEntries[0].fileId : undefined;
    const operation: OutboxOperation = { operationId: crypto.randomUUID(), fileId: indexed.fileId, type: "rename", path: to,
      basePath: from, localHash: sha256Hex(bytes), content, bytes: content === undefined ? bytes : undefined,
      kind: content === undefined ? "blob" : "text", baseContent: indexed.baseContent,
      baseHash: indexed.remoteHash, baseRevision: indexed.remoteRevision, retryCount: 0, createdAt: Date.now() };
    await store.queuePathReuse(operation, { ...indexed, path: to, localHash: operation.localHash, state: "pending" }, releasedFileId);
    status.pending = (await store.pending()).length; status.refresh();
    await this.replayPending();
  }

  async remove(path: string): Promise<void> {
    path = normalizePath(path);
    if (await this.isLocalOnlyArtifactPath(path)) return;
    const { store, status } = this.options;
    const local = await this.options.vault.read(path);
    if (local) {
      const identities = await store.files();
      if (identities.some((entry) => entry.path === path && entry.deleted) &&
          identities.some((entry) => entry.path === path && !entry.deleted)) return;
    }
    const indexed = await store.getFileByPath(path);
    if (!indexed) return;
    await store.queue({ operationId: crypto.randomUUID(), fileId: indexed.fileId, type: "delete", path,
      localHash: indexed.localHash, baseHash: indexed.remoteHash, baseRevision: indexed.remoteRevision,
      baseContent: indexed.baseContent, retryCount: 0, createdAt: Date.now() });
    await store.putFile({ ...indexed, deleted: true, state: "pending" });
    status.pending = (await store.pending()).length; status.refresh();
    await this.replayPending();
  }

  /** Live, anchored comparison consumed by the conflict view. */
  async compareConflict(operationId: string): Promise<{ remote: Record<string, unknown>; local: Record<string, unknown>; stale: { remote: boolean; local: boolean } }> {
    const record = await this.requireConflict(operationId);
    const head = await this.options.kv.get(`f.${record.originalFileId}`);
    if (!head) throw new Error("Conflict remote record is missing");
    const remote = decodeRecord(head.value);
    const copy = await this.options.vault.read(record.copyPath);
    const localHash = copy ? sha256Hex(copy) : undefined;
    const reviewableBlob = remote.kind === "blob" && remote.path.endsWith(".md") &&
      remote.size <= (this.options.inlineLimit ?? DEFAULT_INLINE_LIMIT);
    let metadataOnly = (remote.kind === "blob" && !reviewableBlob) ||
      remote.size > (this.options.inlineLimit ?? DEFAULT_INLINE_LIMIT);
    let remoteContent = remote.content;
    let localContent = copy ? new TextDecoder().decode(copy) : undefined;
    if (reviewableBlob) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        remoteContent = decoder.decode(await this.loadRecordBytes(remote));
        localContent = copy ? decoder.decode(copy) : undefined;
      } catch (error) {
        if (error instanceof TypeError) {
          metadataOnly = true;
          remoteContent = undefined;
          localContent = undefined;
        } else throw error;
      }
    }
    return {
      remote: { path: remote.path, hash: remote.contentHash, size: remote.size, revision: head.revision,
        ...(!metadataOnly && remoteContent !== undefined ? { content: remoteContent } : {}) },
      local: { path: record.copyPath, hash: localHash, size: copy?.length,
        ...(!metadataOnly && localContent !== undefined ? { content: localContent } : {}) },
      stale: { remote: !!record.detectionRemoteHash && remote.contentHash !== record.detectionRemoteHash,
        local: !!record.detectionCopyHash && localHash !== record.detectionCopyHash },
    };
  }

  async keepRemote(operationId: string): Promise<void> {
    const { record, remote, head, canonical } = await this.validatedAction(operationId);
    const remoteBytes = await this.loadRecordBytes(remote);
    const backup = await this.backupCanonical(record, canonical);
    this.applyGuards.set(record.canonicalPath ?? record.originalPath, remote.contentHash);
    await this.options.vault.write(record.canonicalPath ?? record.originalPath, remoteBytes);
    await this.options.store.putFile(this.syncedIndex(remote, head.revision));
    await this.options.store.updateConflict(operationId, { lifecycle: "resolved", recoveryBackup: backup });
    await this.options.store.appendConflictHistory({ operationId, event: "resolved", outcome: "keep-remote" });
    await this.refreshConflicts();
  }

  async keepLocalCopy(operationId: string): Promise<void> {
    const { record, remote, head, canonical } = await this.validatedAction(operationId);
    const copy = await this.options.vault.read(record.copyPath);
    if (!copy) throw new Error("Conflict copy is missing");
    const hash = sha256Hex(copy);
    if (record.detectionCopyHash && hash !== record.detectionCopyHash) throw new Error("Conflict copy changed; refresh conflict review");
    const backup = await this.backupCanonical(record, canonical);
    const path = record.canonicalPath ?? record.originalPath;
    this.applyGuards.set(path, hash);
    await this.options.vault.write(path, copy);
    await this.options.store.queue({ operationId: `resolve-${operationId}`, fileId: record.originalFileId, type: "modify", path,
      localHash: hash, content: path.endsWith(".md") ? new TextDecoder().decode(copy) : undefined,
      bytes: path.endsWith(".md") ? undefined : copy, kind: path.endsWith(".md") ? "text" : "blob",
      baseRevision: head.revision, baseHash: remote.contentHash, retryCount: 0, createdAt: Date.now() });
    await this.options.store.putFile({ fileId: record.originalFileId, path, localHash: hash, remoteHash: remote.contentHash,
      remoteRevision: head.revision, kind: remote.kind, state: "pending" });
    await this.options.store.updateConflict(operationId, { lifecycle: "pending-sync", recoveryBackup: backup });
    await this.options.store.appendConflictHistory({ operationId, event: "pending", outcome: "keep-local-copy" });
    await this.refreshConflicts();
    void this.replayPending().catch((error: unknown) => this.backgroundError("resolution.publish_failed", error));
  }

  async markResolved(operationId: string): Promise<void> {
    const record = await this.requireConflict(operationId);
    const head = await this.options.kv.get(`f.${record.originalFileId}`);
    if (!head) throw new Error("Conflict remote record is missing");
    const remote = decodeRecord(head.value);
    const path = record.canonicalPath ?? record.originalPath;
    const local = await this.options.vault.read(path);
    if (!remote.deleted && remote.path === path && local && sha256Hex(local) === remote.contentHash) {
      await this.options.store.updateConflict(operationId, { lifecycle: "resolved" });
      await this.options.store.appendConflictHistory({ operationId, event: "resolved", outcome: "manual-match" });
      await this.refreshConflicts();
      return;
    }
    if (record.remoteRevision !== undefined && head.revision !== record.remoteRevision) {
      // Older incoming-collision records captured the path before the losing identity moved.
      const expectedRemotePath = record.context === "path-collision" &&
        record.copyFileId === record.originalFileId && record.remotePath === record.originalPath
        ? record.copyPath : record.remotePath;
      const deletionMatches = record.detectionRemoteDeleted === undefined
        ? !remote.deleted : remote.deleted === record.detectionRemoteDeleted;
      const sameSnapshot = !!record.detectionRemoteHash && remote.contentHash === record.detectionRemoteHash &&
        expectedRemotePath !== undefined && remote.path === expectedRemotePath && deletionMatches &&
        (!record.kind || remote.kind === record.kind);
      if (!sameSnapshot) throw new Error("Remote changed; refresh conflict review");
    }
    const deleted = !local;
    await this.options.store.queue({ operationId: `resolve-${operationId}`, fileId: record.originalFileId,
      type: deleted ? "delete" : "modify", path, localHash: local ? sha256Hex(local) : remote.contentHash,
      content: local && path.endsWith(".md") ? new TextDecoder().decode(local) : undefined,
      bytes: local && !path.endsWith(".md") ? local : undefined, kind: local && !path.endsWith(".md") ? "blob" : "text",
      baseRevision: head.revision, baseHash: remote.contentHash, retryCount: 0, createdAt: Date.now() });
    await this.options.store.updateConflict(operationId, { lifecycle: "pending-sync" });
    await this.options.store.appendConflictHistory({ operationId, event: "pending", outcome: deleted ? "manual-delete" : "manual-edit" });
    await this.refreshConflicts();
    void this.replayPending().catch((error: unknown) => this.backgroundError("resolution.publish_failed", error));
  }

  private async requireConflict(operationId: string): Promise<ConflictRecord> {
    const record = await this.options.store.getConflict(operationId);
    if (!record) throw new Error(`Unknown conflict: ${operationId}`);
    if (record.lifecycle === "resolved") throw new Error("Conflict is already resolved");
    return record;
  }

  private async validatedAction(operationId: string): Promise<{ record: ConflictRecord; remote: RemoteFileRecord; head: { value: Uint8Array; revision: number }; canonical?: Uint8Array }> {
    const record = await this.requireConflict(operationId);
    const head = await this.options.kv.get(`f.${record.originalFileId}`);
    if (!head) throw new Error("Conflict remote record is missing");
    const remote = decodeRecord(head.value);
    const path = record.canonicalPath ?? record.originalPath;
    const canonical = await this.options.vault.read(path);
    if (record.remoteRevision !== undefined && head.revision !== record.remoteRevision) throw new Error("Remote changed; refresh conflict review");
    if (record.detectionRemoteHash && remote.contentHash !== record.detectionRemoteHash) throw new Error("Remote content changed; refresh conflict review");
    const canonicalChanged = record.context === "path-collision"
      ? (remote.deleted ? !!canonical : !canonical || sha256Hex(canonical) !== remote.contentHash)
      : !!record.detectionLocalHash && (!canonical || sha256Hex(canonical) !== record.detectionLocalHash);
    if (canonicalChanged) {
      throw new Error("Canonical path changed; refresh conflict review");
    }
    return { record, remote, head, canonical };
  }

  private async backupCanonical(record: ConflictRecord, bytes: Uint8Array | undefined): Promise<ConflictRecord["recoveryBackup"]> {
    if (!bytes) return undefined;
    const path = `${record.canonicalPath ?? record.originalPath}.recovery-${record.operationId}`;
    const hash = sha256Hex(bytes);
    const existing = await this.options.vault.read(path);
    if (existing && sha256Hex(existing) !== hash) throw new Error("Recovery backup path occupied");
    if (!existing) {
      this.applyGuards.set(path, hash);
      await this.options.vault.write(path, bytes);
    }
    await this.options.store.appendConflictHistory({ operationId: record.operationId, event: "backup", path });
    return { path, hash, size: bytes.length };
  }

  private async refreshConflicts(): Promise<void> {
    const conflicts = await this.options.store.unresolvedConflicts();
    this.options.status.conflictPaths = conflicts.map((item) => item.copyPath);
    this.options.status.conflicts = conflicts.length;
    this.options.status.pending = (await this.options.store.pending()).length;
    this.options.status.refresh();
  }

  private async returnResolutionToReview(operation: OutboxOperation, outcome: string): Promise<void> {
    const operationId = operation.operationId.slice("resolve-".length);
    await this.options.store.confirm(operation.operationId);
    const conflict = await this.options.store.getConflict(operationId);
    if (conflict && conflict.lifecycle !== "resolved") {
      await this.options.store.updateConflict(operationId, { lifecycle: "unresolved" });
      await this.options.store.appendConflictHistory({ operationId, event: "stale", outcome });
    }
    await this.refreshConflicts();
  }

  private async captureOne(path: string, bytes: Uint8Array, content?: string): Promise<void> {
    path = normalizePath(path);
    if (await this.isLocalOnlyArtifactPath(path)) return;
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
    const startedAt = performance.now();
    let watchSetupMs = 0;
    let localScanMs = 0;
    let remoteListMs = 0;
    let remoteApplyMs = 0;
    let localApplyMs = 0;
    let outboxReplayMs = 0;
    let remoteApplied = 0;
    let localApplied = 0;
    let stage = "watch";
    status.reconciled = false;
    status.pending = (await store.pending()).length;
    status.conflictPaths = (await store.unresolvedConflicts()).map((item) => item.copyPath);
    status.conflicts = status.conflictPaths.length;
    status.refresh();
    this.options.logger?.debug("reconcile.start", { pending: status.pending, conflicts: status.conflicts });
    try {
      const watchSetupStartedAt = performance.now();
      this.stopWatch?.();
      this.stopWatch = await kv.watch((entry) => {
        if (this.buffering) this.buffered.push(entry);
        else this.queueLive(entry);
      });
      watchSetupMs = Math.round(performance.now() - watchSetupStartedAt);
      stage = "local_scan";
      const localScanStartedAt = performance.now();
      const generatedPaths = new Set((await store.conflicts()).flatMap((conflict) =>
        [conflict.copyPath, conflict.recoveryBackup?.path].filter((path): path is string => !!path)));
      const local = (vault.listFiles
        ? await vault.listFiles()
        : (await vault.listMarkdown()).map((file) => ({ path: file.path, bytes: new TextEncoder().encode(file.content) })))
        .filter((file) => !isConflictReviewPath(file.path) && !generatedPaths.has(file.path));
      const localByPath = new Map(local.map((file) => [file.path, file]));
      localScanMs = Math.round(performance.now() - localScanStartedAt);
      stage = "remote_list";
      const remoteListStartedAt = performance.now();
      const remote = (await kv.list()).sort((left, right) => {
        try {
          return Number(decodeRecord(right.value).deleted) - Number(decodeRecord(left.value).deleted);
        } catch { return 0; }
      });
      await this.recoverPathReuse(local, remote);
      remoteListMs = Math.round(performance.now() - remoteListStartedAt);
      this.options.logger?.debug("reconcile.snapshot", { localFiles: local.length, remoteFiles: remote.length });
      stage = "remote_apply";
      const remoteApplyStartedAt = performance.now();
      const remotePaths = new Set<string>();
      for (const entry of remote) {
        let record: RemoteFileRecord;
        try { record = decodeRecord(entry.value); }
        catch { this.conflict(); continue; }
        if (isConflictReviewPath(record.path)) continue;
        if (!record.deleted) remotePaths.add(record.path);
        if (record.deleted) { await this.applyRemote(entry.value, entry.revision); remoteApplied++; continue; }
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
        remoteApplied++;
      }
      while (this.buffered.length) {
        const batch = this.buffered.splice(0).sort((a, b) => a.revision - b.revision);
        for (const entry of batch) await this.applyRemote(entry.value, entry.revision);
        remoteApplied += batch.length;
      }
      remoteApplyMs = Math.round(performance.now() - remoteApplyStartedAt);
      stage = "local_apply";
      const localApplyStartedAt = performance.now();
      for (const file of local) {
        if (!remotePaths.has(file.path) && !await store.getFileByPath(file.path) && await vault.read(file.path)) {
          await this.captureBytes(file.path, file.bytes);
          localApplied++;
        }
      }
      localApplyMs = Math.round(performance.now() - localApplyStartedAt);
      await this.captureChain;
      stage = "outbox_replay";
      const outboxReplayStartedAt = performance.now();
      await this.replayPending(true);
      outboxReplayMs = Math.round(performance.now() - outboxReplayStartedAt);
    } catch (error) {
      const failure = new Error("Reconciliation failed; local outbox retained", { cause: error });
      status.lastError = errorSummary(failure);
      this.options.logger?.error("reconcile.failed", failure, {
        stage, pending: status.pending, durationMs: Math.round(performance.now() - startedAt),
      });
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
    this.options.logger?.debug("reconcile.complete", {
      pending: status.pending, conflicts: status.conflicts, remoteApplied, localApplied,
      watchSetupMs, localScanMs, remoteListMs, remoteApplyMs, localApplyMs, outboxReplayMs,
      totalDurationMs: Math.round(performance.now() - startedAt),
    });
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
    const bytes = new TextEncoder().encode(localContent);
    const operationId = `bootstrap-${record.fileId}-${sha256Hex(bytes)}`;
    await this.options.store.putConflict({ operationId, originalFileId: record.fileId, originalPath: record.path,
      copyFileId: conflictCopyId(record.fileId, operationId), copyPath: path, remoteRevision: (await this.options.kv.get(`f.${record.fileId}`))?.revision ?? 0,
      lifecycle: "unresolved", context: "bootstrap", canonicalPath: record.path, remotePath: record.path,
      detectionRemoteHash: record.contentHash, detectionRemoteDeleted: record.deleted,
      detectionLocalHash: sha256Hex(bytes), detectionCopyHash: sha256Hex(bytes), kind: record.kind, size: record.size });
    await this.options.store.appendConflictHistory({ operationId, event: "detected", context: "bootstrap", path });
    if (!existing) {
      this.applyGuards.set(path, sha256Hex(bytes));
      await this.options.vault.write(path, bytes);
    }
    return true;
  }

  private async preserveBootstrapBytes(record: RemoteFileRecord, bytes: Uint8Array): Promise<boolean> {
    const path = this.collisionPath(record.path, record.fileId);
    const existing = await this.options.vault.read(path);
    if (existing && sha256Hex(existing) !== sha256Hex(bytes)) { this.conflict(); return false; }
    const operationId = `bootstrap-${record.fileId}-${sha256Hex(bytes)}`;
    await this.options.store.putConflict({ operationId, originalFileId: record.fileId, originalPath: record.path,
      copyFileId: conflictCopyId(record.fileId, operationId), copyPath: path, remoteRevision: (await this.options.kv.get(`f.${record.fileId}`))?.revision ?? 0,
      lifecycle: "unresolved", context: "bootstrap", canonicalPath: record.path, remotePath: record.path,
      detectionRemoteHash: record.contentHash, detectionRemoteDeleted: record.deleted,
      detectionLocalHash: sha256Hex(bytes), detectionCopyHash: sha256Hex(bytes), kind: record.kind, size: record.size });
    await this.options.store.appendConflictHistory({ operationId, event: "detected", context: "bootstrap", path });
    if (!existing) {
      this.applyGuards.set(path, sha256Hex(bytes));
      await this.options.vault.write(path, bytes);
    }
    return true;
  }

  private syncedIndex(record: RemoteFileRecord, revision: number): FileIndexEntry {
    return { fileId: record.fileId, path: record.path, localHash: record.contentHash,
      remoteHash: record.contentHash, remoteRevision: revision,
      baseContent: record.content, kind: record.kind,
      lastAppliedRemoteHash: record.contentHash, deleted: record.deleted, state: "synced" };
  }

  private async recoverPathReuse(local: Array<{ path: string; bytes: Uint8Array }>,
    remote: Array<{ value: Uint8Array }>): Promise<void> {
    const { store } = this.options;
    const indexed = await store.files();
    const remoteById = new Map(remote.flatMap((entry) => {
      try {
        const record = decodeRecord(entry.value);
        return [[record.fileId, record] as const];
      } catch { return []; }
    }));
    const localPaths = new Set(local.map((file) => normalizePath(file.path)));
    for (const file of local) {
      const path = normalizePath(file.path);
      const owners = indexed.filter((entry) => entry.path === path);
      if (owners.length !== 1) continue;
      const owner = owners[0];
      const hash = sha256Hex(file.bytes);
      if (!owner.deleted && owner.localHash === hash) continue;
      const candidates = indexed.filter((entry) => entry.fileId !== owner.fileId && !entry.deleted &&
        entry.path !== path && !localPaths.has(entry.path) && entry.localHash === hash);
      if (candidates.length !== 1) continue;
      const renamed = candidates[0];
      const remoteRecord = remoteById.get(renamed.fileId);
      if (remoteRecord && !remoteRecord.deleted && remoteRecord.path === path) continue;
      const content = path.endsWith(".md") ? new TextDecoder().decode(file.bytes) : undefined;
      const operation: OutboxOperation = {
        operationId: crypto.randomUUID(), fileId: renamed.fileId, type: "rename", path,
        basePath: renamed.path, localHash: hash, content, bytes: content === undefined ? file.bytes.slice() : undefined,
        kind: content === undefined ? "blob" : "text", baseContent: renamed.baseContent,
        baseHash: renamed.remoteHash, baseRevision: renamed.remoteRevision, retryCount: 0, createdAt: Date.now(),
      };
      await store.queuePathReuse(operation, { ...renamed, path, localHash: hash, state: "pending" }, owner.fileId);
    }
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
        if (operation.predecessorOperationId) {
          const predecessor = (await store.pending()).find((item) => item.operationId === operation.predecessorOperationId);
          if (predecessor) {
            const head = await this.options.kv.get(`f.${predecessor.fileId}`);
            if (!head) continue;
            const record = decodeRecord(head.value);
            if (!record.deleted || record.origin.operationId !== predecessor.operationId) continue;
            await this.acknowledge(predecessor, record, head.revision);
          }
        }
        this.options.logger?.debug("outbox.publish", { operationType: operation.type, retryCount: operation.retryCount });
        await this.publishOne(operation);
        this.options.logger?.debug("outbox.published", { operationType: operation.type });
        status.clearError(`outbox:${operation.fileId}`);
        if (operation.type === "delete") {
          for (const dependent of await store.pending()) {
            if (dependent.predecessorOperationId === operation.operationId) processed.delete(dependent.operationId);
          }
        }
      } catch (error) {
        status.lastError = errorSummary(error);
        if (error instanceof BlobStorageUnavailableError) {
          status.markError(`outbox:${operation.fileId}`);
          blockedFiles.add(operation.fileId);
          continue;
        }
        this.options.logger?.error("outbox.publish_failed", error, { operationType: operation.type, retryCount: operation.retryCount });
        const nextAttemptAt = Date.now() + retryDelay(operation.retryCount);
        await store.markRetry(operation.operationId, String(error), nextAttemptAt);
        this.scheduleRetry(retryDelay(operation.retryCount));
        const bytes = operation.bytes ?? (operation.content === undefined ? undefined : new TextEncoder().encode(operation.content));
        if (bytes && chooseStorage(operation.path, bytes, this.options.inlineLimit ?? DEFAULT_INLINE_LIMIT) === "blob") {
          status.markError(`outbox:${operation.fileId}`);
          blockedFiles.add(operation.fileId);
        }
        continue;
      }
    }
    status.pending = (await store.pending()).length;
    status.refresh();
  }

  private async publishOne(operation: OutboxOperation): Promise<void> {
    if (operation.type === "delete") return this.publishDelete(operation);
    if (operation.type === "rename") return this.publishRename(operation);
    const { kv, store, vault } = this.options;
    const key = `f.${operation.fileId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await kv.get(key);
      const remote = current ? decodeRecord(current.value) : undefined;
      const localContent = operation.content;
      if (remote?.origin.operationId === operation.operationId && remote.contentHash === operation.localHash) {
        await this.acknowledge(operation, remote, current!.revision);
        return;
      }
      // A remote write can contain the exact bytes we intend to publish while using
      // a different representation. There is no divergence to preserve as a conflict.
      if (remote && !remote.deleted && remote.contentHash === operation.localHash) {
        await this.acknowledge(operation, remote, current!.revision);
        return;
      }
      if (operation.operationId.startsWith("resolve-") && current?.revision !== operation.baseRevision) {
        await this.returnResolutionToReview(operation, "remote-revision-changed");
        return;
      }
      const indexed = await store.getFile(operation.fileId);
      const operationPath = normalizePath(operation.path);
      const establishedSamePath = operation.type === "modify" &&
        indexed?.fileId === operation.fileId && !indexed.deleted &&
        normalizePath(indexed.path) === operationPath &&
        remote?.fileId === operation.fileId && !remote.deleted &&
        normalizePath(remote.path) === operationPath;
      const path = establishedSamePath
        ? remote!.path
        : await this.resolveOutgoingPath(operation, remote?.path ?? operation.path);
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
        if (!blob || !this.options.vaultId) throw new BlobStorageUnavailableError();
        const key = blobObjectKey(this.options.vaultId, common.contentHash);
        this.options.status.blobsPending++;
        this.options.status.refresh();
        try {
          await blob.upload(key, bytes);
          this.options.status.attachmentState = "CONFIGURED";
          this.options.status.attachmentError = "";
        } catch (error) {
          this.options.status.attachmentState = "TRANSFER_ERROR";
          this.options.status.attachmentError = errorSummary(error);
          throw error;
        }
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
      if (remote.deleted && remote.origin.operationId === operation.operationId) {
        await this.acknowledge(operation, remote, current.revision); return;
      }
      if (operation.operationId.startsWith("resolve-") && current.revision !== operation.baseRevision) {
        await this.returnResolutionToReview(operation, "remote-revision-changed");
        return;
      }
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
    const prior = (await store.unresolvedConflicts()).find((entry) =>
      entry.context === "merge" && entry.originalFileId === operation.fileId);
    if (prior) {
      // A restarted CAS retry must retain the original durable record and copy.
      // Leave this operation in the outbox for refreshed review instead of creating
      // another copy whose identity is merely a retry UUID.
      await store.appendConflictHistory({ operationId: prior.operationId, event: "retry", outcome: "preserved" });
      await this.refreshConflicts();
      throw new Error("Conflict requires refreshed review");
    }
    const copyFileId = conflictCopyId(operation.fileId, operation.operationId);
    const copyPath = operation.path.endsWith(".md")
      ? conflictCopyPath(operation.path, this.options.deviceId, operation.createdAt, operation.operationId)
      : this.collisionPath(operation.path, copyFileId);
    const bytes = operation.bytes ?? new TextEncoder().encode(operation.content!);
    const canonical = remote.deleted ? undefined : await this.loadRecordBytes(remote);
    const existing = await vault.read(copyPath);
    if (existing && sha256Hex(existing) !== operation.localHash) throw new Error("Conflict copy path occupied");
    if (!existing) {
      this.applyGuards.set(copyPath, operation.localHash);
      await vault.write(copyPath, bytes);
    }
    await store.putConflict({ operationId: operation.operationId, originalFileId: operation.fileId,
      originalPath: operation.path, copyFileId, copyPath, remoteRevision: revision, lifecycle: "unresolved", context: "merge",
      canonicalPath: remote.path, remotePath: remote.path, detectionRemoteHash: remote.contentHash,
      detectionRemoteDeleted: remote.deleted, detectionLocalHash: operation.localHash,
      detectionCopyHash: operation.localHash, kind: remote.kind, size: remote.size });
    await store.appendConflictHistory({ operationId: operation.operationId, event: "detected", context: "merge", path: copyPath });
    status.conflictPaths = (await store.unresolvedConflicts()).map((item) => item.copyPath);
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
    if (!existing) {
      this.applyGuards.set(copyPath, remote.contentHash);
      await vault.write(copyPath, remoteBytes);
    }
    await store.putConflict({ operationId: operation.operationId, originalFileId: operation.fileId,
      originalPath: remote.path, copyFileId, copyPath, remoteRevision: revision, lifecycle: "unresolved", context: "merge",
      canonicalPath: remote.path, remotePath: remote.path, detectionRemoteHash: remote.contentHash,
      detectionRemoteDeleted: remote.deleted, detectionLocalHash: operation.localHash,
      detectionCopyHash: remote.contentHash, kind: remote.kind, size: remote.size });
    await store.appendConflictHistory({ operationId: operation.operationId, event: "detected", context: "merge", path: copyPath });
    status.conflictPaths = (await store.unresolvedConflicts()).map((item) => item.copyPath);
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
      copyFileId: operation.fileId, copyPath, remoteRevision: colliding.revision, lifecycle: "unresolved", context: "path-collision",
      canonicalPath: path, remotePath: colliding.record.path, detectionRemoteHash: colliding.record.contentHash,
      detectionRemoteDeleted: colliding.record.deleted,
      detectionLocalHash: local ? sha256Hex(local) : undefined, detectionCopyHash: local ? sha256Hex(local) : undefined,
      kind: colliding.record.kind, size: colliding.record.size });
    await store.appendConflictHistory({ operationId: `path-${colliding.record.fileId}-${operation.fileId}`, event: "detected", context: "path-collision", path: copyPath });
    status.conflictPaths = (await store.unresolvedConflicts()).map((item) => item.copyPath);
    status.conflicts = status.conflictPaths.length; status.refresh();
    return copyPath;
  }

  private async isOccupiedByOtherIdentity(fileId: string, path: string, localHash: string | undefined,
    identities: FileIndexEntry[]): Promise<boolean> {
    const normalized = path.toLocaleLowerCase();
    for (const entry of identities) {
      if (entry.fileId === fileId || entry.deleted) continue;
      if (entry.path.toLocaleLowerCase() === normalized) return true;
      if (!localHash || entry.localHash !== localHash || entry.path === path) continue;
      if (!await this.options.vault.read(entry.path)) return true;
    }
    return false;
  }

  private async acknowledge(operation: OutboxOperation, record: RemoteFileRecord, revision: number): Promise<void> {
    const indexed = await this.options.store.getFile(operation.fileId);
    const latest = (await this.options.store.pending()).find((item) => item.operationId === operation.operationId);
    const hasNewer = latest && (latest.localHash !== operation.localHash || latest.content !== operation.content);
    if (record.deleted) {
      const path = indexed?.path ?? operation.path;
      const local = await this.options.vault.read(path);
      const localHash = local && sha256Hex(local);
      const identities = await this.options.store.files();
      const occupiedByOther = await this.isOccupiedByOtherIdentity(operation.fileId, path, localHash, identities);
      if (local && localHash === indexed?.localHash && !occupiedByOther) {
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
      if ((!current || sha256Hex(current) !== record.contentHash) && !hasNewer &&
          (!current || sha256Hex(current) === operation.localHash)) {
        this.applyGuards.set(record.path, record.contentHash);
        await this.options.vault.write(record.path, new TextEncoder().encode(record.content));
      }
    }
    const outboxHasNewer = await this.options.store.confirmPublished(operation, this.syncedIndex(record, revision));
    if (operation.operationId.startsWith("resolve-")) {
      const conflictId = operation.operationId.slice("resolve-".length);
      const conflict = await this.options.store.getConflict(conflictId);
      if (!outboxHasNewer && conflict?.lifecycle === "pending-sync") {
        await this.options.store.updateConflict(conflictId, { lifecycle: "resolved" });
        await this.options.store.appendConflictHistory({ operationId: conflictId, event: "resolved", outcome: "sync-confirmed" });
        await this.refreshConflicts();
      }
    }
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
      this.options.status.attachmentState = "CONFIGURED";
      this.options.status.attachmentError = "";
      return bytes;
    } catch (error) {
      this.options.status.markError(`blob:${record.fileId}`);
      this.options.status.attachmentState = "TRANSFER_ERROR";
      this.options.status.attachmentError = errorSummary(error);
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
    if (isConflictReviewPath(record.path)) return;
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
        const localHash = local && sha256Hex(local);
        const identities = await store.files();
        const occupiedByOther = await this.isOccupiedByOtherIdentity(current.fileId, current.path, localHash, identities);
        if (local && localHash !== current.localHash && !occupiedByOther) {
          await this.capture(current.path, new TextDecoder().decode(local));
          return;
        }
        if (local && !occupiedByOther) {
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
      copyFileId: loserId, copyPath, remoteRevision: revision, lifecycle: "unresolved", context: "path-collision",
      canonicalPath: record.path, remotePath: loserId === record.fileId ? copyPath : record.path,
      detectionRemoteHash: record.contentHash, detectionRemoteDeleted: record.deleted,
      detectionLocalHash: other.localHash, detectionCopyHash: other.localHash, kind: record.kind, size: record.size });
    await store.appendConflictHistory({ operationId, event: "detected", context: "path-collision", path: copyPath });
    status.conflictPaths = (await store.unresolvedConflicts()).map((item) => item.copyPath);
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
