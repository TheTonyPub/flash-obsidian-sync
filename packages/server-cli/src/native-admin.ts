import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import type { AdministratorCredentials, VaultAdminAdapter, VaultBucket } from "./vault-admin.js";
import type { VaultCredentials, VaultVerificationAdapter } from "./vault-verify.js";

const server = "nats://127.0.0.1:4222";

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

function isAuthenticationFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && /authorization violation|authentication failed/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function crossBucketDenied(kvm: Kvm, peerBucket: string): Promise<boolean> {
  try { await (await kvm.open(peerBucket)).status(); }
  catch (error) {
    if (isPermissionViolation(error)) return true;
    throw new Error("VAULT_CROSS_BUCKET_PROBE_FAILED", { cause: error });
  }
  return false;
}

/** Native-only NATS KV administrative adapter; credentials stay in process memory. */
export function createNativeVaultAdminAdapter(administrator: AdministratorCredentials): VaultAdminAdapter {
  let authenticated = false;
  const connection = async () => connect({ servers: server, user: administrator.username, pass: administrator.password, maxReconnectAttempts: 0 });
  return {
    authenticate: async (credentials) => {
      if (credentials.username !== administrator.username || credentials.password !== administrator.password) return false;
      try { const nc = await connection(); await nc.close(); authenticated = true; return true; }
      catch { return false; }
    },
    listBuckets: async () => {
      if (!authenticated) throw new Error("ADMIN_AUTH_REQUIRED");
      const nc = await connection();
      try {
        const result: VaultBucket[] = [];
        for await (const status of new Kvm(nc).list()) {
          const vaultId = status.bucket.startsWith("OBS_") && status.bucket.endsWith("_FILES") ? status.bucket.slice(4, -6) : "";
          if (vaultId) result.push({ name: status.bucket, vaultId, storage: "file", history: 10, replicas: 1 });
        }
        return result;
      } finally { await nc.close(); }
    },
    createBucket: async (bucket) => {
      if (!authenticated) throw new Error("ADMIN_AUTH_REQUIRED");
      const nc = await connection();
      try { await new Kvm(nc).create(bucket.name, { storage: "file", history: bucket.history, replicas: bucket.replicas }); }
      finally { await nc.close(); }
    },
  };
}

/** Native scoped-user verifier. The probe bucket is deliberately not provisioned. */
export function createNativeVaultVerificationAdapter(credentials: VaultCredentials): VaultVerificationAdapter {
  const connection = async () => connect({ servers: server, user: credentials.username, pass: credentials.password, maxReconnectAttempts: 0 });
  const withKv = async <T>(operation: (kvm: Kvm) => Promise<T>): Promise<T> => {
    const nc = await connection();
    try { return await operation(new Kvm(nc)); }
    finally { await nc.close(); }
  };
  return {
    authenticate: async (candidate) => {
      if (candidate.username !== credentials.username || candidate.password !== credentials.password) return false;
      try { const nc = await connection(); await nc.close(); return true; }
      catch (error) { if (isAuthenticationFailure(error)) return false; throw error; }
    },
    status: (bucket) => withKv(async (kvm) => { await (await kvm.open(bucket)).status(); }),
    put: (bucket, key, value) => withKv(async (kvm) => { await (await kvm.open(bucket)).put(key, value); }),
    get: (bucket, key) => withKv(async (kvm) => (await (await kvm.open(bucket)).get(key))?.value),
    watch: async (bucket, key) => {
      const nc = await connection();
      try {
        const watch = await (await new Kvm(nc).open(bucket)).watch({ key });
        return () => { watch.stop(); void nc.close(); };
      } catch (error) { await nc.close(); throw error; }
    },
    crossBucketDenied: (peerBucket) => withKv((kvm) => crossBucketDenied(kvm, peerBucket)),
  };
}
