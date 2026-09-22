import { describe, expect, it, vi } from "vitest";
import { verifyVault, type VaultVerificationAdapter } from "../../packages/server-cli/src/vault-verify.js";
import { runVaultCommand, type HostAdapter } from "../../packages/server-cli/src/cli.js";

function adapter(): VaultVerificationAdapter & { authenticate: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; crossBucketDenied: ReturnType<typeof vi.fn> } {
  const values = new Map<string, Uint8Array>();
  return {
    authenticate: vi.fn().mockResolvedValue(true), status: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockImplementation(async (_bucket: string, key: string, value: Uint8Array) => values.set(key, value)),
    get: vi.fn().mockImplementation(async (_bucket: string, key: string) => values.get(key)),
    watch: vi.fn().mockResolvedValue(() => {}), crossBucketDenied: vi.fn().mockResolvedValue(true),
  } as VaultVerificationAdapter & { authenticate: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; crossBucketDenied: ReturnType<typeof vi.fn> };
}

describe("fos vault verify", () => {
  it("proves the own-bucket operations and reports cross-bucket access as untested without a peer", async () => {
    const host = adapter();
    await expect(verifyVault(host, "notes", { username: "fos-vault-notes", password: "secret" })).resolves.toEqual({
      ownBucket: true, crossBucket: "not-tested",
    });
    expect(host.put).toHaveBeenCalledWith("OBS_notes_FILES", expect.stringMatching(/^f\.__fos_verify_/), expect.any(Uint8Array));
    expect(host.crossBucketDenied).not.toHaveBeenCalled();
  });
  it("checks access against the supplied existing peer bucket", async () => {
    const host = adapter();
    await expect(verifyVault(host, "notes", { username: "fos-vault-notes", password: "secret" }, "other")).resolves.toEqual({
      ownBucket: true, crossBucket: "denied",
    });
    expect(host.crossBucketDenied).toHaveBeenCalledWith("OBS_other_FILES");
  });
  it("fails when the peer is accessible", async () => {
    const host = adapter();
    host.crossBucketDenied.mockResolvedValue(false);
    await expect(verifyVault(host, "notes", { username: "fos-vault-notes", password: "secret" }, "other")).rejects.toThrow("VAULT_CROSS_BUCKET_ACCESS");
  });
  it("fails before remote access for invalid scoped credentials", async () => {
    const host = adapter();
    await expect(verifyVault(host, "notes", { username: "fos-vault-work", password: "secret" })).rejects.toThrow("VAULT_AUTH_REQUIRED");
    expect(host.put).not.toHaveBeenCalled();
  });
});

describe("fos vault verify command", () => {
  it("accepts scoped credentials only from a root-owned protected input", async () => {
    const scoped = adapter();
    const host: HostAdapter = {
      platform: () => ({ distribution: "ubuntu", release: "24.04", architecture: "amd64" }),
      readProtectedInput: async () => ({ content: "vault-secret\n", uid: 0, mode: 0o600 }),
    };
    await expect(runVaultCommand(["verify", "--mode", "native", "--vault-id", "notes", "--vault-input", "/root/vault"], {
      host, createAdapter: () => ({} as never), createVerificationAdapter: () => scoped,
    })).resolves.toEqual({ verified: true, ownBucket: true, crossBucket: "not-tested" });
    expect(scoped.put).toHaveBeenCalled();
    expect(scoped.crossBucketDenied).not.toHaveBeenCalled();
  });
  it("requires an administrator protected input to verify a real peer and checks that peer exists", async () => {
    const scoped = adapter();
    const host: HostAdapter = {
      platform: () => ({ distribution: "ubuntu", release: "24.04", architecture: "amd64" }),
      readProtectedInput: vi.fn().mockImplementation(async (path: string) => ({
        content: path.endsWith("admin") ? "admin-secret\n" : "vault-secret\n", uid: 0, mode: 0o600,
      })),
    };
    const admin = { authenticate: vi.fn().mockResolvedValue(true), listBuckets: vi.fn().mockResolvedValue([
      { name: "OBS_other_FILES", vaultId: "other", storage: "file", history: 10, replicas: 1 },
    ]) };
    await expect(runVaultCommand(["verify", "--mode", "native", "--vault-id", "notes", "--vault-input", "/root/vault", "--cross-vault-id", "other", "--admin-input", "/root/admin"], {
      host, createAdapter: () => ({} as never), createVerificationAdapter: () => scoped, createAdminAdapter: () => admin as never,
    })).resolves.toEqual({ verified: true, ownBucket: true, crossBucket: "denied" });
    expect(admin.listBuckets).toHaveBeenCalledOnce();
    expect(scoped.crossBucketDenied).toHaveBeenCalledWith("OBS_other_FILES");
  });
  it("fails a peer check before scoped access when administrator confirms that peer is missing", async () => {
    const scoped = adapter();
    const host: HostAdapter = {
      platform: () => ({ distribution: "ubuntu", release: "24.04", architecture: "amd64" }),
      readProtectedInput: vi.fn().mockResolvedValue({ content: "secret", uid: 0, mode: 0o600 }),
    };
    const admin = { authenticate: vi.fn().mockResolvedValue(true), listBuckets: vi.fn().mockResolvedValue([]) };
    await expect(runVaultCommand(["verify", "--mode", "native", "--vault-id", "notes", "--vault-input", "/root/vault", "--cross-vault-id", "missing", "--admin-input", "/root/admin"], {
      host, createAdapter: () => ({} as never), createVerificationAdapter: () => scoped, createAdminAdapter: () => admin as never,
    })).rejects.toThrow("CROSS_VAULT_NOT_FOUND");
    expect(scoped.authenticate).not.toHaveBeenCalled();
  });
});
