export interface FirewallOption {
  enabled: boolean;
  confirmed?: boolean;
}

export type ServiceIdentityOption =
  | { kind: "existing"; user: string; group: string }
  | { kind: "dedicated"; confirmed?: boolean };

export interface HostOptions {
  firewall: FirewallOption;
  identity: ServiceIdentityOption;
}

export interface HostOptionsAdapter {
  activeSshPort(): Promise<number | undefined>;
  previewFirewall(ports: readonly number[]): Promise<void>;
  applyFirewall(ports: readonly number[]): Promise<void>;
  verifySsh(port: number): Promise<boolean>;
  rollbackFirewall(): Promise<void>;
  identityExists(user: string, group: string): Promise<boolean>;
  createDedicatedIdentity(user: "fos-nats" | "fos-caddy", group: "fos-nats" | "fos-caddy"): Promise<void>;
}

function validIdentity(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value);
}

/** Builds an opt-in host-control plan without mutating firewall rules or users. */
export function planHostOptions(options: HostOptions): HostOptions {
  if (options.identity.kind === "existing" && (!validIdentity(options.identity.user) || !validIdentity(options.identity.group))) {
    throw new Error("SERVICE_IDENTITY_INVALID");
  }
  return options;
}

/** Applies only a confirmed firewall change and rolls it back if the active SSH path is lost. */
export async function applyFirewallOption(option: FirewallOption, adapter: HostOptionsAdapter): Promise<"skipped" | "applied"> {
  if (!option.enabled) return "skipped";
  if (!option.confirmed) throw new Error("FIREWALL_CONFIRMATION_REQUIRED");
  const sshPort = await adapter.activeSshPort();
  if (!sshPort || !Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error("ACTIVE_SSH_PORT_REQUIRED");
  const ports = [sshPort, 80, 443];
  await adapter.previewFirewall(ports);
  await adapter.applyFirewall(ports);
  if (await adapter.verifySsh(sshPort)) return "applied";
  await adapter.rollbackFirewall();
  throw new Error("SSH_PRESERVATION_FAILED");
}

/** Chooses an existing safe identity or creates the dedicated identity only after confirmation. */
export async function applyServiceIdentity(option: ServiceIdentityOption, adapter: HostOptionsAdapter): Promise<{ user: string; group: string }> {
  if (option.kind === "dedicated") {
    if (!option.confirmed) throw new Error("IDENTITY_CONFIRMATION_REQUIRED");
    await adapter.createDedicatedIdentity("fos-nats", "fos-nats");
    await adapter.createDedicatedIdentity("fos-caddy", "fos-caddy");
    return { user: "fos-nats", group: "fos-nats" };
  }
  if (!await adapter.identityExists(option.user, option.group)
    || !await adapter.identityExists("fos-caddy", "fos-caddy")) throw new Error("SERVICE_IDENTITY_UNAVAILABLE");
  return { user: option.user, group: option.group };
}
