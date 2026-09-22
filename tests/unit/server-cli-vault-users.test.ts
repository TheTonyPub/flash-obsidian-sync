import { describe, expect, it, vi } from "vitest";
import { addVaultUser, revokeVaultUser, rotateVaultUser, type ManagedAuthorization, type ManagedVaultUser, type VaultUserAdapter } from "../../packages/server-cli/src/vault-users.js";
import { runVaultCommand, type HostAdapter } from "../../packages/server-cli/src/cli.js";

const administrator = { username: "fos-admin", password: "admin-secret" };
const notes: ManagedVaultUser = { vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$notes" };
const work: ManagedVaultUser = { vaultId: "work", username: "fos-vault-work", passwordHash: "$2a$12$work" };
const authorization = (users: ManagedVaultUser[] = []): ManagedAuthorization => ({
  administrator: { username: "fos-admin", passwordHash: "$2a$12$admin" }, users,
});

function adapter(initial: ManagedVaultUser[] = []): VaultUserAdapter & {
  authenticate: ReturnType<typeof vi.fn>;
  readAuthorization: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
} {
  return {
    authenticate: vi.fn().mockImplementation(async (credentials: { password: string }) => credentials.password === "admin-secret"),
    readAuthorization: vi.fn().mockResolvedValue(authorization(initial)),
    validate: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
  } as VaultUserAdapter & Record<"authenticate" | "readAuthorization" | "validate" | "write" | "reload" | "restore", ReturnType<typeof vi.fn>>;
}

const random = (size: number): Uint8Array => new Uint8Array(size).fill(7);

describe("fos vault user lifecycle", () => {
  it("requires administrator authentication before reading or changing managed users", async () => {
    const host = adapter();

    await expect(addVaultUser(host, { username: "fos-vault-notes", password: "bad" }, "notes", random))
      .rejects.toThrow("ADMIN_AUTH_REQUIRED");

    expect(host.readAuthorization).not.toHaveBeenCalled();
    expect(host.write).not.toHaveBeenCalled();
  });

  it("adds a random scoped user with a hash-only managed NATS authorization", async () => {
    const host = adapter();

    const result = await addVaultUser(host, administrator, "notes", random);

    expect(result.created).toBe(true);
    expect(result.credential?.username).toBe("fos-vault-notes");
    expect(result.credential?.password).not.toContain("notes");
    expect(host.validate).toHaveBeenCalledWith(expect.stringContaining('$KV.OBS_notes_FILES.>'));
    const rendered = host.write.mock.calls[0]?.[0] as string;
    expect(rendered).toContain(result.credential!.passwordHash);
    expect(rendered).toContain('$2a$12$admin');
    expect(rendered).not.toContain(result.credential!.password);
    expect(rendered).toContain("$JS.API.STREAM.INFO.KV_OBS_notes_FILES");
    expect(host.reload).toHaveBeenCalledOnce();
  });

  it("does not rotate or overwrite an existing user during idempotent add", async () => {
    const host = adapter([notes]);

    await expect(addVaultUser(host, administrator, "notes", random)).resolves.toEqual({ created: false, user: notes });

    expect(host.write).not.toHaveBeenCalled();
    expect(host.reload).not.toHaveBeenCalled();
  });

  it("rotates only the requested user and preserves other managed users", async () => {
    const host = adapter([notes, work]);

    const result = await rotateVaultUser(host, administrator, "notes", random);

    expect(result.credential.username).toBe("fos-vault-notes");
    const rendered = host.write.mock.calls[0]?.[0] as string;
    expect(rendered).toContain(work.passwordHash);
    expect(rendered).toContain('$2a$12$admin');
    expect(rendered).toContain(result.credential.passwordHash);
    expect(rendered).not.toContain(notes.passwordHash);
  });

  it("rolls configuration back if reload fails and never changes KV buckets", async () => {
    const host = adapter([notes, work]);
    host.reload.mockRejectedValue(new Error("reload failed"));

    await expect(revokeVaultUser(host, administrator, "notes")).rejects.toThrow("reload failed");

    expect(host.restore).toHaveBeenCalledWith(expect.stringContaining(notes.passwordHash));
    expect(host.restore).toHaveBeenCalledWith(expect.stringContaining(work.passwordHash));
    expect(host.restore).toHaveBeenCalledWith(expect.stringContaining('$2a$12$admin'));
    expect(host.write.mock.calls[0]?.[0]).not.toContain("fos-vault-notes\", password");
  });

  it("validates candidate configuration before writing or reloading it", async () => {
    const host = adapter([notes]);
    host.validate.mockRejectedValue(new Error("invalid authorization"));

    await expect(revokeVaultUser(host, administrator, "notes")).rejects.toThrow("invalid authorization");

    expect(host.write).not.toHaveBeenCalled();
    expect(host.reload).not.toHaveBeenCalled();
    expect(host.restore).not.toHaveBeenCalled();
  });

  it("accepts only root-protected administrator input and writes new credentials to protected output", async () => {
    const host = adapter();
    const output = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const inputHost: HostAdapter = {
      platform: () => ({ distribution: "debian", release: "13", architecture: "amd64" }),
      readProtectedInput: vi.fn().mockResolvedValue({ content: "admin-secret\n", uid: 0, mode: 0o600 }),
    };

    await runVaultCommand(["add", "--mode", "native", "--vault-id", "notes", "--admin-input", "/root/admin", "--secrets-output", "/root/new"], {
      host: inputHost, createAdapter: () => host, secretOutput: output,
    });

    expect(output.writeFileAtomically).toHaveBeenCalledWith("/root/new", expect.stringContaining("Vault password:"), { owner: 0, mode: 0o600 });
    expect(host.reload).toHaveBeenCalledOnce();
  });

  it("fails closed before admin authentication for unsafe input files", async () => {
    const host = adapter();
    const inputHost: HostAdapter = {
      platform: () => ({ distribution: "debian", release: "13", architecture: "amd64" }),
      readProtectedInput: vi.fn().mockResolvedValue({ content: "admin-secret", uid: 1000, mode: 0o644 }),
    };

    await expect(runVaultCommand(["revoke", "--mode", "native", "--vault-id", "notes", "--admin-input", "/tmp/admin"], {
      host: inputHost, createAdapter: () => host,
    })).rejects.toThrow("UNPROTECTED_ADMIN_INPUT");

    expect(host.authenticate).not.toHaveBeenCalled();
  });
});
