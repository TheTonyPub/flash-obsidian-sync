import { describe, expect, it } from "vitest";
import { decodeRecord, encodeRecord, sha256Hex } from "../../packages/protocol/src/index.js";
import { type BlobPort, blobObjectKey } from "../../packages/plugin/src/blob-storage.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
async function setup(kv = new NatsKvDouble(), blob?: BlobPort, inlineLimit = 512 * 1024) {
  const vault = new VaultDouble();
  const store = await LocalStore.open(`blob-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId: "device", vaultId: "VAULT", vault, store, kv, blob,
    inlineLimit, status, debounceMs: 0 });
  await engine.start();
  return { kv, vault, store, status, engine };
}

describe("blob publication and apply", () => {
  it("uploads binary bytes before publishing a content-addressed KV record", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const uploaded = new Map<string, Uint8Array>();
    const blob: BlobPort = { upload: async (key, value) => { await gate; uploaded.set(key, value); },
      download: async (key) => uploaded.get(key)! };
    const r = await setup(undefined, blob);
    const image = new Uint8Array([0, 1, 2, 255]);
    r.vault.write("image.png", image);
    const publishing = r.engine.captureBytes("image.png", image);
    for (let i = 0; i < 20 && !(await r.store.pending()).length; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await r.store.pending()).toHaveLength(1);
    expect(r.kv.list()).toHaveLength(0);
    release(); await publishing;
    const record = decodeRecord(r.kv.list().find((entry) => entry.key.startsWith("f."))!.value);
    expect(record.kind).toBe("blob");
    expect(record.content).toBeUndefined();
    expect(record.blob?.key).toBe(blobObjectKey("VAULT", sha256Hex(image)));
    expect(uploaded.get(record.blob!.key)).toEqual(image);
    r.engine.stop(); await r.engine.settle(); r.store.close();
  });

  it("routes oversized Markdown while keeping ordinary Markdown inline", async () => {
    const blob: BlobPort = { upload: async () => {}, download: async () => new Uint8Array() };
    const r = await setup(undefined, blob, 450);
    r.vault.write("small.md", bytes("short"));
    await r.engine.capture("small.md", "short");
    r.vault.write("large.md", bytes("x".repeat(512)));
    await r.engine.capture("large.md", "x".repeat(512));
    const records = r.kv.list().filter((entry) => entry.key.startsWith("f.")).map((entry) => decodeRecord(entry.value));
    expect(records.find((record) => record.path === "small.md")?.kind).toBe("text");
    expect(records.find((record) => record.path === "large.md")?.kind).toBe("blob");
    r.engine.stop(); await r.engine.settle(); r.store.close();
  });

  it("rejects a corrupted download without changing the local file", async () => {
    const kv = new NatsKvDouble();
    const good = bytes("correct");
    const hash = sha256Hex(good);
    kv.create("f.remote", encodeRecord({ schemaVersion: 1, fileId: "remote", path: "image.png", kind: "blob",
      deleted: false, contentHash: hash, size: good.length,
      blob: { algorithm: "sha256", hash, key: blobObjectKey("VAULT", hash), size: good.length },
      origin: { deviceId: "other", operationId: "op", clientTime: 0 } }));
    const r = await setup(kv, { upload: async () => {}, download: async () => bytes("corrupt") });
    expect(r.vault.read("image.png")).toBeUndefined();
    expect(r.status.value).toBe("ERROR");
    r.engine.stop(); await r.engine.settle(); r.store.close();
  });

  it("keeps failed blobs pending while inline Markdown can still publish", async () => {
    const r = await setup(undefined, { upload: async () => { throw new Error("S3 down"); },
      download: async () => { throw new Error("S3 down"); } });
    const image = new Uint8Array([1, 2, 3]);
    r.vault.write("image.png", image);
    await r.engine.captureBytes("image.png", image);
    r.vault.write("note.md", bytes("live"));
    await r.engine.capture("note.md", "live");
    expect(r.kv.list().filter((entry) => entry.key.startsWith("f.")).map((entry) => decodeRecord(entry.value).path)).toContain("note.md");
    expect((await r.store.pending()).some((operation) => operation.path === "image.png")).toBe(true);
    r.engine.stop(); await r.engine.settle(); r.store.close();
  });
});
