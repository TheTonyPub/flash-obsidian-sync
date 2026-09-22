import { describe, expect, it } from "vitest";
import { decodeRecord, encodeRecord, sha256Hex, type RemoteFileRecord } from "../../packages/protocol/src/index.js";
import { SyncStatus, type KvPort, type RemoteEntry } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (vault: VaultDouble, path: string) => {
  const value = vault.read(path);
  return value && new TextDecoder().decode(value);
};
const record = (fileId: string, path: string, content: string): RemoteFileRecord => ({
  schemaVersion: 1, fileId, path, kind: "text", deleted: false, content,
  contentHash: sha256Hex(bytes(content)), size: bytes(content).length,
  origin: { deviceId: "fixture", operationId: `create-${fileId}`, clientTime: 0 },
});
async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not reached");
}
async function replica(id: string, kv: KvPort, vault = new VaultDouble(), store?: LocalStore) {
  const local = store ?? await LocalStore.open(`fault-${id}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId: id, kv, vault, store: local, status, debounceMs: 5 });
  await engine.start();
  return { vault, store: local, status, engine };
}

class BufferedWatchKv implements KvPort {
  readonly events: Array<{ key: string; value: Uint8Array; revision: number }> = [];
  private listener?: (entry: { key: string; value: Uint8Array; revision: number }) => void;
  constructor(private readonly backend: NatsKvDouble) {}
  get(key: string) { return this.backend.get(key); }
  list() { return this.backend.list(); }
  put(key: string, value: Uint8Array) { return this.backend.put(key, value); }
  create(key: string, value: Uint8Array) { return this.backend.create(key, value); }
  update(key: string, value: Uint8Array, revision: number) { return this.backend.update(key, value, revision); }
  watch(listener: (entry: { key: string; value: Uint8Array; revision: number }) => void) {
    this.listener = listener;
    const stop = this.backend.watch((entry) => this.events.push(entry));
    return () => { stop(); this.listener = undefined; };
  }
  deliver(...indexes: number[]): void {
    for (const index of indexes) this.listener?.(this.events[index]!);
  }
}

class RestartableKv implements KvPort {
  online = true;
  constructor(private readonly backend: NatsKvDouble) {}
  private available(): void { if (!this.online) throw new Error("NATS offline"); }
  get(key: string): RemoteEntry | null { this.available(); return this.backend.get(key); }
  list() { this.available(); return this.backend.list(); }
  put(key: string, value: Uint8Array) { this.available(); return this.backend.put(key, value); }
  create(key: string, value: Uint8Array) { this.available(); return this.backend.create(key, value); }
  update(key: string, value: Uint8Array, revision: number) { this.available(); return this.backend.update(key, value, revision); }
  watch(listener: (entry: { key: string; value: Uint8Array; revision: number }) => void) {
    this.available();
    return this.backend.watch((entry) => { if (this.online) listener(entry); });
  }
}

describe("multi-replica fault simulations", () => {
  it.each([[1, 0, 1], [0, 0, 1], [1, 1, 0]])(
    "converges with delayed and duplicate watch delivery %j",
    async (...order: number[]) => {
      const backend = new NatsKvDouble();
      const delayed = new BufferedWatchKv(backend);
      const a = await replica("a", backend);
      const b = await replica("b", delayed);
      a.vault.write("note.md", bytes("first"));
      await a.engine.capture("note.md", "first");
      a.vault.write("note.md", bytes("second"));
      await a.engine.capture("note.md", "second");
      expect(delayed.events).toHaveLength(2);
      const latest = backend.list()[0]!;
      delayed.deliver(...order);
      await b.engine.settle();
      expect(text(b.vault, "note.md")).toBe("second");
      expect((await b.store.getFileByPath("note.md"))?.remoteRevision).toBe(latest.revision);
      expect(await b.store.pending()).toEqual([]);
      expect(decodeRecord(latest.value).contentHash).toBe(sha256Hex(b.vault.read("note.md")!));
      expect(backend.get(latest.key)?.revision).toBe(latest.revision);
      a.engine.stop(); b.engine.stop();
      await a.engine.settle(); await b.engine.settle();
      a.store.close(); b.store.close();
    },
  );

  it("retires a committed mutation after a client crash before local acknowledgement", async () => {
    const backend = new NatsKvDouble();
    const vault = new VaultDouble();
    const name = `crash-${crypto.randomUUID()}`;
    const store = await LocalStore.open(name, indexedDBDouble.indexedDB);
    const a = await replica("a", backend, vault, store);
    store.confirmPublished = async () => { throw new Error("simulated crash before acknowledgement"); };
    vault.files.set("note.md", bytes("durable draft"));
    await a.engine.capture("note.md", "durable draft");
    expect(await store.pending()).toHaveLength(1);
    const committed = backend.list()[0]!;
    a.engine.stop(); await a.engine.settle(); store.close();

    const reopened = await LocalStore.open(name, indexedDBDouble.indexedDB);
    const resumed = await replica("a", backend, vault, reopened);
    expect(await reopened.pending()).toEqual([]);
    expect(text(vault, "note.md")).toBe("durable draft");
    expect(decodeRecord(committed.value).contentHash).toBe(sha256Hex(vault.read("note.md")!));
    expect(backend.get(committed.key)?.revision).toBe(committed.revision);
    resumed.engine.stop(); await resumed.engine.settle(); reopened.close();
  });

  it("replays offline edits after a server restart with the same persisted KV state", async () => {
    const backend = new NatsKvDouble();
    const transport = new RestartableKv(backend);
    const a = await replica("a", transport);
    const b = await replica("b", transport);
    a.vault.write("note.md", bytes("base"));
    await a.engine.capture("note.md", "base");
    await b.engine.settle();
    a.engine.stop(); b.engine.stop();
    transport.online = false;
    a.vault.write("note.md", bytes("after outage"));
    await a.engine.capture("note.md", "after outage");
    expect(await a.store.pending()).toHaveLength(1);
    expect(text(b.vault, "note.md")).toBe("base");
    transport.online = true;
    const resumedA = await replica("a", transport, a.vault, a.store);
    const resumedB = await replica("b", transport, b.vault, b.store);
    await eventually(() => text(b.vault, "note.md") === "after outage");
    expect(await a.store.pending()).toEqual([]);
    expect(decodeRecord(backend.list()[0]!.value).content).toBe("after outage");
    expect(decodeRecord(backend.list()[0]!.value).contentHash).toBe(sha256Hex(b.vault.read("note.md")!));
    resumedA.engine.stop(); resumedB.engine.stop();
    await resumedA.engine.settle(); await resumedB.engine.settle();
    a.store.close(); b.store.close();
  });

  it.each([["file-a", "file-z"], ["file-z", "file-a"]])(
    "preserves both contents for a same-path collision inserted %s then %s",
    async (first: string, second: string) => {
      const backend = new NatsKvDouble();
      backend.create(`f.${first}`, encodeRecord(record(first, "same.md", first)));
      backend.create(`f.${second}`, encodeRecord(record(second, "same.md", second)));
      const a = await replica("a", backend);
      const b = await replica("b", backend);
      await a.engine.reconcile(); await b.engine.reconcile();
      const remote = backend.list().map((entry) => decodeRecord(entry.value));
      expect(new Set(remote.map((entry) => entry.path)).size).toBe(2);
      expect(remote.find((entry) => entry.fileId === "file-a")?.path).toBe("same.md");
      expect(remote.find((entry) => entry.fileId === "file-z")?.path).toBe("same.conflict-file-z.md");
      for (const side of [a, b]) {
        expect(side.vault.listMarkdown().map((item) => item.content).sort()).toEqual(["file-a", "file-z"]);
        expect((await side.store.files()).map((item) => item.fileId).sort()).toEqual(["file-a", "file-z"]);
        expect(await side.store.pending()).toEqual([]);
      }
      a.engine.stop(); b.engine.stop();
      await a.engine.settle(); await b.engine.settle();
      a.store.close(); b.store.close();
    },
  );
});
