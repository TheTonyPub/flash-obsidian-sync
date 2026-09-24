import { describe, expect, it, vi } from "vitest";
import type { BootstrapPlan } from "../../packages/server-cli/src/cli.js";
import { createBootstrapApply, createHostOptionsAdapter, createVaultUserAdapter, type BootstrapRuntime } from "../../packages/server-cli/src/host-deployment.js";
import { applyFirewallOption } from "../../packages/server-cli/src/host-options.js";
import { planBackupSchedule } from "../../packages/server-cli/src/backup.js";
import type { EndpointReadinessOptions } from "../../packages/server-cli/src/tls.js";

const plan: BootstrapPlan = {
  mode: "docker", domain: "sync.example.test", vaultId: "notes",
  installPath: "/opt/flash-osidian-sync", dataPath: "/var/lib/flash-osidian-sync", logPath: "/var/log/flash-osidian-sync",
  systemdServices: ["fos-nats", "fos-caddy"], composeProject: "flash-osidian-sync", preview: "fos docker plan",
};

function runtime(overrides: Partial<BootstrapRuntime> = {}): BootstrapRuntime {
  return {
    uid: () => 0,
    run: vi.fn().mockImplementation(async (command: readonly string[]) => {
      if (command[0] === "docker" && command[1] === "--version") return "Docker version 27.0.0";
      if (command[0] === "docker" && command[1] === "compose" && command[2] === "version") return "Docker Compose version v2.29.0";
      return "";
    }),
    pathInfo: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeText: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    randomId: () => "test",
    resolveDomain: vi.fn().mockResolvedValue(["203.0.113.1"]),
    portReachable: vi.fn().mockResolvedValue(true),
    verifyCertificate: vi.fn().mockResolvedValue(true),
    verifyWss: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function readinessClock(timeoutMs = 250): EndpointReadinessOptions {
  let time = 0;
  return {
    timeoutMs,
    initialDelayMs: 100,
    maxDelayMs: 200,
    now: () => time,
    sleep: async (milliseconds) => { time += milliseconds; },
  };
}

describe("fos bootstrap deployment wiring", () => {
  it("replaces the managed NATS block literally when hashes contain replacement tokens", async () => {
    const current = "before\n# fos-managed-authorization:start\nold\n# fos-managed-authorization:end\nafter\n";
    const replacement = '# fos-managed-authorization:start\nauthorization { users: [{ user: "fos-vault-notes", password: "$2b$12$fixedhash" }] }\n# fos-managed-authorization:end\n';
    const host = runtime({ readText: vi.fn().mockResolvedValue(current) });
    const adapter = createVaultUserAdapter(host, plan);

    await adapter.validate(replacement);

    expect(host.writeText).toHaveBeenCalledWith(
      "/opt/flash-osidian-sync/.nats-server.conf.test.validate",
      `before\n${replacement}after\n`,
      0o640,
    );
  });

  it("validates Compose NATS config through a unique mount path", async () => {
    const config = '# fos-managed-authorization:start\nauthorization { users = [{ user: "fos-admin", password: "hash" }] }\n# fos-managed-authorization:end\n';
    const host = runtime({ readText: vi.fn().mockResolvedValue(config) });
    const adapter = createVaultUserAdapter(host, { ...plan, mode: "podman" });

    await adapter.validate(config);

    const command = vi.mocked(host.run).mock.calls[0]![0];
    expect(command).toContain("run");
    expect(command.some((part) => part.includes(":/etc/nats/nats-server.conf:ro"))).toBe(false);
    const mount = command[command.indexOf("-v") + 1]!;
    expect(mount.split(":").slice(1).join(":")).toMatch(/^\/tmp\//);
    const natsIndex = command.lastIndexOf("nats");
    expect(command.slice(natsIndex + 1)).toEqual(["-c", mount.split(":").slice(1).join(":").replace(/:ro$/, ""), "-t"]);
  });

  it.each(["docker", "podman"] as const)("refreshes the %s config mount after atomic writes and rollback", async (mode) => {
    const original = "# fos-managed-authorization:start\nold\n# fos-managed-authorization:end\n";
    const updated = "# fos-managed-authorization:start\nnew\n# fos-managed-authorization:end\n";
    const configPath = `${plan.installPath}/nats-server.conf`;
    const files = new Map([[configPath, original]]);
    let mountedConfig = original;
    const host = runtime({
      readText: async (path) => files.get(path)!,
      writeText: async (path, contents) => { files.set(path, contents); },
      rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        // A single-file bind mount retains its inode across an atomic host rename.
        // Only recreating the service attaches the replacement file.
        if (command.includes("--force-recreate") && command.at(-1) === "nats") mountedConfig = files.get(configPath)!;
        return "";
      }),
    });
    const adapter = createVaultUserAdapter(host, { ...plan, mode });
    await adapter.write(updated);
    expect(mountedConfig).toBe(original);
    await adapter.reload();
    expect(mountedConfig).toBe(updated);
    await adapter.restore(original);
    expect(mountedConfig).toBe(original);
    expect(host.run).toHaveBeenCalledWith(expect.arrayContaining(["up", "-d", "--no-deps", "--force-recreate", "nats"]));
  });

  it("keeps SSH verification successful while UFW is inactive", async () => {
    const host = runtime({ run: vi.fn().mockImplementation(async (command: readonly string[]) => {
      if (command[0] === "ss") return 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))';
      if (command[0] === "ufw" && command[1] === "status") return "Status: inactive";
      return "";
    }) });

    await expect(applyFirewallOption({ enabled: true, confirmed: true }, createHostOptionsAdapter(host)))
      .resolves.toBe("applied");
    expect(host.run).not.toHaveBeenCalledWith(["ufw", "delete", "allow", "22/tcp"]);
  });

  it("matches active UFW rules by exact SSH port", async () => {
    const host = runtime({ run: vi.fn().mockResolvedValue("Status: active\n\nTo Action From\n22/tcp DENY Anywhere\n2222/tcp ALLOW Anywhere\n") });
    const adapter = createHostOptionsAdapter(host);

    await expect(adapter.verifySsh(22)).resolves.toBe(false);
    await expect(adapter.verifySsh(2222)).resolves.toBe(true);
  });

  it("runs the selected backend then verifies the published WSS endpoint", async () => {
    const host = runtime();

    await createBootstrapApply(host)(plan);

    expect(host.run).toHaveBeenCalledWith(["docker", "compose", "-p", "flash-osidian-sync", "-f", "/opt/flash-osidian-sync/compose.yaml", "up", "-d"]);
    expect(host.verifyWss).toHaveBeenCalledWith("wss://sync.example.test", expect.any(Number));
  });

  it("does not report success when endpoint verification fails", async () => {
    const host = runtime({ verifyCertificate: vi.fn().mockResolvedValue(false) });

    await expect(createBootstrapApply(host, readinessClock())(plan)).rejects.toThrow("TLS_CERTIFICATE_UNVERIFIED");
    expect(host.verifyWss).not.toHaveBeenCalled();
  });

  it("verifies the first vault with scoped credentials before bootstrap apply resolves", async () => {
    const actions: string[] = [];
    const host = runtime({ runWithInput: vi.fn().mockImplementation(async (_command: readonly string[], input: string) => {
      const request = JSON.parse(input) as { action: string };
      actions.push(request.action);
      return request.action === "list" ? "[]" : request.action === "verify" ? '{"crossBucket":"not-tested"}' : "{}";
    }) });
    const credentials = {
      administrator: { username: "fos-admin", password: "admin-secret", passwordHash: "admin-hash" },
      vault: { username: "fos-vault-notes", password: "vault-secret", passwordHash: "vault-hash" },
    };

    await createBootstrapApply(host)(plan, credentials);

    expect(actions).toEqual(["list", "list", "create", "verify"]);
    const verifyCall = (host.runWithInput as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(JSON.parse(verifyCall?.[1] as string)).toMatchObject({
      action: "verify", username: "fos-vault-notes", password: "vault-secret", vaultId: "notes",
    });
    expect(JSON.parse(verifyCall?.[1] as string).crossVaultId).toBeUndefined();
  });

  it("blocks successful bootstrap when first-vault scoped verification fails", async () => {
    const host = runtime({ runWithInput: vi.fn().mockImplementation(async (_command: readonly string[], input: string) => {
      const request = JSON.parse(input) as { action: string };
      if (request.action === "list") return "[]";
      if (request.action === "verify") throw new Error("permission violation or timeout");
      return "{}";
    }) });
    const credentials = {
      administrator: { username: "fos-admin", password: "admin-secret", passwordHash: "admin-hash" },
      vault: { username: "fos-vault-notes", password: "vault-secret", passwordHash: "vault-hash" },
    };

    await expect(createBootstrapApply(host)(plan, credentials)).rejects.toThrow("FIRST_VAULT_VERIFICATION_FAILED");
  });

  it("rejects non-root local deployment before writing managed files", async () => {
    const host = runtime({ uid: () => 1000 });

    await expect(createBootstrapApply(host)(plan)).rejects.toThrow("ROOT_REQUIRED");
    expect(host.writeText).not.toHaveBeenCalled();
  });

  it("does not inspect or mutate UFW when firewall management is omitted", async () => {
    const host = runtime();
    await createBootstrapApply(host)(plan);
    expect(host.run).not.toHaveBeenCalledWith(["ufw", "status"]);
    expect(host.run).not.toHaveBeenCalledWith(expect.arrayContaining(["ufw", "allow"]));
  });

  it("stages the detected SSH rule and removes only added UFW rules when verification fails", async () => {
    const host = runtime();
    const run = host.run as ReturnType<typeof vi.fn>;
    run.mockImplementation(async (command: readonly string[]) => {
      if (command.join(" ") === "ss -H -ltnp") return 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=1,fd=3))';
      if (command[0] === "ufw" && command[1] === "status") return "Status: active";
      if (command[0] === "docker" && command[1] === "--version") return "Docker version 27.0.0";
      if (command[0] === "docker" && command[1] === "compose") return "Docker Compose version v2.29.0";
      return "";
    });
    const selected: BootstrapPlan = { ...plan, hostOptions: {
      firewall: { enabled: true, confirmed: true }, identity: { kind: "existing", user: "fos-nats", group: "fos-nats" },
    } };
    await expect(createBootstrapApply(host)(selected)).rejects.toThrow("SSH_PRESERVATION_FAILED");
    expect(host.run).toHaveBeenCalledWith(["ufw", "allow", "2222/tcp"]);
    expect(host.run).toHaveBeenCalledWith(["ufw", "allow", "80/tcp"]);
    expect(host.run).toHaveBeenCalledWith(["ufw", "allow", "443/tcp"]);
    expect(host.run).toHaveBeenCalledWith(["ufw", "delete", "allow", "443/tcp"]);
    expect(host.run).toHaveBeenCalledWith(["ufw", "delete", "allow", "2222/tcp"]);
  });

  it("writes and enables a backup timer only when the plan explicitly selects one", async () => {
    const host = runtime();
    const scheduled: BootstrapPlan = { ...plan, backupSchedule: planBackupSchedule({ enabled: true, destination: "/backup", retention: 2, interval: "daily" }) };
    await createBootstrapApply(host)(scheduled);
    expect(host.writeText).toHaveBeenCalledWith(expect.stringContaining("fos-backup.service"), expect.stringContaining("User=root"), 0o644);
    expect(host.run).toHaveBeenCalledWith(["systemctl", "enable", "--now", "fos-backup.timer"]);
  });

  it("refuses an unrelated existing backup timer before writing or enabling it", async () => {
    const host = runtime({ pathInfo: vi.fn().mockImplementation(async (path: string) => path.endsWith("fos-backup.timer")
      ? { isFile: true, isSymbolicLink: false, uid: 0, mode: 0o644 } : undefined) });
    const scheduled: BootstrapPlan = { ...plan, backupSchedule: planBackupSchedule({ enabled: true, destination: "/backup", retention: 2, interval: "daily" }) };
    await expect(createBootstrapApply(host)(scheduled)).rejects.toThrow("BACKUP_SCHEDULE_CONFLICT");
    expect(host.writeText).not.toHaveBeenCalled();
  });
});
