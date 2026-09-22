import { imageLock, imageReference } from "./image-lock.js";
import { nativeCompatibilityFor } from "./native-compatibility.js";
import type { HostPlatform } from "./cli.js";
import type { OwnedResource, OwnedStateManifest } from "./state.js";

export interface UpgradeTarget {
  mode: OwnedStateManifest["mode"];
  packages?: readonly { name: "nats-server" | "caddy"; version: string }[];
  images?: readonly string[];
}

/** Captures managed NATS/Caddy configuration and service enablement before mutation. */
export interface UpgradeSnapshot {
  configuration: string;
  services: Readonly<Record<string, string>>;
  packages?: readonly { name: "nats-server" | "caddy"; version: string }[];
}

/** Host boundary for a future `fos upgrade` command. Snapshot and rollback include only owned config/services. */
export interface UpgradeAdapter {
  ownedState(): Promise<OwnedResource | undefined>;
  platform(): Promise<HostPlatform>;
  snapshot(): Promise<UpgradeSnapshot>;
  backup(): Promise<void>;
  validate(target: UpgradeTarget): Promise<void>;
  apply(target: UpgradeTarget): Promise<void>;
  healthCheck(): Promise<void>;
  rollback(snapshot: UpgradeSnapshot): Promise<void>;
}

export interface UpgradeOptions { confirmed: boolean; }

function ownedManifest(resource: OwnedResource | undefined): OwnedStateManifest {
  if (!resource || resource.kind !== "state" || !resource.owned || resource.symlink || !resource.manifest) {
    throw new Error("MANAGED_STATE_REQUIRED");
  }
  return resource.manifest;
}

async function target(adapter: UpgradeAdapter): Promise<UpgradeTarget> {
  const manifest = ownedManifest(await adapter.ownedState());
  if (manifest.mode === "native") {
    const packages = nativeCompatibilityFor(await adapter.platform());
    if (!packages) throw new Error("UPGRADE_PLATFORM_UNSUPPORTED");
    return { mode: manifest.mode, packages };
  }
  return {
    mode: manifest.mode,
    images: [
      imageReference(imageLock.nats),
      imageReference(imageLock.caddy),
    ],
  };
}

/** Returns a redacted immutable target. No snapshot, backup, or service mutation occurs. */
export async function previewUpgrade(adapter: UpgradeAdapter): Promise<string> {
  const next = await target(adapter);
  const pinned = next.mode === "native"
    ? next.packages!.map((item) => `${item.name}=${item.version}`).join(", ")
    : next.images!.join(", ");
  return `fos upgrade preview: ${next.mode}; ${pinned}; backup, validate, apply, health-check, rollback on failure; preserve data`;
}

/** Runs one reversible owned-resource upgrade. Failure after apply restores service/config snapshot; backup data is retained. */
export async function runUpgrade(adapter: UpgradeAdapter, options: UpgradeOptions): Promise<void> {
  if (!options.confirmed) throw new Error("CONFIRMATION_REQUIRED");
  const next = await target(adapter);
  const snapshot = await adapter.snapshot();
  await adapter.backup();
  await adapter.validate(next);
  try {
    await adapter.apply(next);
    await adapter.healthCheck();
  } catch (error) {
    await adapter.rollback(snapshot).catch(() => {});
    throw error;
  }
}
