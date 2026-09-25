import { describe, expect, it } from "vitest";
import { decodeRecord, encodeRecord, sha256Hex, type RemoteFileRecord } from "../../packages/protocol/src/index.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore, type ConflictRecord } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { blobObjectKey, type BlobPort } from "../../packages/plugin/src/blob-storage.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type LifecycleRecord = ConflictRecord & {
  lifecycle: "unresolved" | "pending-sync" | "resolved";
  context: "merge" | "path-collision" | "bootstrap";
  canonicalPath: string;
  remotePath: string;
  detectionRemoteHash: string;
  detectionLocalHash: string;
  detectionCopyHash: string;
  recoveryBackup?: { path: string; hash: string; size: number };
};

type ResolutionEngine = MarkdownSyncEngine & {
  keepRemote: (operationId: string) => Promise<unknown>;
  keepLocalCopy: (operationId: string) => Promise<unknown>;
  markResolved: (operationId: string) => Promise<unknown>;
  compareConflict: (operationId: string) => Promise<unknown>;
};

type Comparison = {
  remote: { path: string; hash: string; content?: string; size?: number; revision?: number };
  local: { path: string; hash: string; content?: string; size?: number };
  stale: { remote: boolean; local: boolean };
};

type HistoryStore = LocalStore & {
  appendConflictHistory: (entry: Record<string, unknown>) => Promise<void>;
  conflictHistory: () => Promise<Array<Record<string, unknown>>>;
};

function bytes(content: string): Uint8Array { return encoder.encode(content); }
function text(vault: VaultDouble, path: string): string | undefined {
  const value = vault.read(path);
  return value && decoder.decode(value);
}

function remote(fileId: string, path: string, content: string): RemoteFileRecord {
  return {
    schemaVersion: 1, fileId, path, kind: "text", deleted: false,
    contentHash: sha256Hex(bytes(content)), size: bytes(content).length, content,
    origin: { deviceId: "remote-device", operationId: `remote-${fileId}`, clientTime: 1 },
  };
}

async function replica(name: string, kv: NatsKvDouble, initial?: string) {
  const vault = new VaultDouble();
  if (initial !== undefined) vault.write("note.md", bytes(initial));
  const store = await LocalStore.open(`lifecycle-${name}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId: name, kv, vault, store, status, debounceMs: 0 });
  await engine.start();
  return { vault, store, status, engine };
}

async function close(state: { engine: MarkdownSyncEngine; store: LocalStore }): Promise<void> {
  state.engine.stop();
  await state.engine.settle();
  state.store.close();
}

describe("durable conflict lifecycle contracts", () => {
  it("upgrades a v2 conflict database without changing an existing unresolved record", async () => {
    const name = `legacy-conflicts-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDBDouble.indexedDB.open(name, 2);
      opening.onupgradeneeded = () => {
        const database = opening.result;
        const files = database.createObjectStore("files", { keyPath: "fileId" });
        files.createIndex("path", "path");
        const outbox = database.createObjectStore("outbox", { keyPath: "operationId" });
        outbox.createIndex("fileId", "fileId");
        database.createObjectStore("conflicts", { keyPath: "operationId" });
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction("conflicts", "readwrite");
        transaction.objectStore("conflicts").put({ operationId: "legacy", originalFileId: "remote", originalPath: "note.md",
          copyFileId: "copy", copyPath: "note.conflict.md", remoteRevision: 4 });
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => { database.close(); resolve(); };
      };
    });
    const store = await LocalStore.open(name, indexedDBDouble.indexedDB);
    expect(await store.getConflict("legacy")).toMatchObject({ operationId: "legacy", remoteRevision: 4 });
    expect(await store.unresolvedConflicts()).toHaveLength(1);
    await store.appendConflictHistory({ operationId: "legacy", event: "migration" });
    expect(await store.conflictHistory()).toHaveLength(1);
    store.close();
  });

  it("records an overlapping merge conflict with detection anchors and no timestamp winner", async () => {
    const kv = new NatsKvDouble();
    const local = await replica("local", kv, "same\n");
    const remoteReplica = await replica("remote", kv);
    local.engine.stop();
    local.vault.write("note.md", bytes("LOCAL\n"));
    const savedGet = kv.get.bind(kv);
    kv.get = () => { throw new Error("offline"); };
    await local.engine.capture("note.md", "LOCAL\n");
    kv.get = savedGet;
    await remoteReplica.engine.capture("note.md", "REMOTE\n");
    await local.engine.start();

    const [record] = await local.store.conflicts() as LifecycleRecord[];
    expect(record?.context).toBe("merge");
    expect(record?.lifecycle).toBe("unresolved");
    expect(record?.detectionRemoteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.detectionCopyHash).toBe(sha256Hex(bytes("LOCAL\n")));
    expect(record).not.toHaveProperty("winnerByTimestamp");
    expect(record).not.toHaveProperty("clientTimeWinner");
    expect((await local.store.pending()).some((operation) => operation.fileId === record?.copyFileId)).toBe(false);
    expect(kv.list().some((entry) => decodeRecord(entry.value).path === record?.copyPath)).toBe(false);
    await local.engine.capture(record!.copyPath, "LOCAL COPY EDIT\n");
    expect(await local.store.pending()).toHaveLength(0);
    await close(local); await close(remoteReplica);
  });

  it("records a distinct path collision and bootstrap preserved copies before unresolved status", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("device", kv, "LOCAL\n");
    const localId = (await state.store.getFileByPath("note.md"))!.fileId;
    const remoteId = localId === "remote" ? "other" : "remote";
    kv.create(`f.${remoteId}`, encodeRecord(remote(remoteId, "note.md", "REMOTE\n")));
    await state.engine.reconcile();
    const records = await state.store.conflicts() as LifecycleRecord[];
    expect(records.length).toBeGreaterThan(0);
    const pathRecord = records.find((record) => record.originalPath === "note.md")!;
    expect(pathRecord.context).toBe("path-collision");
    expect(pathRecord.copyPath.toLocaleLowerCase()).not.toBe(pathRecord.originalPath.toLocaleLowerCase());
    expect(pathRecord.lifecycle).toBe("unresolved");
    await close(state);

    const vault = new VaultDouble();
    const store = await LocalStore.open(`bootstrap-contract-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
    const status = new SyncStatus();
    vault.write("same.md", bytes("local"));
    const bootstrapKv = new NatsKvDouble();
    bootstrapKv.create("f.bootstrap", encodeRecord(remote("bootstrap", "same.md", "remote")));
    const bootstrapEngine = new MarkdownSyncEngine({ deviceId: "device", kv: bootstrapKv, vault, store, status });
    await bootstrapEngine.start();
    const bootstrapRecords = await store.conflicts() as LifecycleRecord[];
    expect(bootstrapRecords).toHaveLength(1);
    expect(bootstrapRecords[0]?.context).toBe("bootstrap");
    expect(text(vault, bootstrapRecords[0]!.copyPath)).toBe("local");
    bootstrapEngine.stop(); store.close();
  });

  it("anchors live comparisons and marks changed remote or copy content stale", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("stale", kv, "same\n");
    kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
    const record: LifecycleRecord = {
      operationId: "stale-op", originalFileId: "remote", originalPath: "note.md",
      copyFileId: "copy", copyPath: "note.conflict.md", remoteRevision: 1,
      lifecycle: "unresolved", context: "merge", canonicalPath: "note.md", remotePath: "note.md",
      detectionRemoteHash: sha256Hex(bytes("REMOTE\n")), detectionLocalHash: sha256Hex(bytes("same\n")),
      detectionCopyHash: sha256Hex(bytes("LOCAL\n")),
    };
    await state.store.putConflict(record);
    state.vault.write("note.conflict.md", bytes("CHANGED\n"));
    const engine = state.engine as unknown as ResolutionEngine;
    expect(typeof engine.compareConflict).toBe("function");
    const comparison = await engine.compareConflict("stale-op") as Comparison;
    expect(comparison).toMatchObject({ stale: { remote: false, local: true } });
    expect(comparison.remote.content).toBe("REMOTE\n");
    expect(comparison.local.content).toBe("CHANGED\n");
    await close(state);
  });

  it("uses metadata only for binary and oversized comparisons and history", async () => {
    const kv = new NatsKvDouble();
    const vault = new VaultDouble();
    const store = await LocalStore.open(`metadata-contract-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
    const binaryBytes = bytes("PNG-BYTES");
    const binaryHash = sha256Hex(binaryBytes);
    kv.create("f.binary", encodeRecord({ schemaVersion: 1, fileId: "binary", path: "image.bin", kind: "blob", deleted: false,
      contentHash: binaryHash, size: binaryBytes.length, blob: { algorithm: "sha256", hash: binaryHash, key: "image.bin", size: binaryBytes.length },
      origin: { deviceId: "remote", operationId: "binary-op", clientTime: 1 } }));
    vault.write("image.conflict.bin", binaryBytes);
    const binary = {
      operationId: "binary-op", originalFileId: "binary", originalPath: "image.bin",
      copyFileId: "copy", copyPath: "image.conflict.bin", remoteRevision: 1,
      lifecycle: "unresolved", context: "merge", canonicalPath: "image.bin", remotePath: "image.bin",
      detectionRemoteHash: "a".repeat(64), detectionLocalHash: "b".repeat(64), detectionCopyHash: "c".repeat(64),
      kind: "blob", size: binaryBytes.length, mime: "image/png",
    } as unknown as LifecycleRecord;
    await store.putConflict(binary);
    const oversizedContent = "x".repeat(600_000);
    const oversized = remote("oversized", "large.md", oversizedContent);
    kv.create("f.oversized", encodeRecord(oversized));
    vault.write("large.conflict.md", bytes(oversizedContent));
    await store.putConflict({ ...binary, operationId: "oversized-op", originalFileId: "oversized", originalPath: "large.md",
      copyFileId: "large-copy", copyPath: "large.conflict.md", remoteRevision: kv.get("f.oversized")!.revision } as unknown as ConflictRecord);
    const stored = await store.getConflict("binary-op") as LifecycleRecord;
    expect(stored).not.toHaveProperty("content");
    expect(stored).toMatchObject({ kind: "blob", size: binaryBytes.length, detectionRemoteHash: "a".repeat(64) });
    const engine = new MarkdownSyncEngine({ deviceId: "device", kv, vault, store, status: new SyncStatus() }) as unknown as ResolutionEngine;
    expect(typeof engine.compareConflict).toBe("function");
    const binaryComparison = await engine.compareConflict("binary-op") as Comparison;
    expect(binaryComparison.remote).toMatchObject({ path: "image.bin", hash: binaryHash, size: binaryBytes.length });
    expect(binaryComparison.remote).not.toHaveProperty("content");
    const oversizedComparison = await engine.compareConflict("oversized-op") as Comparison;
    expect(oversizedComparison.remote).toMatchObject({ path: "large.md", size: oversizedContent.length });
    expect(oversizedComparison.remote).not.toHaveProperty("content");
    const history = store as unknown as HistoryStore;
    expect(typeof history.conflictHistory).toBe("function");
    store.close();
  });

  it("shows a verified small Markdown blob in a conflict comparison", async () => {
    const kv = new NatsKvDouble();
    const vault = new VaultDouble();
    const store = await LocalStore.open(`blob-review-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
    const content = "# Same Markdown\n";
    const payload = bytes(content);
    const hash = sha256Hex(payload);
    const blob: BlobPort = { upload: async () => {}, download: async () => payload };
    kv.create("f.markdown", encodeRecord({ schemaVersion: 1, fileId: "markdown", path: "skill.md", kind: "blob", deleted: false,
      contentHash: hash, size: payload.length, blob: { algorithm: "sha256", hash, key: blobObjectKey("VAULT", hash), size: payload.length },
      origin: { deviceId: "remote", operationId: "blob-op", clientTime: 1 } }));
    vault.write("skill.conflict.md", payload);
    await store.putConflict({ operationId: "blob-op", originalFileId: "markdown", originalPath: "skill.md",
      copyFileId: "copy", copyPath: "skill.conflict.md", remoteRevision: 1, lifecycle: "unresolved", context: "merge",
      canonicalPath: "skill.md", remotePath: "skill.md", detectionRemoteHash: hash, detectionCopyHash: hash } as ConflictRecord);
    const engine = new MarkdownSyncEngine({ deviceId: "device", vaultId: "VAULT", kv, vault, store, blob,
      inlineLimit: 512, status: new SyncStatus() }) as unknown as ResolutionEngine;
    const comparison = await engine.compareConflict("blob-op") as Comparison;
    expect(comparison.remote.content).toBe(content);
    expect(comparison.local.content).toBe(content);
    store.close();
  });

  it("keeps a small Markdown blob metadata-only when either side is invalid UTF-8", async () => {
    const kv = new NatsKvDouble();
    const vault = new VaultDouble();
    const store = await LocalStore.open(`invalid-blob-review-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
    const payload = new Uint8Array([0xff, 0xfe, 0x00]);
    const hash = sha256Hex(payload);
    const blob: BlobPort = { upload: async () => {}, download: async () => payload };
    kv.create("f.markdown", encodeRecord({ schemaVersion: 1, fileId: "markdown", path: "misnamed.md", kind: "blob", deleted: false,
      contentHash: hash, size: payload.length, blob: { algorithm: "sha256", hash, key: blobObjectKey("VAULT", hash), size: payload.length },
      origin: { deviceId: "remote", operationId: "blob-op", clientTime: 1 } }));
    vault.write("misnamed.conflict.md", payload);
    await store.putConflict({ operationId: "blob-op", originalFileId: "markdown", originalPath: "misnamed.md",
      copyFileId: "copy", copyPath: "misnamed.conflict.md", remoteRevision: 1, lifecycle: "unresolved", context: "merge",
      canonicalPath: "misnamed.md", remotePath: "misnamed.md", detectionRemoteHash: hash, detectionCopyHash: hash } as ConflictRecord);
    const engine = new MarkdownSyncEngine({ deviceId: "device", vaultId: "VAULT", kv, vault, store, blob,
      inlineLimit: 512, status: new SyncStatus() }) as unknown as ResolutionEngine;
    const comparison = await engine.compareConflict("blob-op") as Comparison;
    expect(comparison.remote).not.toHaveProperty("content");
    expect(comparison.local).not.toHaveProperty("content");
    store.close();
  });

  it("acknowledges an equal remote blob without creating a false conflict", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("equal-blob", kv, "BASE\n");
    const file = (await state.store.getFileByPath("note.md"))!;
    state.engine.stop();
    const desired = "SAME\n";
    const desiredBytes = bytes(desired);
    const desiredHash = sha256Hex(desiredBytes);
    state.vault.write("note.md", desiredBytes);
    await state.store.queue({ operationId: "local-change", fileId: file.fileId, type: "modify", path: "note.md",
      localHash: desiredHash, content: desired, kind: "text", baseContent: "BASE\n", baseHash: file.remoteHash,
      baseRevision: file.remoteRevision, retryCount: 0, createdAt: Date.now() });
    await state.store.putFile({ ...file, localHash: desiredHash, state: "pending" });
    kv.put(`f.${file.fileId}`, encodeRecord({ schemaVersion: 1, fileId: file.fileId, path: "note.md", kind: "blob", deleted: false,
      contentHash: desiredHash, size: desiredBytes.length, blob: { algorithm: "sha256", hash: desiredHash, key: "ignored", size: desiredBytes.length },
      origin: { deviceId: "other", operationId: "remote-change", clientTime: 2 } }));
    await state.engine.start();
    await state.engine.settle();
    expect(await state.store.pending()).toHaveLength(0);
    expect(await state.store.unresolvedConflicts()).toHaveLength(0);
    expect(decodeRecord(kv.get(`f.${file.fileId}`)!.value).kind).toBe("blob");
    await close(state);
  });

  it("never queues conflict review notes as ordinary files", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("review-folder", kv);
    await state.engine.capture("Flash Sync Conflict Reviews/review.md", "local-only");
    expect(kv.list()).toHaveLength(0);
    expect(await state.store.pending()).toHaveLength(0);
    await close(state);
  });

  it("keeps remote on the canonical path, stores a selected-record backup, and isolates other conflicts", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("actions", kv, "CANONICAL\n");
    state.engine.stop();
    kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
    state.vault.write("note.conflict.md", bytes("PRESERVED\n"));
    await state.store.putConflict({
      operationId: "selected-op", originalFileId: "remote", originalPath: "note.md", copyFileId: "copy",
      copyPath: "note.conflict.md", remoteRevision: kv.get("f.remote")!.revision,
      lifecycle: "unresolved", context: "merge", canonicalPath: "note.md", remotePath: "note.md",
      detectionRemoteHash: sha256Hex(bytes("REMOTE\n")), detectionLocalHash: sha256Hex(bytes("CANONICAL\n")),
      detectionCopyHash: sha256Hex(bytes("PRESERVED\n")),
    } as unknown as ConflictRecord);
    await state.store.putConflict({
      operationId: "other-op", originalFileId: "other", originalPath: "other.md", copyFileId: "other-copy",
      copyPath: "other.conflict.md", remoteRevision: 2, lifecycle: "unresolved", context: "merge",
    } as unknown as ConflictRecord);
    const engine = state.engine as ResolutionEngine;
    expect(typeof engine.keepRemote).toBe("function");
    await engine.keepRemote("selected-op");
    expect(text(state.vault, "note.md")).toBe("REMOTE\n");
    const selected = await state.store.getConflict("selected-op") as LifecycleRecord;
    expect(selected.lifecycle).toBe("resolved");
    expect(selected.recoveryBackup?.path).toBeTruthy();
    expect(await state.store.getConflict("other-op")).toBeTruthy();
    expect((await state.store.getConflict("other-op") as LifecycleRecord).lifecycle).toBe("unresolved");
    expect(state.status.conflictPaths).toEqual(["other.conflict.md"]);
    await close(state);
  });

  it("keeps the local copy pending until CAS confirmation and supports manual edit/delete", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("local-action", kv, "CANONICAL\n");
    state.engine.stop();
    kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
    state.vault.write("note.conflict.md", bytes("LOCAL WINNER\n"));
    await state.store.putConflict({
      operationId: "local-op", originalFileId: "remote", originalPath: "note.md", copyFileId: "copy",
      copyPath: "note.conflict.md", remoteRevision: kv.get("f.remote")!.revision, lifecycle: "unresolved",
      context: "merge", canonicalPath: "note.md", remotePath: "note.md",
      detectionRemoteHash: sha256Hex(bytes("REMOTE\n")), detectionLocalHash: sha256Hex(bytes("CANONICAL\n")),
      detectionCopyHash: sha256Hex(bytes("LOCAL WINNER\n")),
    } as unknown as ConflictRecord);
    const engine = state.engine as ResolutionEngine;
    expect(typeof engine.keepLocalCopy).toBe("function");
    await engine.keepLocalCopy("local-op");
    expect(text(state.vault, "note.md")).toBe("LOCAL WINNER\n");
    await state.engine.settle();
    expect((await state.store.getConflict("local-op") as LifecycleRecord).lifecycle).toBe("resolved");
    expect(decodeRecord(kv.get("f.remote")!.value).content).toBe("LOCAL WINNER\n");
    await close(state);
  });

  it("keeps manual edit and delete unresolved until their queued remote mutations are confirmed", async () => {
    for (const deleted of [false, true]) {
      const kv = new NatsKvDouble();
      const state = await replica(`manual-${deleted}`, kv, "BASE\n");
      state.engine.stop();
      kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
      const operationId = deleted ? "manual-delete" : "manual-edit";
      await state.store.putConflict({ operationId, originalFileId: "remote", originalPath: "note.md", copyFileId: "copy",
        copyPath: "note.conflict.md", remoteRevision: kv.get("f.remote")!.revision, lifecycle: "unresolved", context: "merge",
      } as unknown as ConflictRecord);
      if (deleted) state.vault.delete("note.md");
      else state.vault.write("note.md", bytes("MANUAL EDIT\n"));
      const engine = state.engine as ResolutionEngine;
      expect(typeof engine.markResolved).toBe("function");
      await engine.markResolved(operationId);
      await state.engine.settle();
      expect((await state.store.getConflict(operationId) as LifecycleRecord).lifecycle).toBe("resolved");
      expect(decodeRecord(kv.get("f.remote")!.value).deleted).toBe(deleted);
      await close(state);
    }
  });

  it("blocks a changed remote revision while retaining the selected record", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("guard", kv, "LOCAL\n");
    const engine = state.engine as ResolutionEngine;
    kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
    const record = {
      operationId: "guard-op", originalFileId: "remote", originalPath: "note.md", copyFileId: "copy",
      copyPath: "note.conflict.md", remoteRevision: 1, lifecycle: "unresolved", context: "merge",
      canonicalPath: "note.md", remotePath: "note.md", detectionRemoteHash: sha256Hex(bytes("REMOTE\n")),
      detectionLocalHash: sha256Hex(bytes("LOCAL\n")), detectionCopyHash: "c".repeat(64),
    } as unknown as ConflictRecord;
    await state.store.putConflict(record);
    kv.put("f.remote", encodeRecord(remote("remote", "note.md", "NEW REMOTE\n")));
    expect(typeof engine.keepRemote).toBe("function");
    await expect(engine.keepRemote("guard-op")).rejects.toThrow();
    expect((await state.store.getConflict("guard-op") as LifecycleRecord).lifecycle).toBe("unresolved");
    await close(state);
  });

  it("blocks an unexpected canonical-path change without displacing it", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("canonical-guard", kv, "LOCAL\n");
    const engine = state.engine as ResolutionEngine;
    kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
    await state.store.putConflict({ operationId: "canonical-op", originalFileId: "remote", originalPath: "note.md", copyFileId: "copy",
      copyPath: "note.conflict.md", remoteRevision: 1, lifecycle: "unresolved", context: "merge",
      canonicalPath: "note.md", detectionLocalHash: sha256Hex(bytes("LOCAL\n")), detectionRemoteHash: sha256Hex(bytes("REMOTE\n")), detectionCopyHash: "b".repeat(64),
    } as unknown as ConflictRecord);
    state.vault.write("note.md", bytes("UNEXPECTED\n"));
    expect(typeof engine.keepRemote).toBe("function");
    await expect(engine.keepRemote("canonical-op")).rejects.toThrow();
    expect((await state.store.getConflict("canonical-op") as LifecycleRecord).lifecycle).toBe("unresolved");
    expect(text(state.vault, "note.md")).toBe("UNEXPECTED\n");
    await close(state);
  });

  it("blocks a changed preserved copy before promotion", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("copy-guard", kv, "CANONICAL\n");
    state.engine.stop();
    kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
    state.vault.write("note.conflict.md", bytes("CHANGED COPY\n"));
    await state.store.putConflict({ operationId: "copy-guard-op", originalFileId: "remote", originalPath: "note.md", copyFileId: "copy",
      copyPath: "note.conflict.md", remoteRevision: kv.get("f.remote")!.revision, lifecycle: "unresolved", context: "merge",
      canonicalPath: "note.md", detectionLocalHash: sha256Hex(bytes("CANONICAL\n")), detectionRemoteHash: sha256Hex(bytes("REMOTE\n")),
      detectionCopyHash: sha256Hex(bytes("EXPECTED COPY\n")) } as unknown as ConflictRecord);
    await expect((state.engine as ResolutionEngine).keepLocalCopy("copy-guard-op")).rejects.toThrow();
    expect(text(state.vault, "note.md")).toBe("CANONICAL\n");
    expect((await state.store.getConflict("copy-guard-op") as LifecycleRecord).lifecycle).toBe("unresolved");
    await close(state);
  });

  it("returns a raced resolution to review without overwriting the new remote version", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("resolution-race", kv, "CANONICAL\n");
    state.engine.stop();
    kv.create("f.remote", encodeRecord(remote("remote", "note.md", "REMOTE\n")));
    state.vault.write("note.conflict.md", bytes("LOCAL WINNER\n"));
    await state.store.putConflict({ operationId: "resolution-race-op", originalFileId: "remote", originalPath: "note.md", copyFileId: "copy",
      copyPath: "note.conflict.md", remoteRevision: kv.get("f.remote")!.revision, lifecycle: "unresolved", context: "merge",
      canonicalPath: "note.md", remotePath: "note.md", detectionRemoteHash: sha256Hex(bytes("REMOTE\n")),
      detectionLocalHash: sha256Hex(bytes("CANONICAL\n")), detectionCopyHash: sha256Hex(bytes("LOCAL WINNER\n")) } as unknown as ConflictRecord);
    const originalUpdate = kv.update.bind(kv);
    let raced = false;
    kv.update = (key, value, revision) => {
      if (!raced) {
        raced = true;
        kv.put(key, encodeRecord(remote("remote", "note.md", "REMOTE RACE\n")));
      }
      return originalUpdate(key, value, revision);
    };
    await (state.engine as ResolutionEngine).keepLocalCopy("resolution-race-op");
    await state.engine.settle();
    expect(raced).toBe(true);
    expect(decodeRecord(kv.get("f.remote")!.value).content).toBe("REMOTE RACE\n");
    expect((await state.store.getConflict("resolution-race-op") as LifecycleRecord).lifecycle).toBe("unresolved");
    expect(await state.store.pending()).toHaveLength(0);
    await close(state);
  });

  it("persists redacted bounded history and excludes note content, credentials, and secret storage", async () => {
    const name = `history-contract-${crypto.randomUUID()}`;
    const store = await LocalStore.open(name, indexedDBDouble.indexedDB);
    const api = store as unknown as HistoryStore;
    expect(typeof api.appendConflictHistory).toBe("function");
    expect(typeof api.conflictHistory).toBe("function");
    for (let i = 0; i < 205; i++) await api.appendConflictHistory({ operationId: `op-${i}`, outcome: "detected", content: "PRIVATE NOTE", password: "SECRET", secretStorage: "TOKEN" });
    const history = await api.conflictHistory();
    expect(history.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(history)).not.toContain("PRIVATE NOTE");
    expect(JSON.stringify(history)).not.toContain("SECRET");
    expect(JSON.stringify(history)).not.toContain("TOKEN");
    store.close();
    const reopened = await LocalStore.open(name, indexedDBDouble.indexedDB) as unknown as HistoryStore;
    expect((await reopened.conflictHistory()).length).toBe(history.length);
    reopened.close();
  });
});
