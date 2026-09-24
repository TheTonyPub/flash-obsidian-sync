import { randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import type { BootstrapPlan } from "./cli.js";
import { verifyCredentialPassword, type BootstrapCredentials, type SecretOutputAdapter } from "./credentials.js";
import { installDockerDeployment, type DockerDeploymentAdapter } from "./docker.js";
import { readLocalPlatform } from "./host.js";
import { installNativeDeployment, type NativeDeploymentAdapter } from "./native.js";
import { installPodmanDeployment, type PodmanDeploymentAdapter } from "./podman.js";
import type { OwnedResource, OwnedStateAdapter, OwnedStateManifest } from "./state.js";
import { verifyDomainEndpoint, type EndpointReadinessOptions } from "./tls.js";
import { createVault } from "./vault-admin.js";
import { createNativeVaultAdminAdapter, createNativeVaultVerificationAdapter } from "./native-admin.js";
import { composeAdminWorkerPath } from "./compose-admin.js";
import { createComposeVaultAdminAdapter, createComposeVaultVerificationAdapter } from "./compose-vault-admin.js";
import type { AdministratorCredentials, VaultAdminAdapter } from "./vault-admin.js";
import { verifyVault, type VaultCredentials, type VaultVerificationAdapter } from "./vault-verify.js";
import { applyFirewallOption, applyServiceIdentity, planHostOptions, type HostOptionsAdapter } from "./host-options.js";
import { renderBackupTimer } from "./backup.js";
import type { ManagedAuthorization, VaultUserAdapter } from "./vault-users.js";
import type { LifecycleAdapter } from "./lifecycle.js";
import type { UpgradeAdapter, UpgradeSnapshot, UpgradeTarget } from "./upgrade.js";

const execFile = promisify(execFileCallback);

export interface PathInfo {
  isFile: boolean;
  isSymbolicLink: boolean;
  uid: number;
  mode: number;
}

/** Injectable local I/O boundary. Tests provide a fake; main uses localRuntime. */
export interface BootstrapRuntime {
  uid(): number;
  run(command: readonly string[]): Promise<string>;
  /** Streams sensitive one-shot container input without placing it in argv, env, or a host file. */
  runWithInput?(command: readonly string[], input: string): Promise<string>;
  pathInfo(path: string): Promise<PathInfo | undefined>;
  readText(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  writeText(path: string, contents: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Exact, manifest-owned recursive deletion boundary used only after typed data-deletion confirmation. */
  removeTree?(path: string): Promise<void>;
  randomId(): string;
  resolveDomain(domain: string): Promise<readonly string[]>;
  portReachable(port: 80 | 443): Promise<boolean>;
  verifyCertificate(domain: string, timeoutMs?: number): Promise<boolean>;
  verifyWss(url: string, timeoutMs?: number): Promise<boolean>;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function manifestOwns(manifest: unknown, kind: OwnedResource["kind"], value: string): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const resources = (manifest as OwnedStateManifest).resources;
  if (!resources) return false;
  if (kind === "path" || kind === "state") return resources.paths.includes(value);
  if (kind === "service") return resources.services.includes(value);
  if (kind === "port") return resources.ports.includes(value);
  return resources.composeProject === value;
}

async function readOwnedManifest(runtime: BootstrapRuntime, plan: BootstrapPlan): Promise<unknown> {
  try { return JSON.parse(await runtime.readText(`${plan.installPath}/state.json`)); }
  catch (error) { if (missing(error) || error instanceof SyntaxError) return undefined; throw error; }
}

function managedPaths(plan: BootstrapPlan): string[] {
  const paths = plan.mode === "native"
    ? [`${plan.installPath}/nats-server.conf`, `${plan.installPath}/Caddyfile`, "/etc/systemd/system/fos-nats.service", "/etc/systemd/system/fos-caddy.service"]
    : [`${plan.installPath}/compose.yaml`, `${plan.installPath}/nats-server.conf`, `${plan.installPath}/Caddyfile`];
  if (plan.backupSchedule) paths.push("/etc/systemd/system/fos-backup.service", "/etc/systemd/system/fos-backup.timer", plan.backupSchedule.destination);
  return paths;
}

async function inventory(runtime: BootstrapRuntime, plan: BootstrapPlan): Promise<OwnedResource[]> {
  const manifest = await readOwnedManifest(runtime, plan);
  const paths = await Promise.all(managedPaths(plan).map(async (path): Promise<OwnedResource | undefined> => {
    const info = await runtime.pathInfo(path);
    if (!info) return undefined;
    return { kind: "path", value: path, owned: manifestOwns(manifest, "path", path), symlink: info.isSymbolicLink };
  }));
  return paths.filter((entry): entry is OwnedResource => !!entry);
}

async function writeFileAtomically(runtime: BootstrapRuntime, path: string, contents: string, options: { owner: 0; mode: number }): Promise<void> {
  const existing = await runtime.pathInfo(path);
  if (existing?.isSymbolicLink) throw new Error("RESOURCE_CONFLICT");
  await runtime.mkdir(dirname(path));
  const temporary = `${dirname(path)}/.${path.split("/").pop()}.${runtime.randomId()}.tmp`;
  try {
    await runtime.writeText(temporary, contents, options.mode);
    await runtime.rename(temporary, path);
  } catch (error) {
    await runtime.remove(temporary).catch(() => {});
    throw error;
  }
}

async function commandAvailable(runtime: BootstrapRuntime, command: readonly string[]): Promise<boolean> {
  try { await runtime.run(command); return true; }
  catch { return false; }
}

function composeCommand(executable: "docker" | "podman", args: readonly string[]): readonly string[] {
  return executable === "docker" ? ["docker", "compose", ...args] : ["podman-compose", ...args];
}

function versionFrom(output: string): string | undefined {
  return /(?:^|\s)v?(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1];
}

function nativeAdapter(runtime: BootstrapRuntime, plan: BootstrapPlan): NativeDeploymentAdapter {
  return {
    platform: readLocalPlatform,
    packageManagerAvailable: () => commandAvailable(runtime, ["apt-get", "--version"]),
    packageVersionAvailable: (name, version) => commandAvailable(runtime, ["apt-cache", "show", `${name}=${version}`]),
    identityAvailable: (identity) => commandAvailable(runtime, ["getent", "passwd", identity]),
    groupAvailable: (group) => commandAvailable(runtime, ["getent", "group", group]),
    vendorServicePresent: (service) => commandAvailable(runtime, ["systemctl", "cat", service]),
    inventory: () => inventory(runtime, plan),
    writeFileAtomically: (path, contents, options) => writeFileAtomically(runtime, path, contents, options),
    runCommand: (command) => runtime.run(command).then(() => undefined),
    enableAndStart: (units) => runtime.run(["systemctl", "daemon-reload"]).then(async () => {
      for (const unit of units) await runtime.run(["systemctl", "enable", "--now", unit]);
    }),
    disableAndStop: async (units) => { for (const unit of units) await runtime.run(["systemctl", "disable", "--now", unit]).catch(() => {}); },
    removeFile: (path) => runtime.remove(path),
  };
}

function dockerAdapter(runtime: BootstrapRuntime, plan: BootstrapPlan): DockerDeploymentAdapter {
  return {
    dockerVersion: async () => (await commandAvailable(runtime, ["docker", "--version"])) ? versionFrom(await runtime.run(["docker", "--version"])) : undefined,
    composeVersion: async () => (await commandAvailable(runtime, ["docker", "compose", "version"])) ? versionFrom(await runtime.run(["docker", "compose", "version"])) : undefined,
    inventory: () => inventory(runtime, plan),
    writeFileAtomically: (path, contents, options) => writeFileAtomically(runtime, path, contents, options),
    runCompose: (args) => runtime.run(composeCommand("docker", args)).then(() => undefined),
    removeFile: (path) => runtime.remove(path),
  };
}

function podmanAdapter(runtime: BootstrapRuntime, plan: BootstrapPlan): PodmanDeploymentAdapter {
  return {
    podmanVersion: async () => (await commandAvailable(runtime, ["podman", "--version"])) ? versionFrom(await runtime.run(["podman", "--version"])) : undefined,
    composeProvider: async () => (await commandAvailable(runtime, ["podman-compose", "--version"])) ? { executable: "podman-compose", version: versionFrom(await runtime.run(["podman-compose", "--version"])) ?? "" } : undefined,
    isRootless: async () => runtime.uid() !== 0,
    inventory: () => inventory(runtime, plan),
    writeFileAtomically: (path, contents, options) => writeFileAtomically(runtime, path, contents, options),
    runCompose: (args) => runtime.run(composeCommand("podman", args)).then(() => undefined),
    removeFile: (path) => runtime.remove(path),
  };
}

export function createHostOptionsAdapter(runtime: BootstrapRuntime): HostOptionsAdapter {
  const added: number[] = [];
  return {
    async activeSshPort() {
      const listeners = await runtime.run(["ss", "-H", "-ltnp"]);
      const sshd = listeners.split("\n").find((line) => /\bsshd\b/.test(line));
      const match = sshd && /:(\d+)(?:\s|$)/.exec(sshd);
      return match ? Number(match[1]) : undefined;
    },
    async previewFirewall() { await runtime.run(["ufw", "status"]); },
    async applyFirewall(ports) {
      for (const port of ports) { await runtime.run(["ufw", "allow", `${port}/tcp`]); added.push(port); }
    },
    async verifySsh(port) {
      const status = await runtime.run(["ufw", "status"]);
      if (/^Status:\s*inactive\s*$/mi.test(status)) return true;
      if (!/^Status:\s*active\s*$/mi.test(status)) return false;
      return new RegExp(`^\\s*${port}/tcp(?:\\s+\\(v6\\))?\\s+ALLOW(?:\\s|$)`, "m").test(status);
    },
    async rollbackFirewall() { for (const port of added.reverse()) await runtime.run(["ufw", "delete", "allow", `${port}/tcp`]); },
    identityExists: (user, group) => Promise.all([commandAvailable(runtime, ["getent", "passwd", user]), commandAvailable(runtime, ["getent", "group", group])]).then((result) => result.every(Boolean)),
    async createDedicatedIdentity(user, group) {
      if (!await commandAvailable(runtime, ["getent", "group", group])) await runtime.run(["groupadd", "--system", group]);
      if (!await commandAvailable(runtime, ["getent", "passwd", user])) await runtime.run(["useradd", "--system", "--gid", group, "--no-create-home", "--shell", "/usr/sbin/nologin", user]);
    },
  };
}

/** Executes one selected backend and verifies its externally usable domain endpoint. */
export function createBootstrapApply(runtime: BootstrapRuntime, endpointReadiness?: EndpointReadinessOptions): (plan: BootstrapPlan, credentials?: BootstrapCredentials) => Promise<void> {
  return async (plan, credentials) => {
    if (runtime.uid() !== 0) throw new Error("ROOT_REQUIRED");
    const options = createHostOptionsAdapter(runtime);
    const selected = plan.hostOptions ?? planHostOptions({ firewall: { enabled: false }, identity: { kind: "existing", user: "fos-nats", group: "fos-nats" } });
    if (plan.mode === "native") await applyServiceIdentity(selected.identity, options);
    await applyFirewallOption(selected.firewall, options);
    if (plan.backupSchedule) {
      const manifest = await readOwnedManifest(runtime, plan);
      for (const path of ["/etc/systemd/system/fos-backup.service", "/etc/systemd/system/fos-backup.timer"]) {
        if (await runtime.pathInfo(path) && !manifestOwns(manifest, "path", path)) throw new Error("BACKUP_SCHEDULE_CONFLICT");
      }
      const units = renderBackupTimer(plan.backupSchedule);
      await writeFileAtomically(runtime, "/etc/systemd/system/fos-backup.service", units.service, { owner: 0, mode: 0o644 });
      await writeFileAtomically(runtime, "/etc/systemd/system/fos-backup.timer", units.timer, { owner: 0, mode: 0o644 });
      await runtime.run(["systemctl", "daemon-reload"]);
      await runtime.run(["systemctl", "enable", "--now", "fos-backup.timer"]);
    }
    if (plan.mode === "native") await installNativeDeployment(plan, nativeAdapter(runtime, plan), credentials);
    else if (plan.mode === "docker") await installDockerDeployment(plan, dockerAdapter(runtime, plan), credentials);
    else await installPodmanDeployment(plan, podmanAdapter(runtime, plan), credentials);
    await verifyDomainEndpoint(plan.domain, runtime, endpointReadiness);
    if (credentials) {
      const administrator = { username: credentials.administrator.username, password: credentials.administrator.password };
      const admin = createVaultAdminAdapter(runtime, plan, administrator);
      try { await createVault(admin, administrator, plan.vaultId); }
      catch { throw new Error("FIRST_BUCKET_PROVISIONING_FAILED: deployment retained; repair NATS and recover with the original administrator secret"); }
      const scopedCredentials = { username: credentials.vault.username, password: credentials.vault.password };
      try {
        await verifyVault(createVaultVerificationAdapter(runtime, plan, scopedCredentials), plan.vaultId, scopedCredentials);
      } catch (error) {
        throw new Error("FIRST_VAULT_VERIFICATION_FAILED", { cause: error });
      }
    }
  };
}

/** Safe writer for the one-time unattended secret handoff. */
export function createSecretOutputAdapter(runtime: BootstrapRuntime): SecretOutputAdapter {
  return { writeFileAtomically: (path, contents, options) => writeFileAtomically(runtime, path, contents, options) };
}

const authorizationBlock = /# fos-managed-authorization:start\n([\s\S]*?)# fos-managed-authorization:end\n?/;
const userDeclaration = /\{ user: "([^"]+)", password: "([^"]+)"/g;

function parseManagedAuthorization(config: string): ManagedAuthorization {
  const block = authorizationBlock.exec(config)?.[1];
  if (!block) throw new Error("MANAGED_AUTHORIZATION_NOT_FOUND");
  const entries = [...block.matchAll(userDeclaration)];
  const admin = entries.find((entry) => entry[1] === "fos-admin");
  if (!admin) throw new Error("MANAGED_ADMINISTRATOR_NOT_FOUND");
  return { administrator: { username: "fos-admin", passwordHash: admin[2]! }, users: entries
    .filter((entry) => entry[1]!.startsWith("fos-vault-"))
    .map((entry) => ({ vaultId: entry[1]!.slice("fos-vault-".length), username: entry[1]!, passwordHash: entry[2]! })) };
}

function replaceManagedAuthorization(config: string, authorization: string): string {
  if (!authorizationBlock.test(config)) throw new Error("MANAGED_AUTHORIZATION_NOT_FOUND");
  return config.replace(authorizationBlock, () => authorization);
}

/** Runtime-backed vault-user config editor. It only replaces the marked authorization block. */
export function createVaultUserAdapter(runtime: BootstrapRuntime, plan: BootstrapPlan): VaultUserAdapter {
  const configPath = `${plan.installPath}/nats-server.conf`;
  // Atomic replacement changes the inode behind a single-file bind mount.
  // Recreate only NATS so container backends read the new file, including rollback.
  const reload = plan.mode === "native" ? ["systemctl", "reload", "fos-nats.service"] as const
    : composeCommand(plan.mode === "docker" ? "docker" : "podman", ["-p", plan.composeProject!, "-f", `${plan.installPath}/compose.yaml`, "up", "-d", "--no-deps", "--force-recreate", "nats"]);
  const read = (): Promise<string> => runtime.readText(configPath);
  const write = async (authorization: string): Promise<void> => {
    const next = replaceManagedAuthorization(await read(), authorization);
    await writeFileAtomically(runtime, configPath, next, { owner: 0, mode: 0o640 });
    if (plan.mode === "native") await runtime.run(["chown", "root:fos-nats", configPath]);
  };
  return {
    authenticate: async (credentials) => {
      const current = parseManagedAuthorization(await read());
      return credentials.username === "fos-admin" && verifyCredentialPassword({ username: credentials.username, password: credentials.password, passwordHash: current.administrator.passwordHash });
    },
    readAuthorization: async () => parseManagedAuthorization(await read()),
    validate: async (authorization) => {
      const validationId = runtime.randomId();
      const temporary = `${dirname(configPath)}/.nats-server.conf.${validationId}.validate`;
      const containerConfig = `/tmp/.nats-server.conf.${validationId}.validate`;
      try {
        await runtime.writeText(temporary, replaceManagedAuthorization(await read(), authorization), 0o640);
        if (plan.mode === "native") await runtime.run(["nats-server", "-c", temporary, "-t"]);
        else await runtime.run(composeCommand(plan.mode === "docker" ? "docker" : "podman", ["-p", plan.composeProject!, "-f", `${plan.installPath}/compose.yaml`, "run", "--rm", "--no-deps", "-v", `${temporary}:${containerConfig}:ro`, "nats", "-c", containerConfig, "-t"]));
      } finally { await runtime.remove(temporary).catch(() => {}); }
    },
    write,
    reload: async () => { await runtime.run(reload); },
    restore: async (authorization) => { await write(authorization); await runtime.run(reload).catch(() => {}); },
  };
}

function composeAdminRuntime(runtime: BootstrapRuntime, mode: "docker" | "podman") {
  return {
    runContainer: (args: readonly string[], input: string) => {
      if (!runtime.runWithInput) throw new Error("COMPOSE_ADMIN_STDIN_UNAVAILABLE");
      return runtime.runWithInput([mode === "docker" ? "docker" : "podman", ...args], input);
    },
  };
}

/** Selects a private local or Compose-network NATS administrator connection. */
export function createVaultAdminAdapter(runtime: BootstrapRuntime, plan: BootstrapPlan, administrator: AdministratorCredentials): VaultAdminAdapter {
  if (plan.mode === "native") return createNativeVaultAdminAdapter(administrator);
  return createComposeVaultAdminAdapter(composeAdminRuntime(runtime, plan.mode), composeAdminWorkerPath, administrator);
}

/** Selects a scoped-user verifier without exposing the NATS TCP port. */
export function createVaultVerificationAdapter(runtime: BootstrapRuntime, plan: BootstrapPlan, credentials: VaultCredentials, crossVaultId?: string): VaultVerificationAdapter {
  if (plan.mode === "native") return createNativeVaultVerificationAdapter(credentials);
  return createComposeVaultVerificationAdapter(composeAdminRuntime(runtime, plan.mode), composeAdminWorkerPath, credentials, crossVaultId);
}

type UpgradeConfiguration = { readonly files: Readonly<Record<string, string>>; readonly services: Readonly<Record<string, string>> };

async function requireUpgradeManifest(state: OwnedStateAdapter): Promise<OwnedStateManifest> {
  const states = (await state.inventory()).filter((entry) => entry.kind === "state");
  if (states.length !== 1 || !states[0]!.owned || states[0]!.symlink || !states[0]!.manifest) throw new Error("MANAGED_STATE_REQUIRED");
  return states[0]!.manifest;
}

function composeRuntime(mode: "docker" | "podman", manifest: OwnedStateManifest, file = "/opt/flash-osidian-sync/compose.yaml"): readonly string[] {
  const project = manifest.resources.composeProject;
  if (!project) throw new Error("MANAGED_STATE_REQUIRED");
  return mode === "docker" ? ["docker", "compose", "-p", project, "-f", file] : ["podman-compose", "-p", project, "-f", file];
}

function upgradeConfigPaths(manifest: OwnedStateManifest): readonly string[] {
  return manifest.resources.paths.filter((path) => path.endsWith("/nats-server.conf") || path.endsWith("/Caddyfile") || path.endsWith("/compose.yaml"));
}

function dataPaths(manifest: OwnedStateManifest): readonly string[] {
  return manifest.resources.paths.filter((path) => path.startsWith("/var/lib/flash-osidian-sync/"));
}

/** Builds a manifest-bound local adapter. It never targets a resource absent from managed state. */
export function createLocalLifecycleAdapters(runtime: BootstrapRuntime, state: OwnedStateAdapter): { lifecycle: LifecycleAdapter; upgrade: UpgradeAdapter } {
  const ownedState = async (): Promise<OwnedResource | undefined> => {
    const entries = (await state.inventory()).filter((entry) => entry.kind === "state");
    return entries.length === 1 ? entries[0] : undefined;
  };
  const inventory = async (): Promise<readonly OwnedResource[]> => {
    const manifest = await requireUpgradeManifest(state);
    const files = await Promise.all(manifest.resources.paths.map(async (path): Promise<OwnedResource | undefined> => {
      const info = await runtime.pathInfo(path);
      return info ? { kind: path.endsWith("/state.json") ? "state" : "path", value: path, owned: true, symlink: info.isSymbolicLink, ...(path.endsWith("/state.json") ? { manifest } : {}) } : undefined;
    }));
    return [
      ...files.filter((entry): entry is OwnedResource => !!entry),
      ...manifest.resources.services.map((value) => ({ kind: "service" as const, value, owned: true })),
      ...(manifest.resources.composeProject ? [{ kind: "compose-project" as const, value: manifest.resources.composeProject, owned: true }] : []),
    ];
  };
  const snapshot = async (): Promise<UpgradeSnapshot> => {
    const manifest = await requireUpgradeManifest(state);
    const files = Object.fromEntries(await Promise.all(upgradeConfigPaths(manifest).map(async (path) => [path, await runtime.readText(path)])));
    const services = manifest.mode === "native"
      ? Object.fromEntries(await Promise.all(manifest.resources.services.map(async (service) => [service, (await runtime.run(["systemctl", "is-enabled", service])).trim()])))
      : { compose: "managed" };
    const packages = manifest.mode === "native" ? (await Promise.all(["nats-server", "caddy"].map(async (name) => ({
      name: name as "nats-server" | "caddy", version: (await runtime.run(["dpkg-query", "-W", "-f=${Version}", name])).trim(),
    })))).filter((item) => !!item.version) : undefined;
    return { configuration: JSON.stringify({ files, services } satisfies UpgradeConfiguration), services, ...(packages ? { packages } : {}) };
  };
  const validate = async (target: UpgradeTarget): Promise<void> => {
    const manifest = await requireUpgradeManifest(state);
    const paths = upgradeConfigPaths(manifest);
    if (target.mode === "native") {
      for (const item of target.packages ?? []) await runtime.run(["apt-cache", "show", `${item.name}=${item.version}`]);
      await runtime.run(["nats-server", "-c", paths.find((path) => path.endsWith("nats-server.conf"))!, "-t"]);
      await runtime.run(["caddy", "validate", "--config", paths.find((path) => path.endsWith("Caddyfile"))!, "--adapter", "caddyfile"]);
    } else await runtime.run([...composeRuntime(target.mode, manifest), "config"]);
  };
  const apply = async (target: UpgradeTarget): Promise<void> => {
    const manifest = await requireUpgradeManifest(state);
    if (target.mode === "native") {
      await runtime.run(["apt-get", "update"]);
      await runtime.run(["apt-get", "install", "--yes", ...target.packages!.map((item) => `${item.name}=${item.version}`)]);
      await runtime.run(["systemctl", "restart", "fos-nats.service"]);
      await runtime.run(["systemctl", "restart", "fos-caddy.service"]);
      return;
    }
    const compose = "/opt/flash-osidian-sync/compose.yaml";
    const current = await runtime.readText(compose);
    const [nats, caddy] = target.images!;
    const natsImage = /^\s*image:\s*(?:docker\.io\/library\/)?nats:\S+$/m;
    const caddyImage = /^\s*image:\s*(?:docker\.io\/library\/)?caddy:\S+$/m;
    if (!natsImage.test(current) || !caddyImage.test(current)) throw new Error("COMPOSE_IMAGE_LOCK_NOT_FOUND");
    const candidate = current.replace(natsImage, `    image: ${nats}`).replace(caddyImage, `    image: ${caddy}`);
    if (candidate !== current) {
      const temporary = `${dirname(compose)}/.compose-upgrade-${runtime.randomId()}.yaml`;
      try {
        await runtime.writeText(temporary, candidate, 0o640);
        await runtime.run([...composeRuntime(target.mode, manifest, temporary), "config"]);
      } finally { await runtime.remove(temporary).catch(() => {}); }
      await writeFileAtomically(runtime, compose, candidate, { owner: 0, mode: 0o640 });
    }
    await runtime.run([...composeRuntime(target.mode, manifest), "config"]);
    await runtime.run([...composeRuntime(target.mode, manifest), "pull"]);
    await runtime.run([...composeRuntime(target.mode, manifest), "up", "-d"]);
  };
  const rollback = async (snapshot: UpgradeSnapshot): Promise<void> => {
    const manifest = await requireUpgradeManifest(state);
    const saved = JSON.parse(snapshot.configuration) as UpgradeConfiguration;
    for (const [path, contents] of Object.entries(saved.files)) {
      await writeFileAtomically(runtime, path, contents, { owner: 0, mode: 0o640 });
      if (manifest.mode === "native" && path.endsWith("/nats-server.conf")) await runtime.run(["chown", "root:fos-nats", path]);
      if (manifest.mode === "native" && path.endsWith("/Caddyfile")) await runtime.run(["chown", "root:fos-caddy", path]);
    }
    if (manifest.mode === "native") {
      if (snapshot.packages?.length) await runtime.run(["apt-get", "install", "--yes", ...snapshot.packages.map((item) => `${item.name}=${item.version}`)]);
      await runtime.run(["systemctl", "daemon-reload"]);
      for (const service of manifest.resources.services) await runtime.run(["systemctl", "restart", service]);
    } else await runtime.run([...composeRuntime(manifest.mode, manifest), "up", "-d"]);
  };
  return {
    lifecycle: {
      inventory,
      backup: async () => { await runtime.run(["tar", "-C", "/var/lib/flash-osidian-sync", "-czf", `/var/lib/flash-osidian-sync/upgrade-${runtime.randomId()}.tar.gz`, "nats", "caddy-data", "caddy-config"]); },
      upgrade: async () => { throw new Error("UPGRADE_ADAPTER_REQUIRED"); }, rollback: async () => {},
      removeOwned: async () => {
        const manifest = await requireUpgradeManifest(state);
        if (manifest.mode === "native") for (const service of manifest.resources.services) await runtime.run(["systemctl", "disable", "--now", service]);
        else await runtime.run([...composeRuntime(manifest.mode, manifest), "down"]);
        for (const path of upgradeConfigPaths(manifest)) await runtime.remove(path);
        const statePath = manifest.mode === "native" ? "/etc/flash-osidian-sync/state.json" : "/opt/flash-osidian-sync/state.json";
        await runtime.remove(statePath);
      },
      removeData: async () => {
        if (!runtime.removeTree) throw new Error("RECURSIVE_DELETE_UNAVAILABLE");
        const manifest = await requireUpgradeManifest(state);
        for (const path of dataPaths(manifest)) await runtime.removeTree(path);
      },
    },
    upgrade: { ownedState, platform: readLocalPlatform, snapshot, backup: async () => {
      await runtime.run(["tar", "-C", "/var/lib/flash-osidian-sync", "-czf", `/var/lib/flash-osidian-sync/upgrade-${runtime.randomId()}.tar.gz`, "nats", "caddy-data", "caddy-config"]);
    }, validate, apply, healthCheck: async () => { const manifest = await requireUpgradeManifest(state); await verifyDomainEndpoint(manifest.domain, runtime); }, rollback },
  };
}

function waitForSocket<T>(executor: (done: (value: T) => void, fail: () => void) => void): Promise<T> {
  return new Promise((resolve) => executor(resolve, () => resolve(false as T)));
}

const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 10_000;

export function createLocalRuntime(): BootstrapRuntime {
  return {
    uid: () => process.getuid?.() ?? -1,
    run: async ([file, ...args]) => (await execFile(file!, [...args], { encoding: "utf8" })).stdout,
    runWithInput: ([file, ...args], input) => new Promise<string>((resolve, reject) => {
      const child = spawn(file!, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; let error = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(error || `COMMAND_FAILED:${file}`)));
      child.stdin.end(input);
    }),
    pathInfo: async (path) => {
      try {
        const info = await lstat(path);
        return { isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink(), uid: info.uid, mode: info.mode };
      } catch (error) { if (missing(error)) return undefined; throw error; }
    },
    readText: (path) => readFile(path, "utf8"),
    mkdir: (path) => mkdir(path, { recursive: true, mode: 0o750 }).then(() => undefined),
    writeText: (path, contents, mode) => writeFile(path, contents, { encoding: "utf8", mode, flag: "wx" }),
    rename,
    remove: (path) => rm(path, { force: true }),
    removeTree: (path) => rm(path, { recursive: true, force: false }),
    randomId: randomUUID,
    resolveDomain: (domain) => dns.resolve(domain),
    portReachable: (port) => waitForSocket<boolean>((done, fail) => {
      const socket = connectTcp({ host: "127.0.0.1", port });
      socket.setTimeout(5_000);
      socket.once("connect", () => { socket.destroy(); done(true); });
      socket.once("timeout", () => { socket.destroy(); fail(); });
      socket.once("error", () => fail());
    }),
    verifyCertificate: (domain, timeoutMs = DEFAULT_READINESS_PROBE_TIMEOUT_MS) => waitForSocket<boolean>((done, fail) => {
      const socket = connectTls({ host: domain, port: 443, servername: domain, rejectUnauthorized: true });
      socket.setTimeout(timeoutMs);
      socket.once("secureConnect", () => { const valid = socket.authorized; socket.destroy(); done(valid); });
      socket.once("timeout", () => { socket.destroy(); fail(); });
      socket.once("error", () => fail());
    }),
    verifyWss: (url, timeoutMs = DEFAULT_READINESS_PROBE_TIMEOUT_MS) => waitForSocket<boolean>((done, fail) => {
      const endpoint = new URL(url);
      const socket = connectTls({ host: endpoint.hostname, port: 443, servername: endpoint.hostname, rejectUnauthorized: true });
      let response = "";
      socket.setTimeout(timeoutMs);
      socket.once("secureConnect", () => socket.write(`GET ${endpoint.pathname || "/"} HTTP/1.1\r\nHost: ${endpoint.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
      socket.on("data", (chunk) => { response += chunk.toString("utf8"); if (response.includes("\r\n\r\n")) { socket.destroy(); done(/^HTTP\/1\.1 101\b/.test(response)); } });
      socket.once("timeout", () => { socket.destroy(); fail(); });
      socket.once("error", () => fail());
    }),
  };
}
