import { describe, expect, it } from "vitest";
import { decodeRecord } from "../../packages/protocol/src/index.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const text = (vault: VaultDouble, path: string) => {
  const bytes = vault.read(path);
  return bytes && new TextDecoder().decode(bytes);
};

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not reached");
}

async function replica(deviceId: string, kv: NatsKvDouble) {
  const vault = new VaultDouble();
  const store = await LocalStore.open(`state-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId, vault, store, kv, status, debounceMs: 5 });
  await engine.start();
  return { vault, store, status, engine };
}

describe("inline Markdown sync", () => {
  it("propagates single-writer edits in both directions without echo", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    const b = await replica("device-b", kv);
    a.vault.write("notes/a.md", new TextEncoder().encode("from A"));
    await eventually(() => text(b.vault, "notes/a.md") === "from A");
    expect(await b.store.pending()).toEqual([]);
    const first = await a.store.getFileByPath("notes/a.md");
    expect(first?.fileId).toBeTruthy();
    b.vault.write("notes/a.md", new TextEncoder().encode("from B"));
    await eventually(() => text(a.vault, "notes/a.md") === "from B");
    expect((await a.store.getFileByPath("notes/a.md"))?.fileId).toBe(first?.fileId);
    const entry = kv.get(`f.${first?.fileId}`)!;
    expect(decodeRecord(entry.value).content).toBe("from B");
    expect(await a.store.pending()).toEqual([]);
    expect(await b.store.pending()).toEqual([]);
    a.engine.stop(); b.engine.stop(); a.store.close(); b.store.close();
  });

  it("persists an operation before network publication and leaves it pending on failure", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    const originalCreate = kv.create.bind(kv);
    let seenBeforeWrite = false;
    kv.create = () => {
      void a.store.pending().then((pending) => { seenBeforeWrite = pending.length === 1; });
      throw new Error("NATS offline");
    };
    a.vault.write("notes/a.md", new TextEncoder().encode("draft"));
    await eventually(() => a.status.value === "PENDING" && a.vault.events.length === 1);
    await eventually(() => seenBeforeWrite);
    expect((await a.store.pending()).map((item) => item.content)).toEqual(["draft"]);
    kv.create = originalCreate;
    a.engine.stop(); a.store.close();
  });

  it("debounces editor changes and publishes final content", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    a.engine.scheduleCapture("notes/a.md", "a");
    a.engine.scheduleCapture("notes/a.md", "ab");
    a.engine.scheduleCapture("notes/a.md", "abc");
    await eventually(() => a.vault.events.length === 0 && a.status.pending === 0 && a.store !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const file = await a.store.getFileByPath("notes/a.md");
    expect(decodeRecord(kv.get(`f.${file?.fileId}`)!.value).content).toBe("abc");
    a.engine.stop(); a.store.close();
  });

  it("keeps a newer local edit made while an earlier edit is publishing", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    a.vault.write("notes/a.md", new TextEncoder().encode("base"));
    await eventually(() => kv.list().length === 1);
    const file = await a.store.getFileByPath("notes/a.md");
    expect(file).toBeDefined();

    const originalUpdate = kv.update.bind(kv);
    let release!: () => void;
    let entered!: () => void;
    const publishing = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    kv.update = (async (...args: Parameters<typeof kv.update>) => {
      entered();
      await held;
      return originalUpdate(...args);
    }) as unknown as typeof kv.update;

    a.vault.write("notes/a.md", new TextEncoder().encode("first"));
    await publishing;
    a.vault.write("notes/a.md", new TextEncoder().encode("second"));
    await eventually(() => a.status.pending > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await eventually(() => decodeRecord(kv.get(`f.${file?.fileId}`)!.value).content === "second" && a.status.pending === 0);
    expect(text(a.vault, "notes/a.md")).toBe("second");
    expect(await a.store.pending()).toEqual([]);
    const revision = kv.get(`f.${file?.fileId}`)!.revision;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kv.get(`f.${file?.fileId}`)!.revision).toBe(revision);
    a.engine.stop(); a.store.close();
  });
});
