/** Administrator-gated, data-preserving NATS KV bucket administration. */

export interface AdministratorCredentials {
  username: string;
  password: string;
}

export interface VaultBucket {
  name: string;
  /** Original, case-sensitive vault identifier recorded with the bucket. */
  vaultId: string;
  storage: "file";
  history: 10;
  replicas: 1;
}

export interface VaultAdminAdapter {
  authenticate(credentials: AdministratorCredentials): Promise<boolean>;
  listBuckets(): Promise<readonly VaultBucket[]>;
  createBucket(bucket: VaultBucket): Promise<void>;
}

export interface VaultCreateResult {
  created: boolean;
  bucket: VaultBucket;
}

const vaultIdPattern = /^[A-Za-z0-9_-]+$/;

export function vaultBucketName(vaultId: string): string {
  return `OBS_${vaultId}_FILES`;
}

function requireVaultId(vaultId: string): void {
  if (!vaultIdPattern.test(vaultId)) throw new Error("VAULT_ID_REQUIRED");
}

async function requireAdministrator(adapter: VaultAdminAdapter, credentials: AdministratorCredentials): Promise<void> {
  if (credentials.username !== "fos-admin" || !credentials.password || !await adapter.authenticate(credentials)) {
    throw new Error("ADMIN_AUTH_REQUIRED");
  }
}

function requestedBucket(vaultId: string): VaultBucket {
  return { name: vaultBucketName(vaultId), vaultId, storage: "file", history: 10, replicas: 1 };
}

function matchExisting(vaultId: string, buckets: readonly VaultBucket[]): VaultBucket | undefined {
  const existing = buckets.find((bucket) => bucket.name === vaultBucketName(vaultId));
  if (existing && existing.vaultId !== vaultId) throw new Error("VAULT_ID_COLLISION");
  return existing;
}

/** Creates only a missing bucket. Existing bucket settings and JetStream data are never modified. */
export async function createVault(adapter: VaultAdminAdapter, administrator: AdministratorCredentials, vaultId: string): Promise<VaultCreateResult> {
  await requireAdministrator(adapter, administrator);
  requireVaultId(vaultId);
  const existing = matchExisting(vaultId, await adapter.listBuckets());
  if (existing) return { created: false, bucket: existing };
  const bucket = requestedBucket(vaultId);
  await adapter.createBucket(bucket);
  return { created: true, bucket };
}

export async function listVaults(adapter: VaultAdminAdapter, administrator: AdministratorCredentials): Promise<readonly VaultBucket[]> {
  await requireAdministrator(adapter, administrator);
  return adapter.listBuckets();
}

export async function inspectVault(adapter: VaultAdminAdapter, administrator: AdministratorCredentials, vaultId: string): Promise<VaultBucket | undefined> {
  await requireAdministrator(adapter, administrator);
  requireVaultId(vaultId);
  return matchExisting(vaultId, await adapter.listBuckets());
}
