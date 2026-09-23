import { describe, expect, it, vi } from "vitest";
import type { CredentialRecord, CredentialStore } from "../../packages/server-cli/src/credential-store.js";
import type { HandoffConfig, HandoffResult } from "../../packages/server-cli/src/handoff-builder.js";

type ImportOptions = {
  credentialStore: Partial<CredentialStore>;
  renderHandoff: (config: HandoffConfig) => Promise<HandoffResult>;
  promptEndpoint?: () => Promise<string>;
  promptEncryptionPhrase?: () => Promise<string>;
  discloseInteractiveSecrets?: (contents: string) => Promise<void> | void;
  secretOutput?: { writeFileAtomically(path: string, contents: string, options: { owner: 0; mode: 0o600 }): Promise<void> };
  unattended?: boolean;
  createAdapter?: () => unknown;
};

type ImportCommand = (args: string[], options: ImportOptions) => Promise<unknown>;

async function runImport(args: string[], options: ImportOptions): Promise<unknown> {
  const cli = await import("../../packages/server-cli/src/cli.js");
  const command = (cli as unknown as { runImportCommand?: ImportCommand }).runImportCommand;
  if (!command) throw new Error("IMPORT_COMMAND_NOT_IMPLEMENTED");
  return command(args, options);
}

function retainedStore(endpoint = "wss://managed.example.test"): CredentialStore & Record<string, ReturnType<typeof vi.fn>> {
  const administrator: CredentialRecord = { kind: "administrator", username: "fos-admin", password: "admin-secret", endpoint };
  const vault: CredentialRecord = { kind: "vault", vaultId: "notes", username: "fos-vault-notes", password: "vault-secret", endpoint };
  return {
    administratorPath: "/var/lib/flash-osidian-sync/credentials/administrator.json",
    vaultPath: (vaultId: string) => `/var/lib/flash-osidian-sync/credentials/vaults/${vaultId}.json`,
    readAdministrator: vi.fn().mockResolvedValue(administrator),
    readVault: vi.fn().mockResolvedValue(vault),
  } as unknown as CredentialStore & Record<string, ReturnType<typeof vi.fn>>;
}

function handoffResult(): HandoffResult {
  return { uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" };
}

describe("fos import command", () => {
  it("reads exactly the retained vault record and regenerates a vault-only URI and QR", async () => {
    const credentialStore = retainedStore();
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await runImport(["import", "--vault-id", "notes"], {
      credentialStore, renderHandoff, discloseInteractiveSecrets: vi.fn(),
    });

    expect(credentialStore.readVault).toHaveBeenCalledWith("notes");
    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({
      vaultId: "notes", server: "wss://managed.example.test", username: "fos-vault-notes", password: "vault-secret",
    }));
  });

  it("uses a valid endpoint override and rejects invalid endpoint overrides before rendering", async () => {
    const credentialStore = retainedStore();
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await runImport(["import", "--vault-id", "notes", "--wss-endpoint", "wss://override.example.test"], {
      credentialStore, renderHandoff, discloseInteractiveSecrets: vi.fn(),
    });
    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ server: "wss://override.example.test" }));

    renderHandoff.mockClear();
    await expect(runImport(["import", "--vault-id", "notes", "--wss-endpoint", "https://wrong.example.test"], {
      credentialStore, renderHandoff, discloseInteractiveSecrets: vi.fn(),
    })).rejects.toThrow(/WSS|endpoint/i);
    expect(renderHandoff).not.toHaveBeenCalled();
  });

  it("uses the retained administrator managed endpoint before a stale vault-record endpoint", async () => {
    const credentialStore = retainedStore("wss://managed.example.test");
    (credentialStore.readVault as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "vault", vaultId: "notes", username: "fos-vault-notes", password: "vault-secret", endpoint: "wss://old.example.test",
    });
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await runImport(["import", "--vault-id", "notes"], {
      credentialStore, renderHandoff, discloseInteractiveSecrets: vi.fn(),
    });

    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ server: "wss://managed.example.test" }));
  });

  it("runs locally without creating, authenticating, or mutating a server adapter", async () => {
    const credentialStore = retainedStore();
    const createAdapter = vi.fn(() => ({ authenticate: vi.fn(), write: vi.fn(), reload: vi.fn() }));
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await runImport(["import", "--vault-id", "notes"], {
      credentialStore, renderHandoff, createAdapter, discloseInteractiveSecrets: vi.fn(),
    });

    expect(createAdapter).not.toHaveBeenCalled();
    expect(renderHandoff).toHaveBeenCalledOnce();
  });

  it("rejects an administrator record instead of producing an import handoff", async () => {
    const credentialStore = retainedStore();
    (credentialStore.readVault as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "administrator", username: "fos-admin", password: "admin-secret", endpoint: "wss://managed.example.test",
    });
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await expect(runImport(["import", "--vault-id", "notes"], {
      credentialStore, renderHandoff, discloseInteractiveSecrets: vi.fn(),
    })).rejects.toThrow(/vault|administrator|credential/i);
    expect(renderHandoff).not.toHaveBeenCalled();
  });

  it.each(["missing", "unretained", "revoked"])("reports rotation guidance for a %s vault credential", async () => {
    const credentialStore = retainedStore();
    (credentialStore.readVault as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await expect(runImport(["import", "--vault-id", "notes"], {
      credentialStore, renderHandoff, discloseInteractiveSecrets: vi.fn(),
    })).rejects.toThrow(/rotate|--keep/i);
    expect(renderHandoff).not.toHaveBeenCalled();
  });

  it("writes unattended URI and QR only to the explicit protected output path", async () => {
    const credentialStore = retainedStore();
    const writeFileAtomically = vi.fn().mockResolvedValue(undefined);
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await runImport(["import", "--vault-id", "notes", "--secrets-output", "/root/fos-import-output"], {
      credentialStore, renderHandoff, unattended: true, secretOutput: { writeFileAtomically },
    });

    expect(writeFileAtomically).toHaveBeenCalledWith(
      "/root/fos-import-output", expect.stringContaining("obsidian://flash-sync-import?data=2.payload"), { owner: 0, mode: 0o600 },
    );
  });

  it("discloses URI and QR interactively without administrator credentials", async () => {
    const credentialStore = retainedStore();
    const discloseInteractiveSecrets = vi.fn();
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());

    await runImport(["import", "--vault-id", "notes"], {
      credentialStore, renderHandoff, discloseInteractiveSecrets,
    });

    expect(discloseInteractiveSecrets).toHaveBeenCalledWith(expect.stringContaining("obsidian://flash-sync-import?data=2.payload"));
    expect(discloseInteractiveSecrets.mock.calls.flat().join(" ")).not.toContain("admin-secret");
  });

  it("defaults to plaintext v2 without a phrase and passes an interactive phrase for v1", async () => {
    const credentialStore = retainedStore();
    const renderHandoff = vi.fn().mockResolvedValue(handoffResult());
    const promptEncryptionPhrase = vi.fn().mockResolvedValue("phrase-123");

    await runImport(["import", "--vault-id", "notes"], {
      credentialStore, renderHandoff, promptEncryptionPhrase, discloseInteractiveSecrets: vi.fn(),
    });
    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ encryptionPhrase: "phrase-123" }));
  });
});
