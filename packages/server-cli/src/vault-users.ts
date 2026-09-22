import { generateVaultCredential, type NatsCredential, type RandomBytes } from "./credentials.js";
import { vaultBucketName, type AdministratorCredentials } from "./vault-admin.js";

export interface ManagedVaultUser {
  vaultId: string;
  username: string;
  passwordHash: string;
}

export interface ManagedAdministrator {
  username: "fos-admin";
  passwordHash: string;
}

export interface ManagedAuthorization {
  administrator: ManagedAdministrator;
  users: readonly ManagedVaultUser[];
}

export interface VaultUserAdapter {
  authenticate(credentials: AdministratorCredentials): Promise<boolean>;
  readAuthorization(): Promise<ManagedAuthorization>;
  validate(renderedAuthorization: string): Promise<void>;
  write(renderedAuthorization: string): Promise<void>;
  reload(): Promise<void>;
  restore(renderedAuthorization: string): Promise<void>;
}

export interface VaultUserResult {
  created: boolean;
  user: ManagedVaultUser;
  credential?: NatsCredential;
}

const vaultIdPattern = /^[A-Za-z0-9_-]+$/;

function requireVaultId(vaultId: string): void {
  if (!vaultIdPattern.test(vaultId)) throw new Error("VAULT_ID_REQUIRED");
}

async function requireAdministrator(adapter: VaultUserAdapter, credentials: AdministratorCredentials): Promise<void> {
  if (credentials.username !== "fos-admin" || !credentials.password || !await adapter.authenticate(credentials)) {
    throw new Error("ADMIN_AUTH_REQUIRED");
  }
}

function scopedUser(user: ManagedVaultUser): string {
  const bucket = vaultBucketName(user.vaultId);
  const stream = `KV_${bucket}`;
  return `    { user: "${user.username}", password: "${user.passwordHash}"
      permissions: {
        publish: { allow: [
          "$KV.${bucket}.>",
          "$JS.API.STREAM.INFO.${stream}",
          "$JS.API.DIRECT.GET.${stream}",
          "$JS.API.STREAM.MSG.GET.${stream}",
          "$JS.API.CONSUMER.CREATE.${stream}.>",
          "$JS.API.CONSUMER.INFO.${stream}.>",
          "$JS.API.CONSUMER.DELETE.${stream}.>",
          "$JS.API.CONSUMER.MSG.NEXT.${stream}.>"
        ] }
        subscribe: { allow: ["_INBOX.>", "$KV.${bucket}.>"] }
      }
    }`;
}

/** Renders only bcrypt hashes; plaintext passwords never enter managed configuration. */
export function renderManagedAuthorization(authorization: ManagedAuthorization): string {
  return `# fos-managed-authorization:start\nauthorization {\n  users: [\n    { user: "${authorization.administrator.username}", password: "${authorization.administrator.passwordHash}" },\n${authorization.users.map(scopedUser).join(",\n")}\n  ]\n}\n# fos-managed-authorization:end\n`;
}

async function updateUsers(adapter: VaultUserAdapter, before: ManagedAuthorization, users: readonly ManagedVaultUser[]): Promise<void> {
  const previous = renderManagedAuthorization(before);
  const next = renderManagedAuthorization({ ...before, users });
  await adapter.validate(next);
  try {
    await adapter.write(next);
    await adapter.reload();
  } catch (error) {
    await adapter.restore(previous).catch(() => {});
    throw error;
  }
}

function existingFor(users: readonly ManagedVaultUser[], vaultId: string): ManagedVaultUser | undefined {
  const user = users.find((item) => item.vaultId === vaultId);
  if (user && user.username !== `fos-vault-${vaultId}`) throw new Error("VAULT_USER_COLLISION");
  return user;
}

export async function addVaultUser(adapter: VaultUserAdapter, administrator: AdministratorCredentials, vaultId: string,
  randomBytes: RandomBytes): Promise<VaultUserResult> {
  await requireAdministrator(adapter, administrator);
  requireVaultId(vaultId);
  const before = await adapter.readAuthorization();
  const existing = existingFor(before.users, vaultId);
  if (existing) return { created: false, user: existing };
  const credential = generateVaultCredential(vaultId, randomBytes);
  const user = { vaultId, username: credential.username, passwordHash: credential.passwordHash };
  await updateUsers(adapter, before, [...before.users, user]);
  return { created: true, user, credential };
}

export async function rotateVaultUser(adapter: VaultUserAdapter, administrator: AdministratorCredentials, vaultId: string,
  randomBytes: RandomBytes): Promise<{ user: ManagedVaultUser; credential: NatsCredential }> {
  await requireAdministrator(adapter, administrator);
  requireVaultId(vaultId);
  const before = await adapter.readAuthorization();
  const existing = existingFor(before.users, vaultId);
  if (!existing) throw new Error("VAULT_USER_NOT_FOUND");
  const credential = generateVaultCredential(vaultId, randomBytes);
  const user = { vaultId, username: credential.username, passwordHash: credential.passwordHash };
  await updateUsers(adapter, before, before.users.map((item) => item.vaultId === vaultId ? user : item));
  return { user, credential };
}

export async function revokeVaultUser(adapter: VaultUserAdapter, administrator: AdministratorCredentials, vaultId: string): Promise<void> {
  await requireAdministrator(adapter, administrator);
  requireVaultId(vaultId);
  const before = await adapter.readAuthorization();
  if (!existingFor(before.users, vaultId)) throw new Error("VAULT_USER_NOT_FOUND");
  await updateUsers(adapter, before, before.users.filter((item) => item.vaultId !== vaultId));
}
