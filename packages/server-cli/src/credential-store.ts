import { join } from "node:path";

export type CredentialRecord = {
  kind: "administrator" | "vault";
  vaultId?: string;
  username: string;
  password: string;
  endpoint: string;
};

export interface AtomicFs {
  writeFileAtomically(path: string, contents: string, options: { owner: 0; mode: 0o600 }): Promise<void>;
  readFile(path: string): Promise<string>;
  removeFile(path: string): Promise<void>;
}

export interface CredentialStore {
  administratorPath: string;
  vaultPath(vaultId: string): string;
  readAdministrator(): Promise<CredentialRecord | undefined>;
  readVault(vaultId: string): Promise<CredentialRecord | undefined>;
  writeAdministrator(record: CredentialRecord): Promise<void>;
  writeAdministrator(path: string, record: CredentialRecord, options: { owner: 0; mode: 0o600 }): Promise<void>;
  writeVault(record: CredentialRecord): Promise<void>;
  writeVault(path: string, record: CredentialRecord, options: { owner: 0; mode: 0o600 }): Promise<void>;
  removeVault(vaultId: string): Promise<void>;
}

const writeOptions = { owner: 0, mode: 0o600 } as const;

function validVaultId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function validEndpoint(value: string): boolean {
  try { return new URL(value).protocol === "wss:"; }
  catch { return false; }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" || String(error).includes("ENOENT");
}

function fail(operation: string): never {
  throw new Error(`Credential store ${operation} failed`);
}

function validate(record: unknown, expectedKind: CredentialRecord["kind"], vaultId?: string): CredentialRecord {
  if (!record || typeof record !== "object") fail("record validation");
  const value = record as Partial<CredentialRecord>;
  if (value.kind !== expectedKind || typeof value.username !== "string" || !value.username
    || typeof value.password !== "string" || !value.password || typeof value.endpoint !== "string" || !validEndpoint(value.endpoint)) {
    fail("record validation");
  }
  if (expectedKind === "administrator") {
    if (value.vaultId !== undefined || value.username !== "fos-admin") fail("record validation");
    return value as CredentialRecord;
  }
  if (typeof value.vaultId !== "string" || !validVaultId(value.vaultId) || value.vaultId !== vaultId
    || value.username !== `fos-vault-${value.vaultId}`) fail("record validation");
  return value as CredentialRecord;
}

function encode(record: CredentialRecord): string {
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
}

function decode(contents: string): unknown {
  return JSON.parse(Buffer.from(contents, "base64url").toString("utf8"));
}

export function createCredentialStore(options: { rootDir: string; fs: AtomicFs }): CredentialStore {
  const administratorPath = join(options.rootDir, "administrator.json");
  const vaultPath = (vaultId: string): string => {
    if (!validVaultId(vaultId)) throw new Error("Credential store vault ID is invalid");
    return join(options.rootDir, "vaults", `${vaultId}.json`);
  };
  const read = async (path: string, kind: CredentialRecord["kind"], vaultId?: string): Promise<CredentialRecord | undefined> => {
    try { return validate(decode(await options.fs.readFile(path)), kind, vaultId); }
    catch (error) {
      if (missing(error)) return undefined;
      return fail("read");
    }
  };
  const write = async (path: string, record: CredentialRecord, kind: CredentialRecord["kind"], vaultId?: string): Promise<void> => {
    validate(record, kind, vaultId);
    try { await options.fs.writeFileAtomically(path, encode(record), writeOptions); }
    catch { fail("write"); }
  };
  return {
    administratorPath,
    vaultPath,
    readAdministrator: () => read(administratorPath, "administrator"),
    readVault: (vaultId) => read(vaultPath(vaultId), "vault", vaultId),
    writeAdministrator: (...args: [CredentialRecord] | [string, CredentialRecord, { owner: 0; mode: 0o600 }]) => {
      const [path, record] = typeof args[0] === "string" ? [args[0], args[1]!] : [administratorPath, args[0]];
      return write(path, record, "administrator");
    },
    writeVault: (...args: [CredentialRecord] | [string, CredentialRecord, { owner: 0; mode: 0o600 }]) => {
      const [path, record] = typeof args[0] === "string" ? [args[0], args[1]!] : [vaultPath(args[0].vaultId ?? ""), args[0]];
      return write(path, record, "vault", record.vaultId);
    },
    removeVault: async (vaultId) => {
      try { await options.fs.removeFile(vaultPath(vaultId)); }
      catch (error) { if (!missing(error)) fail("remove"); }
    },
  };
}
