import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { NatsKvAdapter } from "../../packages/plugin/src/connection.js";

const executable = process.env.NATS_SERVER_BIN;
const externalUrl = process.env.NATS_TEST_URL;

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
  throw new Error("NATS snapshot session timed out");
}

async function withAdapter(run: (adapter: NatsKvAdapter, kv: Awaited<ReturnType<Kvm["open"]>>, url: string, bucket: string) => Promise<void>) {
  if (!externalUrl && !executable) throw new Error("Set NATS_SERVER_BIN or NATS_TEST_URL to a disposable NATS 2.15.0 instance");
  const directory = await mkdtemp(join(tmpdir(), "easy-sync-snapshot-"));
  let server: ReturnType<typeof spawn> | undefined;
  const connections: Array<Awaited<ReturnType<typeof connect>>> = [];
  try {
    const port = externalUrl ? 0 : await freePort();
    const url = externalUrl ?? `nats://127.0.0.1:${port}`;
    if (!externalUrl) server = spawn(executable!, ["--jetstream", "--store_dir", directory, "--port", String(port)], { stdio: "ignore" });
    let admin: Awaited<ReturnType<typeof connect>> | undefined;
    for (let i = 0; i < 100; i++) {
      try { admin = await connect({ servers: url, maxReconnectAttempts: 0 }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    if (!admin) throw new Error("NATS server did not start");
    connections.push(admin);
    const bucket = `OBS_SNAPSHOT_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_FILES`;
    const kv = await new Kvm(admin).create(bucket, { history: 10 });
    const connection = await connect({ servers: url });
    connections.push(connection);
    await run(new NatsKvAdapter(kv, connection, 0, undefined, bucket), kv, url, bucket);
  } finally {
    for (const connection of connections.reverse()) await connection.close();
    if (server) {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const integration = describe.skipIf(!externalUrl && !executable);

integration("NATS KV snapshot session", () => {
  it("emits current values and tombstones, continues live, and deletes its ephemeral consumer", async () => {
    await withAdapter(async (adapter, kv, _url, bucket) => {
      const liveValue = new TextEncoder().encode("current value");
      const tombstoneValue = new TextEncoder().encode(JSON.stringify({ deleted: true }));
      await kv.put("f.live", liveValue);
      await kv.put("f.deleted", tombstoneValue);

      const session = await adapter.openSnapshotSession();
      expect(session.initialCount).toBe(2);
      const snapshot = [];
      for await (const entry of session.snapshot) snapshot.push(entry);
      await session.snapshotComplete;
      expect(snapshot).toHaveLength(2);
      expect(new Map(snapshot.map((entry) => [entry.key, new TextDecoder().decode(entry.value)]))).toEqual(
        new Map([["f.live", "current value"], ["f.deleted", JSON.stringify({ deleted: true })]]),
      );

      const entries = session.entries[Symbol.asyncIterator]();
      const initial = [await entries.next(), await entries.next()];
      expect(initial.every((entry) => !entry.done)).toBe(true);
      await kv.put("f.live", new TextEncoder().encode("new revision"));
      const next = await entries.next();
      expect(next.done).toBe(false);
      expect(next.value?.key).toBe("f.live");
      expect(new TextDecoder().decode(next.value!.value)).toBe("new revision");
      expect(next.value!.revision).toBeGreaterThan(snapshot.find((entry) => entry.key === "f.live")!.revision);

      const managerConnection = await connect({ servers: _url });
      const manager = await jetstreamManager(managerConnection);
      const consumerInfos = async () => {
        const infos = [];
        for await (const info of await manager.consumers.list(`KV_${bucket}`)) infos.push(info);
        return infos;
      };
      const [consumerInfo] = await consumerInfos();
      expect(consumerInfo?.config.filter_subject).toBe(`$KV.${bucket}.f.>`);
      expect(consumerInfo?.config.deliver_subject).toBeUndefined();
      await session.stop();
      await eventually(async () => (await consumerInfos()).length === 0);
      await managerConnection.close();
    });
  }, 15000);

  it("completes an empty snapshot immediately and keeps delivering through the same session", async () => {
    await withAdapter(async (adapter, kv, _url, bucket) => {
      const session = await adapter.openSnapshotSession();
      expect(session.initialCount).toBe(0);
      await Promise.race([
        session.snapshotComplete,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Empty snapshot did not complete")), 1000)),
      ]);
      const entries = session.entries[Symbol.asyncIterator]();
      await kv.put("f.first", new TextEncoder().encode("after snapshot"));
      const next = await entries.next();
      expect(next.done).toBe(false);
      expect(next.value?.key).toBe("f.first");
      expect(new TextDecoder().decode(next.value!.value)).toBe("after snapshot");
      await session.stop();

      const managerConnection = await connect({ servers: _url });
      const manager = await jetstreamManager(managerConnection);
      const names: string[] = [];
      for await (const info of await manager.consumers.list(`KV_${bucket}`)) names.push(info.name);
      expect(names).toEqual([]);
      await managerConnection.close();
    });
  }, 15000);
});
