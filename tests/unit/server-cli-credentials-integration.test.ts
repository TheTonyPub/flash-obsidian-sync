import { describe, expect, it, vi } from "vitest";
import { renderNatsAuthorization, type BootstrapCredentials, type SecretOutputAdapter } from "../../packages/server-cli/src/credentials.js";
import { runBootstrap, type BootstrapPlan, type HostAdapter, type RunBootstrapOptions } from "../../packages/server-cli/src/cli.js";
import type { OwnedStateAdapter } from "../../packages/server-cli/src/state.js";

const host: HostAdapter = {
  platform: () => ({ distribution: "debian", release: "13", architecture: "amd64" }),
};

function bootstrapArgs(): string[] {
  return ["bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--vault-id", "notes", "--non-interactive", "--input", "/root/fos-input.json", "--secrets-output", "/root/fos-secrets", "--approve"];
}

function protectedHost(): HostAdapter {
  return {
    ...host,
    readProtectedInput: vi.fn().mockResolvedValue({
      content: JSON.stringify({ mode: "docker", domain: "sync.example.test", vaultId: "notes" }),
      uid: 0,
      mode: 0o600,
    }),
  };
}

type CredentialOptions = RunBootstrapOptions & {
  apply: (plan: BootstrapPlan, credentials: BootstrapCredentials) => Promise<void>;
  secretOutput: SecretOutputAdapter;
};

function stateAdapter(): OwnedStateAdapter & { inventory: ReturnType<typeof vi.fn>; writeStateAtomically: ReturnType<typeof vi.fn> } {
  let manifest: ReturnType<typeof JSON.parse> | undefined;
  return {
    inventory: vi.fn().mockImplementation(async () => manifest ? [{
      kind: "state" as const,
      value: "/opt/flash-osidian-sync/state.json",
      owned: true,
      manifest,
    }] : []),
    writeStateAtomically: vi.fn().mockImplementation(async (_path: string, contents: string) => {
      manifest = JSON.parse(contents);
    }),
  };
}

describe("fos bootstrap credential integration", () => {
  it("writes only credential hashes into deployment configuration, then hands secrets off after endpoint verification", async () => {
    const events: string[] = [];
    const state = stateAdapter();
    const secretOutput = { writeFileAtomically: vi.fn().mockImplementation(async () => { events.push("handoff"); }) };
    const apply = vi.fn().mockImplementation(async (_plan: BootstrapPlan, credentials: BootstrapCredentials) => {
      const authorization = renderNatsAuthorization(credentials);
      expect(authorization).toContain(credentials.administrator.passwordHash);
      expect(authorization).toContain(credentials.vault.passwordHash);
      expect(authorization).not.toContain(credentials.administrator.password);
      expect(authorization).not.toContain(credentials.vault.password);
      events.push("configuration-written");
      events.push("endpoint-verified");
    });

    await runBootstrap(bootstrapArgs(), {
      host: protectedHost(), state, apply, secretOutput,
    } as CredentialOptions);

    expect(events).toEqual(["configuration-written", "endpoint-verified", "handoff"]);
    expect(secretOutput.writeFileAtomically).toHaveBeenCalledWith(
      "/root/fos-secrets",
      expect.stringContaining("Administrator password:"),
      { owner: 0, mode: 0o600 },
    );
  });

  it("does not hand credentials off when deployment endpoint verification fails", async () => {
    const secretOutput = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const apply = vi.fn().mockRejectedValue(new Error("TLS_CERTIFICATE_UNVERIFIED"));

    await expect(runBootstrap(bootstrapArgs(), {
      host: protectedHost(), state: stateAdapter(), apply, secretOutput,
    } as CredentialOptions)).rejects.toThrow("TLS_CERTIFICATE_UNVERIFIED");

    expect(secretOutput.writeFileAtomically).not.toHaveBeenCalled();
  });

  it("does not commit state or hand off secrets if first-vault scoped verification fails after deployment", async () => {
    const state = stateAdapter();
    const secretOutput = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const apply = vi.fn().mockRejectedValue(new Error("FIRST_VAULT_VERIFICATION_FAILED"));

    await expect(runBootstrap(bootstrapArgs(), {
      host: protectedHost(), state, apply, secretOutput,
    } as CredentialOptions)).rejects.toThrow("FIRST_VAULT_VERIFICATION_FAILED");

    expect(state.writeStateAtomically).not.toHaveBeenCalled();
    expect(secretOutput.writeFileAtomically).not.toHaveBeenCalled();
  });

  it("refuses a repeated bootstrap without redisplaying or replacing credential handoff", async () => {
    const state = stateAdapter();
    const secretOutput = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };
    const apply = vi.fn().mockResolvedValue(undefined);
    const options = { host: protectedHost(), state, apply, secretOutput } as CredentialOptions;

    await runBootstrap(bootstrapArgs(), options);
    const firstHandoff = secretOutput.writeFileAtomically.mock.calls[0]?.[1];
    expect(firstHandoff).toContain("Flash Osidian Sync credentials");

    await expect(runBootstrap(bootstrapArgs(), options)).rejects.toThrow("CREDENTIAL_RECOVERY_UNAVAILABLE");
    expect(apply).toHaveBeenCalledOnce();
    expect(secretOutput.writeFileAtomically).toHaveBeenCalledOnce();
  });
});
