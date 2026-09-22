import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { NatsKvAdapter, SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, VaultDouble } from "../doubles/index.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (vault: VaultDouble, path: string) => {
  const value = vault.read(path);
  return value && new TextDecoder().decode(value);
};

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition not reached");
}

describe("NATS persistence and offline recovery", () => {
  it("bootstraps, retains offline edit, and catches up after server restart", async () => {
    const executable = process.env.NATS_SERVER_BIN;
    const docker = process.env.NATS_TEST_DOCKER === "1";
    if (!executable && !docker) throw new Error("Set NATS_SERVER_BIN or NATS_TEST_DOCKER=1");
    const directory = await mkdtemp(join(tmpdir(), "easy-sync-recovery-"));
    const serverPort = await port();
    const url = `nats://127.0.0.1:${serverPort}`;
    let server: ChildProcess | undefined;
    let containerCreated = false;
    let containerRunning = false;
    const containerName = `easy-sync-test-${crypto.randomUUID()}`;
    const connections: NatsConnection[] = [];
    const engines: MarkdownSyncEngine[] = [];
    const stores: LocalStore[] = [];

    async function launch(): Promise<NatsConnection> {
      if (docker) {
        if (containerCreated) execFileSync("docker", ["start", containerName]);
        else {
          execFileSync("docker", ["run", "-d", "--name", containerName,
            "-p", `127.0.0.1:${serverPort}:4222`, "-v", `${containerName}-data:/data`,
            "nats:2.15.0", "-js", "-sd", "/data"]);
          containerCreated = true;
        }
        containerRunning = true;
      } else {
        server = spawn(executable!, ["--jetstream", "--store_dir", directory, "--port", String(serverPort)], { stdio: "ignore" });
      }
      for (let i = 0; i < 100; i++) {
        try {
          const nc = await connect({ servers: url, maxReconnectAttempts: 0 });
          connections.push(nc);
          return nc;
        } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      throw new Error("NATS server did not start");
    }

    async function shutdown(): Promise<void> {
      if (docker) {
        if (containerRunning) execFileSync("docker", ["stop", containerName]);
        containerRunning = false;
        return;
      }
      const process = server;
      if (!process) return;
      server = undefined;
      if (process.exitCode === null) {
        process.kill("SIGTERM");
        await new Promise<void>((resolve) => process.once("exit", () => resolve()));
      }
    }

    async function replica(deviceId: string, vault: VaultDouble, store: LocalStore) {
      const connection = await connect({ servers: url, maxReconnectAttempts: 0 });
      connections.push(connection);
      const bucket = await new Kvm(connection).open("OBS_RECOVERY_FILES");
      const engine = new MarkdownSyncEngine({
        deviceId, vault, store, kv: new NatsKvAdapter(bucket, connection),
        status: new SyncStatus(), debounceMs: 5,
      });
      engines.push(engine);
      await engine.start();
      return { engine, connection };
    }

    try {
      const admin = await launch();
      await new Kvm(admin).create("OBS_RECOVERY_FILES", { history: 10 });
      const aVault = new VaultDouble();
      aVault.write("bootstrap.md", bytes("initial"));
      const aStore = await LocalStore.open(`recovery-a-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
      stores.push(aStore);
      const a = await replica("device-a", aVault, aStore);
      const bVault = new VaultDouble();
      const bStore = await LocalStore.open(`recovery-b-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
      stores.push(bStore);
      const b = await replica("device-b", bVault, bStore);
      expect(text(bVault, "bootstrap.md")).toBe("initial");

      await shutdown();
      aVault.write("bootstrap.md", bytes("edited offline"));
      await eventually(async () => (await aStore.pending()).some((op) => op.content === "edited offline"));
      a.engine.stop(); b.engine.stop();
      await a.connection.close(); await b.connection.close(); await admin.close();
      expect(text(aVault, "bootstrap.md")).toBe("edited offline");

      await launch();
      const resumed = await replica("device-a", aVault, aStore);
      expect(await aStore.pending()).toEqual([]);
      const freshVault = new VaultDouble();
      const freshStore = await LocalStore.open(`recovery-fresh-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
      stores.push(freshStore);
      await replica("device-fresh", freshVault, freshStore);
      expect(text(freshVault, "bootstrap.md")).toBe("edited offline");
      const existingVault = new VaultDouble();
      existingVault.write("bootstrap.md", bytes("different local"));
      const existingStore = await LocalStore.open(`recovery-existing-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
      stores.push(existingStore);
      await replica("device-existing", existingVault, existingStore);
      expect(text(existingVault, "bootstrap.md")).toBe("edited offline");
      const fileId = (await aStore.getFileByPath("bootstrap.md"))!.fileId;
      expect(text(existingVault, `bootstrap.conflict-device-existing-${fileId}.md`)).toBe("different local");
      expect((await resumed.engine.reconcile(), await aStore.pending())).toEqual([]);
      aVault.write("bootstrap.md", bytes("first rapid edit"));
      await new Promise((resolve) => setTimeout(resolve, 15));
      aVault.write("bootstrap.md", bytes("second rapid edit"));
      await eventually(() => text(freshVault, "bootstrap.md") === "second rapid edit");
      expect(text(aVault, "bootstrap.md")).toBe("second rapid edit");
      await eventually(async () => (await aStore.pending()).length === 0);
      const kv = await new Kvm(resumed.connection).open("OBS_RECOVERY_FILES");
      const settledRevision = (await kv.get(`f.${fileId}`))!.revision;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await kv.get(`f.${fileId}`))!.revision).toBe(settledRevision);
      expect(text(aVault, "bootstrap.md")).toBe("second rapid edit");
    } finally {
      for (const engine of engines) engine.stop();
      for (const connection of connections) await connection.close();
      for (const store of stores) store.close();
      await shutdown();
      if (containerCreated) {
        execFileSync("docker", ["rm", "-f", containerName]);
        execFileSync("docker", ["volume", "rm", `${containerName}-data`]);
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
