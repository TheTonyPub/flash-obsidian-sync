import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { decodeRecord } from "../../packages/protocol/src/index.js";
import { connectS3Blob } from "../../packages/plugin/src/blob-storage.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const execFile = promisify(execFileCallback);
const image = "docker.io/rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff";
const bytes = (value: string) => new TextEncoder().encode(value);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("disposable S3-compatible blob integration", () => {
  let containerId = "";
  const replicas: Array<{ engine: MarkdownSyncEngine; store: LocalStore }> = [];
  afterAll(async () => {
    for (const replica of replicas) replica.engine.stop();
    for (const replica of replicas) { await replica.engine.settle(); replica.store.close(); }
    if (containerId) await execFile("docker", ["rm", "-f", containerId]);
  });

  const run = process.env.S3_TEST_DOCKER === "1" ? it : it.skip;
  run("uploads before KV, verifies download, rejects corruption, and tolerates S3 outage", async () => {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const { stdout } = await execFile("docker", ["run", "-d", "--rm", "-p", `127.0.0.1:${port}:9000`,
      "-e", "RUSTFS_VOLUMES=/data", "-e", "RUSTFS_ACCESS_KEY=testadmin", "-e", "RUSTFS_SECRET_KEY=testpassword123",
      image]);
    containerId = stdout.trim();
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(`${endpoint}/health/ready`)).ok; if (ready) break; }
      catch { /* Container is starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Disposable MinIO did not start");
    const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: "testadmin", secretAccessKey: "testpassword123" } });
    await client.send(new CreateBucketCommand({ Bucket: "easy-sync-test" }));
    const blob = await connectS3Blob({ endpoint, bucket: "easy-sync-test", region: "us-east-1",
      accessKeyId: "testadmin", secretKeySecretKey: "secret", allowHttpForTests: true },
    { getSecret: async () => "testpassword123" });
    const kv = new NatsKvDouble();
    async function replica(id: string) {
      const vault = new VaultDouble();
      const store = await LocalStore.open(`minio-${id}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
      const status = new SyncStatus();
      const engine = new MarkdownSyncEngine({ deviceId: id, vaultId: "VAULT", vault, store, kv, blob,
        status, inlineLimit: 512, debounceMs: 0 });
      await engine.start();
      replicas.push({ engine, store });
      return { vault, store, status, engine };
    }
    const a = await replica("a");
    const payload = new Uint8Array([0, 1, 2, 3, 255]);
    a.vault.write("image.png", payload);
    await a.engine.captureBytes("image.png", payload);
    const record = decodeRecord(kv.list().find((entry) => entry.key.startsWith("f."))!.value);
    expect(record.kind).toBe("blob");
    expect(record.content).toBeUndefined();
    expect(await blob.download(record.blob!.key)).toEqual(payload);
    const b = await replica("b");
    expect(b.vault.read("image.png")).toEqual(payload);
    await client.send(new PutObjectCommand({ Bucket: "easy-sync-test", Key: record.blob!.key,
      Body: new Uint8Array([9, 9, 9, 9, 9]) }));
    const c = await replica("c");
    expect(c.vault.read("image.png")).toBeUndefined();
    expect(c.status.value).toBe("ERROR");
    await client.send(new PutObjectCommand({ Bucket: "easy-sync-test", Key: record.blob!.key, Body: payload }));
    await c.engine.reconcile();
    expect(c.vault.read("image.png")).toEqual(payload);
    expect(c.status.value).toBe("SYNCED");
    await execFile("docker", ["rm", "-f", containerId]);
    containerId = "";
    const offline = new Uint8Array([8, 8]);
    a.vault.write("offline.bin", offline);
    await a.engine.captureBytes("offline.bin", offline);
    a.vault.write("note.md", bytes("still live"));
    await a.engine.capture("note.md", "still live");
    expect(kv.list().filter((entry) => entry.key.startsWith("f.")).map((entry) => decodeRecord(entry.value))
      .find((entry) => entry.path === "note.md")?.content)
      .toBe("still live");
    expect((await a.store.pending()).some((entry) => entry.path === "offline.bin")).toBe(true);
  }, 30000);
});
