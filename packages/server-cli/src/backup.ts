import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

export const DEFAULT_BACKUP_SOURCES = [
  "/etc/flash-osidian-sync",
  "/var/lib/flash-osidian-sync/nats",
  "/var/lib/flash-osidian-sync/caddy-data",
  "/var/lib/flash-osidian-sync/caddy-config",
] as const;

export interface BackupScheduleInput {
  enabled: boolean;
  destination: string;
  retention: number;
  interval: "daily" | "weekly";
  sources?: readonly string[];
}

export interface BackupSchedule {
  readonly destination: string;
  readonly retention: number;
  readonly interval: "daily" | "weekly";
  readonly sources: readonly string[];
}

export interface BackupArtifact {
  readonly path: string;
  readonly createdAt: number;
}

export interface BackupPathInfo {
  readonly uid: number;
  readonly mode: number;
}

export interface BackupAdapter {
  pathInfo(path: string): Promise<BackupPathInfo | undefined>;
  createDirectory(path: string, mode: number): Promise<void>;
  createSnapshot(input: { destination: string; sources: readonly string[] }): Promise<BackupArtifact>;
  listSnapshots(destination: string): Promise<readonly BackupArtifact[]>;
  removeSnapshot(path: string): Promise<void>;
  restoreSnapshot(snapshotPath: string, target: string): Promise<readonly string[]>;
}

function invalidSource(path: string): boolean {
  return !isAbsolute(path) || path === "/" || relative("/", path).startsWith("..");
}

function overlaps(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return fromLeft === "" || fromRight === "" || (!fromLeft.startsWith("..") && !isAbsolute(fromLeft)) ||
    (!fromRight.startsWith("..") && !isAbsolute(fromRight));
}

function requireSchedule(input: BackupScheduleInput): BackupSchedule {
  if (!input.enabled) throw new Error("BACKUP_NOT_ENABLED");
  if (!isAbsolute(input.destination) || input.destination === "/") throw new Error("BACKUP_DESTINATION_REQUIRED");
  if (!Number.isSafeInteger(input.retention) || input.retention < 1 || input.retention > 365) {
    throw new Error("BACKUP_RETENTION_INVALID");
  }
  const sources = input.sources ?? DEFAULT_BACKUP_SOURCES;
  if (!sources.length || sources.some(invalidSource) || new Set(sources).size !== sources.length) {
    throw new Error("BACKUP_SOURCES_INVALID");
  }
  if (sources.some((source) => overlaps(source, input.destination))) throw new Error("BACKUP_DESTINATION_OVERLAPS_SOURCE");
  return { destination: input.destination, retention: input.retention, interval: input.interval, sources: [...sources] };
}

/** Validates an explicitly opted-in schedule; it does not install a scheduler. */
export function planBackupSchedule(input: BackupScheduleInput): BackupSchedule {
  return requireSchedule(input);
}

/** Root-owned systemd units. Installation is a separate explicit operator action. */
export function renderBackupTimer(schedule: BackupSchedule): { service: string; timer: string } {
  const calendar = schedule.interval === "daily" ? "daily" : "weekly";
  const command = `/usr/bin/fos backup --destination ${schedule.destination} --retention ${schedule.retention}`;
  return {
    service: `[Unit]\nDescription=Flash Osidian Sync backup\n\n[Service]\nType=oneshot\nUser=root\nExecStart=${command}\n`,
    timer: `[Unit]\nDescription=Flash Osidian Sync backup schedule\n\n[Timer]\nOnCalendar=${calendar}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

async function requireProtectedDestination(destination: string, adapter: BackupAdapter): Promise<void> {
  let info = await adapter.pathInfo(destination);
  if (!info) {
    await adapter.createDirectory(destination, 0o700);
    info = await adapter.pathInfo(destination);
  }
  if (!info || info.uid !== 0 || (info.mode & 0o077) !== 0) throw new Error("BACKUP_DESTINATION_UNPROTECTED");
}

/** Creates one protected snapshot and prunes only older snapshots managed by this adapter. */
export async function runBackup(schedule: BackupSchedule, adapter: BackupAdapter): Promise<BackupArtifact> {
  await requireProtectedDestination(schedule.destination, adapter);
  const artifact = await adapter.createSnapshot({ destination: schedule.destination, sources: schedule.sources });
  const snapshots = [...await adapter.listSnapshots(schedule.destination)]
    .sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
  for (const snapshot of snapshots.slice(0, Math.max(0, snapshots.length - schedule.retention))) {
    await adapter.removeSnapshot(snapshot.path);
  }
  return artifact;
}

/** Restores into a new disposable directory and confirms every scheduled source was restored. */
export async function restoreCheck(schedule: BackupSchedule, artifact: BackupArtifact, target: string,
  adapter: BackupAdapter): Promise<{ restoredSources: readonly string[] }> {
  if (!isAbsolute(target) || target === "/" || target === schedule.destination) throw new Error("RESTORE_TARGET_INVALID");
  if (await adapter.pathInfo(target)) throw new Error("RESTORE_TARGET_EXISTS");
  await adapter.createDirectory(target, 0o700);
  const restoredSources = await adapter.restoreSnapshot(artifact.path, target);
  if (restoredSources.length !== schedule.sources.length || restoredSources.some((source, index) => source !== schedule.sources[index])) {
    throw new Error("RESTORE_VERIFICATION_FAILED");
  }
  return { restoredSources };
}

type SnapshotManifest = { createdAt: number; sources: string[] };

function snapshotName(): string {
  return `backup-${Date.now()}-${crypto.randomUUID()}.snapshot`;
}

function payloadPath(source: string): string {
  if (invalidSource(source)) throw new Error("BACKUP_SOURCES_INVALID");
  return source.slice(1);
}

/** Local filesystem adapter. Callers choose sources and destination; no schedule is installed automatically. */
export function createLocalBackupAdapter(): BackupAdapter {
  return {
    async pathInfo(path) {
      try {
        const info = await stat(path);
        return { uid: info.uid, mode: info.mode & 0o777 };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async createDirectory(path, mode) { await mkdir(path, { recursive: true, mode }); },
    async createSnapshot({ destination, sources }) {
      const createdAt = Date.now();
      const path = join(destination, snapshotName());
      const payload = join(path, "payload");
      await mkdir(payload, { recursive: true, mode: 0o700 });
      for (const source of sources) {
        const target = join(payload, payloadPath(source));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await cp(source, target, { recursive: true, force: false, errorOnExist: true });
      }
      const manifest: SnapshotManifest = { createdAt, sources: [...sources] };
      await writeFile(join(path, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      return { path, createdAt };
    },
    async listSnapshots(destination) {
      const entries = await readdir(destination, { withFileTypes: true });
      const snapshots: BackupArtifact[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^backup-\d+-[0-9a-f-]+\.snapshot$/.test(entry.name)) continue;
        const path = join(destination, entry.name);
        try {
          const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as SnapshotManifest;
          if (Number.isSafeInteger(manifest.createdAt) && Array.isArray(manifest.sources)) snapshots.push({ path, createdAt: manifest.createdAt });
        } catch { /* Ignore incomplete snapshots; never delete unknown destination contents. */ }
      }
      return snapshots;
    },
    async removeSnapshot(path) { await rm(path, { recursive: true, force: false }); },
    async restoreSnapshot(snapshotPath, target) {
      const manifest = JSON.parse(await readFile(join(snapshotPath, "manifest.json"), "utf8")) as SnapshotManifest;
      if (!Array.isArray(manifest.sources) || manifest.sources.some(invalidSource)) throw new Error("BACKUP_MANIFEST_INVALID");
      for (const source of manifest.sources) {
        const output = join(target, payloadPath(source));
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await cp(join(snapshotPath, "payload", payloadPath(source)), output, { recursive: true, force: false, errorOnExist: true });
      }
      return manifest.sources;
    },
  };
}
