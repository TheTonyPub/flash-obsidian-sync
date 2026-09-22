import { describe, expect, it, vi } from "vitest";
import { createVault, inspectVault, listVaults, type VaultAdminAdapter, type VaultBucket } from "../../packages/server-cli/src/vault-admin.js";
import { runVaultCommand, type HostAdapter } from "../../packages/server-cli/src/cli.js";

const administrator = { username: "fos-admin", password: "admin-secret" };

function bucket(vaultId: string): VaultBucket {
  return {
    name: `OBS_${vaultId}_FILES`, vaultId,
    storage: "file", history: 10, replicas: 1,
  };
}

function adapter(initial: VaultBucket[] = []): VaultAdminAdapter & {
  authenticate: ReturnType<typeof vi.fn>;
  listBuckets: ReturnType<typeof vi.fn>;
  createBucket: ReturnType<typeof vi.fn>;
} {
  const buckets = [...initial];
  return {
    authenticate: vi.fn().mockImplementation(async (credentials: { password: string }) => credentials.password === "admin-secret"),
    listBuckets: vi.fn().mockImplementation(async () => [...buckets]),
    createBucket: vi.fn().mockImplementation(async (next: VaultBucket) => { buckets.push(next); }),
  };
}

describe("fos vault administration", () => {
  it("requires the administrator identity before changing or reading buckets", async () => {
    const host = adapter();

    await expect(createVault(host, { username: "fos-vault-notes", password: "wrong" }, "notes"))
      .rejects.toThrow("ADMIN_AUTH_REQUIRED");
    await expect(listVaults(host, { username: "fos-admin", password: "wrong" }))
      .rejects.toThrow("ADMIN_AUTH_REQUIRED");

    expect(host.createBucket).not.toHaveBeenCalled();
    expect(host.listBuckets).not.toHaveBeenCalled();
  });

  it("creates a file-backed bucket with history ten and one replica", async () => {
    const host = adapter();

    const result = await createVault(host, administrator, "notes");

    expect(result.created).toBe(true);
    expect(result.bucket).toEqual(bucket("notes"));
    expect(host.createBucket).toHaveBeenCalledWith(bucket("notes"));
  });

  it("is idempotent for the same vault and preserves its bucket", async () => {
    const existing = bucket("notes");
    const host = adapter([existing]);

    const result = await createVault(host, administrator, "notes");

    expect(result).toEqual({ created: false, bucket: existing });
    expect(host.createBucket).not.toHaveBeenCalled();
  });

  it("rejects a bucket name already claimed by a different vault ID without changing data", async () => {
    const existing = { ...bucket("other"), name: "OBS_notes_FILES" };
    const host = adapter([existing]);

    await expect(createVault(host, administrator, "notes")).rejects.toThrow("VAULT_ID_COLLISION");

    expect(host.createBucket).not.toHaveBeenCalled();
  });

  it("lists and inspects preserved vault properties through administrator authentication", async () => {
    const existing = bucket("notes");
    const host = adapter([existing]);

    await expect(listVaults(host, administrator)).resolves.toEqual([existing]);
    await expect(inspectVault(host, administrator, "notes")).resolves.toEqual(existing);
    expect(host.authenticate).toHaveBeenCalledWith(administrator);
  });
});

describe("fos vault bucket commands", () => {
  const host: HostAdapter = { platform: () => ({ distribution: "ubuntu", release: "24.04", architecture: "amd64" }) };

  it("uses protected administrator input for create and never sends it through command arguments", async () => {
    const remote = adapter();
    const readProtectedInput = vi.fn().mockResolvedValue({ content: "admin-secret\n", uid: 0, mode: 0o600 });

    await runVaultCommand(["create", "--mode", "native", "--vault-id", "notes", "--admin-input", "/root/admin"], {
      host: { ...host, readProtectedInput }, createAdapter: () => remote as never, createAdminAdapter: () => remote,
    });

    expect(remote.createBucket).toHaveBeenCalledWith(bucket("notes"));
    expect(readProtectedInput).toHaveBeenCalledWith("/root/admin");
  });

  it("lists through admin auth and rejects missing protected input in unattended bucket operations", async () => {
    const remote = adapter([bucket("notes")]);
    await expect(runVaultCommand(["list", "--mode", "native"], {
      host, createAdapter: () => remote as never, createAdminAdapter: () => remote,
    })).rejects.toThrow("ADMIN_INPUT_REQUIRED");
    await expect(runVaultCommand(["list", "--mode", "native", "--admin-input", "/root/admin"], {
      host: { ...host, readProtectedInput: async () => ({ content: "admin-secret", uid: 0, mode: 0o600 }) },
      createAdapter: () => remote as never, createAdminAdapter: () => remote,
    })).resolves.toEqual([bucket("notes")]);
  });
});
