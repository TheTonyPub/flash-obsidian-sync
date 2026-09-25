import { describe, expect, it } from "vitest";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/nats-core";
import { SecretStorageDouble, NatsKvDouble } from "../doubles/index.js";
import { indexedDBDouble } from "../doubles/index.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { connectVault, NatsKvAdapter, SyncStatus, type VaultConnectionConfig } from "../../packages/plugin/src/connection.js";

const config = (vaultId: string): VaultConnectionConfig => ({
  vaultId,
  bucket: `OBS_${vaultId}_FILES`,
  server: "wss://nats.example.test:443",
  username: `user-${vaultId}`,
  passwordSecretKey: `nats-${vaultId}`,
});

describe("NATS connection", () => {
  it("lists KV values with bounded concurrency and preserves key order", async () => {
    const keys = Array.from({ length: 12 }, (_, index) => `f.${index}`);
    let active = 0;
    let peak = 0;
    const kv = {
      keys: async () => (async function* () { for (const key of keys) yield key; })(),
      get: async (key: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        const index = Number(key.slice(2));
        return index === 3 ? null : { value: new Uint8Array([index]), revision: index + 1 };
      },
    } as unknown as KV;
    const adapter = new NatsKvAdapter(kv, {} as NatsConnection);

    const listed = await adapter.list();

    expect(listed.map((entry) => entry.key)).toEqual(keys.filter((key) => key !== "f.3"));
    expect(peak).toBe(8);
  });

  it("reads password from SecretStorage and opens only configured bucket", async () => {
    const secrets = new SecretStorageDouble();
    await secrets.setSecret("nats-A", "strong-a");
    const kv = new NatsKvDouble();
    const opened: string[] = [];
    const status = new SyncStatus();
    const remote = await connectVault(config("A"), secrets, async (options, bucket) => {
      expect(options).toEqual({ servers: "wss://nats.example.test:443", user: "user-A", pass: "strong-a" });
      opened.push(bucket);
      return kv;
    }, status);
    const revision = await remote.put("f.file-1", new Uint8Array([1]));
    expect((await remote.get("f.file-1"))?.revision).toBe(revision);
    const seen: number[] = [];
    const stop = await remote.watch((entry) => seen.push(entry.revision));
    await remote.put("f.file-2", new Uint8Array([2]));
    expect(seen).toHaveLength(1);
    stop();
    expect(opened).toEqual(["OBS_A_FILES"]);
    expect(status.value).not.toBe("SYNCED");
  });

  it("rejects insecure URL and missing credentials without opening KV", async () => {
    const secrets = new SecretStorageDouble();
    const status = new SyncStatus();
    const connector = () => { throw new Error("must not connect"); };
    await expect(connectVault({ ...config("A"), server: "ws://localhost" }, secrets, connector, status)).rejects.toThrow(/WSS/);
    await expect(connectVault(config("A"), secrets, connector, status)).rejects.toThrow(/password/);
    expect(status.value).toBe("AUTH_ERROR");
    expect(status.connectionState).toBe("AUTH_ERROR");
    expect(status.connectionError).toMatch(/password missing/);
  });

  it("retains pending work after rejected or revoked credentials", async () => {
    const secrets = new SecretStorageDouble();
    await secrets.setSecret("nats-A", "revoked");
    const store = await LocalStore.open(`auth-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
    await store.queue({
      operationId: "op-1", fileId: "file-1", type: "modify", path: "note.md",
      localHash: "hash", content: "draft", retryCount: 0, createdAt: 1,
    });
    const status = new SyncStatus();
    await expect(connectVault(config("A"), secrets, async () => { throw new Error("Authorization Violation"); }, status)).rejects.toThrow();
    expect(status.value).toBe("AUTH_ERROR");
    expect((await store.pending()).map((item) => item.operationId)).toEqual(["op-1"]);
    store.close();
  });

  it("keeps vault users in separate buckets", async () => {
    const secrets = new SecretStorageDouble();
    await secrets.setSecret("nats-A", "a");
    await secrets.setSecret("nats-B", "b");
    const buckets = new Map([["OBS_A_FILES", new NatsKvDouble()], ["OBS_B_FILES", new NatsKvDouble()]]);
    const connector = async (options: { user: string; pass: string }, bucket: string) => {
      if (options.user !== `user-${bucket.split("_")[1]}` || options.pass !== bucket.split("_")[1].toLowerCase()) {
        throw new Error("Authorization Violation");
      }
      return buckets.get(bucket)!;
    };
    const a = await connectVault(config("A"), secrets, connector, new SyncStatus());
    const b = await connectVault(config("B"), secrets, connector, new SyncStatus());
    await a.put("f.shared", new Uint8Array([1]));
    expect(await b.get("f.shared")).toBeNull();
    await expect(connector({ user: "user-A", pass: "a" }, "OBS_B_FILES")).rejects.toThrow(/Authorization/);
  });
});
