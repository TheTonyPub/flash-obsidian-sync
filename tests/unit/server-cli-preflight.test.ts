import { describe, expect, it, vi } from "vitest";
import {
  buildBootstrapPlan,
  parseBootstrapRequest,
  runBootstrap,
  type HostAdapter,
} from "../../packages/server-cli/src/cli.js";
import { readLocalPlatform, readLocalProtectedInput } from "../../packages/server-cli/src/host.js";
import type { OwnedStateAdapter } from "../../packages/server-cli/src/state.js";

const supportedHost = (): HostAdapter => ({
  platform: () => ({ distribution: "debian", release: "13", architecture: "amd64" }),
});
const state = (): OwnedStateAdapter => ({ inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn().mockResolvedValue(undefined) });
const secrets = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };

describe("fos bootstrap preflight", () => {
  it("uses fos names and flash-osidian-sync managed paths without changing NATS bucket naming", async () => {
    const native = await buildBootstrapPlan(parseBootstrapRequest([
      "bootstrap", "--mode", "native", "--domain", "sync.example.test", "--vault-id", "notes",
    ]), supportedHost());
    expect(native.preview).toContain("fos bootstrap plan");
    expect(native.preview).toContain("/etc/flash-osidian-sync");
    expect(native.preview).toContain("/var/lib/flash-osidian-sync");
    expect(native.preview).toContain("/var/log/flash-osidian-sync");
    expect(native.preview).toContain("fos-nats");
    expect(native.preview).toContain("fos-caddy");

    const compose = await buildBootstrapPlan(parseBootstrapRequest([
      "bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--vault-id", "notes",
    ]), supportedHost());
    expect(compose.preview).toContain("/opt/flash-osidian-sync");
    expect(compose.preview).toContain("flash-osidian-sync");
    expect(compose.preview).not.toContain("OBS_NOTES_FILES");
  });

  it("fails closed if a legacy easy-sync-server managed path exists", async () => {
    const request = parseBootstrapRequest([
      "bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--vault-id", "notes",
    ]);
    await expect(buildBootstrapPlan(request, {
      ...supportedHost(), pathExists: async (path) => path === "/opt/easy-sync-server",
    })).rejects.toThrow("LEGACY_MANAGED_PATH_EXISTS");
  });

  it("rejects an unsupported platform before a plan or mutation", async () => {
    const apply = vi.fn();
    const request = parseBootstrapRequest([
      "bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--vault-id", "notes",
    ], supportedHost());

    await expect(buildBootstrapPlan(request, {
      platform: () => ({ distribution: "ubuntu", release: "22.04", architecture: "amd64" }),
    })).rejects.toThrow("UNSUPPORTED_PLATFORM");
    expect(apply).not.toHaveBeenCalled();
  });

  it("accepts Debian 13 only from the Debian release line", async () => {
    const request = parseBootstrapRequest([
      "bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--vault-id", "notes",
    ]);
    await expect(buildBootstrapPlan(request, {
      platform: () => ({ distribution: "debian", release: "12", architecture: "amd64" }),
    })).rejects.toThrow("UNSUPPORTED_PLATFORM");
  });

  it("accepts Ubuntu 26.04 amd64 in all installation modes", async () => {
    const platform = () => ({ distribution: "ubuntu", release: "26.04", architecture: "amd64" });
    for (const mode of ["native", "docker", "podman"] as const) {
      const request = parseBootstrapRequest([
        "bootstrap", "--mode", mode, "--domain", "sync.example.test", "--vault-id", "notes",
      ]);
      await expect(buildBootstrapPlan(request, { platform })).resolves.toMatchObject({ mode });
    }
  });

  it("rejects a remote target and never invokes a host mutation", async () => {
    const apply = vi.fn();

    await expect(runBootstrap([
      "bootstrap", "--host", "sync.example.test", "--mode", "native", "--domain", "sync.example.test", "--vault-id", "notes",
    ], { host: supportedHost(), apply })).rejects.toThrow("REMOTE_TARGET_UNSUPPORTED");

    expect(apply).not.toHaveBeenCalled();
  });

  it("requires a valid endpoint domain before planning", async () => {
    const request = parseBootstrapRequest([
      "bootstrap", "--mode", "podman", "--vault-id", "notes",
    ], supportedHost());

    await expect(buildBootstrapPlan(request, supportedHost())).rejects.toThrow("DOMAIN_REQUIRED");
  });

  it("collects interactive choices, renders a redacted preview, and waits for confirmation", async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce("docker")
      .mockResolvedValueOnce("sync.example.test")
      .mockResolvedValueOnce("ops@example.test")
      .mockResolvedValueOnce("notes")
      .mockResolvedValueOnce("no").mockResolvedValueOnce("no")
      .mockResolvedValueOnce("no");
    const apply = vi.fn();

    const result = await runBootstrap(["bootstrap"], { host: supportedHost(), prompt, apply });

    expect(prompt).toHaveBeenCalled();
    expect(result.preview).toContain("sync.example.test");
    expect(result.preview).toContain("docker");
    expect(result.preview).toContain("/opt/flash-osidian-sync");
    expect(result.preview).not.toMatch(/password\s*[:=]\s*\S+/i);
    expect(result.applied).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies only after the interactive confirmation", async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce("native")
      .mockResolvedValueOnce("sync.example.test")
      .mockResolvedValueOnce("ops@example.test")
      .mockResolvedValueOnce("notes")
      .mockResolvedValueOnce("no").mockResolvedValueOnce("no")
      .mockResolvedValueOnce("yes");
    const apply = vi.fn();

    const result = await runBootstrap(["bootstrap"], { host: supportedHost(), prompt, apply, state: state(), discloseInteractiveSecrets: vi.fn() });

    expect(result.applied).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("commits owned state only after the injected apply succeeds", async () => {
    const state: OwnedStateAdapter & { writeStateAtomically: ReturnType<typeof vi.fn> } = {
      inventory: vi.fn().mockResolvedValue([]), writeStateAtomically: vi.fn(),
    };
    await expect(runBootstrap([
      "bootstrap", "--mode", "docker", "--domain", "sync.example.test", "--email", "ops@example.test", "--vault-id", "notes",
    ], { host: supportedHost(), prompt: vi.fn().mockResolvedValue("yes"), state, apply: vi.fn().mockRejectedValue(new Error("APPLY_FAILED")), discloseInteractiveSecrets: vi.fn() })).rejects.toThrow("APPLY_FAILED");
    expect(state.writeStateAtomically).not.toHaveBeenCalled();
  });

  it("has a read-only status command and fails explicitly without an inventory adapter", async () => {
    await expect(runBootstrap(["status"], { host: supportedHost() })).rejects.toThrow("STATUS_ADAPTER_REQUIRED");
    const result = await runBootstrap(["status"], { host: supportedHost(), state: {
      inventory: async () => [], writeStateAtomically: async () => { throw new Error("must not write"); },
    } });
    expect(result.applied).toBe(false);
    expect(result.preview).toContain("NOT_INSTALLED");
  });

  it("shows the preview before asking for confirmation, including when choices were supplied", async () => {
    const events: string[] = [];
    const prompt = vi.fn(async (question: string) => {
      if (!question.includes("Apply this plan")) return "no";
      events.push("confirm");
      return "no";
    });
    const result = await runBootstrap([
      "bootstrap", "--mode", "native", "--domain", "sync.example.test", "--email", "ops@example.test", "--vault-id", "notes",
    ], {
      host: supportedHost(), prompt,
      showPreview: async (preview) => { events.push(`preview:${preview}`); },
    });

    expect(events[0]).toContain("install path: /etc/flash-osidian-sync");
    expect(events[1]).toBe("confirm");
    expect(result.applied).toBe(false);
  });

  it("requires protected unattended input, secrets output, and approval without prompting", async () => {
    const prompt = vi.fn();

    await expect(runBootstrap(["bootstrap", "--non-interactive", "--approve", "--secrets-output", "/root/secrets"], {
      host: supportedHost(), prompt, apply: vi.fn(),
    })).rejects.toThrow("NONINTERACTIVE_INPUT_REQUIRED");
    expect(prompt).not.toHaveBeenCalled();

    await expect(runBootstrap(["bootstrap", "--non-interactive", "--input", "/root/request.json", "--approve"], {
      host: supportedHost(), prompt, apply: vi.fn(),
    })).rejects.toThrow("NONINTERACTIVE_SECRETS_OUTPUT_REQUIRED");

    await expect(runBootstrap(["bootstrap", "--non-interactive", "--input", "/root/request.json", "--secrets-output", "/root/secrets"], {
      host: supportedHost(), prompt, apply: vi.fn(),
    })).rejects.toThrow("CONFIRMATION_REQUIRED");
  });

  it("reads a root-owned 0600 unattended request and rejects unprotected input", async () => {
    const apply = vi.fn();
    const readProtectedInput = vi.fn().mockResolvedValue({
      content: JSON.stringify({ mode: "podman", domain: "sync.example.test", email: "ops@example.test", vaultId: "notes" }),
      mode: 0o600, uid: 0,
    });
    const result = await runBootstrap([
      "bootstrap", "--non-interactive", "--input", "/root/request.json", "--secrets-output", "/root/secrets", "--approve",
    ], { host: { ...supportedHost(), readProtectedInput }, apply, state: state(), secretOutput: secrets });
    expect(readProtectedInput).toHaveBeenCalledWith("/root/request.json");
    expect(result.applied).toBe(true);

    await expect(runBootstrap([
      "bootstrap", "--non-interactive", "--input", "/root/request.json", "--secrets-output", "/root/secrets", "--approve",
    ], { host: { ...supportedHost(), readProtectedInput: async () => ({ content: "{}", mode: 0o644, uid: 0 }) }, apply })).rejects.toThrow("UNPROTECTED_INPUT");
  });
});

describe("local platform probe", () => {
  it("reads Debian release and maps Node architecture without mutating the host", async () => {
    await expect(readLocalPlatform(async () => "ID=debian\nVERSION_ID=13\n", "x64")).resolves.toEqual({
      distribution: "debian", release: "13", architecture: "amd64",
    });
  });

  it("reads unattended input with its mode and owner metadata", async () => {
    await expect(readLocalProtectedInput("/root/request.json", async () => "{}", async () => ({ mode: 0o100600, uid: 0 }))).resolves.toEqual({
      content: "{}", mode: 0o100600, uid: 0,
    });
  });
});
