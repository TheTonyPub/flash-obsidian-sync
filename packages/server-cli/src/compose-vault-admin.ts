import { runComposeAdminWorker, type ComposeAdminRuntime, type ComposeWorkerRequest } from "./compose-admin.js";
import { vaultBucketName, type AdministratorCredentials, type VaultAdminAdapter } from "./vault-admin.js";
import type { VaultCredentials, VaultVerificationAdapter } from "./vault-verify.js";

function parse<T>(output: string): T {
  try { return JSON.parse(output) as T; }
  catch { throw new Error("COMPOSE_ADMIN_INVALID_OUTPUT"); }
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

/** Compose admin client. Password travels only through the one-shot container stdin. */
export function createComposeVaultAdminAdapter(runtime: ComposeAdminRuntime, workerPath: string, administrator: AdministratorCredentials): VaultAdminAdapter {
  let authenticated = false;
  const execute = (action: ComposeWorkerRequest["action"], vaultId?: string) => runComposeAdminWorker(runtime, "flash-osidian-sync", workerPath,
    { action, username: administrator.username, password: administrator.password, vaultId });
  return {
    authenticate: async (candidate) => {
      if (candidate.username !== administrator.username || candidate.password !== administrator.password) return false;
      try { await execute("list"); authenticated = true; return true; }
      catch { return false; }
    },
    listBuckets: async () => {
      if (!authenticated) throw new Error("ADMIN_AUTH_REQUIRED");
      return parse<string[]>(await execute("list")).filter((name) => name.startsWith("OBS_") && name.endsWith("_FILES"))
        .map((name) => ({ name, vaultId: name.slice(4, -6), storage: "file", history: 10, replicas: 1 }));
    },
    createBucket: async (bucket) => {
      if (!authenticated || bucket.name !== vaultBucketName(bucket.vaultId)) throw new Error("ADMIN_AUTH_REQUIRED");
      await execute("create", bucket.vaultId);
    },
  };
}

/** The worker performs the scoped read/write/watch/status/cross-bucket probe atomically. */
export function createComposeVaultVerificationAdapter(runtime: ComposeAdminRuntime, workerPath: string, credentials: VaultCredentials, crossVaultId?: string): VaultVerificationAdapter {
  let verified = false;
  let crossBucket: "not-tested" | "denied" | undefined;
  const execute = () => runComposeAdminWorker(runtime, "flash-osidian-sync", workerPath,
    { action: "verify", username: credentials.username, password: credentials.password, vaultId: credentials.username.slice("fos-vault-".length), crossVaultId });
  return {
    authenticate: async (candidate) => {
      if (candidate.username !== credentials.username || candidate.password !== credentials.password) return false;
      try {
        const result = parse<{ crossBucket: "not-tested" | "denied" }>(await execute());
        if (result.crossBucket !== "not-tested" && result.crossBucket !== "denied") throw new Error("COMPOSE_ADMIN_INVALID_OUTPUT");
        crossBucket = result.crossBucket;
        verified = true;
        return true;
      }
      catch (error) { if (isAuthenticationFailure(error)) return false; throw error; }
    },
    status: async () => { if (!verified) throw new Error("VAULT_AUTH_REQUIRED"); },
    put: async () => { if (!verified) throw new Error("VAULT_AUTH_REQUIRED"); },
    get: async () => verified ? new TextEncoder().encode("fos-verify") : undefined,
    watch: async () => () => {},
    crossBucketDenied: async () => verified && crossBucket === "denied",
  };
}
