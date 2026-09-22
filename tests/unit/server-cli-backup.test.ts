import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalBackupAdapter,
  planBackupSchedule,
  restoreCheck,
  runBackup,
  renderBackupTimer,
  type BackupAdapter,
} from "../../packages/server-cli/src/backup.js";
import { runBackupCommand } from "../../packages/server-cli/src/cli.js";

function adapter(overrides: Partial<BackupAdapter> = {}): BackupAdapter {
  return {
    pathInfo: vi.fn().mockResolvedValue({ uid: 0, mode: 0o700 }),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    createSnapshot: vi.fn().mockResolvedValue({ path: "/backup/backup-new.snapshot", createdAt: 30 }),
    listSnapshots: vi.fn().mockResolvedValue([
      { path: "/backup/backup-old.snapshot", createdAt: 10 },
      { path: "/backup/backup-mid.snapshot", createdAt: 20 },
      { path: "/backup/backup-new.snapshot", createdAt: 30 },
    ]),
    removeSnapshot: vi.fn().mockResolvedValue(undefined),
    restoreSnapshot: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("fos backup schedules", () => {
  it("requires explicit opt-in, protected absolute destination, and bounded retention", () => {
    expect(() => planBackupSchedule({ enabled: false, destination: "/backup", retention: 2, interval: "daily" }))
      .toThrow("BACKUP_NOT_ENABLED");
    expect(() => planBackupSchedule({ enabled: true, destination: "relative", retention: 2, interval: "daily" }))
      .toThrow("BACKUP_DESTINATION_REQUIRED");
    expect(() => planBackupSchedule({ enabled: true, destination: "/backup", retention: 0, interval: "daily" }))
      .toThrow("BACKUP_RETENTION_INVALID");
    expect(() => planBackupSchedule({ enabled: true, destination: "/var/lib/flash-osidian-sync/nats/backups",
      retention: 2, interval: "daily", sources: ["/var/lib/flash-osidian-sync/nats"] }))
      .toThrow("BACKUP_DESTINATION_OVERLAPS_SOURCE");
  });

  it("refuses unsafe backup destinations and retains only the configured number of snapshots", async () => {
    const unsafe = adapter({ pathInfo: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o755 }) });
    const schedule = planBackupSchedule({ enabled: true, destination: "/backup", retention: 2, interval: "daily" });
    await expect(runBackup(schedule, unsafe)).rejects.toThrow("BACKUP_DESTINATION_UNPROTECTED");
    expect(unsafe.createSnapshot).not.toHaveBeenCalled();

    const safe = adapter();
    await runBackup(schedule, safe);
    expect(safe.removeSnapshot).toHaveBeenCalledWith("/backup/backup-old.snapshot");
    expect(safe.removeSnapshot).not.toHaveBeenCalledWith("/backup/backup-new.snapshot");
  });

  it("creates and verifies a restore in a disposable location", async () => {
    const root = await mkdtemp(join(tmpdir(), "fos-backup-test-"));
    try {
      const sourceA = join(root, "sources", "nats");
      const sourceB = join(root, "sources", "caddy-data");
      const destination = join(root, "backups");
      const restoreDestination = join(root, "restore");
      await mkdir(sourceA, { recursive: true });
      await mkdir(sourceB, { recursive: true });
      await writeFile(join(sourceA, "state.txt"), "jetstream");
      await writeFile(join(sourceB, "cert.txt"), "certificate");
      const schedule = planBackupSchedule({ enabled: true, destination, retention: 2, interval: "daily",
        sources: [sourceA, sourceB] });
      const local = createLocalBackupAdapter();
      const rootOwnedAdapter: BackupAdapter = {
        ...local,
        pathInfo: async (path) => {
          const info = await local.pathInfo(path);
          return info && { ...info, uid: 0 };
        },
      };
      const backup = await runBackup(schedule, rootOwnedAdapter);

      await expect(restoreCheck(schedule, backup, restoreDestination, rootOwnedAdapter)).resolves.toEqual({
        restoredSources: [sourceA, sourceB],
      });
      expect(await readFile(join(restoreDestination, sourceA.slice(1), "state.txt"), "utf8")).toBe("jetstream");
      expect(await readFile(join(restoreDestination, sourceB.slice(1), "cert.txt"), "utf8")).toBe("certificate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs backup only as root and never through bootstrap", async () => {
    const safe = adapter();
    await expect(runBackupCommand(["backup", "--destination", "/backup", "--retention", "2"], { isRoot: () => false, adapter: safe }))
      .rejects.toThrow("ROOT_REQUIRED");
    expect(safe.createSnapshot).not.toHaveBeenCalled();
    await expect(runBackupCommand(["backup", "--destination", "/backup", "--retention", "2"], { isRoot: () => true, adapter: safe }))
      .resolves.toEqual({ artifact: "/backup/backup-new.snapshot" });
  });

  it("renders a root-owned daily systemd schedule only for explicit backup input", () => {
    const schedule = planBackupSchedule({ enabled: true, destination: "/backup", retention: 2, interval: "daily" });
    const rendered = renderBackupTimer(schedule);
    expect(rendered.service).toContain("User=root");
    expect(rendered.service).toContain("fos backup --destination /backup --retention 2");
    expect(rendered.timer).toContain("OnCalendar=daily");
  });
});
