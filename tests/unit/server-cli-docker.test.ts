import { describe, expect, it, vi } from "vitest";
import type { BootstrapPlan } from "../../packages/server-cli/src/cli.js";
import {
  installDockerDeployment,
  planDockerDeployment,
  type DockerDeploymentAdapter,
} from "../../packages/server-cli/src/docker.js";

const plan: BootstrapPlan = {
  mode: "docker", domain: "sync.example.test", vaultId: "notes",
  installPath: "/opt/flash-osidian-sync", dataPath: "/var/lib/flash-osidian-sync", logPath: "/var/log/flash-osidian-sync",
  systemdServices: ["fos-nats", "fos-caddy"], composeProject: "flash-osidian-sync", preview: "fos docker plan",
};

function dockerHost(overrides: Partial<DockerDeploymentAdapter> = {}): DockerDeploymentAdapter & {
  writeFileAtomically: ReturnType<typeof vi.fn>;
  runCompose: ReturnType<typeof vi.fn>;
} {
  return {
    dockerVersion: vi.fn().mockResolvedValue("27.0.0"),
    composeVersion: vi.fn().mockResolvedValue("2.29.0"),
    inventory: vi.fn().mockResolvedValue([]),
    writeFileAtomically: vi.fn().mockResolvedValue(undefined),
    runCompose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as DockerDeploymentAdapter & { writeFileAtomically: ReturnType<typeof vi.fn>; runCompose: ReturnType<typeof vi.fn> };
}

describe("fos Docker Compose deployment", () => {
  it("renders pinned Caddy and NATS images on one private network", async () => {
    const deployment = await planDockerDeployment(plan, dockerHost());

    expect(deployment.composeYaml).toMatch(/image:\s*caddy:2\.11\.4@sha256:[a-f0-9]{64}/);
    expect(deployment.composeYaml).toMatch(/image:\s*nats:2\.15\.0@sha256:[a-f0-9]{64}/);
    expect(deployment.composeYaml).toContain("fos-internal:");
    expect(deployment.composeYaml).toContain("caddy:");
    expect(deployment.composeYaml).toContain("nats:");
    expect(deployment.composeYaml).toContain("restart: unless-stopped");
  });

  it("publishes only Caddy entry ports and disables NATS monitoring", async () => {
    const deployment = await planDockerDeployment(plan, dockerHost());

    expect(deployment.composeYaml).toMatch(/ports:[\s\S]*- "80:80"[\s\S]*- "443:443"/);
    expect(deployment.composeYaml).not.toMatch(/- "(?:9222|8222):/);
    expect(deployment.composeYaml).toMatch(/expose:\s*\n\s*- "9222"/);
    expect(deployment.composeYaml).not.toContain("8222");
    expect(deployment.caddyfile).toContain("{\n    acme_ca https://acme-v02.api.letsencrypt.org/directory\n    email   mail@hello.com\n}\n");
    expect(deployment.caddyfile).toContain("nats:9222");
    expect(deployment.caddyfile).not.toContain("/monitoring");
    expect(deployment.natsConfig).not.toMatch(/\b(?:http|http_port|http_base_path)\s*:/);
    expect(deployment.natsConfig).toMatch(/websocket\s*\{[\s\S]*no_tls:\s*true/);
  });

  it("uses a configured Caddy ACME account email", async () => {
    const deployment = await planDockerDeployment({ ...plan, email: "ops@example.test" }, dockerHost());

    expect(deployment.caddyfile).toContain("email   ops@example.test");
    expect(deployment.caddyfile).not.toContain("email   mail@hello.com");
  });

  it("gives Caddy an outbound edge network for ACME while NATS remains private", async () => {
    const deployment = await planDockerDeployment(plan, dockerHost());

    expect(deployment.composeYaml).toMatch(/caddy:[\s\S]*networks:\n\s+- fos-edge\n\s+- fos-internal/);
    expect(deployment.composeYaml).toMatch(/nats:[\s\S]*networks:\n\s+- fos-internal/);
    expect(deployment.composeYaml).toMatch(/fos-edge:\s*\{\}/);
    expect(deployment.composeYaml).toMatch(/fos-internal:\n\s+internal: true/);
    expect(deployment.composeYaml).toMatch(/caddy:[\s\S]*command: \["caddy", "run", "--config", "\/etc\/caddy\/Caddyfile"\]/);
  });

  it("persists JetStream and Caddy data beneath managed data paths", async () => {
    const deployment = await planDockerDeployment(plan, dockerHost());

    expect(deployment.natsConfig).toContain('store_dir: "/data"');
    expect(deployment.composeYaml).toContain("/var/lib/flash-osidian-sync/nats:/data");
    expect(deployment.composeYaml).toContain("/var/lib/flash-osidian-sync/caddy-data:/data");
    expect(deployment.composeYaml).toContain("/var/lib/flash-osidian-sync/caddy-config:/config");
  });

  it("accepts supported Compose v2 and v5, and fails before writes when unavailable", async () => {
    const composeFive = dockerHost({ composeVersion: vi.fn().mockResolvedValue("5.4.0") });
    await expect(installDockerDeployment(plan, composeFive)).resolves.toBeDefined();
    const dockerMissing = dockerHost({ dockerVersion: vi.fn().mockResolvedValue(undefined) });
    await expect(installDockerDeployment(plan, dockerMissing)).rejects.toThrow("DOCKER_UNAVAILABLE");
    expect(dockerMissing.writeFileAtomically).not.toHaveBeenCalled();

    const composeMissing = dockerHost({ composeVersion: vi.fn().mockResolvedValue(undefined) });
    await expect(installDockerDeployment(plan, composeMissing)).rejects.toThrow("DOCKER_COMPOSE_SUPPORTED_VERSION_REQUIRED");
    expect(composeMissing.writeFileAtomically).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "port", value: "443", owned: false }],
    [{ kind: "compose-project", value: "flash-osidian-sync", owned: false }],
    [{ kind: "path", value: "/opt/flash-osidian-sync/compose.yaml", owned: false }],
  ] as const)("refuses an existing owned resource before Compose writes or commands: %j", async (inventory) => {
    const host = dockerHost({ inventory: vi.fn().mockResolvedValue(inventory) });

    await expect(installDockerDeployment(plan, host)).rejects.toThrow("DOCKER_RESOURCE_CONFLICT");
    expect(host.writeFileAtomically).not.toHaveBeenCalled();
    expect(host.runCompose).not.toHaveBeenCalled();
  });
});
