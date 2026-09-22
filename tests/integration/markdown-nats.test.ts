import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { decodeRecord } from "../../packages/protocol/src/index.js";
import { NatsKvAdapter, SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, VaultDouble } from "../doubles/index.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("NATS synchronization timed out");
}

const content = (vault: VaultDouble, path: string) => {
  const value = vault.read(path);
  return value && new TextDecoder().decode(value);
};

describe("disposable NATS Markdown integration", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

  it("delivers single-writer Markdown both ways through real JetStream KV", async () => {
    const executable = process.env.NATS_SERVER_BIN;
    if (!executable) throw new Error("Set NATS_SERVER_BIN to the disposable test nats-server binary");
    const directory = await mkdtemp(join(tmpdir(), "easy-sync-nats-"));
    const port = await freePort();
    const server = spawn(executable, ["--jetstream", "--store_dir", directory, "--port", String(port)], { stdio: "ignore" });
    cleanups.push(async () => {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => server.once("exit", () => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const url = `nats://127.0.0.1:${port}`;
    let admin;
    for (let i = 0; i < 100; i++) {
      try { admin = await connect({ servers: url, maxReconnectAttempts: 0 }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    if (!admin) throw new Error("NATS server did not start");
    cleanups.push(async () => { await admin.close(); });
    const bucket = "OBS_INTEGRATION_FILES";
    await new Kvm(admin).create(bucket, { history: 10 });

    async function replica(deviceId: string) {
      const connection = await connect({ servers: url });
      cleanups.push(async () => { await connection.close(); });
      const kv = new NatsKvAdapter(await new Kvm(connection).open(bucket), connection);
      const vault = new VaultDouble();
      const store = await LocalStore.open(`integration-${deviceId}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
      cleanups.push(async () => { store.close(); });
      const engine = new MarkdownSyncEngine({ deviceId, vault, store, kv, status: new SyncStatus(), debounceMs: 5 });
      await engine.start();
      cleanups.push(async () => { engine.stop(); });
      return { vault, store, kv, engine };
    }

    const a = await replica("device-a");
    const b = await replica("device-b");
    a.vault.write("notes/shared.md", new TextEncoder().encode("one"));
    await eventually(async () => content(b.vault, "notes/shared.md") === "one");
    b.vault.write("notes/shared.md", new TextEncoder().encode("two"));
    await eventually(async () => content(a.vault, "notes/shared.md") === "two");
    const file = await a.store.getFileByPath("notes/shared.md");
    const remote = await a.kv.get(`f.${file?.fileId}`);
    expect(decodeRecord(remote!.value).content).toBe("two");
    expect(await a.store.pending()).toEqual([]);
    expect(await b.store.pending()).toEqual([]);
    const fileId = file!.fileId;
    a.vault.rename("notes/shared.md", "notes/renamed.md");
    await a.engine.rename("notes/shared.md", "notes/renamed.md");
    await eventually(async () => content(b.vault, "notes/renamed.md") === "two" && !b.vault.read("notes/shared.md"));
    expect(decodeRecord((await a.kv.get(`f.${fileId}`))!.value).fileId).toBe(fileId);
    b.engine.stop();
    b.vault.delete("notes/renamed.md");
    const get = b.kv.get.bind(b.kv);
    b.kv.get = async () => { throw new Error("offline"); };
    await b.engine.remove("notes/renamed.md");
    b.kv.get = get;
    a.vault.write("notes/renamed.md", new TextEncoder().encode("third"));
    await eventually(async () => decodeRecord((await a.kv.get(`f.${fileId}`))!.value).content === "third");
    await b.engine.start();
    await eventually(async () => decodeRecord((await a.kv.get(`f.${fileId}`))!.value).deleted);
    const [conflict] = await b.store.conflicts();
    expect(content(b.vault, conflict!.copyPath)).toBe("third");
    expect(b.vault.read("notes/renamed.md")).toBeUndefined();
  }, 15000);
});
