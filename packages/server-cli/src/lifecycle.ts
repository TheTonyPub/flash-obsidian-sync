import type { OwnedResource } from "./state.js";

export type LifecycleAction = "upgrade" | "uninstall";
export interface LifecycleAdapter {
  inventory(): Promise<readonly OwnedResource[]>;
  backup(): Promise<void>;
  upgrade(): Promise<void>;
  rollback(): Promise<void>;
  removeOwned(): Promise<void>;
  removeData(): Promise<void>;
}
export interface LifecycleOptions { confirmed: boolean; deleteData?: boolean; typedConfirmation?: string }

async function requireOwned(adapter: LifecycleAdapter): Promise<void> {
  if ((await adapter.inventory()).some((resource) => !resource.owned || resource.symlink)) throw new Error("RESOURCE_CONFLICT");
}

export async function previewLifecycle(action: LifecycleAction, adapter: LifecycleAdapter): Promise<string> {
  await requireOwned(adapter);
  return action === "upgrade" ? "fos upgrade preview: backup, validate, apply, rollback on failure; preserve data"
    : "fos uninstall preview: remove owned services/configuration; preserve data";
}

export async function runLifecycle(action: LifecycleAction, options: LifecycleOptions, adapter: LifecycleAdapter): Promise<void> {
  if (!options.confirmed) throw new Error("CONFIRMATION_REQUIRED");
  if (action === "uninstall" && options.deleteData && options.typedConfirmation !== "DELETE_DATA") {
    throw new Error("DATA_DELETION_CONFIRMATION_REQUIRED");
  }
  await requireOwned(adapter);
  if (action === "upgrade") {
    await adapter.backup();
    try { await adapter.upgrade(); } catch (error) { await adapter.rollback(); throw error; }
    return;
  }
  await adapter.removeOwned();
  if (options.deleteData) {
    await adapter.removeData();
  }
}
