import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeRemotePath, decodePathOwnershipRecord, encodePathOwnershipRecord, encodeRecord, pathOwnershipKey, sha256Hex,
  type RemoteFileRecord,
} from "../../packages/protocol/src/index.js";
import { SyncStatus, type KvFileEntry, type KvPort, type KvSnapshotSession } from "../../packages/plugin/src/connection.js";
import { LocalStore, type FileIndexEntry } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine, retryDelay, type MarkdownVault } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, SnapshotKvSessionDouble, VaultDouble } from "../doubles/index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const record = (fileId: string, path: string, text: string, operationId = "remote-op"): RemoteFileRecord => ({
  schemaVersion: 1, fileId, path, kind: "text", deleted: false,
  contentHash: sha256Hex(bytes(text)), size: bytes(text).length, content: text,
  origin: { deviceId: "remote", operationId, clientTime: 1 },
});
const read = (vault: VaultDouble, path: string) => {
  const data = vault.read(path);
  return data && new TextDecoder().decode(data);
};
const store = () => LocalStore.open(`reconcile-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
function sessionPort(backend: NatsKvDouble, session: KvSnapshotSession) {
  const list = vi.fn(backend.list.bind(backend));
  const openSnapshotSession = vi.fn(() => session);
  const kv: KvPort = {
    get: backend.get.bind(backend), list, put: backend.put.bind(backend), watch: backend.watch.bind(backend),
    create: backend.create.bind(backend), update: backend.update.bind(backend), openSnapshotSession,
  };
  return { kv, list, openSnapshotSession };
}
function indexEntry(fileId: string, path: string, content: string, revision: number, overrides: Partial<FileIndexEntry> = {}): FileIndexEntry {
  const hash = sha256Hex(bytes(content));
  return { fileId, path, localHash: hash, remoteHash: hash, baseContent: content, remoteRevision: revision,
    kind: "text", lastAppliedRemoteHash: hash, state: "synced", ...overrides };
}

describe("reconciliation and durable replay", () => {
  it("prefers the primary snapshot/live session for discovery", async () => {
    const backend = new NatsKvDouble();
    const session = new SnapshotKvSessionDouble(1);
    session.pushSnapshot({ key: "f.private", value: encodeRecord(record("private", "note.md", "private body")), revision: 1 });
    session.completeInitialSnapshot();
    const openSnapshotSession = vi.fn(() => session);
    const kv: KvPort = {
      get: backend.get.bind(backend), list: backend.list.bind(backend), put: backend.put.bind(backend),
      watch: backend.watch.bind(backend), create: backend.create.bind(backend), update: backend.update.bind(backend),
      openSnapshotSession,
    };
    const local = await store();
    const debug = vi.fn();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault: new VaultDouble(),
      status: new SyncStatus(), logger: { debug, error: vi.fn() } });

    await engine.start();

    expect(openSnapshotSession).toHaveBeenCalledTimes(1);
    const complete = debug.mock.calls.find(([event]) => event === "reconcile.complete")?.[1];
    expect(complete).toMatchObject({ discoveryMode: "snapshot-pull", initialEntryCount: 1,
      snapshotComplete: true, fallbackReasonClass: undefined });
    expect(JSON.stringify(complete)).not.toContain("private body");
    engine.stop(); local.close();
  });

  it("falls back to buffered watch plus a complete listing when the snapshot session cannot open", async () => {
    const backend = new NatsKvDouble();
    const watch = vi.fn((listener: (entry: { key: string; value: Uint8Array; revision: number }) => void) => {
      const stop = backend.watch(listener);
      backend.create("f.file-a", encodeRecord(record("file-a", "remote.md", "from fallback")));
      return stop;
    });
    const list = vi.fn(backend.list.bind(backend));
    const kv: KvPort = { get: backend.get.bind(backend), list, put: backend.put.bind(backend), watch,
      openSnapshotSession: vi.fn(async () => { throw new Error("snapshot consumer unavailable"); }) };
    const local = await store();
    const vault = new VaultDouble();
    const status = new SyncStatus();
    const debug = vi.fn();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status,
      logger: { debug, error: vi.fn() } });

    await engine.start();

    expect(watch).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(read(vault, "remote.md")).toBe("from fallback");
    expect(status.reconciled).toBe(true);
    const complete = debug.mock.calls.find(([event]) => event === "reconcile.complete")?.[1];
    expect(complete).toMatchObject({ discoveryMode: "legacy-list", initialEntryCount: 1,
      snapshotComplete: false, fallbackReasonClass: "consumer_creation:Error" });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("snapshot consumer unavailable");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("from fallback");
    engine.stop(); local.close();
  });

  it("retains local outbox work and stays unreconciled when snapshot and fallback discovery fail", async () => {
    const backend = new NatsKvDouble();
    const local = await store();
    const vault = new VaultDouble();
    vault.write("pending.md", bytes("local work"));
    const pending = { operationId: "pending", fileId: "file-local", type: "create" as const, path: "pending.md",
      content: "local work", localHash: sha256Hex(bytes("local work")), baseRevision: undefined,
      baseHash: undefined, baseContent: undefined, retryCount: 0, createdAt: 1 };
    await local.queue(pending);
    const watch = vi.fn(backend.watch.bind(backend));
    const list = vi.fn(() => { throw new Error("fallback list unavailable"); });
    const kv: KvPort = { get: backend.get.bind(backend), list, put: backend.put.bind(backend), watch,
      openSnapshotSession: vi.fn(async () => { throw new Error("snapshot consumer unavailable"); }) };
    const status = new SyncStatus();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status });

    await expect(engine.start()).rejects.toThrow();

    expect(await local.pending()).toHaveLength(1);
    expect(status.reconciled).toBe(false);
    expect(status.value).not.toBe("SYNCED");
    engine.stop(); local.close();
  });

  it("reconciles through the full-list fallback when the live snapshot consumer ends after startup", async () => {
    const backend = new NatsKvDouble();
    let finishDelivery!: () => void;
    const session: KvSnapshotSession = {
      initialCount: 0,
      snapshotComplete: Promise.resolve(),
      snapshot: { async *[Symbol.asyncIterator]() {} },
      entries: { [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<KvFileEntry>>((resolve) => {
          finishDelivery = () => resolve({ done: true, value: undefined });
        }),
      }) },
      stop: () => { finishDelivery?.(); },
    };
    const status = new SyncStatus();
    const list = vi.fn(() => {
      expect(status.reconciled).toBe(false);
      return backend.list();
    });
    let sessionCalls = 0;
    const openSnapshotSession = vi.fn(() => {
      if (sessionCalls++ === 0) return session;
      throw new Error("snapshot consumer unavailable after reconnect");
    });
    const kv: KvPort = { get: backend.get.bind(backend), list, put: backend.put.bind(backend),
      watch: backend.watch.bind(backend), openSnapshotSession };
    const local = await store();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault: new VaultDouble(), status });

    await engine.start();
    expect(status.reconciled).toBe(true);
    finishDelivery();
    for (let attempt = 0; attempt < 100 && (!list.mock.calls.length || !status.reconciled); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(openSnapshotSession).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(status.reconciled).toBe(true);
    engine.stop(); local.close();
  });

  it("does not report reconciled when queued live apply finishes after its snapshot source fails", async () => {
    const backend = new NatsKvDouble();
    let wakeEntry: ((result: IteratorResult<KvFileEntry>) => void) | undefined;
    let queuedEntry: KvFileEntry | undefined;
    let ended = false;
    const session: KvSnapshotSession = {
      initialCount: 0,
      snapshotComplete: Promise.resolve(),
      snapshot: { async *[Symbol.asyncIterator]() {} },
      entries: { [Symbol.asyncIterator]: () => ({
        next: () => {
          if (queuedEntry) {
            const value = queuedEntry; queuedEntry = undefined;
            return Promise.resolve({ done: false, value });
          }
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<KvFileEntry>>((resolve) => { wakeEntry = resolve; });
        },
      }) },
      stop: () => {
        ended = true;
        wakeEntry?.({ done: true, value: undefined });
        wakeEntry = undefined;
      },
    };
    const send = (entry: KvFileEntry) => {
      if (wakeEntry) { const wake = wakeEntry; wakeEntry = undefined; wake({ done: false, value: entry }); }
      else queuedEntry = entry;
    };
    const finish = () => {
      ended = true;
      wakeEntry?.({ done: true, value: undefined });
      wakeEntry = undefined;
    };
    const status = new SyncStatus();
    let releaseWrite!: () => void;
    let releaseList!: () => void;
    let startedList!: () => void;
    const listStarted = new Promise<void>((resolve) => { startedList = resolve; });
    const list = vi.fn(() => new Promise<ReturnType<NatsKvDouble["list"]>>((resolve) => {
      startedList();
      releaseList = () => resolve(backend.list());
    }));
    let sessionCalls = 0;
    const openSnapshotSession = vi.fn(() => {
      if (sessionCalls++ === 0) return session;
      throw new Error("snapshot consumer unavailable after reconnect");
    });
    const fileBytes = new Map<string, Uint8Array>();
    const vault: MarkdownVault = {
      read: (path) => fileBytes.get(path)?.slice(),
      write: (path, value) => new Promise<void>((resolve) => {
        releaseWrite = () => { fileBytes.set(path, value.slice()); resolve(); };
      }),
      listMarkdown: () => [], listFiles: () => [], onModify: () => () => {},
    };
    const kv: KvPort = { get: backend.get.bind(backend), list, put: backend.put.bind(backend),
      watch: backend.watch.bind(backend), openSnapshotSession };
    const local = await store();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status });

    await engine.start();
    const remote = record("file-a", "remote.md", "live");
    const revision = backend.create("f.file-a", encodeRecord(remote));
    send({ key: "f.file-a", value: encodeRecord(remote), revision });
    for (let attempt = 0; attempt < 100 && !releaseWrite; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releaseWrite).toBeTypeOf("function");
    finish();
    releaseWrite();
    await listStarted;
    await engine.settle();

    expect(status.reconciled).toBe(false);
    releaseList();
    for (let attempt = 0; attempt < 100 && !status.reconciled; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(list).toHaveBeenCalledTimes(1);
    expect(status.reconciled).toBe(true);
    engine.stop(); local.close();
  });

  it("handles snapshot cleanup rejection when the engine stops", async () => {
    let endDelivery!: () => void;
    const session: KvSnapshotSession = {
      initialCount: 0,
      snapshotComplete: Promise.resolve(),
      snapshot: { async *[Symbol.asyncIterator]() {} },
      entries: { [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<KvFileEntry>>((resolve) => {
          endDelivery = () => resolve({ done: true, value: undefined });
        }),
      }) },
      stop: () => { endDelivery?.(); throw new Error("consumer delete failed"); },
    };
    const backend = new NatsKvDouble();
    const logger = { debug: vi.fn(), error: vi.fn() };
    const local = await store();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv: {
      get: backend.get.bind(backend), list: backend.list.bind(backend), put: backend.put.bind(backend),
      watch: backend.watch.bind(backend), openSnapshotSession: () => session,
    }, store: local, vault: new VaultDouble(), status: new SyncStatus(), logger });

    await engine.start();
    engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.error).toHaveBeenCalledWith("reconcile.snapshot_cleanup_failed", expect.any(Error));
    local.close();
  });

  it("exposes a complete nonempty snapshot with revision metadata and continuing live delivery", async () => {
    const session = new SnapshotKvSessionDouble(2);
    const first: KvFileEntry = { key: "f.a", value: bytes("a1"), revision: 7 };
    const second: KvFileEntry = { key: "f.b", value: bytes("b1"), revision: 9 };
    session.pushSnapshot(first);
    session.pushSnapshot(second);
    expect(session.initialCount).toBe(2);
    expect(() => new SnapshotKvSessionDouble(1).completeInitialSnapshot()).toThrow("Expected 1 initial entries, received 0");
    const iterator = session.snapshot[Symbol.asyncIterator]();
    const pendingCompletion = session.snapshotComplete;
    session.completeInitialSnapshot();
    await pendingCompletion;
    expect(await iterator.next()).toMatchObject({ value: { key: "f.a", revision: 7, value: bytes("a1") } });
    expect(await iterator.next()).toMatchObject({ value: { key: "f.b", revision: 9, value: bytes("b1") } });
    expect(await iterator.next()).toMatchObject({ done: true });

    const live = session.entries[Symbol.asyncIterator]();
    expect(await live.next()).toMatchObject({ value: { key: "f.a", revision: 7 } });
    session.pushLive({ key: "f.a", value: bytes("a2"), revision: 10 });
    expect(await live.next()).toMatchObject({ value: { key: "f.b", revision: 9 } });
    expect(await live.next()).toMatchObject({ value: { key: "f.a", revision: 10, value: bytes("a2") } });
    await session.stop();
    expect(session.stopCalls).toBe(1);
    expect(await live.next()).toMatchObject({ done: true });
  });

  it("completes an empty initial snapshot without waiting for a record and retains tombstone revisions", async () => {
    const session = new SnapshotKvSessionDouble();
    let complete = false;
    void session.snapshotComplete.then(() => { complete = true; });
    session.completeInitialSnapshot();
    await session.snapshotComplete;
    expect(complete).toBe(true);
    expect(await session.snapshot[Symbol.asyncIterator]().next()).toMatchObject({ done: true });

    const tombstoneBase = record("deleted", "deleted.md", "old");
    const { content: _content, ...tombstoneRecord } = tombstoneBase;
    const tombstone: KvFileEntry = { key: "f.deleted", value: encodeRecord({ ...tombstoneRecord, deleted: true, size: 0 }), revision: 12 };
    const withTombstone = new SnapshotKvSessionDouble(1);
    withTombstone.pushSnapshot(tombstone);
    withTombstone.completeInitialSnapshot();
    expect(await withTombstone.snapshot[Symbol.asyncIterator]().next()).toMatchObject({
      value: { key: "f.deleted", revision: 12, value: tombstone.value },
    });
  });

  it("reconciles a reused path by file identity, retaining the old tombstone and new owner", async () => {
    const kv = new NatsKvDouble();
    const { content: _content, ...oldRecord } = record("file-a", "shared.md", "old");
    const deleted = { ...oldRecord, deleted: true, size: 0 };
    const current = record("file-b", "shared.md", "new owner");
    kv.create("f.file-a", encodeRecord(deleted));
    kv.create("f.file-b", encodeRecord(current));
    const local = await store();
    const vault = new VaultDouble();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status: new SyncStatus() });

    await engine.start();

    expect(read(vault, "shared.md")).toBe("new owner");
    expect(await local.getFile("file-a")).toMatchObject({ deleted: true, path: "shared.md" });
    expect(await local.getFile("file-b")).toMatchObject({ deleted: false, path: "shared.md" });
    expect(await local.unresolvedConflicts()).toEqual([]);
    expect(await local.pending()).toEqual([]);
    engine.stop(); local.close();
  });

  it("keeps a racing live revision, rejects a delayed revision, and applies an overlap only once", async () => {
    const backend = new NatsKvDouble();
    backend.create("f.file-a", encodeRecord(record("file-a", "remote.md", "fallback base")));
    const session = new SnapshotKvSessionDouble(1);
    session.pushSnapshot({ key: "f.file-a", value: encodeRecord(record("file-a", "remote.md", "snapshot")), revision: 4 });
    session.pushLive({ key: "f.file-a", value: encodeRecord(record("file-a", "remote.md", "snapshot")), revision: 4 });
    session.pushLive({ key: "f.file-a", value: encodeRecord(record("file-a", "remote.md", "delayed")), revision: 3 });
    session.pushLive({ key: "f.file-a", value: encodeRecord(record("file-a", "remote.md", "latest")), revision: 5 });
    session.completeInitialSnapshot();
    const { kv, list, openSnapshotSession } = sessionPort(backend, session);
    const local = await store();
    const vault = new VaultDouble();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status: new SyncStatus() });

    await engine.start();

    expect(read(vault, "remote.md")).toBe("latest");
    expect((await local.getFile("file-a"))?.remoteRevision).toBe(5);
    expect(await local.pending()).toEqual([]);
    expect(openSnapshotSession).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    engine.stop(); local.close();
  });

  it("applies a discovered tombstone without producing feedback-loop outbox work", async () => {
    const backend = new NatsKvDouble();
    const live = record("file-a", "note.md", "before");
    const liveRevision = backend.create("f.file-a", encodeRecord(live));
    const ownerKey = pathOwnershipKey("note.md");
    backend.create(ownerKey, encodePathOwnershipRecord({ schemaVersion: 1, canonicalPath: canonicalizeRemotePath("note.md"),
      fileId: "file-a", operationId: "remote-create", state: "owned" }));
    const local = await store();
    const vault = new VaultDouble();
    vault.write("note.md", bytes("before"));
    await local.putFile(indexEntry("file-a", "note.md", "before", liveRevision));
    const tombstoneBase = record("file-a", "note.md", "before", "remote-delete");
    const { content: _content, ...tombstoneRecord } = tombstoneBase;
    const tombstone = { ...tombstoneRecord, deleted: true, size: 0 };
    const session = new SnapshotKvSessionDouble(1);
    session.pushSnapshot({ key: "f.file-a", value: encodeRecord(tombstone), revision: liveRevision + 1 });
    session.completeInitialSnapshot();
    const { kv, list, openSnapshotSession } = sessionPort(backend, session);
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status: new SyncStatus() });

    await engine.start();

    expect(read(vault, "note.md")).toBeUndefined();
    expect(await local.getFile("file-a")).toMatchObject({ deleted: true, remoteRevision: liveRevision + 1 });
    expect(await local.pending()).toEqual([]);
    expect(openSnapshotSession).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    engine.stop(); local.close();
  });

  it("recovers a reused path from the snapshot while preserving ownership by fileId", async () => {
    const backend = new NatsKvDouble();
    const tombstoneBase = record("file-a", "shared.md", "old", "delete-a");
    const { content: _content, ...tombstoneFields } = tombstoneBase;
    const tombstone = { ...tombstoneFields, deleted: true, size: 0 };
    backend.create("f.file-a", encodeRecord(tombstone));
    const renamed = record("file-b", "previous.md", "reused content", "create-b");
    const bRevision = backend.create("f.file-b", encodeRecord(renamed));
    const ownerKey = pathOwnershipKey("shared.md");
    backend.create(ownerKey, encodePathOwnershipRecord({ schemaVersion: 1, canonicalPath: canonicalizeRemotePath("shared.md"),
      fileId: "file-a", operationId: "create-a", state: "owned" }));
    const local = await store();
    const vault = new VaultDouble();
    vault.write("shared.md", bytes("reused content"));
    await local.putFile(indexEntry("file-a", "shared.md", "old", 1, { deleted: true }));
    await local.putFile(indexEntry("file-b", "previous.md", "reused content", bRevision));
    const session = new SnapshotKvSessionDouble(2);
    session.pushSnapshot({ key: "f.file-a", value: encodeRecord(tombstone), revision: 1 });
    session.pushSnapshot({ key: "f.file-b", value: encodeRecord(renamed), revision: bRevision });
    session.completeInitialSnapshot();
    const { kv, list, openSnapshotSession } = sessionPort(backend, session);
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status: new SyncStatus() });

    await engine.start();

    expect(read(vault, "shared.md")).toBe("reused content");
    expect(await local.getFile("file-a")).toMatchObject({ deleted: true, path: "shared.md" });
    expect(await local.getFile("file-b")).toMatchObject({ path: "shared.md", state: "synced" });
    expect(decodePathOwnershipRecord((await kv.get(ownerKey))!.value, ownerKey)).toMatchObject({ fileId: "file-b", state: "owned" });
    expect((await local.unresolvedConflicts())).toEqual([]);
    expect((await local.pending())).toEqual([]);
    expect(openSnapshotSession).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    engine.stop(); local.close();
  });

  it("preserves a durable local edit when snapshot reconciliation meets a newer CAS revision", async () => {
    const backend = new NatsKvDouble();
    const base = record("file-a", "note.md", "base");
    const baseRevision = backend.create("f.file-a", encodeRecord(base));
    const remote = record("file-a", "note.md", "remote revision");
    const remoteRevision = backend.update("f.file-a", encodeRecord(remote), baseRevision);
    const local = await store();
    const vault = new VaultDouble();
    vault.write("note.md", bytes("durable local edit"));
    await local.putFile(indexEntry("file-a", "note.md", "durable local edit", baseRevision, {
      remoteHash: base.contentHash, baseContent: base.content, state: "pending",
    }));
    const pending = { operationId: "pending-edit", fileId: "file-a", type: "modify" as const, path: "note.md",
      content: "durable local edit", localHash: sha256Hex(bytes("durable local edit")), baseRevision,
      baseHash: base.contentHash, baseContent: base.content, retryCount: 0, createdAt: 1 };
    await local.queue(pending);
    const session = new SnapshotKvSessionDouble(1);
    session.pushSnapshot({ key: "f.file-a", value: encodeRecord(remote), revision: remoteRevision });
    session.completeInitialSnapshot();
    const { kv, list, openSnapshotSession } = sessionPort(backend, session);
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status: new SyncStatus() });

    await engine.start();

    const conflicts = await local.unresolvedConflicts();
    const preserved = conflicts.map((conflict) => read(vault, conflict.copyPath)).find(Boolean);
    expect(preserved ?? read(vault, "note.md")).toBe("durable local edit");
    expect(conflicts.length + (await local.pending()).length).toBeGreaterThan(0);
    expect(await local.getFile("file-a")).toBeDefined();
    expect(openSnapshotSession).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    engine.stop(); local.close();
  });

  it("keeps interrupted discovery unreconciled and opens a fresh session on reconnect", async () => {
    const backend = new NatsKvDouble();
    const interrupted = new SnapshotKvSessionDouble(1);
    interrupted.pushSnapshot({ key: "f.file-a", value: encodeRecord(record("file-a", "note.md", "partial")), revision: 1 });
    const resumed = new SnapshotKvSessionDouble(0);
    resumed.completeInitialSnapshot();
    let online = false;
    const list = vi.fn(() => {
      if (!online) throw new Error("mobile connection lost during discovery");
      return backend.list();
    });
    let sessionCalls = 0;
    const openSnapshotSession = vi.fn(() => sessionCalls++ === 0 ? interrupted : resumed);
    const kv: KvPort = {
      get: backend.get.bind(backend), list, put: backend.put.bind(backend), watch: backend.watch.bind(backend),
      create: backend.create.bind(backend), update: backend.update.bind(backend), openSnapshotSession,
    };
    const local = await store();
    const status = new SyncStatus();
    const engine = new MarkdownSyncEngine({ deviceId: "mobile", kv, store: local, vault: new VaultDouble(), status });

    const startup = engine.start();
    interrupted.stop();
    await expect(startup).rejects.toThrow();
    expect(status.reconciled).toBe(false);
    online = true;
    await engine.reconcile();

    expect(openSnapshotSession).toHaveBeenCalledTimes(2);
    expect(status.reconciled).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    engine.stop(); local.close();
  });

  it("bounds exponential retry delay", () => {
    expect([0, 1, 2, 20].map(retryDelay)).toEqual([1000, 2000, 4000, 60000]);
  });

  it("retains offline work, replays on restart, and reports SYNCED only afterward", async () => {
    const kv = new NatsKvDouble();
    const local = await store();
    const vault = new VaultDouble();
    const status = new SyncStatus();
    const actualCreate = kv.create.bind(kv);
    kv.create = () => { throw new Error("NATS offline"); };
    const first = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status, debounceMs: 1 });
    await first.start();
    vault.write("note.md", bytes("offline"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await local.pending())[0]).toMatchObject({ content: "offline", retryCount: 1 });
    expect(status.value).not.toBe("SYNCED");
    first.stop();
    kv.create = actualCreate;
    const resumed = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status, debounceMs: 1 });
    await resumed.start();
    expect(await local.pending()).toEqual([]);
    expect(status.value).toBe("SYNCED");
    resumed.stop(); local.close();
  });

  it("retires an operation already acknowledged by KV after local crash", async () => {
    const kv = new NatsKvDouble();
    const local = await store();
    const vault = new VaultDouble();
    vault.write("note.md", bytes("saved"));
    const operationId = "already-acked";
    const remote = record("file-a", "note.md", "saved", operationId);
    remote.origin.deviceId = "device-a";
    const revision = kv.create("f.file-a", encodeRecord(remote));
    await local.queue({ operationId, fileId: "file-a", type: "create", path: "note.md", content: "saved",
      localHash: remote.contentHash, retryCount: 0, createdAt: 1 });
    const status = new SyncStatus();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status });
    await engine.start();
    expect(await local.pending()).toEqual([]);
    expect((await local.getFile("file-a"))?.remoteRevision).toBe(revision);
    engine.stop(); local.close();
  });

  it("holds non-SYNCED status while remote listing is incomplete", async () => {
    const kv = new NatsKvDouble();
    const original = kv.list.bind(kv);
    let release!: () => void;
    let entered!: () => void;
    const listing = new Promise<void>((resolve) => { entered = resolve; });
    const delayed: KvPort = {
      get: kv.get.bind(kv), put: kv.put.bind(kv), watch: kv.watch.bind(kv),
      create: kv.create.bind(kv), update: kv.update.bind(kv),
      list: async () => { await new Promise<void>((resolve) => { release = resolve; entered(); }); return original(); },
    };
    const local = await store();
    const status = new SyncStatus();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv: delayed, store: local, vault: new VaultDouble(), status });
    const starting = engine.start();
    await listing;
    expect(status.value).not.toBe("SYNCED");
    release();
    await starting;
    expect(status.value).toBe("SYNCED");
    engine.stop(); local.close();
  });

  it("coalesces a visibility-style reconcile request while startup reconciliation is running", async () => {
    const kv = new NatsKvDouble();
    const original = kv.list.bind(kv);
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const listing = new Promise<void>((resolve) => { entered = resolve; });
    const delayed: KvPort = {
      get: kv.get.bind(kv), put: kv.put.bind(kv), watch: kv.watch.bind(kv),
      create: kv.create.bind(kv), update: kv.update.bind(kv),
      list: async () => {
        calls++;
        await new Promise<void>((resolve) => { release = resolve; entered(); });
        return original();
      },
    };
    const local = await store();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv: delayed, store: local, vault: new VaultDouble(), status: new SyncStatus() });

    const starting = engine.start();
    await listing;
    const visibilityReconcile = engine.reconcile();
    release();
    await Promise.all([starting, visibilityReconcile]);

    expect(calls).toBe(1);
    engine.stop(); local.close();
  });

  it("records bounded stage timings and reconcile work counts", async () => {
    const kv = new NatsKvDouble();
    const local = await store();
    const debug = vi.fn();
    const engine = new MarkdownSyncEngine({
      deviceId: "device-a", kv, store: local, vault: new VaultDouble(), status: new SyncStatus(),
      logger: { debug, error: vi.fn() },
    });

    await engine.start();

    const complete = debug.mock.calls.find(([event]) => event === "reconcile.complete")?.[1] as Record<string, number>;
    expect(complete).toMatchObject({ pending: 0, conflicts: 0, remoteApplied: 0, localApplied: 0 });
    for (const field of ["watchSetupMs", "localScanMs", "remoteListMs", "remoteApplyMs", "localApplyMs", "outboxReplayMs", "totalDurationMs"]) {
      expect(complete[field]).toBeTypeOf("number");
      expect(complete[field]).toBeGreaterThanOrEqual(0);
    }
    engine.stop(); local.close();
  });

  it("catches up after mobile resume and ignores duplicate remote revisions", async () => {
    const kv = new NatsKvDouble();
    const local = await store();
    const vault = new VaultDouble();
    const status = new SyncStatus();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status });
    await engine.start();
    engine.stop();
    kv.create("f.file-a", encodeRecord(record("file-a", "remote.md", "after resume")));
    await engine.reconcile();
    expect(read(vault, "remote.md")).toBe("after resume");
    expect(await local.pending()).toEqual([]);
    const eventCount = vault.events.length;
    await engine.reconcile();
    expect(vault.events).toHaveLength(eventCount);
    engine.stop(); local.close();
  });

  it("retains a local edit that has not reached debounce when a remote update arrives", async () => {
    const kv = new NatsKvDouble();
    const base = record("file-a", "note.md", "base");
    const revision = kv.create("f.file-a", encodeRecord(base));
    const local = await store();
    const vault = new VaultDouble();
    vault.write("note.md", bytes("base"));
    const status = new SyncStatus();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault, status, debounceMs: 1000 });
    await engine.start();
    vault.write("note.md", bytes("unpublished local"));
    kv.update("f.file-a", encodeRecord(record("file-a", "note.md", "new remote")), revision);
    for (let i = 0; i < 50 && read(vault, "note.md") !== "new remote"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [conflict] = await local.conflicts();
    expect(read(vault, conflict!.copyPath)).toBe("unpublished local");
    expect(read(vault, "note.md")).toBe("new remote");
    expect(status.value).not.toBe("SYNCED");
    engine.stop(); local.close();
  });

  it("does not claim SYNCED while a watched remote write is still applying", async () => {
    const kv = new NatsKvDouble();
    const local = await store();
    const vault = new VaultDouble();
    let release!: () => void;
    let applying = false;
    const delayedVault: MarkdownVault = {
      read: vault.read.bind(vault), listMarkdown: vault.listMarkdown.bind(vault), onModify: vault.onModify.bind(vault),
      write: async (path, value) => {
        applying = true;
        await new Promise<void>((resolve) => { release = resolve; });
        vault.write(path, value);
      },
    };
    const status = new SyncStatus();
    const engine = new MarkdownSyncEngine({ deviceId: "device-a", kv, store: local, vault: delayedVault, status });
    await engine.start();
    expect(status.value).toBe("SYNCED");
    kv.create("f.file-a", encodeRecord(record("file-a", "new.md", "remote")));
    for (let i = 0; i < 20 && !applying; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(applying).toBe(true);
    expect(status.value).not.toBe("SYNCED");
    release();
    for (let i = 0; i < 20 && status.value !== "SYNCED"; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(read(vault, "new.md")).toBe("remote");
    expect(status.value).toBe("SYNCED");
    engine.stop(); local.close();
  });
});
