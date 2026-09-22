import { describe, expect, it } from "vitest";
import { decodeRecord, encodeRecord, sha256Hex } from "../../packages/protocol/src/index.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array | undefined) => value && new TextDecoder().decode(value);

async function replica(id: string, kv: NatsKvDouble, path?: string, content?: string) {
  const vault = new VaultDouble();
  if (path && content) vault.write(path, bytes(content));
  const store = await LocalStore.open(`life-${id}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId: id, vault, store, kv, status, debounceMs: 0 });
  await engine.start();
  return { vault, store, status, engine };
}

describe("file lifecycle", () => {
  it("propagates rename on the same KV key and fileId", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("a", kv, "old.md", "body");
    const b = await replica("b", kv);
    const id = (await a.store.getFileByPath("old.md"))!.fileId;
    a.vault.rename("old.md", "new.md");
    await a.engine.rename("old.md", "new.md");
    await b.engine.settle();
    expect(kv.list()).toHaveLength(1);
    expect(decodeRecord(kv.list()[0]!.value)).toMatchObject({ fileId: id, path: "new.md" });
    expect(text(b.vault.read("old.md"))).toBeUndefined();
    expect(text(b.vault.read("new.md"))).toBe("body");
    expect((await b.store.getFileByPath("new.md"))?.fileId).toBe(id);
    a.engine.stop(); b.engine.stop(); await a.engine.settle(); await b.engine.settle(); a.store.close(); b.store.close();
  });

  it("publishes a tombstone and removes the peer file", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("a", kv, "note.md", "body");
    const b = await replica("b", kv);
    a.vault.delete("note.md");
    await a.engine.remove("note.md");
    await b.engine.settle();
    expect(decodeRecord(kv.list()[0]!.value).deleted).toBe(true);
    expect(b.vault.read("note.md")).toBeUndefined();
    a.engine.stop(); b.engine.stop(); await a.engine.settle(); await b.engine.settle(); a.store.close(); b.store.close();
  });

  it("keeps a remote edit when an offline delete races it", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("a", kv, "note.md", "base");
    const b = await replica("b", kv);
    const originalId = (await a.store.getFileByPath("note.md"))!.fileId;
    a.engine.stop();
    a.vault.delete("note.md");
    const get = kv.get.bind(kv);
    kv.get = () => { throw new Error("offline"); };
    await a.engine.remove("note.md");
    kv.get = get;
    b.vault.write("note.md", bytes("edited"));
    await b.engine.capture("note.md", "edited");
    await a.engine.start();
    expect(decodeRecord(kv.get(`f.${originalId}`)!.value).deleted).toBe(true);
    const [conflict] = await a.store.conflicts();
    expect(text(a.vault.read(conflict!.copyPath))).toBe("edited");
    a.engine.stop(); b.engine.stop(); await a.engine.settle(); await b.engine.settle(); a.store.close(); b.store.close();
  });

  it("does not overwrite either file on a same-path different-ID collision", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("a", kv, "note.md", "local");
    const localId = (await a.store.getFileByPath("note.md"))!.fileId;
    const remoteId = localId < "zzzz" ? "zzzz" : "0000";
    const content = "remote";
    kv.create(`f.${remoteId}`, encodeRecord({ schemaVersion: 1, fileId: remoteId, path: "note.md", kind: "text",
      deleted: false, contentHash: sha256Hex(bytes(content)), size: bytes(content).length, content,
      origin: { deviceId: "other", operationId: "other-create", clientTime: 0 } }));
    await a.engine.reconcile();
    const records = kv.list().map((entry) => decodeRecord(entry.value)).filter((entry) => !entry.deleted);
    expect(new Set(records.map((entry) => entry.path)).size).toBe(2);
    expect(a.vault.listMarkdown().map((entry) => entry.content).sort()).toEqual(["local", "remote"]);
    a.engine.stop(); await a.engine.settle(); a.store.close();
  });
});
