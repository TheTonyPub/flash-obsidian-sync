import { vaultBucketName } from "./vault-admin.js";

export interface VaultCredentials { username: string; password: string; }

export interface VaultVerificationAdapter {
  authenticate(credentials: VaultCredentials): Promise<boolean>;
  status(bucket: string): Promise<void>;
  put(bucket: string, key: string, value: Uint8Array): Promise<void>;
  get(bucket: string, key: string): Promise<Uint8Array | undefined>;
  watch(bucket: string, key: string): Promise<() => void>;
  crossBucketDenied(peerBucket: string): Promise<boolean>;
}

/** Verifies the scoped operations required by the plugin without modifying user data. */
export async function verifyVault(adapter: VaultVerificationAdapter, vaultId: string, credentials: VaultCredentials, crossVaultId?: string): Promise<{
  ownBucket: true;
  crossBucket: "not-tested" | "denied";
}> {
  if (!credentials.password || credentials.username !== `fos-vault-${vaultId}` || !await adapter.authenticate(credentials)) {
    throw new Error("VAULT_AUTH_REQUIRED");
  }
  if (crossVaultId !== undefined && (!/^[A-Za-z0-9_-]+$/.test(crossVaultId) || crossVaultId === vaultId)) throw new Error("CROSS_VAULT_ID_INVALID");
  const bucket = vaultBucketName(vaultId);
  const key = `f.__fos_verify_${crypto.randomUUID()}`;
  const value = new TextEncoder().encode("fos-verify");
  await adapter.status(bucket);
  const stop = await adapter.watch(bucket, key);
  try {
    await adapter.put(bucket, key, value);
    const read = await adapter.get(bucket, key);
    if (!read || new TextDecoder().decode(read) !== "fos-verify") throw new Error("VAULT_READ_VERIFY_FAILED");
  } finally { stop(); }
  if (crossVaultId === undefined) return { ownBucket: true, crossBucket: "not-tested" };
  if (!await adapter.crossBucketDenied(vaultBucketName(crossVaultId))) throw new Error("VAULT_CROSS_BUCKET_ACCESS");
  return { ownBucket: true, crossBucket: "denied" };
}
