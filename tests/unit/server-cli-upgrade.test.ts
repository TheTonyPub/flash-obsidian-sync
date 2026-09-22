import { describe, expect, it, vi } from "vitest";
import { previewUpgrade, runUpgrade, type UpgradeAdapter } from "../../packages/server-cli/src/upgrade.js";
import type { OwnedResource } from "../../packages/server-cli/src/state.js";
import { runLifecycleCommand } from "../../packages/server-cli/src/cli.js";
import type { LifecycleAdapter } from "../../packages/server-cli/src/lifecycle.js";
import { createLocalLifecycleAdapters, type BootstrapRuntime } from "../../packages/server-cli/src/host-deployment.js";
import type { OwnedStateAdapter } from "../../packages/server-cli/src/state.js";

const state: OwnedResource = {
  kind: "state", value: "/etc/flash-osidian-sync/state.json", owned: true,
  manifest: { version: 1, mode: "native", domain: "sync.example.test", vaultId: "notes", resources: { paths: [], services: [], ports: ["80", "443"] } },
};

function adapter(overrides: Partial<UpgradeAdapter> = {}): UpgradeAdapter & Record<"backup" | "snapshot" | "validate" | "apply" | "healthCheck" | "rollback", ReturnType<typeof vi.fn>> {
  return {
    ownedState: vi.fn().mockResolvedValue(state),
    platform: vi.fn().mockResolvedValue({ distribution: "debian", release: "13", architecture: "amd64" }),
    snapshot: vi.fn().mockResolvedValue({ configuration: "nats-config", services: { "fos-nats": "active", "fos-caddy": "active" } }),
    backup: vi.fn().mockResolvedValue(undefined), validate: vi.fn().mockResolvedValue(undefined), apply: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined), ...overrides,
  } as UpgradeAdapter & Record<"backup" | "snapshot" | "validate" | "apply" | "healthCheck" | "rollback", ReturnType<typeof vi.fn>>;
}

describe("fos upgrade", () => {
  it("previews immutable native package versions without mutation", async () => {
    const host = adapter();
    await expect(previewUpgrade(host)).resolves.toContain("nats-server=2.10.27-1+b2");
    expect(host.snapshot).not.toHaveBeenCalled();
    expect(host.apply).not.toHaveBeenCalled();
  });

  it("backs up, snapshots, validates, applies, and health-checks pinned native packages", async () => {
    const host = adapter();
    await runUpgrade(host, { confirmed: true });
    expect(host.backup).toHaveBeenCalledOnce();
    expect(host.validate).toHaveBeenCalledWith(expect.objectContaining({ mode: "native", packages: expect.arrayContaining([expect.objectContaining({ name: "nats-server" })]) }));
    expect(host.apply).toHaveBeenCalledOnce();
    expect(host.healthCheck).toHaveBeenCalledOnce();
    expect(host.rollback).not.toHaveBeenCalled();
  });

  it("uses immutable Compose image references and rolls configuration/services back after failed health check", async () => {
    const composeState = { ...state, value: "/opt/flash-osidian-sync/state.json", manifest: { ...state.manifest!, mode: "docker" as const } };
    const host = adapter({ ownedState: vi.fn().mockResolvedValue(composeState), healthCheck: vi.fn().mockRejectedValue(new Error("WSS_HEALTH_FAILED")) });
    await expect(runUpgrade(host, { confirmed: true })).rejects.toThrow("WSS_HEALTH_FAILED");
    expect(host.validate).toHaveBeenCalledWith(expect.objectContaining({ mode: "docker", images: expect.arrayContaining([expect.stringMatching(/@sha256:/)]) }));
    expect(host.rollback).toHaveBeenCalledWith(await host.snapshot.mock.results[0]!.value);
  });

  it("fails closed before backup for unowned state, unsupported native platform, or missing confirmation", async () => {
    const host = adapter({ ownedState: vi.fn().mockResolvedValue({ ...state, owned: false }) });
    await expect(runUpgrade(host, { confirmed: true })).rejects.toThrow("MANAGED_STATE_REQUIRED");
    expect(host.backup).not.toHaveBeenCalled();
    await expect(runUpgrade(adapter({ platform: vi.fn().mockResolvedValue({ distribution: "debian", release: "12", architecture: "amd64" }) }), { confirmed: true }))
      .rejects.toThrow("UPGRADE_PLATFORM_UNSUPPORTED");
    await expect(runUpgrade(adapter(), { confirmed: false })).rejects.toThrow("CONFIRMATION_REQUIRED");
  });
});

describe("fos upgrade/uninstall operator commands", () => {
  function lifecycle(): LifecycleAdapter {
    return { inventory: vi.fn().mockResolvedValue([state]), backup: vi.fn(), upgrade: vi.fn(), rollback: vi.fn(), removeOwned: vi.fn(), removeData: vi.fn() };
  }

  it("keeps upgrade read-only until --approve", async () => {
    const host = adapter(); const control = lifecycle();
    await expect(runLifecycleCommand(["upgrade"], { lifecycle: control, upgrade: host, isRoot: () => true })).resolves.toContain("upgrade preview");
    expect(host.snapshot).not.toHaveBeenCalled();
    await expect(runLifecycleCommand(["upgrade", "--approve"], { lifecycle: control, upgrade: host, isRoot: () => true })).resolves.toBe("fos upgrade complete");
    expect(host.apply).toHaveBeenCalledOnce();
  });

  it("preserves data by default and requires exact DELETE_DATA confirmation", async () => {
    const host = adapter(); const control = lifecycle();
    await expect(runLifecycleCommand(["uninstall", "--approve"], { lifecycle: control, upgrade: host, isRoot: () => true })).resolves.toContain("data preserved");
    expect(control.removeData).not.toHaveBeenCalled();
    await expect(runLifecycleCommand(["uninstall", "--approve", "--delete-data", "--confirm", "no"], { lifecycle: control, upgrade: host, isRoot: () => true }))
      .rejects.toThrow("DATA_DELETION_CONFIRMATION_REQUIRED");
    await runLifecycleCommand(["uninstall", "--approve", "--delete-data", "--confirm", "DELETE_DATA"], { lifecycle: control, upgrade: host, isRoot: () => true });
    expect(control.removeData).toHaveBeenCalledOnce();
  });

  it("rejects all lifecycle operations outside root before preview or mutation", async () => {
    const host = adapter(); const control = lifecycle();
    await expect(runLifecycleCommand(["upgrade"], { lifecycle: control, upgrade: host, isRoot: () => false })).rejects.toThrow("ROOT_REQUIRED");
    expect(host.ownedState).not.toHaveBeenCalled();
  });
});

describe("local upgrade adapter", () => {
  it("updates only manifest-owned Compose configuration with pinned images", async () => {
    const manifest = {
      ...state.manifest!, mode: "docker" as const,
      resources: {
        paths: ["/opt/flash-osidian-sync/compose.yaml", "/opt/flash-osidian-sync/nats-server.conf", "/opt/flash-osidian-sync/Caddyfile", "/opt/flash-osidian-sync/state.json", "/var/lib/flash-osidian-sync/nats"],
        services: [], ports: ["80", "443"], composeProject: "flash-osidian-sync" as const,
      },
    };
    const stateAdapter: OwnedStateAdapter = { inventory: vi.fn().mockResolvedValue([{ ...state, value: "/opt/flash-osidian-sync/state.json", manifest }]), writeStateAtomically: vi.fn() };
    const removeTree = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      uid: () => 0, run: vi.fn().mockResolvedValue(""), pathInfo: vi.fn().mockResolvedValue({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o640 }),
      readText: vi.fn().mockResolvedValue("services:\n  nats:\n    image: nats:old\n  caddy:\n    image: caddy:old\n"),
      mkdir: vi.fn(), writeText: vi.fn(), rename: vi.fn(), remove: vi.fn().mockResolvedValue(undefined), removeTree, randomId: () => "test", resolveDomain: vi.fn().mockResolvedValue(["203.0.113.1"]),
      portReachable: vi.fn().mockResolvedValue(true), verifyCertificate: vi.fn().mockResolvedValue(true), verifyWss: vi.fn().mockResolvedValue(true),
    } as unknown as BootstrapRuntime;
    const local = createLocalLifecycleAdapters(runtime, stateAdapter);

    await runUpgrade(local.upgrade, { confirmed: true });

    expect(runtime.writeText).toHaveBeenCalledWith("/opt/flash-osidian-sync/.compose.yaml.test.tmp", expect.stringContaining("@sha256:"), 0o640);
    expect(runtime.rename).toHaveBeenCalledWith("/opt/flash-osidian-sync/.compose.yaml.test.tmp", "/opt/flash-osidian-sync/compose.yaml");
    expect(runtime.run).toHaveBeenCalledWith(["docker", "compose", "-p", "flash-osidian-sync", "-f", "/opt/flash-osidian-sync/compose.yaml", "pull"]);
    expect(runtime.remove).toHaveBeenCalledWith("/opt/flash-osidian-sync/.compose-upgrade-test.yaml");
    expect(runtime.remove).not.toHaveBeenCalledWith("/var/lib/flash-osidian-sync/nats");
    await local.lifecycle.removeData();
    expect(removeTree).toHaveBeenCalledWith("/var/lib/flash-osidian-sync/nats");
  });

  it("accepts an already pinned Compose file without rewriting it", async () => {
    const manifest = { ...state.manifest!, mode: "docker" as const, resources: { paths: ["/opt/flash-osidian-sync/compose.yaml", "/opt/flash-osidian-sync/state.json"], services: [], ports: ["80", "443"], composeProject: "flash-osidian-sync" as const } };
    const stateAdapter: OwnedStateAdapter = { inventory: vi.fn().mockResolvedValue([{ ...state, value: "/opt/flash-osidian-sync/state.json", manifest }]), writeStateAtomically: vi.fn() };
    const pinned = "services:\n  nats:\n    image: nats:2.15.0@sha256:c0d27f3054601a99055aa5ec897b0a55bf1869ae50f454e659acfbbea11d2ab7\n  caddy:\n    image: caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d\n";
    const runtime = { uid: () => 0, run: vi.fn().mockResolvedValue(""), pathInfo: vi.fn(), readText: vi.fn().mockResolvedValue(pinned), mkdir: vi.fn(), writeText: vi.fn(), rename: vi.fn(), remove: vi.fn(), randomId: () => "test", resolveDomain: vi.fn().mockResolvedValue(["203.0.113.1"]), portReachable: vi.fn().mockResolvedValue(true), verifyCertificate: vi.fn().mockResolvedValue(true), verifyWss: vi.fn().mockResolvedValue(true) } as unknown as BootstrapRuntime;
    await runUpgrade(createLocalLifecycleAdapters(runtime, stateAdapter).upgrade, { confirmed: true });
    expect(runtime.writeText).not.toHaveBeenCalled();
    expect(runtime.run).toHaveBeenCalledWith(["docker", "compose", "-p", "flash-osidian-sync", "-f", "/opt/flash-osidian-sync/compose.yaml", "config"]);
  });

  it("restores native config with service-readable group ownership", async () => {
    const manifest = { ...state.manifest!, resources: { paths: ["/etc/flash-osidian-sync/nats-server.conf", "/etc/flash-osidian-sync/Caddyfile", "/etc/flash-osidian-sync/state.json"], services: ["fos-nats.service", "fos-caddy.service"], ports: ["80", "443"] } };
    const stateAdapter: OwnedStateAdapter = { inventory: vi.fn().mockResolvedValue([{ ...state, manifest }]), writeStateAtomically: vi.fn() };
    const runtime = { uid: () => 0, run: vi.fn().mockResolvedValue(""), pathInfo: vi.fn().mockResolvedValue(undefined), readText: vi.fn(), mkdir: vi.fn(), writeText: vi.fn(), rename: vi.fn(), remove: vi.fn(), randomId: () => "test", resolveDomain: vi.fn(), portReachable: vi.fn(), verifyCertificate: vi.fn(), verifyWss: vi.fn() } as unknown as BootstrapRuntime;
    await createLocalLifecycleAdapters(runtime, stateAdapter).upgrade.rollback({ configuration: JSON.stringify({ files: { "/etc/flash-osidian-sync/nats-server.conf": "nats", "/etc/flash-osidian-sync/Caddyfile": "caddy" }, services: {} }), services: {} });
    expect(runtime.run).toHaveBeenCalledWith(["chown", "root:fos-nats", "/etc/flash-osidian-sync/nats-server.conf"]);
    expect(runtime.run).toHaveBeenCalledWith(["chown", "root:fos-caddy", "/etc/flash-osidian-sync/Caddyfile"]);
  });
});
