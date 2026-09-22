import { describe, expect, it, vi } from "vitest";
import type { BootstrapPlan } from "../../packages/server-cli/src/cli.js";
import {
  installNativeDeployment,
  planNativeDeployment,
  type NativeDeploymentAdapter,
} from "../../packages/server-cli/src/native.js";
import { nativeCompatibilityLock } from "../../packages/server-cli/src/native-compatibility.js";

const plan: BootstrapPlan = {
  mode: "native",
  domain: "sync.example.test",
  vaultId: "notes",
  installPath: "/etc/flash-osidian-sync",
  dataPath: "/var/lib/flash-osidian-sync",
  logPath: "/var/log/flash-osidian-sync",
  systemdServices: ["fos-nats", "fos-caddy"],
  preview: "fos native plan",
};

function nativeHost(overrides: Partial<NativeDeploymentAdapter> = {}): NativeDeploymentAdapter & {
  writeFileAtomically: ReturnType<typeof vi.fn>;
  enableAndStart: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
} {
  return {
    platform: vi.fn().mockResolvedValue({ distribution: "debian", release: "13", architecture: "amd64" }),
    packageManagerAvailable: vi.fn().mockResolvedValue(true),
    packageVersionAvailable: vi.fn().mockResolvedValue(true),
    identityAvailable: vi.fn().mockResolvedValue(true),
    inventory: vi.fn().mockResolvedValue([]),
    writeFileAtomically: vi.fn().mockResolvedValue(undefined),
    enableAndStart: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue(undefined),
    groupAvailable: vi.fn().mockResolvedValue(true),
    vendorServicePresent: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as NativeDeploymentAdapter & { writeFileAtomically: ReturnType<typeof vi.fn>; enableAndStart: ReturnType<typeof vi.fn>; runCommand: ReturnType<typeof vi.fn> };
}

describe("fos native Debian/Ubuntu deployment", () => {
  it("rejects unsupported native hosts and unavailable package sources before writing", async () => {
    const unsupported = nativeHost({
      platform: vi.fn().mockResolvedValue({ distribution: "ubuntu", release: "22.04", architecture: "amd64" }),
    });
    await expect(installNativeDeployment(plan, unsupported)).rejects.toThrow("UNSUPPORTED_PLATFORM");
    expect(unsupported.writeFileAtomically).not.toHaveBeenCalled();
    expect(unsupported.enableAndStart).not.toHaveBeenCalled();

    const unavailableSource = nativeHost({ packageVersionAvailable: vi.fn().mockResolvedValue(false) });
    await expect(installNativeDeployment(plan, unavailableSource)).rejects.toThrow("NATIVE_PACKAGE_SOURCE_UNAVAILABLE");
    expect(unavailableSource.writeFileAtomically).not.toHaveBeenCalled();
  });

  it("uses the fos 0.1.0 Debian 13 amd64 APT compatibility lock", async () => {
    const host = nativeHost();
    const deployment = await planNativeDeployment(plan, host);

    expect(nativeCompatibilityLock).toMatchObject({ cliVersion: "0.1.0" });
    expect(deployment.packages).toEqual([
      { name: "nats-server", version: "2.10.27-1+b2" },
      { name: "caddy", version: "2.6.2-12+deb13u1" },
    ]);
    expect(deployment.commands).toContainEqual([
      "apt-get", "install", "--yes",
      "nats-server=2.10.27-1+b2", "caddy=2.6.2-12+deb13u1",
    ]);
    expect(host.packageVersionAvailable).toHaveBeenNthCalledWith(1, "nats-server", "2.10.27-1+b2");
    expect(host.packageVersionAvailable).toHaveBeenNthCalledWith(2, "caddy", "2.6.2-12+deb13u1");
  });

  it("uses the fos 0.1.0 Ubuntu 24.04 amd64 APT compatibility lock", async () => {
    const ubuntuHost = nativeHost({
      platform: vi.fn().mockResolvedValue({ distribution: "ubuntu", release: "24.04", architecture: "amd64" }),
    });
    const deployment = await planNativeDeployment(plan, ubuntuHost);

    expect(deployment.packages).toEqual([
      { name: "nats-server", version: "2.10.7-1ubuntu0.3" },
      { name: "caddy", version: "2.6.2-6ubuntu0.24.04.3" },
    ]);
    expect(deployment.commands).toContainEqual([
      "apt-get", "install", "--yes",
      "nats-server=2.10.7-1ubuntu0.3", "caddy=2.6.2-6ubuntu0.24.04.3",
    ]);
    expect(ubuntuHost.packageVersionAvailable).toHaveBeenNthCalledWith(1, "nats-server", "2.10.7-1ubuntu0.3");
    expect(ubuntuHost.packageVersionAvailable).toHaveBeenNthCalledWith(2, "caddy", "2.6.2-6ubuntu0.24.04.3");
  });

  it("uses the fos 0.1.0 Ubuntu 26.04 amd64 APT compatibility lock", async () => {
    const ubuntuHost = nativeHost({
      platform: vi.fn().mockResolvedValue({ distribution: "ubuntu", release: "26.04", architecture: "amd64" }),
    });
    const deployment = await planNativeDeployment(plan, ubuntuHost);

    expect(deployment.packages).toEqual([
      { name: "nats-server", version: "2.10.27-1build1" },
      { name: "caddy", version: "2.6.2-14" },
    ]);
    expect(deployment.commands).toContainEqual([
      "apt-get", "install", "--yes",
      "nats-server=2.10.27-1build1", "caddy=2.6.2-14",
    ]);
    expect(deployment.units["fos-nats.service"]).toContain("ExecStart=/usr/sbin/nats-server -c /etc/flash-osidian-sync/nats-server.conf");
    expect(ubuntuHost.packageVersionAvailable).toHaveBeenNthCalledWith(1, "nats-server", "2.10.27-1build1");
    expect(ubuntuHost.packageVersionAvailable).toHaveBeenNthCalledWith(2, "caddy", "2.6.2-14");
  });

  it("fails closed before mutation when fos has no lock for a platform", async () => {
    const host = nativeHost({
      platform: vi.fn().mockResolvedValue({ distribution: "debian", release: "13", architecture: "arm64" }),
    });

    await expect(installNativeDeployment(plan, host)).rejects.toThrow("UNSUPPORTED_PLATFORM");
    expect(host.packageVersionAvailable).not.toHaveBeenCalled();
    expect(host.writeFileAtomically).not.toHaveBeenCalled();
  });

  it("uses distinct non-root service identities and isolated fos systemd unit names", async () => {
    const deployment = await planNativeDeployment(plan, nativeHost());

    expect(deployment.units).toEqual(expect.objectContaining({
      "fos-nats.service": expect.stringMatching(/^\[Unit\][\s\S]*\nUser=fos-nats\n/),
      "fos-caddy.service": expect.stringMatching(/^\[Unit\][\s\S]*\nUser=fos-caddy\n/),
    }));
    expect(Object.keys(deployment.units)).toEqual(["fos-nats.service", "fos-caddy.service"]);
    expect(deployment.units["fos-nats.service"]).not.toContain("User=root");
    expect(deployment.units["fos-caddy.service"]).not.toContain("User=root");
    expect(deployment.units["fos-caddy.service"]).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
  });

  it("requires matching service groups and grants only those users access to their configuration", async () => {
    const host = nativeHost();

    await installNativeDeployment(plan, host);

    expect(host.groupAvailable).toHaveBeenCalledWith("fos-nats");
    expect(host.groupAvailable).toHaveBeenCalledWith("fos-caddy");
    expect(host.writeFileAtomically).toHaveBeenCalledWith(
      "/etc/flash-osidian-sync/nats-server.conf", expect.any(String), { owner: 0, mode: 0o640 },
    );
    expect(host.runCommand).toHaveBeenCalledWith(["chown", "root:fos-nats", "/etc/flash-osidian-sync/nats-server.conf"]);
    expect(host.runCommand).toHaveBeenCalledWith(["chmod", "0755", "/etc/flash-osidian-sync"]);
    expect(host.runCommand).toHaveBeenCalledWith(["runuser", "-u", "fos-nats", "--", "test", "-r", "/etc/flash-osidian-sync/nats-server.conf"]);
    expect(host.runCommand).toHaveBeenCalledWith(["runuser", "-u", "fos-caddy", "--", "test", "-r", "/etc/flash-osidian-sync/Caddyfile"]);
  });

  it("rejects preexisting vendor units before package install or service masking", async () => {
    const host = nativeHost({ vendorServicePresent: vi.fn().mockResolvedValue(true) });

    await expect(installNativeDeployment(plan, host)).rejects.toThrow("VENDOR_SERVICE_CONFLICT");

    expect(host.runCommand).not.toHaveBeenCalled();
    expect(host.writeFileAtomically).not.toHaveBeenCalled();
  });

  it("unmasks package vendor units when native installation fails after masking them", async () => {
    const host = nativeHost({
      runCommand: vi.fn().mockImplementation(async (command: readonly string[]) => {
        if (command[0] === "apt-get") throw new Error("apt failed");
      }),
    });

    await expect(installNativeDeployment(plan, host)).rejects.toThrow("apt failed");

    expect(host.runCommand).toHaveBeenCalledWith(["systemctl", "mask", "nats-server.service", "caddy.service"]);
    expect(host.runCommand).toHaveBeenCalledWith(["systemctl", "unmask", "nats-server.service", "caddy.service"]);
  });

  it("keeps the NATS WebSocket listener private and JetStream state persistent", async () => {
    const deployment = await planNativeDeployment(plan, nativeHost());

    expect(deployment.natsConfig).toContain('store_dir: "/var/lib/flash-osidian-sync/nats"');
    expect(deployment.natsConfig).toMatch(/websocket\s*\{[\s\S]*listen:\s*"127\.0\.0\.1:9222"/);
    expect(deployment.natsConfig).toContain('listen: "127.0.0.1:4222"');
    expect(deployment.natsConfig).not.toMatch(/\b(?:http|http_port|http_base_path)\s*:/);
    expect(deployment.natsConfig).not.toMatch(/listen:\s*"0\.0\.0\.0:9222"/);
    expect(deployment.caddyfile).toContain("{\n    acme_ca https://acme-v02.api.letsencrypt.org/directory\n    email   mail@hello.com\n}\n");
    expect(deployment.caddyfile).toContain("127.0.0.1:9222");
    expect(deployment.caddyfile).toContain("sync.example.test");
    expect(deployment.units["fos-caddy.service"]).toContain("/var/lib/flash-osidian-sync/caddy-data");
    expect(deployment.units["fos-caddy.service"]).toContain("/var/lib/flash-osidian-sync/caddy-config");
  });

  it("uses a configured Caddy ACME account email", async () => {
    const deployment = await planNativeDeployment({ ...plan, email: "ops@example.test" }, nativeHost());

    expect(deployment.caddyfile).toContain("email   ops@example.test");
    expect(deployment.caddyfile).not.toContain("email   mail@hello.com");
  });

  it("does not adopt or modify unrelated NATS/Caddy services or files", async () => {
    const host = nativeHost({
      inventory: vi.fn().mockResolvedValue([
        { kind: "service", value: "nats.service", owned: false },
        { kind: "path", value: "/etc/nats/nats-server.conf", owned: false },
        { kind: "service", value: "caddy.service", owned: false },
      ]),
    });

    const deployment = await planNativeDeployment(plan, host);

    expect(deployment.units).not.toHaveProperty("nats.service");
    expect(deployment.units).not.toHaveProperty("caddy.service");
    expect(deployment.natsConfig).not.toContain("/etc/nats");
  });

  it.each([
    [{ kind: "path", value: "/etc/flash-osidian-sync/nats-server.conf", owned: false }],
    [{ kind: "service", value: "fos-nats.service", owned: false }],
    [{ kind: "port", value: "443", owned: false }],
  ] as const)("rejects an occupied required resource before modifying the host: %j", async (inventory) => {
    const host = nativeHost({ inventory: vi.fn().mockResolvedValue(inventory) });

    await expect(installNativeDeployment(plan, host)).rejects.toThrow("NATIVE_RESOURCE_CONFLICT");
    expect(host.writeFileAtomically).not.toHaveBeenCalled();
    expect(host.enableAndStart).not.toHaveBeenCalled();
  });
});
