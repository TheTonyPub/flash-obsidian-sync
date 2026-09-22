import type { BootstrapPlan } from "./cli.js";
import { imageLock } from "./image-lock.js";
import { inspectDomainProxyConfiguration, renderDomainCaddyfile } from "./tls.js";
import type { OwnedResource } from "./state.js";
import { renderNatsAuthorization, type BootstrapCredentials } from "./credentials.js";

export interface DockerDeployment {
  composeYaml: string;
  natsConfig: string;
  caddyfile: string;
}

export interface DockerDeploymentAdapter {
  dockerVersion(): Promise<string | undefined>;
  composeVersion(): Promise<string | undefined>;
  inventory(): Promise<OwnedResource[]>;
  writeFileAtomically(path: string, contents: string, options: { owner: 0; mode: number }): Promise<void>;
  runCompose(args: readonly string[]): Promise<void>;
  removeFile?(path: string): Promise<void>;
}

function requireLockedImages(): void {
  for (const image of Object.values(imageLock)) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image.digest) || !image.source.startsWith("https://hub.docker.com/")) {
      throw new Error("IMAGE_LOCK_UNAVAILABLE");
    }
  }
}

export async function planDockerDeployment(plan: BootstrapPlan, _host: DockerDeploymentAdapter, credentials?: BootstrapCredentials): Promise<DockerDeployment> {
  if (plan.mode !== "docker" || !plan.composeProject) throw new Error("DOCKER_PLAN_REQUIRED");
  requireLockedImages();
  const natsConfig = `jetstream { store_dir: "/data" }
websocket {
  listen: "0.0.0.0:9222"
  no_tls: true
}
${credentials ? renderNatsAuthorization(credentials) : ""}`;
  const caddyfile = renderDomainCaddyfile(plan.domain, "nats:9222", plan.email);
  inspectDomainProxyConfiguration({ domain: plan.domain, caddyfile, natsConfig, natsPrivate: true });
  const composeYaml = `name: ${plan.composeProject}
services:
  caddy:
    image: caddy:${imageLock.caddy.tag}@${imageLock.caddy.digest}
    platform: linux/amd64
    restart: unless-stopped
    command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ${plan.dataPath}/caddy-data:/data
      - ${plan.dataPath}/caddy-config:/config
      - ${plan.installPath}/Caddyfile:/etc/caddy/Caddyfile:ro
    networks:
      - fos-edge
      - fos-internal
  nats:
    image: nats:${imageLock.nats.tag}@${imageLock.nats.digest}
    platform: linux/amd64
    restart: unless-stopped
    command: ["-c", "/etc/nats/nats-server.conf"]
    expose:
      - "9222"
    volumes:
      - ${plan.dataPath}/nats:/data
      - ${plan.installPath}/nats-server.conf:/etc/nats/nats-server.conf:ro
    networks:
      - fos-internal
networks:
  fos-edge: {}
  fos-internal:
    internal: true
`;
  return { composeYaml, natsConfig, caddyfile };
}

function conflicts(plan: BootstrapPlan, input: OwnedResource | OwnedResource[]): boolean {
  const inventory = Array.isArray(input) ? input : [input];
  const paths = new Set([`${plan.installPath}/compose.yaml`, `${plan.installPath}/Caddyfile`, `${plan.installPath}/nats-server.conf`]);
  return inventory.some((resource) => ((resource.kind === "path" && paths.has(resource.value))
    || (resource.kind === "port" && ["80", "443"].includes(resource.value))
    || (resource.kind === "compose-project" && resource.value === plan.composeProject)) && (!resource.owned || resource.symlink));
}

async function preflight(host: DockerDeploymentAdapter): Promise<void> {
  const docker = await host.dockerVersion();
  if (!docker) throw new Error("DOCKER_UNAVAILABLE");
  const compose = await host.composeVersion();
  if (!compose || !/^(?:2|5)\./.test(compose)) throw new Error("DOCKER_COMPOSE_SUPPORTED_VERSION_REQUIRED");
}

export async function installDockerDeployment(plan: BootstrapPlan, host: DockerDeploymentAdapter, credentials?: BootstrapCredentials): Promise<DockerDeployment> {
  await preflight(host);
  const deployment = await planDockerDeployment(plan, host, credentials);
  if (conflicts(plan, await host.inventory())) throw new Error("DOCKER_RESOURCE_CONFLICT");
  const files: Array<[string, string]> = [
    [`${plan.installPath}/compose.yaml`, deployment.composeYaml],
    [`${plan.installPath}/Caddyfile`, deployment.caddyfile],
    [`${plan.installPath}/nats-server.conf`, deployment.natsConfig],
  ];
  const written: string[] = [];
  const compose = ["-p", plan.composeProject!, "-f", `${plan.installPath}/compose.yaml`];
  try {
    for (const [path, contents] of files) { await host.writeFileAtomically(path, contents, { owner: 0, mode: 0o640 }); written.push(path); }
    await host.runCompose([...compose, "config"]);
    await host.runCompose([...compose, "up", "-d"]);
    return deployment;
  } catch (error) {
    await host.runCompose([...compose, "down"]).catch(() => {}); // Deliberately no -v: preserve JetStream/Caddy data.
    for (const path of written.reverse()) await host.removeFile?.(path);
    throw error;
  }
}
