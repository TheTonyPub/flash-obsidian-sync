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

  it("publishes a path-releasing delete before a different file is renamed into that path", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    await a.engine.capture("notes/todo.md", "A");
    await a.engine.capture("notes/todo_diff.md", "B");
    const fileA = await a.store.getFileByPath("notes/todo.md");
    const fileB = await a.store.getFileByPath("notes/todo_diff.md");
    expect(fileA?.fileId).toBeTruthy();
    expect(fileB?.fileId).toBeTruthy();

    const writes: string[] = [];
    const update = kv.update.bind(kv);
    kv.update = ((key, value, revision) => {
      writes.push(key);
      return update(key, value, revision);
    }) as typeof kv.update;
    a.vault.delete("notes/todo.md");
    await a.engine.remove("notes/todo.md");
    a.vault.rename("notes/todo_diff.md", "notes/todo.md");
    await a.engine.rename("notes/todo_diff.md", "notes/todo.md");

    expect(writes.slice(-2)).toEqual([`f.${fileA!.fileId}`, `f.${fileB!.fileId}`]);
    expect(decodeRecord(kv.get(`f.${fileA!.fileId}`)!.value).deleted).toBe(true);
    expect(decodeRecord(kv.get(`f.${fileB!.fileId}`)!.value)).toMatchObject({ path: "notes/todo.md", deleted: false });
    a.engine.stop(); a.store.close();
  });

  it("does not treat an occupied destination as a released owner when rename has not happened", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    await a.engine.capture("notes/todo.md", "A");
    await a.engine.capture("notes/todo_diff.md", "B");
    const fileA = (await a.store.getFileByPath("notes/todo.md"))!;
    const fileB = (await a.store.getFileByPath("notes/todo_diff.md"))!;

    await a.engine.rename("notes/todo_diff.md", "notes/todo.md");

    expect(decodeRecord(kv.get(`f.${fileA.fileId}`)!.value).deleted).toBe(false);
    expect(decodeRecord(kv.get(`f.${fileB.fileId}`)!.value).path).toBe("notes/todo_diff.md");
    expect(text(a.vault, "notes/todo.md")).toBe("A");
    expect(text(a.vault, "notes/todo_diff.md")).toBe("B");
    expect(await a.store.pending()).toEqual([]);
    expect(a.status.conflicts).toBeGreaterThan(0);
    a.engine.stop(); a.store.close();
  });

  it("records the delete predecessor when the rename callback arrives first", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    await a.engine.capture("notes/todo.md", "A");
    await a.engine.capture("notes/todo_diff.md", "B");
    const fileA = await a.store.getFileByPath("notes/todo.md");
    const fileB = await a.store.getFileByPath("notes/todo_diff.md");

    a.vault.delete("notes/todo.md");
    a.vault.rename("notes/todo_diff.md", "notes/todo.md");
    await a.engine.rename("notes/todo_diff.md", "notes/todo.md");
    await a.engine.remove("notes/todo.md");

    expect(decodeRecord(kv.get(`f.${fileA!.fileId}`)!.value).deleted).toBe(true);
    expect(decodeRecord(kv.get(`f.${fileB!.fileId}`)!.value).path).toBe("notes/todo.md");
    expect(await a.store.pending()).toEqual([]);
    a.vault.delete("notes/todo.md");
    await a.engine.remove("notes/todo.md");
    expect(decodeRecord(kv.get(`f.${fileB!.fileId}`)!.value).deleted).toBe(true);
    a.engine.stop(); a.store.close();
  });

  it("recovers a path-reuse delete and rename after restart before either event was captured", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    await a.engine.capture("notes/todo.md", "A");
    await a.engine.capture("notes/todo_diff.md", "B");
    const fileA = await a.store.getFileByPath("notes/todo.md");
    const fileB = await a.store.getFileByPath("notes/todo_diff.md");

    a.engine.stop();
    a.vault.delete("notes/todo.md");
    a.vault.rename("notes/todo_diff.md", "notes/todo.md");
    await a.engine.start();
    await a.engine.settle();

    expect(decodeRecord(kv.get(`f.${fileA!.fileId}`)!.value).deleted).toBe(true);
    expect(decodeRecord(kv.get(`f.${fileB!.fileId}`)!.value)).toMatchObject({ path: "notes/todo.md", deleted: false });
    a.engine.stop(); a.store.close();
  });

  it("keeps a path-reusing rename pending after delete failure and retries it after the delete", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    await a.engine.capture("notes/todo.md", "A");
    await a.engine.capture("notes/todo_diff.md", "B");
    const fileA = await a.store.getFileByPath("notes/todo.md");
    const fileB = await a.store.getFileByPath("notes/todo_diff.md");
    const update = kv.update.bind(kv);
    kv.update = ((key, value, revision) => {
      if (key === `f.${fileA!.fileId}`) throw new Error("delete temporarily unavailable");
      return update(key, value, revision);
    }) as typeof kv.update;

    a.vault.delete("notes/todo.md");
    await a.engine.remove("notes/todo.md");
    a.vault.rename("notes/todo_diff.md", "notes/todo.md");
    await a.engine.rename("notes/todo_diff.md", "notes/todo.md");
    expect(decodeRecord(kv.get(`f.${fileB!.fileId}`)!.value).path).toBe("notes/todo_diff.md");
    const pending = await a.store.pending();
    const deletion = pending.find((operation) => operation.fileId === fileA!.fileId);
    const rename = pending.find((operation) => operation.fileId === fileB!.fileId);
    expect(rename?.predecessorOperationId).toBe(deletion?.operationId);
    expect(rename).toBeDefined();
    await a.engine.capture("notes/independent.md", "C");
    expect(decodeRecord(kv.get(`f.${(await a.store.getFileByPath("notes/independent.md"))!.fileId}`)!.value).content).toBe("C");

    kv.update = update as typeof kv.update;
    a.engine.stop();
    await a.engine.start();
    await a.engine.settle();
    expect(decodeRecord(kv.get(`f.${fileA!.fileId}`)!.value).deleted).toBe(true);
    expect(decodeRecord(kv.get(`f.${fileB!.fileId}`)!.value).path).toBe("notes/todo.md");
    a.engine.stop(); a.store.close();
  });

  it("recovers a remotely successful delete after restart before local acknowledgement", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    await a.engine.capture("notes/todo.md", "A");
    await a.engine.capture("notes/todo_diff.md", "B");
    const fileA = await a.store.getFileByPath("notes/todo.md");
    const fileB = await a.store.getFileByPath("notes/todo_diff.md");
    a.engine.stop();
    a.vault.delete("notes/todo.md");
    await a.store.queue({ operationId: "delete-a", fileId: fileA!.fileId, type: "delete", path: "notes/todo.md",
      localHash: fileA!.localHash, baseHash: fileA!.remoteHash, baseRevision: fileA!.remoteRevision,
      baseContent: fileA!.baseContent, retryCount: 0, createdAt: 1 });
    await a.store.putFile({ ...fileA!, deleted: true, state: "pending" });
    const head = kv.get(`f.${fileA!.fileId}`)!;
    const record = decodeRecord(head.value);
    kv.update(`f.${fileA!.fileId}`, new TextEncoder().encode(JSON.stringify({ ...record, deleted: true,
      content: undefined, origin: { deviceId: "device-a", operationId: "delete-a", clientTime: Date.now() } })), head.revision);
    await a.store.queue({ operationId: "rename-b", fileId: fileB!.fileId, type: "rename", path: "notes/todo.md",
      basePath: "notes/todo_diff.md", localHash: fileB!.localHash, content: "B", baseHash: fileB!.remoteHash,
      baseRevision: fileB!.remoteRevision, retryCount: 0, createdAt: 2 });
    await a.store.putFile({ ...fileB!, path: "notes/todo.md", state: "pending" });

    await a.engine.start();
    await a.engine.settle();
    expect(decodeRecord(kv.get(`f.${fileB!.fileId}`)!.value).path).toBe("notes/todo.md");
    expect(await a.store.pending()).toEqual([]);
    a.engine.stop(); a.store.close();
  });

  it("does not unblock a rename from a tombstone with a different operation identity", async () => {
    const kv = new NatsKvDouble();
    const a = await replica("device-a", kv);
    await a.engine.capture("notes/todo.md", "A");
    await a.engine.capture("notes/todo_diff.md", "B");
    const fileA = (await a.store.getFileByPath("notes/todo.md"))!;
    const fileB = (await a.store.getFileByPath("notes/todo_diff.md"))!;
    const headA = kv.get(`f.${fileA.fileId}`)!;
    const staleRecord = decodeRecord(headA.value);
    const staleRevision = kv.update(`f.${fileA.fileId}`, new TextEncoder().encode(JSON.stringify({ ...staleRecord,
      deleted: true, content: undefined, origin: { deviceId: "other", operationId: "older-delete", clientTime: 1 } })), headA.revision);
    const deleteOperationId = "current-delete-a";
    await a.store.queue({ operationId: deleteOperationId, fileId: fileA.fileId, type: "delete", path: fileA.path,
      localHash: fileA.localHash, baseHash: fileA.remoteHash, baseRevision: staleRevision + 1,
      retryCount: 0, createdAt: 1 });
    await a.store.putFile({ ...fileA, deleted: true, state: "pending" });
    a.vault.delete("notes/todo.md");
    a.vault.rename("notes/todo_diff.md", "notes/todo.md");
    await a.store.queuePathReuse({ operationId: "dependent-rename-b", fileId: fileB.fileId, type: "rename",
      path: "notes/todo.md", basePath: fileB.path, localHash: fileB.localHash, content: "B",
      baseRevision: fileB.remoteRevision, baseHash: fileB.remoteHash, retryCount: 0, createdAt: 2 },
    { ...fileB, path: "notes/todo.md", state: "pending" }, fileA.fileId);
    const update = kv.update.bind(kv);
    kv.update = ((key, value, revision) => {
      if (key === `f.${fileA.fileId}`) throw new Error("current delete unavailable");
      return update(key, value, revision);
    }) as typeof kv.update;

    await a.engine.reconcile();

    expect(decodeRecord(kv.get(`f.${fileA.fileId}`)!.value).origin.operationId).toBe("older-delete");
    expect(decodeRecord(kv.get(`f.${fileB.fileId}`)!.value).path).toBe("notes/todo_diff.md");
    const pending = await a.store.pending();
    expect(pending.find((item) => item.operationId === "dependent-rename-b")?.predecessorOperationId).toBe(deleteOperationId);
    kv.update = update as typeof kv.update;
    a.engine.stop(); a.store.close();
  });
});
