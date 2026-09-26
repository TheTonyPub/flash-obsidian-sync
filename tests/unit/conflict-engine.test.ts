import { describe, expect, it } from "vitest";
import { decodeRecord, encodeRecord, sha256Hex } from "../../packages/protocol/src/index.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function replica(name: string, kv: NatsKvDouble, initial?: string) {
  const vault = new VaultDouble();
  if (initial !== undefined) vault.write("note.md", encoder.encode(initial));
  const store = await LocalStore.open(`conflict-${name}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId: name, kv, vault, store, status, debounceMs: 0 });
  await engine.start();
  return { vault, store, status, engine };
}

describe("revision-safe publication", () => {
  it("retries a failed expected-revision write against the new head", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("race", kv, "one\ntwo\n");
    const originalUpdate = kv.update.bind(kv);
    let raced = false;
    kv.update = (key, value, revision) => {
      if (!raced) {
        raced = true;
        const remote = decodeRecord(kv.get(key)!.value);
        const content = "one\nTWO\n";
        kv.put(key, encodeRecord({ ...remote, content, contentHash: sha256Hex(encoder.encode(content)),
          size: encoder.encode(content).length, origin: { deviceId: "other", operationId: "race-write", clientTime: 0 } }));
      }
      return originalUpdate(key, value, revision);
    };
    a.vault.write("note.md", encoder.encode("ONE\ntwo\n"));
    await a.engine.capture("note.md", "ONE\ntwo\n");
    expect(raced).toBe(true);
    expect(decodeRecord(kv.list().find((entry) => entry.key.startsWith("f."))!.value).content).toBe("ONE\nTWO\n");
    expect(decoder.decode(a.vault.read("note.md"))).toBe("ONE\nTWO\n");
    expect(await a.store.pending()).toHaveLength(0);
    a.engine.stop(); await a.engine.settle(); a.store.close();
  });

  it("captures the exact base and merges disjoint offline edits", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("a", kv, "one\ntwo\nthree\n");
    const b = await replica("b", kv);
    a.engine.stop();
    a.vault.write("note.md", encoder.encode("ONE\ntwo\nthree\n"));
    // Queue while unavailable using a port whose read fails.
    const originalGet = kv.get.bind(kv);
    kv.get = () => { throw new Error("offline"); };
    await a.engine.capture("note.md", "ONE\ntwo\nthree\n");
    expect((await a.store.pending())[0]?.baseContent).toBe("one\ntwo\nthree\n");
    kv.get = originalGet;
    await b.engine.capture("note.md", "one\ntwo\nTHREE\n");
    await a.engine.start();
    expect(decoder.decode(a.vault.read("note.md"))).toBe("ONE\ntwo\nTHREE\n");
    expect(decodeRecord(kv.list().find((entry) => entry.key.startsWith("f."))!.value).content).toBe("ONE\ntwo\nTHREE\n");
    expect(await a.store.pending()).toHaveLength(0);
    a.engine.stop(); b.engine.stop(); await a.engine.settle(); await b.engine.settle(); a.store.close(); b.store.close();
  });

  it("preserves overlapping offline edit in a discoverable conflict copy", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("a", kv, "same\n");
    const b = await replica("b", kv);
    a.engine.stop();
    a.vault.write("note.md", encoder.encode("LOCAL\n"));
    const originalGet = kv.get.bind(kv);
    kv.get = () => { throw new Error("offline"); };
    await a.engine.capture("note.md", "LOCAL\n");
    kv.get = originalGet;
    await b.engine.capture("note.md", "REMOTE\n");
    await a.engine.start();
    const [conflict] = await a.store.conflicts();
    expect(conflict?.copyPath).toMatch(/^note\.conflict-a-.*\.md$/);
    expect(decoder.decode(a.vault.read(conflict!.copyPath))).toBe("LOCAL\n");
    expect(decoder.decode(a.vault.read("note.md"))).toBe("REMOTE\n");
    expect(a.status.value).toBe("CONFLICT");
    a.engine.stop(); b.engine.stop(); await a.engine.settle(); await b.engine.settle(); a.store.close(); b.store.close();
  });
});
