import type { BootstrapPlan } from "./cli.js";

export interface OwnedResource {
  kind: "path" | "service" | "compose-project" | "port" | "state";
  value: string;
  owned: boolean;
  symlink?: boolean;
  manifest?: OwnedStateManifest;
}

export interface OwnedStateAdapter {
  inventory(): Promise<OwnedResource[]>;
  writeStateAtomically(path: string, contents: string, options: { owner: 0; mode: 0o600 }): Promise<void>;
}

export interface OwnedResources {
  paths: string[];
  services: string[];
  ports: string[];
  composeProject?: "flash-osidian-sync";
}

export interface OwnedStateManifest {
  version: 1;
  mode: BootstrapPlan["mode"];
  domain: string;
  vaultId: string;
  resources: OwnedResources;
}

export interface StateReconciliation {
  changed: boolean;
  manifest: OwnedStateManifest;
  actions: string[];
  status: string;
}

export interface OwnedStatePreparation extends StateReconciliation {
  statePath: string;
}

export interface OwnedStatus {
  kind: "NOT_INSTALLED" | "MANAGED" | "CONFLICT";
  mode?: BootstrapPlan["mode"];
  diagnostic: string;
}

export function ownedResourcesForPlan(plan: BootstrapPlan): OwnedResources {
  const paths = plan.mode === "native"
    ? [
      `${plan.installPath}/nats-server.conf`, `${plan.installPath}/Caddyfile`, `${plan.installPath}/state.json`,
      `${plan.dataPath}/nats`, `${plan.dataPath}/caddy-data`, `${plan.dataPath}/caddy-config`, plan.logPath,
    ]
    : [
      `${plan.installPath}/compose.yaml`, `${plan.installPath}/Caddyfile`, `${plan.installPath}/nats-server.conf`,
      `${plan.installPath}/state.json`, `${plan.dataPath}/nats`, `${plan.dataPath}/caddy-data`, `${plan.dataPath}/caddy-config`, plan.logPath,
    ];
  if (plan.backupSchedule) paths.push("/etc/systemd/system/fos-backup.service", "/etc/systemd/system/fos-backup.timer", plan.backupSchedule.destination);
  return {
    paths,
    services: [...(plan.mode === "native" ? plan.systemdServices.map((service) => `${service}.service`) : []), ...(plan.backupSchedule ? ["fos-backup.service", "fos-backup.timer"] : [])],
    ports: ["80", "443"],
    ...(plan.composeProject ? { composeProject: plan.composeProject } : {}),
  };
}

function relevant(resource: OwnedResource, resources: OwnedResources): boolean {
  if (resource.kind === "path" || resource.kind === "state") return resources.paths.includes(resource.value);
  if (resource.kind === "service") return resources.services.includes(resource.value);
  if (resource.kind === "compose-project") return resource.value === resources.composeProject;
  return resources.ports.includes(resource.value);
}

function sameManifest(left: OwnedStateManifest, right: OwnedStateManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function prepareOwnedState(plan: BootstrapPlan, host: OwnedStateAdapter): Promise<OwnedStatePreparation> {
  const resources = ownedResourcesForPlan(plan);
  const manifest: OwnedStateManifest = { version: 1, mode: plan.mode, domain: plan.domain, vaultId: plan.vaultId, resources };
  const inventory = await host.inventory();
  for (const resource of inventory) {
    if (!relevant(resource, resources)) continue;
    if (!resource.owned || resource.symlink) throw new Error("RESOURCE_CONFLICT");
  }
  const statePath = `${plan.installPath}/state.json`;
  const existing = inventory.find((resource) => resource.kind === "state" && resource.value === statePath && resource.owned);
  if (existing?.manifest && sameManifest(existing.manifest, manifest)) {
    return { changed: false, manifest, actions: [`state-unchanged:${plan.mode}`], status: `fos ${plan.mode}: state unchanged`, statePath };
  }
  if (existing) throw new Error("STATE_DRIFT");
  return { changed: true, manifest, actions: [`write-state:${plan.mode}`], status: `fos ${plan.mode}: state ready to record`, statePath };
}

export async function commitOwnedState(prepared: OwnedStatePreparation, host: OwnedStateAdapter): Promise<StateReconciliation> {
  if (!prepared.changed) return prepared;
  await host.writeStateAtomically(prepared.statePath, `${JSON.stringify(prepared.manifest, null, 2)}\n`, { owner: 0, mode: 0o600 });
  return { ...prepared, status: `fos ${prepared.manifest.mode}: state recorded` };
}

export async function reconcileOwnedState(plan: BootstrapPlan, host: OwnedStateAdapter): Promise<StateReconciliation> {
  return commitOwnedState(await prepareOwnedState(plan, host), host);
}

export async function readOwnedStatus(host: Pick<OwnedStateAdapter, "inventory">): Promise<OwnedStatus> {
  const inventory = await host.inventory();
  const relevant = inventory.filter((resource) => resource.kind === "state" || resource.value.startsWith("/etc/flash-osidian-sync/")
    || resource.value.startsWith("/opt/flash-osidian-sync/") || resource.value.startsWith("/var/lib/flash-osidian-sync/")
    || resource.value.startsWith("/var/log/flash-osidian-sync/") || resource.value === "fos-nats.service"
    || resource.value === "fos-caddy.service" || resource.value === "flash-osidian-sync" || resource.value === "80" || resource.value === "443");
  if (relevant.some((resource) => !resource.owned || resource.symlink)) {
    return { kind: "CONFLICT", diagnostic: "fos status: CONFLICT — a managed resource is occupied or unsafe" };
  }
  const state = inventory.find((resource) => resource.kind === "state" && resource.owned);
  if (!state?.manifest) return { kind: "NOT_INSTALLED", diagnostic: "fos status: NOT_INSTALLED — no managed state manifest found" };
  return { kind: "MANAGED", mode: state.manifest.mode, diagnostic: `fos status: MANAGED — ${state.manifest.mode}` };
}
