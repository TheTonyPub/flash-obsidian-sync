import type { BootstrapPlan, HostPlatform } from "./cli.js";
import { nativeCompatibilityFor, type LockedNativePackage } from "./native-compatibility.js";
import { inspectDomainProxyConfiguration, renderDomainCaddyfile } from "./tls.js";
import type { OwnedResource } from "./state.js";
import { renderNatsAuthorization, type BootstrapCredentials } from "./credentials.js";

export type NativePackage = LockedNativePackage;

export interface NativeDeployment {
  packages: NativePackage[];
  commands: ReadonlyArray<readonly string[]>;
  natsConfig: string;
  caddyfile: string;
  units: Record<"fos-nats.service" | "fos-caddy.service", string>;
}

export interface NativeDeploymentAdapter {
  platform(): Promise<HostPlatform>;
  packageManagerAvailable(): Promise<boolean>;
  packageVersionAvailable(name: NativePackage["name"], version: string): Promise<boolean>;
  identityAvailable(identity: "fos-nats" | "fos-caddy"): Promise<boolean>;
  groupAvailable(group: "fos-nats" | "fos-caddy"): Promise<boolean>;
  vendorServicePresent(service: "nats-server.service" | "caddy.service"): Promise<boolean>;
  inventory(): Promise<OwnedResource[]>;
  writeFileAtomically(path: string, contents: string, options: { owner: 0; mode: number }): Promise<void>;
  enableAndStart(units: readonly ["fos-nats.service", "fos-caddy.service"]): Promise<void>;
  runCommand?(command: readonly string[]): Promise<void>;
  validateConfiguration?(deployment: NativeDeployment): Promise<void>;
  removeFile?(path: string): Promise<void>;
  disableAndStop?(units: readonly ["fos-nats.service", "fos-caddy.service"]): Promise<void>;
}

function unitFiles(plan: BootstrapPlan): NativeDeployment["units"] {
  const nats = `[Unit]
Description=Flash Osidian Sync NATS
After=network-online.target

[Service]
User=fos-nats
Group=fos-nats
ExecStart=/usr/sbin/nats-server -c ${plan.installPath}/nats-server.conf
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
StateDirectory=flash-osidian-sync/nats
LogsDirectory=flash-osidian-sync
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
  const caddy = `[Unit]
Description=Flash Osidian Sync Caddy
After=network-online.target fos-nats.service

[Service]
User=fos-caddy
Group=fos-caddy
ExecStart=/usr/bin/caddy run --environ --config ${plan.installPath}/Caddyfile
Restart=on-failure
StateDirectory=flash-osidian-sync/caddy-data flash-osidian-sync/caddy-config
LogsDirectory=flash-osidian-sync
Environment=XDG_DATA_HOME=${plan.dataPath}/caddy-data
Environment=XDG_CONFIG_HOME=${plan.dataPath}/caddy-config
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
  return { "fos-nats.service": nats, "fos-caddy.service": caddy };
}

export async function planNativeDeployment(plan: BootstrapPlan, host: NativeDeploymentAdapter, credentials?: BootstrapCredentials): Promise<NativeDeployment> {
  const packages = nativeCompatibilityFor(await host.platform());
  if (plan.mode !== "native" || !packages) throw new Error("UNSUPPORTED_PLATFORM");
  if (!await host.packageManagerAvailable() || !(await Promise.all(packages.map((item) => host.packageVersionAvailable(item.name, item.version)))).every(Boolean)) {
    throw new Error("NATIVE_PACKAGE_SOURCE_UNAVAILABLE");
  }
  if (!(await Promise.all([host.identityAvailable("fos-nats"), host.identityAvailable("fos-caddy")])).every(Boolean)) {
    throw new Error("NATIVE_IDENTITY_UNAVAILABLE");
  }
  if (!(await Promise.all([host.groupAvailable("fos-nats"), host.groupAvailable("fos-caddy")])).every(Boolean)) {
    throw new Error("NATIVE_GROUP_UNAVAILABLE");
  }
  const natsConfig = `jetstream { store_dir: "${plan.dataPath}/nats" }
listen: "127.0.0.1:4222"
websocket {
  listen: "127.0.0.1:9222"
  no_tls: true
}
${credentials ? renderNatsAuthorization(credentials) : ""}`;
  const caddyfile = renderDomainCaddyfile(plan.domain, "127.0.0.1:9222", plan.email);
  inspectDomainProxyConfiguration({ domain: plan.domain, caddyfile, natsConfig, natsPrivate: true });
  return {
    packages: [...packages],
    commands: [
      ["apt-get", "update"],
      ["apt-get", "install", "--yes", ...packages.map((item) => `${item.name}=${item.version}`)],
    ],
    natsConfig,
    caddyfile,
    units: unitFiles(plan),
  };
}

function conflicts(plan: BootstrapPlan, inventory: OwnedResource[]): boolean {
  const paths = new Set([`${plan.installPath}/nats-server.conf`, `${plan.installPath}/Caddyfile`, "/etc/systemd/system/fos-nats.service", "/etc/systemd/system/fos-caddy.service"]);
  const services = new Set(["fos-nats.service", "fos-caddy.service"]);
  return inventory.some((item) => ((item.kind === "path" && paths.has(item.value))
    || (item.kind === "service" && services.has(item.value)) || (item.kind === "port" && ["80", "443"].includes(item.value)))
    && (!item.owned || item.symlink));
}

function validateRenderedConfiguration(plan: BootstrapPlan, deployment: NativeDeployment): void {
  if (!deployment.natsConfig.includes(`store_dir: "${plan.dataPath}/nats"`)
    || !deployment.natsConfig.includes('listen: "127.0.0.1:9222"')
    || !deployment.caddyfile.includes(`${plan.domain} {`)) throw new Error("NATIVE_CONFIG_INVALID");
}

export async function installNativeDeployment(plan: BootstrapPlan, host: NativeDeploymentAdapter, credentials?: BootstrapCredentials): Promise<NativeDeployment> {
  const deployment = await planNativeDeployment(plan, host, credentials);
  if ((await Promise.all([host.vendorServicePresent("nats-server.service"), host.vendorServicePresent("caddy.service")])).some(Boolean)) {
    throw new Error("VENDOR_SERVICE_CONFLICT");
  }
  const inventory = await host.inventory();
  if (conflicts(plan, Array.isArray(inventory) ? inventory : [inventory] as unknown as OwnedResource[])) {
    throw new Error("NATIVE_RESOURCE_CONFLICT");
  }
  if (!host.runCommand) throw new Error("NATIVE_COMMAND_RUNNER_REQUIRED");
  const written: string[] = [];
  try {
    validateRenderedConfiguration(plan, deployment);
    // Distribution packages may attempt to start their vendor units during apt install.
    // Mask them until the authenticated configuration has been installed.
    await host.runCommand(["systemctl", "mask", "nats-server.service", "caddy.service"]);
    for (const command of deployment.commands) await host.runCommand(command);
    const files: Array<[string, string, number]> = [
      [`${plan.installPath}/nats-server.conf`, deployment.natsConfig, 0o640],
      [`${plan.installPath}/Caddyfile`, deployment.caddyfile, 0o644],
      ["/etc/systemd/system/fos-nats.service", deployment.units["fos-nats.service"], 0o644],
      ["/etc/systemd/system/fos-caddy.service", deployment.units["fos-caddy.service"], 0o644],
    ];
    for (const [path, contents, mode] of files) {
      await host.writeFileAtomically(path, contents, { owner: 0, mode });
      written.push(path);
    }
    await host.runCommand(["chmod", "0755", plan.installPath]);
    await host.runCommand(["chown", "root:fos-nats", `${plan.installPath}/nats-server.conf`]);
    await host.runCommand(["runuser", "-u", "fos-nats", "--", "test", "-r", `${plan.installPath}/nats-server.conf`]);
    await host.runCommand(["runuser", "-u", "fos-caddy", "--", "test", "-r", `${plan.installPath}/Caddyfile`]);
    await host.runCommand(["nats-server", "-c", `${plan.installPath}/nats-server.conf`, "-t"]);
    await host.runCommand(["caddy", "validate", "--config", `${plan.installPath}/Caddyfile`]);
    await host.validateConfiguration?.(deployment);
    await host.runCommand(["systemctl", "disable", "--now", "nats-server.service", "caddy.service"]);
    await host.runCommand(["systemctl", "unmask", "nats-server.service", "caddy.service"]);
    await host.enableAndStart(["fos-nats.service", "fos-caddy.service"]);
    return deployment;
  } catch (error) {
    await host.disableAndStop?.(["fos-nats.service", "fos-caddy.service"]);
    await host.runCommand(["systemctl", "unmask", "nats-server.service", "caddy.service"]).catch(() => {});
    for (const path of written.reverse()) await host.removeFile?.(path);
    throw error;
  }
}
