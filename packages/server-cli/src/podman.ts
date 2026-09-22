import type { BootstrapPlan } from "./cli.js";
import { planDockerDeployment, type DockerDeployment } from "./docker.js";
import type { OwnedResource } from "./state.js";
import type { BootstrapCredentials } from "./credentials.js";

export interface PodmanComposeProvider {
  executable: "podman-compose";
  version: string;
}

export interface PodmanDeploymentAdapter {
  podmanVersion(): Promise<string | undefined>;
  composeProvider(): Promise<PodmanComposeProvider | undefined>;
  isRootless(): Promise<boolean>;
  inventory(): Promise<OwnedResource[]>;
  writeFileAtomically(path: string, contents: string, options: { owner: 0; mode: number }): Promise<void>;
  runCompose(args: readonly string[]): Promise<void>;
  removeFile?(path: string): Promise<void>;
}

export type PodmanDeployment = DockerDeployment;

export async function planPodmanDeployment(plan: BootstrapPlan, host: PodmanDeploymentAdapter, credentials?: BootstrapCredentials): Promise<PodmanDeployment> {
  if (plan.mode !== "podman" || !plan.composeProject) throw new Error("PODMAN_PLAN_REQUIRED");
  return planDockerDeployment({ ...plan, mode: "docker" }, {
    dockerVersion: host.podmanVersion,
    composeVersion: async () => (await host.composeProvider())?.version,
    inventory: host.inventory,
    writeFileAtomically: host.writeFileAtomically,
    runCompose: host.runCompose,
    removeFile: host.removeFile,
  }, credentials);
}

async function preflight(host: PodmanDeploymentAdapter): Promise<void> {
  const podman = await host.podmanVersion();
  if (!podman?.startsWith("5.")) throw new Error("PODMAN_5_REQUIRED");
  const provider = await host.composeProvider();
  if (!provider || provider.executable !== "podman-compose" || !provider.version) throw new Error("PODMAN_COMPOSE_PROVIDER_REQUIRED");
  if (await host.isRootless()) throw new Error("PODMAN_ROOTFUL_REQUIRED");
}

function conflicts(plan: BootstrapPlan, inventory: OwnedResource[]): boolean {
  const paths = new Set([`${plan.installPath}/compose.yaml`, `${plan.installPath}/Caddyfile`, `${plan.installPath}/nats-server.conf`]);
  return inventory.some((resource) => ((resource.kind === "path" && paths.has(resource.value))
    || (resource.kind === "port" && ["80", "443"].includes(resource.value))
    || (resource.kind === "compose-project" && resource.value === plan.composeProject)) && (!resource.owned || resource.symlink));
}

export async function installPodmanDeployment(plan: BootstrapPlan, host: PodmanDeploymentAdapter, credentials?: BootstrapCredentials): Promise<PodmanDeployment> {
  await preflight(host);
  const deployment = await planPodmanDeployment(plan, host, credentials);
  if (conflicts(plan, await host.inventory())) throw new Error("PODMAN_RESOURCE_CONFLICT");
  const files: Array<[string, string]> = [
    [`${plan.installPath}/compose.yaml`, deployment.composeYaml],
    [`${plan.installPath}/Caddyfile`, deployment.caddyfile],
    [`${plan.installPath}/nats-server.conf`, deployment.natsConfig],
  ];
  const written: string[] = [];
  const compose = ["-p", plan.composeProject!, "-f", `${plan.installPath}/compose.yaml`];
  try {
    for (const [path, contents] of files) {
      await host.writeFileAtomically(path, contents, { owner: 0, mode: 0o640 });
      written.push(path);
    }
    await host.runCompose([...compose, "config"]);
    await host.runCompose([...compose, "up", "-d"]);
    return deployment;
  } catch (error) {
    await host.runCompose([...compose, "down"]).catch(() => {});
    for (const path of written.reverse()) await host.removeFile?.(path);
    throw error;
  }
}
