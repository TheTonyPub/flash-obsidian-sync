import { describe, expect, it, vi } from "vitest";

const storeModulePath = "../../packages/server-cli/src/credential-store.js";

type CredentialRecord = { kind: "administrator" | "vault"; vaultId?: string; username: string; password: string; endpoint: string };
type AtomicFs = {
  writeFileAtomically(path: string, contents: string, options: { owner: 0; mode: 0o600 }): Promise<void>;
  readFile(path: string): Promise<string>;
  removeFile(path: string): Promise<void>;
};
type CredentialStore = {
  administratorPath: string;
  vaultPath(vaultId: string): string;
  readAdministrator(): Promise<CredentialRecord | undefined>;
  readVault(vaultId: string): Promise<CredentialRecord | undefined>;
  writeAdministrator(record: CredentialRecord): Promise<void>;
  writeVault(record: CredentialRecord): Promise<void>;
  removeVault(vaultId: string): Promise<void>;
};
type StoreModule = {
  createCredentialStore(options: { rootDir: string; fs: AtomicFs }): CredentialStore;
};

async function loadStore(): Promise<StoreModule> {
  return await import(storeModulePath) as StoreModule;
}

function atomicFs() {
  const files = new Map<string, string>();
  let failNextWrite = false;
  const fs: AtomicFs = {
    writeFileAtomically: vi.fn(async (path, contents) => {
      if (failNextWrite) { failNextWrite = false; throw new Error("atomic write failed administrator-secret"); }
      files.set(path, contents);
    }),
    readFile: vi.fn(async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    }),
    removeFile: vi.fn(async (path) => { files.delete(path); }),
  };
  return { fs, files, failWrite: () => { failNextWrite = true; } };
}

describe("managed credential store adapter", () => {
  it("uses fixed role-separated paths and exact vault IDs", async () => {
    const { createCredentialStore } = await loadStore();
    const io = atomicFs();
    const store = createCredentialStore({ rootDir: "/var/lib/flash-osidian-sync/credentials", fs: io.fs });

    expect(store.administratorPath).toBe("/var/lib/flash-osidian-sync/credentials/administrator.json");
    expect(store.vaultPath("notes")).toBe("/var/lib/flash-osidian-sync/credentials/vaults/notes.json");
    expect(store.vaultPath("work")).not.toBe(store.vaultPath("notes"));
    await store.writeVault({ kind: "vault", vaultId: "notes", username: "fos-vault-notes", password: "notes-secret", endpoint: "wss://sync.example.test" });
    await expect(store.readVault("notes")).resolves.toMatchObject({ vaultId: "notes" });
    await expect(store.readVault("work")).resolves.toBeUndefined();
  });

  it("writes role records atomically with root-owned mode 0600 metadata", async () => {
    const { createCredentialStore } = await loadStore();
    const io = atomicFs();
    const store = createCredentialStore({ rootDir: "/var/lib/flash-osidian-sync/credentials", fs: io.fs });

    await store.writeAdministrator({ kind: "administrator", username: "fos-admin", password: "admin-secret", endpoint: "wss://sync.example.test" });

    expect(io.fs.writeFileAtomically).toHaveBeenCalledWith(
      "/var/lib/flash-osidian-sync/credentials/administrator.json",
      expect.not.stringContaining("admin-secret"),
      { owner: 0, mode: 0o600 },
    );
  });

  it("preserves the previous record when an atomic replacement fails and redacts the error", async () => {
    const { createCredentialStore } = await loadStore();
    const io = atomicFs();
    const store = createCredentialStore({ rootDir: "/var/lib/flash-osidian-sync/credentials", fs: io.fs });
    const first = { kind: "vault" as const, vaultId: "notes", username: "fos-vault-notes", password: "old-secret", endpoint: "wss://sync.example.test" };
    await store.writeVault(first);
    io.failWrite();

    await expect(store.writeVault({ ...first, password: "new-secret" })).rejects.not.toThrow(/new-secret|old-secret/);
    await expect(store.readVault("notes")).resolves.toEqual(first);
  });

  it("rejects administrator records through the vault lookup and validates role and vault binding", async () => {
    const { createCredentialStore } = await loadStore();
    const io = atomicFs();
    const store = createCredentialStore({ rootDir: "/var/lib/flash-osidian-sync/credentials", fs: io.fs });

    await store.writeAdministrator({ kind: "administrator", username: "fos-admin", password: "admin-secret", endpoint: "wss://sync.example.test" });
    await expect(store.readVault("administrator")).resolves.toBeUndefined();
    await expect(store.writeVault({ kind: "administrator", vaultId: "notes", username: "fos-admin", password: "admin-secret", endpoint: "wss://sync.example.test" }))
      .rejects.toThrow(/vault|record|role/i);
    await expect(store.writeAdministrator({ kind: "administrator", username: "not-fos-admin", password: "admin-secret", endpoint: "wss://sync.example.test" }))
      .rejects.toThrow(/administrator|username|record/i);
  });

  it("treats removing a never-retained vault record as idempotent", async () => {
    const { createCredentialStore } = await loadStore();
    const io = atomicFs();
    io.fs.removeFile = vi.fn(async () => {
      const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw error;
    });
    const store = createCredentialStore({ rootDir: "/var/lib/flash-osidian-sync/credentials", fs: io.fs });

    await expect(store.removeVault("never-kept")).resolves.toBeUndefined();
  });
});
