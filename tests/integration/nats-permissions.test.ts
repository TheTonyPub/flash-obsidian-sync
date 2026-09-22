import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";

const buckets = ["OBS_VAULT_A_FILES", "OBS_VAULT_B_FILES"] as const;
const api = (bucket: string) => [
  `$JS.API.STREAM.INFO.KV_${bucket}`,
  `$JS.API.DIRECT.GET.KV_${bucket}`,
  `$JS.API.STREAM.MSG.GET.KV_${bucket}`,
  `$JS.API.CONSUMER.CREATE.KV_${bucket}.>`,
  `$JS.API.CONSUMER.INFO.KV_${bucket}.>`,
  `$JS.API.CONSUMER.DELETE.KV_${bucket}.>`,
  `$JS.API.CONSUMER.MSG.NEXT.KV_${bucket}.>`,
];
const quoted = (subjects: string[]) => subjects.map((subject) => JSON.stringify(subject)).join(", ");
const user = (name: string, password: string, bucket: string) => `{
  user: ${JSON.stringify(name)}, password: ${JSON.stringify(password)},
  permissions: {
    publish: { allow: [${quoted([`$KV.${bucket}.>`, ...api(bucket)])}] },
    subscribe: { allow: ["_INBOX.>", ${JSON.stringify(`$KV.${bucket}.>`)}] }
  }
}`;

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

it("on pinned NATS 2.15.0, isolates two vault KV buckets and rejects absent, wrong, and revoked credentials", async () => {
  const executable = process.env.NATS_SERVER_BIN;
  if (!executable) throw new Error("Set NATS_SERVER_BIN to the disposable test nats-server binary");
  expect(execFileSync(executable, ["--version"], { encoding: "utf8" })).toContain("v2.15.0");
  const directory = await mkdtemp(join(tmpdir(), "easy-sync-permissions-"));
  const config = join(directory, "nats.conf");
  const port = await freePort();
  const render = (includeA: boolean) => `listen: "127.0.0.1:${port}"
jetstream { store_dir: ${JSON.stringify(join(directory, "store"))} }
authorization {
  users: [
    { user: "admin", password: "admin-pass" },
    ${includeA ? `${user("vault-a", "vault-a-pass", buckets[0])},` : ""}
    ${user("vault-b", "vault-b-pass", buckets[1])}
  ]
}`;
  await writeFile(config, render(true));
  const server = spawn(executable, ["-c", config], { stdio: "ignore" });
  cleanups.push(async () => {
    server.kill("SIGTERM");
    if (server.exitCode === null) await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `nats://127.0.0.1:${port}`;
  const open = (user?: string, pass?: string) => connect({ servers: url, user, pass, maxReconnectAttempts: 0, timeout: 250 });
  let admin;
  for (let i = 0; i < 100; i++) {
    try { admin = await open("admin", "admin-pass"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  if (!admin) throw new Error("NATS server did not start");
  cleanups.push(() => admin.close());
  for (const bucket of buckets) await new Kvm(admin).create(bucket, { history: 10 });
  for (const bucket of buckets) await (await new Kvm(admin).open(bucket)).put("f.seed", new TextEncoder().encode(bucket));

  await expect(open()).rejects.toThrow();
  await expect(open("vault-a", "wrong-pass")).rejects.toThrow();

  for (const [name, pass, bucket] of [
    ["vault-a", "vault-a-pass", buckets[0]],
    ["vault-b", "vault-b-pass", buckets[1]],
  ] as const) {
    const connection = await open(name, pass);
    cleanups.push(() => connection.close());
    const kv = await new Kvm(connection).open(bucket);
    expect((await kv.status()).bucket).toBe(bucket);
    const keys: string[] = [];
    for await (const key of await kv.keys()) keys.push(key);
    expect(keys).toContain("f.seed");
    const watch = await kv.watch({ key: "f.test" });
    const next = (async () => { for await (const entry of watch) return entry; throw new Error("watch closed"); })();
    const payload = new TextEncoder().encode(name);
    await kv.put("f.test", payload);
    expect(new TextDecoder().decode((await kv.get("f.test"))?.value)).toBe(name);
    const event = await Promise.race([next, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("watch timed out")), 2000))]);
    expect(event.key).toBe("f.test");
    const revision = await kv.create("f.new", payload);
    await kv.update("f.new", payload, revision);
    watch.stop();
    const other = await new Kvm(connection).open(bucket === buckets[0] ? buckets[1] : buckets[0]);
    await expect(other.put("f.test", payload)).rejects.toThrow();
    const crossRead = await other.get("f.test").catch(() => null);
    expect(crossRead).toBeNull();
    await expect(other.watch({ key: "f.seed" })).rejects.toThrow();
  }

  await writeFile(config, render(false));
  server.kill("SIGHUP");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expect(open("vault-a", "vault-a-pass")).rejects.toThrow();
  const unaffected = await open("vault-b", "vault-b-pass");
  await unaffected.close();
});
