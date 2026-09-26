import { describe, expect, it } from "vitest";
import { decodeRecord } from "../../packages/protocol/src/index.js";
import { type BlobPort } from "../../packages/plugin/src/blob-storage.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

async function engineFor(options: {
  kv: NatsKvDouble;
  vault: VaultDouble;
  store: LocalStore;
  blob?: BlobPort;
  inlineLimit?: number;
}) {
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId: "device", vaultId: "VAULT", ...options,
    inlineLimit: options.inlineLimit ?? 512 * 1024, status, debounceMs: 0 });
  await engine.start();
  return { engine, status };
}

describe("optional S3", () => {
  it("keeps blob-required files local without retrying, while Markdown syncs and later S3 resumes them", async () => {
    const kv = new NatsKvDouble();
    const vault = new VaultDouble();
    const store = await LocalStore.open(`optional-s3-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
    const withoutS3 = await engineFor({ kv, vault, store, inlineLimit: 450 });

    await withoutS3.engine.capture("note.md", "NATS-only Markdown");
    const image = new Uint8Array([137, 80, 78, 71]);
    const oversizedMarkdown = "x".repeat(512);
    vault.write("image.png", image);
    await withoutS3.engine.captureBytes("image.png", image);
    vault.write("large.md", new TextEncoder().encode(oversizedMarkdown));
    await withoutS3.engine.capture("large.md", oversizedMarkdown);

    expect(kv.list().filter((entry) => entry.key.startsWith("f.")).map((entry) => decodeRecord(entry.value))).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "note.md", kind: "text" }),
    ]));
    const publishedPaths = kv.list().filter((entry) => entry.key.startsWith("f.")).map((entry) => decodeRecord(entry.value).path);
    expect(publishedPaths).not.toContain("image.png");
    expect(publishedPaths).not.toContain("large.md");
    expect(vault.read("image.png")).toEqual(image);
    expect(withoutS3.status.value).toBe("ERROR");
    expect(withoutS3.status.lastError).toContain("S3 storage is not configured");
    const pending = await store.pending();
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "image.png", kind: "blob", retryCount: 0 }),
      expect.objectContaining({ path: "large.md", kind: "text", retryCount: 0 }),
    ]));
    expect(pending.find((operation) => operation.path === "image.png")).not.toHaveProperty("nextAttemptAt");
    expect(pending.find((operation) => operation.path === "large.md")).not.toHaveProperty("nextAttemptAt");

    withoutS3.engine.stop();
    const uploaded = new Map<string, Uint8Array>();
    const blob: BlobPort = {
      upload: async (key, bytes) => { uploaded.set(key, bytes.slice()); },
      download: async (key) => uploaded.get(key)!,
    };
    const withS3 = await engineFor({ kv, vault, store, blob, inlineLimit: 450 });

    const imageRecord = kv.list().filter((entry) => entry.key.startsWith("f.")).map((entry) => decodeRecord(entry.value)).find((record) => record.path === "image.png");
    const oversizedRecord = kv.list().filter((entry) => entry.key.startsWith("f.")).map((entry) => decodeRecord(entry.value)).find((record) => record.path === "large.md");
    expect(imageRecord).toMatchObject({ kind: "blob", blob: { size: image.length } });
    expect(imageRecord).not.toHaveProperty("content");
    expect(oversizedRecord).toMatchObject({ kind: "blob", blob: { size: oversizedMarkdown.length } });
    expect(uploaded.get(imageRecord!.blob!.key)).toEqual(image);
    expect(await store.pending()).toEqual([]);
    withS3.engine.stop();
    await withS3.engine.settle();
    store.close();
  });
});
