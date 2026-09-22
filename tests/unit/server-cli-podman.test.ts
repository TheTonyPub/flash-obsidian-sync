import { describe, expect, it, vi } from "vitest";
import type { BootstrapPlan } from "../../packages/server-cli/src/cli.js";
import {
  installPodmanDeployment,
  planPodmanDeployment,
  type PodmanDeploymentAdapter,
} from "../../packages/server-cli/src/podman.js";

const plan: BootstrapPlan = {
  mode: "podman", domain: "sync.example.test", vaultId: "notes",
  installPath: "/opt/flash-osidian-sync", dataPath: "/var/lib/flash-osidian-sync", logPath: "/var/log/flash-osidian-sync",
  systemdServices: ["fos-nats", "fos-caddy"], composeProject: "flash-osidian-sync", preview: "fos podman plan",
};

function podmanHost(overrides: Partial<PodmanDeploymentAdapter> = {}): PodmanDeploymentAdapter & {
  writeFileAtomically: ReturnType<typeof vi.fn>;
  runCompose: ReturnType<typeof vi.fn>;
} {
  return {
    podmanVersion: vi.fn().mockResolvedValue("5.4.0"),
    composeProvider: vi.fn().mockResolvedValue({ executable: "podman-compose", version: "1.3.0" }),
    isRootless: vi.fn().mockResolvedValue(false),
    inventory: vi.fn().mockResolvedValue([]),
    writeFileAtomically: vi.fn().mockResolvedValue(undefined),
    runCompose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as PodmanDeploymentAdapter & { writeFileAtomically: ReturnType<typeof vi.fn>; runCompose: ReturnType<typeof vi.fn> };
}

describe("fos Podman Compose deployment", () => {
  it("uses the portable Compose topology with persistent volumes and restart policy", async () => {
    const deployment = await planPodmanDeployment(plan, podmanHost());

    expect(deployment.composeYaml).toContain("restart: unless-stopped");
    expect(deployment.composeYaml).toContain("/var/lib/flash-osidian-sync/nats:/data");
    expect(deployment.composeYaml).toContain("/var/lib/flash-osidian-sync/caddy-data:/data");
    expect(deployment.composeYaml).toContain("/var/lib/flash-osidian-sync/caddy-config:/config");
    expect(deployment.composeYaml).toMatch(/ports:[\s\S]*- "80:80"[\s\S]*- "443:443"/);
    expect(deployment.composeYaml).not.toMatch(/- "(?:9222|8222):/);
    expect(deployment.composeYaml).not.toContain("8222");
    expect(deployment.natsConfig).not.toMatch(/\b(?:http|http_port|http_base_path)\s*:/);
  });

  it.each([
    ["4.9.9", { executable: "podman-compose", version: "1.3.0" }, false, "PODMAN_5_REQUIRED"],
    ["5.4.0", undefined, false, "PODMAN_COMPOSE_PROVIDER_REQUIRED"],
    ["5.4.0", { executable: "docker-compose", version: "2.29.0" }, false, "PODMAN_COMPOSE_PROVIDER_REQUIRED"],
    ["5.4.0", { executable: "podman-compose", version: "1.3.0" }, true, "PODMAN_ROOTFUL_REQUIRED"],
  ] as const)("rejects unsupported runtime setup before writes: %s", async (podmanVersion, provider, rootless, expected) => {
    const host = podmanHost({
      podmanVersion: vi.fn().mockResolvedValue(podmanVersion),
      composeProvider: vi.fn().mockResolvedValue(provider),
      isRootless: vi.fn().mockResolvedValue(rootless),
    });

    await expect(installPodmanDeployment(plan, host)).rejects.toThrow(expected);
    expect(host.writeFileAtomically).not.toHaveBeenCalled();
    expect(host.runCompose).not.toHaveBeenCalled();
  });

  it("validates the chosen provider before bringing up the managed project", async () => {
    const host = podmanHost();

    await installPodmanDeployment(plan, host);

    expect(host.runCompose).toHaveBeenNthCalledWith(1, ["-p", "flash-osidian-sync", "-f", "/opt/flash-osidian-sync/compose.yaml", "config"]);
    expect(host.runCompose).toHaveBeenNthCalledWith(2, ["-p", "flash-osidian-sync", "-f", "/opt/flash-osidian-sync/compose.yaml", "up", "-d"]);
  });
});
