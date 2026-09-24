import { describe, expect, it, vi } from "vitest";
import { parseBootstrapRequest, runBootstrap, runVaultCommand, type HostAdapter, type RunBootstrapOptions, type RunVaultCommandOptions } from "../../packages/server-cli/src/cli.js";
import type { CredentialRecord, CredentialStore } from "../../packages/server-cli/src/credential-store.js";
import type { ManagedAuthorization, ManagedVaultUser, VaultUserAdapter } from "../../packages/server-cli/src/vault-users.js";
import type { VaultVerificationAdapter } from "../../packages/server-cli/src/vault-verify.js";

const host: HostAdapter = {
  platform: () => ({ distribution: "debian", release: "13", architecture: "amd64" }),
  readProtectedInput: vi.fn().mockResolvedValue({
    content: JSON.stringify({ mode: "docker", domain: "sync.example.test", vaultId: "notes" }), uid: 0, mode: 0o600,
  }),
};

function adapter(users: ManagedVaultUser[] = []): VaultUserAdapter & Record<string, ReturnType<typeof vi.fn>> {
  const authorization: ManagedAuthorization = { administrator: { username: "fos-admin", passwordHash: "$2a$12$admin" }, users };
  return {
    authenticate: vi.fn().mockResolvedValue(true), readAuthorization: vi.fn().mockResolvedValue(authorization),
    validate: vi.fn().mockResolvedValue(undefined), write: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined), restore: vi.fn().mockResolvedValue(undefined),
  } as VaultUserAdapter & Record<string, ReturnType<typeof vi.fn>>;
}

function store(endpoint = "wss://managed.example.test"): CredentialStore & Record<string, ReturnType<typeof vi.fn>> {
  const administrator: CredentialRecord = { kind: "administrator", username: "fos-admin", password: "admin-secret", endpoint };
  return {
    administratorPath: "/var/lib/flash-osidian-sync/credentials/administrator.json",
    vaultPath: (vaultId: string) => `/var/lib/flash-osidian-sync/credentials/vaults/${vaultId}.json`,
    readAdministrator: vi.fn().mockResolvedValue(administrator),
    readVault: vi.fn(), writeAdministrator: vi.fn(), writeVault: vi.fn(), removeVault: vi.fn(),
  } as unknown as CredentialStore & Record<string, ReturnType<typeof vi.fn>>;
}

function verificationAdapter(): VaultVerificationAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    authenticate: vi.fn().mockResolvedValue(true), status: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(new TextEncoder().encode("fos-verify")),
    watch: vi.fn().mockResolvedValue(vi.fn()), crossBucketDenied: vi.fn().mockResolvedValue(true),
  } as VaultVerificationAdapter & Record<string, ReturnType<typeof vi.fn>>;
}

function vaultOptions(overrides: Record<string, unknown> = {}, users: ManagedVaultUser[] = [{ vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$old" }]): RunVaultCommandOptions {
  return {
    host, createAdapter: () => adapter(users),
    promptSecret: vi.fn().mockResolvedValue("admin-secret"), discloseInteractiveSecrets: vi.fn().mockResolvedValue(undefined),
    createVerificationAdapter: () => verificationAdapter(),
    ...overrides,
  } as unknown as RunVaultCommandOptions;
}

function bootstrapArgs(extra: string[] = []): string[] {
  return ["bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--vault-id", "notes", "--non-interactive",
    "--input", "/root/fos-input.json", "--secrets-output", "/root/fos-secrets", "--approve", ...extra];
}

describe("fos endpoint-aware vault lifecycle", () => {
  it("parses and validates an explicit --wss-endpoint without discovering a hostname", () => {
    const request = parseBootstrapRequest([...bootstrapArgs(), "--wss-endpoint", "wss://override.example.test"]);
    expect((request as unknown as { wssEndpoint?: string }).wssEndpoint).toBe("wss://override.example.test");
    expect(() => parseBootstrapRequest([...bootstrapArgs(), "--wss-endpoint", "https://wrong.example.test"]))
      .toThrow(/WSS|endpoint/i);
    expect(() => parseBootstrapRequest([...bootstrapArgs(), "--wss-endpoint", "10.0.0.8"]))
      .toThrow(/WSS|endpoint/i);
  });

  it("uses an explicit endpoint over the managed bootstrap endpoint for vault handoff", async () => {
    const credentialStore = store();
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const options = vaultOptions({ credentialStore, renderHandoff });

    await runVaultCommand(["rotate", "--mode", "native", "--vault-id", "notes", "--wss-endpoint", "wss://override.example.test"], options);

    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ server: "wss://override.example.test", username: "fos-vault-notes" }));
    expect(renderHandoff.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({ username: "fos-admin", password: "admin-secret" }));
  });

  it("falls back to the managed endpoint and prompts interactively when no endpoint is supplied", async () => {
    const credentialStore = store("wss://bootstrap.example.test");
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const promptEndpoint = vi.fn().mockResolvedValue("wss://prompted.example.test");
    const options = vaultOptions({ credentialStore, renderHandoff, promptEndpoint }, []);

    await runVaultCommand(["add", "--mode", "native", "--vault-id", "notes"], options);
    expect(promptEndpoint).not.toHaveBeenCalled();
    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ server: "wss://bootstrap.example.test" }));

    const noManaged = vaultOptions({ credentialStore: store(""), renderHandoff, promptEndpoint }, []);
    await runVaultCommand(["add", "--mode", "native", "--vault-id", "notes"], noManaged);
    expect(promptEndpoint).toHaveBeenCalledOnce();
    expect(renderHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ server: "wss://prompted.example.test" }));
  });

  it("prompts for an optional interactive bootstrap phrase and passes it only to the handoff builder", async () => {
    const phrase = "phrase-123";
    const promptEncryptionPhrase = vi.fn().mockResolvedValue(phrase);
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=1.payload", qr: "QR" });
    const args = ["bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--email", "ops@example.test", "--vault-id", "notes"];
    const options = {
      host,
      prompt: vi.fn().mockResolvedValue("yes"),
      promptEncryptionPhrase,
      state: { inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) },
      apply: vi.fn(), discloseInteractiveSecrets: vi.fn().mockResolvedValue(undefined), renderHandoff,
    } as unknown as RunBootstrapOptions;

    await runBootstrap(args, options);

    expect(args).not.toContain(phrase);
    expect(promptEncryptionPhrase).toHaveBeenCalledOnce();
    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ encryptionPhrase: phrase }));
  });

  it.each([
    ["cancellation", vi.fn().mockRejectedValue(new Error("PROMPT_CANCELLED"))],
    ["short phrase", vi.fn().mockResolvedValue("short")],
  ])("aborts bootstrap before apply when the optional phrase is %s", async (_label, promptEncryptionPhrase) => {
    const apply = vi.fn();
    const renderHandoff = vi.fn(async (config: { encryptionPhrase?: string }) => {
      if (config.encryptionPhrase && config.encryptionPhrase.length < 8) throw new Error("Code phrase must contain at least 8 characters");
      return { uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" };
    });
    const options = {
      host,
      prompt: vi.fn().mockResolvedValue("yes"),
      promptEncryptionPhrase,
      state: { inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) },
      apply, discloseInteractiveSecrets: vi.fn().mockResolvedValue(undefined), renderHandoff,
    } as unknown as RunBootstrapOptions;

    await expect(runBootstrap([
      "bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--email", "ops@example.test", "--vault-id", "notes",
    ], options)).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(renderHandoff).not.toHaveBeenCalled();
  });

  it("fails unattended creation before adapter authentication when no endpoint exists and never resolves one from an IP", async () => {
    const credentialStore = store("");
    const endpointResolver = vi.fn();
    const vaultAdapter = adapter();
    const options = vaultOptions({ credentialStore, createAdapter: () => vaultAdapter, endpointResolver, unattended: true }, []);

    await expect(runVaultCommand(["add", "--mode", "native", "--vault-id", "notes"], options)).rejects.toThrow(/endpoint/i);
    expect(endpointResolver).not.toHaveBeenCalled();
    expect(vaultAdapter.authenticate).not.toHaveBeenCalled();
    expect(vaultAdapter.write).not.toHaveBeenCalled();
  });

  it.each([
    ["add", [] as ManagedVaultUser[]],
    ["rotate", [{ vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$old" }] as ManagedVaultUser[]],
  ])("requires an explicit, managed, or prompted endpoint before %s can mutate the vault", async (action, users) => {
    const credentialStore = store("");
    const vaultAdapter = adapter(users);
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const options = vaultOptions({ credentialStore, createAdapter: () => vaultAdapter, renderHandoff }, users);

    await expect(runVaultCommand([action, "--mode", "native", "--vault-id", "notes"], options)).rejects.toThrow(/endpoint/i);
    expect(vaultAdapter.authenticate).not.toHaveBeenCalled();
    expect(vaultAdapter.write).not.toHaveBeenCalled();
    expect(credentialStore.writeVault).not.toHaveBeenCalled();
    expect(renderHandoff).not.toHaveBeenCalled();
  });

  it("does not hand off or retain a new credential when verification is unavailable", async () => {
    const credentialStore = store();
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const discloseInteractiveSecrets = vi.fn().mockResolvedValue(undefined);
    const options = vaultOptions({ credentialStore, renderHandoff, discloseInteractiveSecrets, createVerificationAdapter: undefined }, []);

    await expect(runVaultCommand([
      "add", "--mode", "native", "--vault-id", "notes", "--wss-endpoint", "wss://managed.example.test", "--keep",
    ], options)).rejects.toThrow(/verification/i);
    expect(renderHandoff).not.toHaveBeenCalled();
    expect(discloseInteractiveSecrets).not.toHaveBeenCalled();
    expect(credentialStore.writeVault).not.toHaveBeenCalled();
  });

  it("supports bootstrap --keep and emits a one-time vault-only handoff after verification", async () => {
    const credentialStore = store();
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const apply = vi.fn(async () => undefined);
    const options = {
      host, state: { inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) },
      apply, secretOutput: { writeFileAtomically: vi.fn().mockResolvedValue(undefined) }, credentialStore, renderHandoff,
    } as RunBootstrapOptions;

    await runBootstrap(bootstrapArgs(["--keep"]), options);
    expect(credentialStore.writeAdministrator).toHaveBeenCalled();
    expect(credentialStore.writeVault).toHaveBeenCalled();
    expect(renderHandoff).toHaveBeenCalledOnce();
    expect(renderHandoff.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ username: "fos-vault-notes" }));
    expect(renderHandoff.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({ username: "fos-admin" }));
    expect(renderHandoff.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ encryptionPhrase: "" }));
  });

  it("persists the administrator record before one-time handoff", async () => {
    const order: string[] = [];
    const credentialStore = store();
    const writeAdministrator = credentialStore.writeAdministrator as unknown as ReturnType<typeof vi.fn>;
    const secretOutput = { writeFileAtomically: vi.fn(async () => { order.push("handoff"); }) };
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const options = {
      host,
      state: { inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) },
      apply: vi.fn(), secretOutput, credentialStore, renderHandoff,
    } as RunBootstrapOptions;

    writeAdministrator.mockImplementationOnce(async () => { order.push("administrator"); });
    await runBootstrap(bootstrapArgs(), options);
    expect(order).toEqual(["administrator", "handoff"]);
  });

  it("delivers protected handoff once and reports a redacted failure when administrator persistence fails", async () => {
    const order: string[] = [];
    const credentialStore = store();
    const writeAdministrator = credentialStore.writeAdministrator as unknown as ReturnType<typeof vi.fn>;
    const secretOutput = { writeFileAtomically: vi.fn(async () => { order.push("handoff"); }) };
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const options = {
      host,
      state: { inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) },
      apply: vi.fn(), secretOutput, credentialStore, renderHandoff,
    } as RunBootstrapOptions;

    secretOutput.writeFileAtomically.mockClear();
    writeAdministrator.mockImplementationOnce(async () => {
      order.push("administrator");
      throw new Error("disk failure admin-secret");
    });
    let failure: unknown;
    try { await runBootstrap(bootstrapArgs(), options); }
    catch (error) { failure = error; }

    expect(secretOutput.writeFileAtomically).toHaveBeenCalledOnce();
    expect(String(failure)).toMatch(/credential store write failed/i);
    expect(String(failure)).not.toContain("admin-secret");
    expect(order).toEqual(["administrator", "handoff"]);
  });

  it("recovers admin and vault credentials through protected output when QR rendering fails", async () => {
    const secretOutput = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const renderHandoff = vi.fn().mockRejectedValue(new Error("QR renderer failed vault-secret"));
    const options = {
      host,
      state: { inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) },
      apply: vi.fn(), secretOutput, renderHandoff,
    } as RunBootstrapOptions;

    let failure: unknown;
    try { await runBootstrap(bootstrapArgs(), options); }
    catch (error) { failure = error; }

    expect(secretOutput.writeFileAtomically).toHaveBeenCalledOnce();
    const protectedContents = secretOutput.writeFileAtomically.mock.calls[0]?.[1] as string;
    expect(protectedContents).toContain("Administrator password:");
    expect(protectedContents).toContain("Vault password:");
    expect(String(failure)).toMatch(/handoff|render/i);
    expect(String(failure)).not.toContain("vault-secret");
  });

  it("recovers both credentials when state commit fails after server apply", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const secretOutput = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const state = {
      inventory: vi.fn().mockResolvedValue([]),
      writeStateAtomically: vi.fn().mockRejectedValue(new Error("state commit failed admin-secret")),
    };
    const options = { host, state, apply, secretOutput } as RunBootstrapOptions;

    let failure: unknown;
    try { await runBootstrap(bootstrapArgs(), options); }
    catch (error) { failure = error; }

    expect(apply).toHaveBeenCalledOnce();
    expect(secretOutput.writeFileAtomically).toHaveBeenCalledOnce();
    const protectedContents = secretOutput.writeFileAtomically.mock.calls[0]?.[1] as string;
    expect(protectedContents).toContain("Administrator password:");
    expect(protectedContents).toContain("Vault password:");
    expect(String(failure)).toMatch(/state|recovery|bootstrap/i);
    expect(String(failure)).not.toContain("admin-secret");
  });

  it("delivers protected bootstrap secrets even when administrator retention fails after apply", async () => {
    const credentialStore = store();
    (credentialStore.writeAdministrator as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("disk failure admin-secret"));
    const apply = vi.fn(async () => undefined);
    const secretOutput = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const options = {
      host,
      state: { inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) },
      apply,
      secretOutput,
      credentialStore,
    } as RunBootstrapOptions;

    let failure: unknown;
    try {
      await runBootstrap(bootstrapArgs(), options);
    } catch (error) {
      failure = error;
    }
    expect(apply).toHaveBeenCalledOnce();
    expect(secretOutput.writeFileAtomically).toHaveBeenCalledOnce();
    expect(String(failure)).toMatch(/credential store write failed/i);
    expect(String(failure)).not.toContain("admin-secret");
  });

  it("retains only the vault credential for --keep on add/rotate and excludes administrator handoff data", async () => {
    const credentialStore = store();
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const options = vaultOptions({ credentialStore, renderHandoff });

    await runVaultCommand(["add", "--mode", "native", "--vault-id", "notes", "--keep"], vaultOptions({ credentialStore, renderHandoff }, []));
    await runVaultCommand(["rotate", "--mode", "native", "--vault-id", "notes", "--keep"], options);
    expect(credentialStore.writeVault).toHaveBeenCalled();
    expect(credentialStore.writeAdministrator).not.toHaveBeenCalled();
    expect(renderHandoff).toHaveBeenCalledTimes(2);
    expect(renderHandoff.mock.calls.flat().join(" ")).not.toContain("admin-secret");
  });

  it("prompts for an optional phrase on interactive vault-user handoff", async () => {
    const phrase = "phrase-123";
    const promptEncryptionPhrase = vi.fn().mockResolvedValue(phrase);
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=1.payload", qr: "QR" });
    const args = ["add", "--mode", "native", "--vault-id", "notes", "--wss-endpoint", "wss://managed.example.test"];

    await runVaultCommand(args, vaultOptions({ renderHandoff, promptEncryptionPhrase }, []));

    expect(args).not.toContain(phrase);
    expect(promptEncryptionPhrase).toHaveBeenCalledOnce();
    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ encryptionPhrase: phrase }));
  });

  it.each([
    ["add", [] as ManagedVaultUser[]],
    ["rotate", [{ vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$old" }] as ManagedVaultUser[]],
  ])("aborts %s before server mutation when the optional phrase prompt is cancelled", async (action, users) => {
    const credentialStore = store();
    const vaultAdapter = adapter(users);
    const promptEncryptionPhrase = vi.fn().mockRejectedValue(new Error("PROMPT_CANCELLED"));
    const renderHandoff = vi.fn();
    const options = vaultOptions({ credentialStore, createAdapter: () => vaultAdapter, promptEncryptionPhrase, renderHandoff }, users);

    await expect(runVaultCommand([action, "--mode", "native", "--vault-id", "notes", "--wss-endpoint", "wss://managed.example.test",
      ...(action === "rotate" ? ["--keep"] : [])], options)).rejects.toThrow(/cancel/i);
    expect(vaultAdapter.write).not.toHaveBeenCalled();
    expect(credentialStore.writeVault).not.toHaveBeenCalled();
    expect(credentialStore.removeVault).not.toHaveBeenCalled();
    expect(renderHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ["add", [] as ManagedVaultUser[]],
    ["rotate", [{ vaultId: "notes", username: "fos-vault-notes", passwordHash: "$2a$12$old" }] as ManagedVaultUser[]],
  ])("aborts %s before server mutation when the optional phrase is shorter than eight characters", async (action, users) => {
    const credentialStore = store();
    const vaultAdapter = adapter(users);
    const promptEncryptionPhrase = vi.fn().mockResolvedValue("short");
    const renderHandoff = vi.fn(async (config: { encryptionPhrase?: string }) => {
      if (config.encryptionPhrase && config.encryptionPhrase.length < 8) throw new Error("Code phrase must contain at least 8 characters");
      return { uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" };
    });
    const options = vaultOptions({ credentialStore, createAdapter: () => vaultAdapter, promptEncryptionPhrase, renderHandoff }, users);

    await expect(runVaultCommand([action, "--mode", "native", "--vault-id", "notes", "--wss-endpoint", "wss://managed.example.test",
      ...(action === "rotate" ? ["--keep"] : [])], options)).rejects.toThrow(/8|phrase/i);
    expect(vaultAdapter.write).not.toHaveBeenCalled();
    expect(credentialStore.writeVault).not.toHaveBeenCalled();
    expect(credentialStore.removeVault).not.toHaveBeenCalled();
  });

  it("defaults an unattended vault-user handoff to an empty phrase", async () => {
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });
    const secretOutput = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const args = ["add", "--mode", "native", "--vault-id", "notes", "--wss-endpoint", "wss://managed.example.test",
      "--admin-input", "/root/admin", "--secrets-output", "/root/new"];
    const options = vaultOptions({
      renderHandoff, secretOutput,
      host: { ...host, readProtectedInput: vi.fn().mockResolvedValue({ content: "admin-secret", uid: 0, mode: 0o600 }) },
    }, []);

    await runVaultCommand(args, options);

    expect(renderHandoff).toHaveBeenCalledWith(expect.objectContaining({ encryptionPhrase: "" }));
    expect(secretOutput.writeFileAtomically).toHaveBeenCalled();
  });

  it("does not render a handoff when add finds an existing vault user", async () => {
    const credentialStore = store();
    const renderHandoff = vi.fn().mockResolvedValue({ uri: "obsidian://flash-sync-import?data=2.payload", qr: "QR" });

    await runVaultCommand(["add", "--mode", "native", "--vault-id", "notes"], vaultOptions({ credentialStore, renderHandoff }));

    expect(renderHandoff).not.toHaveBeenCalled();
    expect(credentialStore.writeVault).not.toHaveBeenCalled();
  });
});
