import { chmod, chown, lstat, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostPlatform } from "./cli.js";
import type { OwnedResource, OwnedStateAdapter, OwnedStateManifest } from "./state.js";

export async function readLocalPlatform(
  readOsRelease: (path: string, encoding: "utf8") => Promise<string> = readFile,
  architecture = process.arch,
): Promise<HostPlatform> {
  const values = Object.fromEntries((await readOsRelease("/etc/os-release", "utf8"))
    .split("\n")
    .flatMap((line) => {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      return match ? [[match[1], match[2].replace(/^"|"$/g, "")]] : [];
    }));
  return {
    distribution: values.ID?.toLowerCase() ?? "unknown",
    release: values.VERSION_ID ?? "unknown",
    architecture: architecture === "x64" ? "amd64" : architecture,
  };
}

export async function readLocalProtectedInput(
  path: string,
  read: (path: string, encoding: "utf8") => Promise<string> = readFile,
  inspect: (path: string) => Promise<{ mode: number; uid: number }> = stat,
): Promise<{ content: string; mode: number; uid: number }> {
  const [content, metadata] = await Promise.all([read(path, "utf8"), inspect(path)]);
  return { content, mode: metadata.mode, uid: metadata.uid };
}

export async function localPathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface LocalStateAdapterOptions {
  nativeStatePath?: string;
  composeStatePath?: string;
  owner?: number;
}

const defaultStatePaths = {
  nativeStatePath: "/etc/flash-osidian-sync/state.json",
  composeStatePath: "/opt/flash-osidian-sync/state.json",
};

function validManifest(value: unknown): value is OwnedStateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !["native", "docker", "podman"].includes(data.mode as string)
    || typeof data.domain !== "string" || typeof data.vaultId !== "string") return false;
  const resources = data.resources;
  return !!resources && typeof resources === "object" && !Array.isArray(resources)
    && Array.isArray((resources as Record<string, unknown>).paths)
    && Array.isArray((resources as Record<string, unknown>).services)
    && Array.isArray((resources as Record<string, unknown>).ports);
}

async function localStateResource(path: string, owner: number): Promise<OwnedResource | undefined> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try { metadata = await lstat(path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink()) return { kind: "state", value: path, owned: false, symlink: true };
  if (!metadata.isFile() || metadata.uid !== owner || (metadata.mode & 0o077) !== 0) {
    return { kind: "state", value: path, owned: false };
  }
  try {
    const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
    return validManifest(manifest) ? { kind: "state", value: path, owned: true, manifest } : { kind: "state", value: path, owned: false };
  } catch { return { kind: "state", value: path, owned: false }; }
}

export function createLocalOwnedStateAdapter(options: LocalStateAdapterOptions = {}): OwnedStateAdapter {
  const paths = { ...defaultStatePaths, ...options };
  const owner = options.owner ?? 0;
  const statePaths = [paths.nativeStatePath, paths.composeStatePath];
  return {
    inventory: async () => (await Promise.all(statePaths.map((path) => localStateResource(path, owner)))).filter((value): value is OwnedResource => !!value),
    writeStateAtomically: async (path, contents, writeOptions) => {
      if (!statePaths.includes(path) || writeOptions.owner !== owner || writeOptions.mode !== 0o600) throw new Error("STATE_WRITE_REJECTED");
      try {
        const existing = await lstat(path);
        if (existing.isSymbolicLink()) throw new Error("RESOURCE_CONFLICT");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temporary = join(dirname(path), `.state-${process.pid}-${crypto.randomUUID()}.tmp`);
      try {
        await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await chown(temporary, owner, -1);
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}
