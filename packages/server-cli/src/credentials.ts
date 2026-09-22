import { randomBytes as nodeRandomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const PASSWORD_BYTES = 32;
const BCRYPT_COST = 12;

export interface NatsCredential {
  username: string;
  password: string;
  passwordHash: string;
}

export interface BootstrapCredentials {
  administrator: NatsCredential;
  vault: NatsCredential;
}

export interface SecretOutputAdapter {
  writeFileAtomically(path: string, contents: string, options: { owner: 0; mode: 0o600 }): Promise<void>;
}

export type RandomBytes = (size: number) => Uint8Array;

function passwordFrom(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function usernameForVault(vaultId: string): string {
  return `fos-vault-${vaultId}`;
}

function credential(username: string, randomBytes: RandomBytes): NatsCredential {
  const password = passwordFrom(randomBytes(PASSWORD_BYTES));
  return { username, password, passwordHash: bcrypt.hashSync(password, BCRYPT_COST) };
}

/** Generates a vault-only credential for administrator-approved user creation or rotation. */
export function generateVaultCredential(vaultId: string, randomBytes: RandomBytes = nodeRandomBytes): NatsCredential {
  return credential(usernameForVault(vaultId), randomBytes);
}

/** Generates independent 256-bit passwords. Plaintext values are for one-time handoff only. */
export function generateBootstrapCredentials(vaultId: string, randomBytes: RandomBytes = nodeRandomBytes): BootstrapCredentials {
  const administrator = credential("fos-admin", randomBytes);
  const vault = credential(usernameForVault(vaultId), randomBytes);
  if (administrator.password === vault.password) throw new Error("CREDENTIAL_RANDOMNESS_COLLISION");
  return { administrator, vault };
}

export function verifyCredentialPassword(credentialToVerify: NatsCredential): boolean {
  return bcrypt.compareSync(credentialToVerify.password, credentialToVerify.passwordHash);
}

function scopedVaultAuthorization(vault: NatsCredential): string {
  const vaultId = vault.username.startsWith("fos-vault-") ? vault.username.slice("fos-vault-".length) : "";
  if (!vaultId) throw new Error("VAULT_USERNAME_REQUIRED");
  const bucket = `OBS_${vaultId}_FILES`;
  const stream = `KV_${bucket}`;
  return `    { user: "${vault.username}", password: "${vault.passwordHash}"
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

/** Render only hashes for inclusion in managed NATS configuration. */
export function renderNatsAuthorization(credentials: Pick<BootstrapCredentials, "administrator" | "vault">): string {
  return `# fos-managed-authorization:start\nauthorization {\n  users: [\n    { user: "${credentials.administrator.username}", password: "${credentials.administrator.passwordHash}" },\n${scopedVaultAuthorization(credentials.vault)}\n  ]\n}\n# fos-managed-authorization:end\n`;
}

export function formatSecretHandoff(credentials: BootstrapCredentials): string {
  return [
    "Flash Osidian Sync credentials (shown once)",
    `Administrator username: ${credentials.administrator.username}`,
    `Administrator password: ${credentials.administrator.password}`,
    `Vault username: ${credentials.vault.username}`,
    `Vault password: ${credentials.vault.password}`,
    "Store these credentials securely. The vault password belongs in the Obsidian plugin settings.",
    "",
  ].join("\n");
}

/**
 * Creates a single-use credential handoff. The caller invokes it only after
 * services and connectivity checks have succeeded.
 */
export function createCredentialHandoff(credentials: BootstrapCredentials): {
  discloseInteractive: (write: (contents: string) => Promise<void> | void) => Promise<void>;
  writeUnattended: (path: string, output: SecretOutputAdapter) => Promise<void>;
} {
  let delivered = false;
  const consume = async (write: (contents: string) => Promise<void> | void): Promise<void> => {
    if (delivered) throw new Error("SECRETS_ALREADY_DELIVERED");
    await write(formatSecretHandoff(credentials));
    delivered = true;
  };
  return {
    discloseInteractive: (write) => consume(write),
    writeUnattended: (path, output) => consume((contents) => output.writeFileAtomically(path, contents, { owner: 0, mode: 0o600 })),
  };
}
