import { describe, expect, it } from "vitest";
import { encodeRecord, sha256Hex, type RemoteFileRecord } from "../../packages/protocol/src/index.js";
import { SyncStatus, type KvPort } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine, retryDelay, type MarkdownVault } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

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

describe("reconciliation and durable replay", () => {
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
