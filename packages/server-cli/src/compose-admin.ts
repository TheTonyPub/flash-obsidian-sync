import { imageLock, imageReference } from "./image-lock.js";
import { fileURLToPath } from "node:url";

export interface ComposeAdminRuntime {
  runContainer(args: readonly string[], stdin: string): Promise<string>;
}

export interface ComposeWorkerRequest {
  action: "create" | "list" | "inspect" | "verify";
  username: string;
  password: string;
  vaultId?: string;
  crossVaultId?: string;
}

/** Published alongside the CLI entrypoint and mounted read-only for one-shot execution. */
export const composeAdminWorkerPath = fileURLToPath(new URL("./admin-worker.js", import.meta.url));

export async function runComposeAdminWorker(runtime: ComposeAdminRuntime, project: "flash-osidian-sync", workerPath: string,
  request: ComposeWorkerRequest): Promise<string> {
  const image = imageReference(imageLock.nodeAdmin);
  return runtime.runContainer([
    "run", "--rm", "-i", "--network", `${project}_fos-internal`, "--pull", "never",
    "--mount", `type=bind,src=${workerPath},dst=/app/admin-worker.js,readonly`, image, "node", "/app/admin-worker.js",
  ], `${JSON.stringify(request)}\n`);
}

/** Runs a one-shot nats-box client on the private Compose network. The caller supplies a stdin-only script. */
export async function runComposeAdmin(runtime: ComposeAdminRuntime, project: "flash-osidian-sync", script: string): Promise<string> {
  if (!script.trim()) throw new Error("ADMIN_SCRIPT_REQUIRED");
  const image = imageReference(imageLock.natsBox);
  return runtime.runContainer([
    "run", "--rm", "-i", "--network", `${project}_fos-internal`, "--pull", "never",
    image, "sh", "-s",
  ], script);
}
