import { describe, expect, it, vi } from "vitest";
import type { BootstrapPlan } from "../../packages/server-cli/src/cli.js";
import {
  ownedResourcesForPlan,
  readOwnedStatus,
  reconcileOwnedState,
  type OwnedStateAdapter,
} from "../../packages/server-cli/src/state.js";

const nativePlan: BootstrapPlan = {
  mode: "native", domain: "sync.example.test", vaultId: "notes",
  installPath: "/etc/flash-osidian-sync", dataPath: "/var/lib/flash-osidian-sync", logPath: "/var/log/flash-osidian-sync",
  systemdServices: ["fos-nats", "fos-caddy"], preview: "fos native plan",
};
const dockerPlan: BootstrapPlan = {
  mode: "docker", domain: "sync.example.test", vaultId: "notes",
  installPath: "/opt/flash-osidian-sync", dataPath: "/var/lib/flash-osidian-sync", logPath: "/var/log/flash-osidian-sync",
  systemdServices: ["fos-nats", "fos-caddy"], composeProject: "flash-osidian-sync", preview: "fos docker plan",
};

function adapter(inventory: Awaited<ReturnType<OwnedStateAdapter["inventory"]>> = []): OwnedStateAdapter & {
  writeStateAtomically: ReturnType<typeof vi.fn>;
} {
  return { inventory: vi.fn().mockResolvedValue(inventory), writeStateAtomically: vi.fn().mockResolvedValue(undefined) };
}

describe("fos owned state reconciliation", () => {
  it("inventories only flash-osidian-sync resources for native and Compose modes", () => {
    expect(ownedResourcesForPlan(nativePlan)).toEqual(expect.objectContaining({
      paths: expect.arrayContaining([
        "/etc/flash-osidian-sync/nats-server.conf",
        "/etc/flash-osidian-sync/Caddyfile",
        "/etc/flash-osidian-sync/state.json",
        "/var/lib/flash-osidian-sync/nats",
        "/var/lib/flash-osidian-sync/caddy-data",
        "/var/lib/flash-osidian-sync/caddy-config",
        "/var/log/flash-osidian-sync",
      ]),
      services: ["fos-nats.service", "fos-caddy.service"],
    }));
    expect(ownedResourcesForPlan(dockerPlan)).toEqual(expect.objectContaining({
      paths: expect.arrayContaining([
        "/opt/flash-osidian-sync/compose.yaml",
        "/opt/flash-osidian-sync/Caddyfile",
        "/opt/flash-osidian-sync/nats-server.conf",
        "/opt/flash-osidian-sync/state.json",
        "/var/lib/flash-osidian-sync/nats",
        "/var/lib/flash-osidian-sync/caddy-data",
        "/var/lib/flash-osidian-sync/caddy-config",
      ]),
      composeProject: "flash-osidian-sync",
    }));
    expect(ownedResourcesForPlan(dockerPlan).paths).not.toContain("/etc/caddy/Caddyfile");
  });

  it.each([
    [nativePlan, [{ kind: "path", value: "/etc/flash-osidian-sync/nats-server.conf", owned: false }]],
    [nativePlan, [{ kind: "service", value: "fos-nats.service", owned: false }]],
    [dockerPlan, [{ kind: "compose-project", value: "flash-osidian-sync", owned: false }]],
    [nativePlan, [{ kind: "port", value: "443", owned: false }]],
  ] as const)("fails before state writes when an unrelated resource is occupied: %j", async (plan, inventory) => {
    const host = adapter([...inventory]);

    await expect(reconcileOwnedState(plan, host)).rejects.toThrow("RESOURCE_CONFLICT");
    expect(host.writeStateAtomically).not.toHaveBeenCalled();
  });

  it("refuses an unsafe symlink in a managed location without replacing it", async () => {
    const host = adapter([{ kind: "path", value: "/opt/flash-osidian-sync/state.json", owned: false, symlink: true }]);

    await expect(reconcileOwnedState(dockerPlan, host)).rejects.toThrow("RESOURCE_CONFLICT");
    expect(host.writeStateAtomically).not.toHaveBeenCalled();
  });

  it("does not rewrite an unchanged owned manifest or recreate credentials or KV", async () => {
    const first = adapter();
    const applied = await reconcileOwnedState(dockerPlan, first);
    const repeat = adapter([{ kind: "state", value: "/opt/flash-osidian-sync/state.json", owned: true, manifest: applied.manifest }]);

    const repeated = await reconcileOwnedState(dockerPlan, repeat);

    expect(repeated.changed).toBe(false);
    expect(repeated.manifest).toEqual(applied.manifest);
    expect(repeated.actions).not.toContain("regenerate-credentials");
    expect(repeated.actions).not.toContain("recreate-kv");
    expect(repeat.writeStateAtomically).not.toHaveBeenCalled();
  });

  it("atomically writes the native state manifest as root-owned mode 0600", async () => {
    const host = adapter();

    await reconcileOwnedState(nativePlan, host);

    expect(host.writeStateAtomically).toHaveBeenCalledWith(
      "/etc/flash-osidian-sync/state.json",
      expect.any(String),
      { owner: 0, mode: 0o600 },
    );
  });

  it("refuses to overwrite a changed owned manifest without explicit drift handling", async () => {
    const host = adapter([{ kind: "state", value: "/opt/flash-osidian-sync/state.json", owned: true,
      manifest: { version: 1, mode: "docker", domain: "other.example.test", vaultId: "notes", resources: ownedResourcesForPlan(dockerPlan) } }]);

    await expect(reconcileOwnedState(dockerPlan, host)).rejects.toThrow("STATE_DRIFT");
    expect(host.writeStateAtomically).not.toHaveBeenCalled();
  });

  it("reports no installation, managed mode, and conflict without writing state", async () => {
    await expect(readOwnedStatus(adapter())).resolves.toMatchObject({ kind: "NOT_INSTALLED" });
    const manifest = (await reconcileOwnedState(dockerPlan, adapter())).manifest;
    await expect(readOwnedStatus(adapter([{ kind: "state", value: "/opt/flash-osidian-sync/state.json", owned: true, manifest }]))).resolves.toMatchObject({
      kind: "MANAGED", mode: "docker",
    });
    await expect(readOwnedStatus(adapter([{ kind: "path", value: "/etc/flash-osidian-sync/Caddyfile", owned: false }]))).resolves.toMatchObject({ kind: "CONFLICT" });
  });
});
