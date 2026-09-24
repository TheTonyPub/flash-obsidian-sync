import { describe, expect, it, vi } from "vitest";
import { runBootstrap, runVaultCommand, type BootstrapPlan, type HostAdapter, type RunBootstrapOptions, type RunVaultCommandOptions } from "../../packages/server-cli/src/cli.js";
import type { BootstrapCredentials } from "../../packages/server-cli/src/credentials.js";
import type { OwnedStateAdapter } from "../../packages/server-cli/src/state.js";
import type { ManagedAuthorization, ManagedVaultUser, VaultUserAdapter } from "../../packages/server-cli/src/vault-users.js";

type CredentialStore = {
  writeAdministrator: ReturnType<typeof vi.fn>;
  writeVault: ReturnType<typeof vi.fn>;
  readVault: ReturnType<typeof vi.fn>;
  removeVault: ReturnType<typeof vi.fn>;
};

const ADMINISTRATOR_RECORD = "/var/lib/flash-osidian-sync/credentials/administrator.json";
const vaultRecord = (vaultId: string): string => `/var/lib/flash-osidian-sync/credentials/vaults/${vaultId}.json`;

function credentialStore(): CredentialStore {
  const records = new Map<string, unknown>();
  return {
    writeAdministrator: vi.fn(async (path: string, record: unknown) => { records.set(path, record); }),
    writeVault: vi.fn(async (path: string, record: unknown) => { records.set(path, record); }),
    readVault: vi.fn(async (vaultId: string) => records.get(vaultRecord(vaultId))),
    removeVault: vi.fn(async (vaultId: string) => { records.delete(vaultRecord(vaultId)); }),
  };
}

const host: HostAdapter = {
  platform: () => ({ distribution: "debian", release: "13", architecture: "amd64" }),
  readProtectedInput: vi.fn().mockResolvedValue({
    content: JSON.stringify({ mode: "docker", domain: "sync.example.test", vaultId: "notes" }), uid: 0, mode: 0o600,
  }),
};

function state(): OwnedStateAdapter {
  let manifest: ReturnType<typeof JSON.parse> | undefined;
  return {
    inventory: vi.fn().mockImplementation(async () => manifest ? [{
      kind: "state" as const, value: "/opt/flash-osidian-sync/state.json", owned: true, manifest,
    }] : []),
    writeStateAtomically: vi.fn().mockImplementation(async (_path: string, contents: string) => { manifest = JSON.parse(contents); }),
  };
}

function bootstrapArgs(keep = false): string[] {
  return ["bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--vault-id", "notes", "--non-interactive",
    "--input", "/root/fos-input.json", "--secrets-output", "/root/fos-secrets", "--approve", ...(keep ? ["--keep"] : [])];
}

function userAdapter(users: ManagedVaultUser[] = []): VaultUserAdapter & Record<string, ReturnType<typeof vi.fn>> {
  const authorization: ManagedAuthorization = { administrator: { username: "fos-admin", passwordHash: "$2a$12$admin" }, users };
  return {
    authenticate: vi.fn().mockResolvedValue(true),
    readAuthorization: vi.fn().mockResolvedValue(authorization),
    validate: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
  } as VaultUserAdapter & Record<string, ReturnType<typeof vi.fn>>;
}

function vaultOptions(store: CredentialStore, adapter: VaultUserAdapter, verification?: object): RunVaultCommandOptions {
  return {
    host,
    createAdapter: () => adapter,
    promptSecret: vi.fn().mockResolvedValue("admin-secret"),
    discloseInteractiveSecrets: vi.fn().mockResolvedValue(undefined),
    ...(verification ? { createVerificationAdapter: () => verification } : {}),
    credentialStore: store,
  } as RunVaultCommandOptions;
}

describe("fos protected credential store contract", () => {
  it("keeps administrator and retained vault records separate with root-owned atomic writes", async () => {
    const store = credentialStore();
    let generated: BootstrapCredentials | undefined;
    const options = {
      host,
      state: state(),
      apply: vi.fn(async (_plan: BootstrapPlan, credentials: BootstrapCredentials) => { generated = credentials; }),
      secretOutput: { writeFileAtomically: vi.fn().mockResolvedValue(undefined) },
      credentialStore: store,
    } as RunBootstrapOptions;

    await runBootstrap(bootstrapArgs(true), options);

    expect(generated).toBeDefined();
    expect(store.writeAdministrator).toHaveBeenCalledWith(
      ADMINISTRATOR_RECORD, expect.objectContaining({ username: "fos-admin" }), { owner: 0, mode: 0o600 },
    );
    expect(store.writeVault).toHaveBeenCalledWith(
      vaultRecord("notes"), expect.objectContaining({ username: "fos-vault-notes" }), { owner: 0, mode: 0o600 },
    );
    expect(store.writeAdministrator.mock.calls[0]?.[1]).not.toEqual(store.writeVault.mock.calls[0]?.[1]);
  });

  it("always retains the administrator record but leaves the vault record absent without --keep", async () => {
    const store = credentialStore();
    const options = {
      host,
      state: state(),
      apply: vi.fn(),
      secretOutput: { writeFileAtomically: vi.fn().mockResolvedValue(undefined) },
      credentialStore: store,
    } as RunBootstrapOptions;

    await runBootstrap(bootstrapArgs(false), options);

    expect(store.writeAdministrator).toHaveBeenCalledWith(
      ADMINISTRATOR_RECORD, expect.objectContaining({ username: "fos-admin" }), { owner: 0, mode: 0o600 },
    );
    expect(store.writeVault).not.toHaveBeenCalled();
  });

  it("retains no vault credential without --keep and redacts store write failures", async () => {
    const store = credentialStore();
    store.writeAdministrator.mockRejectedValue(new Error("write failed admin-secret"));
    const options = {
      host,
      state: state(),
      apply: vi.fn(),
      secretOutput: { writeFileAtomically: vi.fn().mockResolvedValue(undefined) },
      credentialStore: store,
    } as RunBootstrapOptions;

    try {
      await runBootstrap(bootstrapArgs(false), options);
      throw new Error("expected protected store failure");
    } catch (error) {
      expect(String(error)).toContain("write failed");
      expect(String(error)).not.toContain("admin-secret");
    }
    expect(store.writeVault).not.toHaveBeenCalled();
  });

  it("rotates a retained vault only after verification and removes stale retention without --keep", async () => {
    const store = credentialStore();
    const order: string[] = [];
    store.readVault.mockResolvedValue({ vaultId: "notes", username: "fos-vault-notes", password: "old-secret" });
    const adapter = userAdapter([{ vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$old" }]);
    const verification = {
      authenticate: vi.fn().mockImplementation(async () => { order.push("verify"); return true; }), status: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(new TextEncoder().encode("fos-verify")),
      watch: vi.fn().mockResolvedValue(vi.fn()), crossBucketDenied: vi.fn().mockResolvedValue(true),
    };
    store.writeVault.mockImplementation(async () => { order.push("write"); });

    await runVaultCommand(["rotate", "--mode", "native", "--vault-id", "notes", "--keep", "--wss-endpoint", "wss://managed.example.test"], vaultOptions(store, adapter, verification));
    expect(verification.authenticate).toHaveBeenCalledOnce();
    expect(store.readVault).toHaveBeenCalledWith("notes");
    expect(store.writeVault).toHaveBeenCalledWith(
      vaultRecord("notes"), expect.objectContaining({ username: "fos-vault-notes" }), { owner: 0, mode: 0o600 },
    );
    expect(order).toEqual(["verify", "write"]);

    await runVaultCommand(["rotate", "--mode", "native", "--vault-id", "notes", "--wss-endpoint", "wss://managed.example.test"], vaultOptions(store, adapter, verification));
    expect(store.removeVault).toHaveBeenCalledWith("notes");
  });

  it("leaves retained credentials unchanged when replacement verification fails", async () => {
    const store = credentialStore();
    const adapter = userAdapter([{ vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$old" }]);
    const verification = {
      authenticate: vi.fn().mockResolvedValue(false), status: vi.fn(), put: vi.fn(), get: vi.fn(), watch: vi.fn(), crossBucketDenied: vi.fn(),
    };

    await expect(runVaultCommand(["rotate", "--mode", "native", "--vault-id", "notes", "--keep", "--wss-endpoint", "wss://managed.example.test"], vaultOptions(store, adapter, verification)))
      .rejects.toThrow("VAULT_AUTH_REQUIRED");
    expect(store.writeVault).not.toHaveBeenCalled();
    expect(store.removeVault).not.toHaveBeenCalled();
  });

  it("removes only the revoked vault record after successful server revocation", async () => {
    const store = credentialStore();
    const adapter = userAdapter([
      { vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$notes" },
      { vaultId: "work", username: "fos-vault-work", passwordHash: "$2a$12$work" },
    ]);

    await runVaultCommand(["revoke", "--mode", "native", "--vault-id", "notes"], vaultOptions(store, adapter));
    expect(store.removeVault).toHaveBeenCalledWith("notes");
    expect(store.removeVault).not.toHaveBeenCalledWith("work");
  });

  it("preserves the retained record when server revocation fails", async () => {
    const store = credentialStore();
    const adapter = userAdapter([{ vaultId: "work", username: "fos-vault-work", passwordHash: "$2a$12$work" }]);
    (adapter.reload as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("revoke failed"));

    await expect(runVaultCommand(["revoke", "--mode", "native", "--vault-id", "work"], vaultOptions(store, adapter))).rejects.toThrow("revoke failed");
    expect(store.removeVault).not.toHaveBeenCalledWith("work");
  });
});
