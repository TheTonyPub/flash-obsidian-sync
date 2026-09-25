import { describe, expect, it } from "vitest";
import { decodeRecord, encodeRecord, sha256Hex, type RemoteFileRecord } from "../../packages/protocol/src/index.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore, type ConflictRecord } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

type LifecycleRecord = ConflictRecord & {
  lifecycle: "unresolved" | "pending-sync" | "resolved";
  recoveryBackup?: { path: string; hash: string; size: number };
};

describe("conflict restart and CAS simulations", () => {
  it("rebuilds unresolved records and selected recovery backups after restart", async () => {
    const name = `restart-contract-${crypto.randomUUID()}`;
    const first = await LocalStore.open(name, indexedDBDouble.indexedDB);
    await first.putConflict({
      operationId: "restart-op", originalFileId: "remote", originalPath: "note.md",
      copyFileId: "copy", copyPath: "note.conflict.md", remoteRevision: 7,
      lifecycle: "unresolved", recoveryBackup: { path: "note.backup.md", hash: "a".repeat(64), size: 5 },
    } as unknown as LifecycleRecord);
    first.close();
    const restarted = await LocalStore.open(name, indexedDBDouble.indexedDB);
    const record = await restarted.getConflict("restart-op") as LifecycleRecord;
    expect(record.lifecycle).toBe("unresolved");
    expect(record.recoveryBackup?.path).toBe("note.backup.md");
    restarted.close();
  });

  it("keeps CAS retries idempotent and independent across unresolved conflicts", async () => {
    const name = `cas-contract-${crypto.randomUUID()}`;
    const store = await LocalStore.open(name, indexedDBDouble.indexedDB);
    const record = {
      operationId: "cas-op", originalFileId: "remote", originalPath: "note.md",
      copyFileId: "copy", copyPath: "note.conflict.md", remoteRevision: 9,
      lifecycle: "pending-sync",
    } as unknown as LifecycleRecord;
    await store.putConflict(record);
    await store.putConflict(record);
    expect(await store.conflicts()).toHaveLength(1);
    await store.putConflict({ ...record, operationId: "other-op", copyPath: "other.conflict.md", lifecycle: "unresolved" } as unknown as LifecycleRecord);
    expect((await store.conflicts()).map((entry) => entry.operationId).sort()).toEqual(["cas-op", "other-op"]);
    expect((await store.getConflict("cas-op") as LifecycleRecord).lifecycle).toBe("pending-sync");
    store.close();
  });

  it("restarts an engine with a preserved copy and retries a raced CAS without duplicating the conflict", async () => {
    const bytes = (value: string) => new TextEncoder().encode(value);
    const remote = (content: string): RemoteFileRecord => ({
      schemaVersion: 1, fileId: "remote", path: "note.md", kind: "text", deleted: false,
      contentHash: sha256Hex(bytes(content)), size: bytes(content).length, content,
      origin: { deviceId: "remote-device", operationId: "remote-op", clientTime: 1 },
    });
    const kv = new NatsKvDouble();
    const vault = new VaultDouble();
    vault.write("note.md", bytes("BASE\n"));
    const name = `engine-restart-${crypto.randomUUID()}`;
    const firstStore = await LocalStore.open(name, indexedDBDouble.indexedDB);
    const first = new MarkdownSyncEngine({ deviceId: "local", kv, vault, store: firstStore, status: new SyncStatus(), debounceMs: 0 });
    await first.start();
    first.stop();
    vault.write("note.md", bytes("LOCAL\n"));
    const originalGet = kv.get.bind(kv);
    kv.get = () => { throw new Error("offline"); };
    await first.capture("note.md", "LOCAL\n");
    kv.get = originalGet;
    kv.create("f.remote", encodeRecord(remote("REMOTE\n")));
    firstStore.close();

    const restartedStore = await LocalStore.open(name, indexedDBDouble.indexedDB);
    const restarted = new MarkdownSyncEngine({ deviceId: "local", kv, vault, store: restartedStore, status: new SyncStatus(), debounceMs: 0 });
    await restarted.start();
    const firstRecords = await restartedStore.conflicts();
    expect(firstRecords).toHaveLength(1);
    expect(vault.read(firstRecords[0]!.copyPath)).toBeTruthy();
    let raced = false;
    const originalUpdate = kv.update.bind(kv);
    kv.update = (key, value, revision) => {
      if (!raced) {
        raced = true;
        const head = kv.get(key)!;
        const current = decodeRecord(head.value);
        kv.put(key, encodeRecord({ ...current, content: "REMOTE RACE\n", contentHash: sha256Hex(bytes("REMOTE RACE\n")), size: bytes("REMOTE RACE\n").length }));
      }
      return originalUpdate(key, value, revision);
    };
    vault.write("note.md", bytes("LOCAL AFTER RESTART\n"));
    await restarted.capture("note.md", "LOCAL AFTER RESTART\n");
    expect(raced).toBe(true);
    const afterRetry = await restartedStore.conflicts();
    const retried = afterRetry.filter((entry) => entry.operationId === firstRecords[0]!.operationId);
    expect(retried).toHaveLength(1);
    expect(vault.read(retried[0]!.copyPath)).toBeTruthy();
    expect(retried[0]!.lifecycle).not.toBe("resolved");
    restarted.stop(); await restarted.settle(); restartedStore.close();
  });
});
