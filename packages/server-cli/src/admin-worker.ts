import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";

type Request = { action: "create" | "list" | "inspect" | "verify"; username: string; password: string; vaultId?: string; crossVaultId?: string };
const bucket = (vaultId: string) => `OBS_${vaultId}_FILES`;

function isPermissionViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && /permissions?\s+violation/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function crossBucketDenied(kvm: Kvm, peerVaultId: string): Promise<boolean> {
  try { await (await kvm.open(bucket(peerVaultId))).status(); }
  catch (error) {
    if (isPermissionViolation(error)) return true;
    throw new Error("VAULT_CROSS_BUCKET_PROBE_FAILED", { cause: error });
  }
  return false;
}

const input = await new Promise<string>((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => { value += chunk; });
  process.stdin.once("end", () => resolve(value));
  process.stdin.once("error", reject);
});
const request = JSON.parse(input) as Request;
const nc = await connect({ servers: "nats://nats:4222", user: request.username, pass: request.password, maxReconnectAttempts: 0 });
try {
  const kvm = new Kvm(nc);
  if (request.action === "list") { const values: string[] = []; for await (const status of kvm.list()) values.push(status.bucket); process.stdout.write(`${JSON.stringify(values)}\n`); }
  else if (request.action === "create" && request.vaultId) { await kvm.create(bucket(request.vaultId), { storage: "file", history: 10, replicas: 1 }); process.stdout.write("{}\n"); }
  else if (request.action === "inspect" && request.vaultId) { process.stdout.write(`${JSON.stringify(await (await kvm.open(bucket(request.vaultId))).status())}\n`); }
  else if (request.action === "verify" && request.vaultId) {
    const kv = await kvm.open(bucket(request.vaultId));
    await kv.status();
    const key = `f.__fos_verify_${crypto.randomUUID()}`;
    const value = new TextEncoder().encode("fos-verify");
    const watch = await kv.watch({ key });
    let read: Awaited<ReturnType<typeof kv.get>>;
    try {
      await kv.put(key, value);
      read = await kv.get(key);
    }
    finally { watch.stop(); }
    if (new TextDecoder().decode(read?.value) !== "fos-verify") throw new Error("VAULT_READ_VERIFY_FAILED");
    const crossBucket = request.crossVaultId === undefined ? "not-tested"
      : await crossBucketDenied(kvm, request.crossVaultId) ? "denied" : "accessible";
    if (crossBucket === "accessible") throw new Error("VAULT_CROSS_BUCKET_ACCESS");
    process.stdout.write(`${JSON.stringify({ crossBucket })}\n`);
  }
  else throw new Error("ADMIN_REQUEST_INVALID");
} finally { await nc.close(); }
