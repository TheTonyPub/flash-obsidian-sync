import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_PLUGIN_ID,
  LEGACY_MIGRATION_MARKER,
  PLUGIN_ID,
  migrateLegacyPluginData,
  registerImportUriHandlers,
  type PluginIdentityMigrationAdapter,
} from "../../packages/plugin/src/plugin-id-migration.js";

const legacySettings = {
  vaultId: "VAULT_A",
  boundVaultId: "VAULT_A",
  deviceId: "device-a",
  server: "wss://sync.example.test",
  username: "user-a",
  passwordSecretKey: "easy-sync-nats-secret-a",
  s3SecretKeySecretKey: "easy-sync-s3-secret-a",
};

const migratedSettings = {
  ...legacySettings,
  [LEGACY_MIGRATION_MARKER]: {
    fromPluginId: LEGACY_PLUGIN_ID,
    vaultId: "VAULT_A",
    deviceId: "device-a",
    boundVaultId: "VAULT_A",
    outbox: "copied",
  },
};

function migrationAdapter(overrides: Partial<PluginIdentityMigrationAdapter> = {}): PluginIdentityMigrationAdapter & {
  loadPluginData: ReturnType<typeof vi.fn>;
  savePluginData: ReturnType<typeof vi.fn>;
  copyIndexedDb: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  getSecret: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
} {
  return {
    loadPluginData: vi.fn().mockImplementation(async (id: string) => id === LEGACY_PLUGIN_ID ? legacySettings : null),
    savePluginData: vi.fn().mockResolvedValue(undefined),
    copyIndexedDb: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    getSecret: vi.fn(),
    setSecret: vi.fn(),
    ...overrides,
  } as unknown as PluginIdentityMigrationAdapter & {
    loadPluginData: ReturnType<typeof vi.fn>;
    savePluginData: ReturnType<typeof vi.fn>;
    copyIndexedDb: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    getSecret: ReturnType<typeof vi.fn>;
    setSecret: ReturnType<typeof vi.fn>;
  };
}

describe("legacy easy-sync identity migration", () => {
  it("preserves settings, SecretStorage key references, and the IndexedDB outbox", async () => {
    const adapter = migrationAdapter();

    const result = await migrateLegacyPluginData(adapter);

    expect(LEGACY_PLUGIN_ID).toBe("easy-sync");
    expect(PLUGIN_ID).toBe("flash-osidian-sync");
    expect(adapter.copyIndexedDb).toHaveBeenCalledWith(
      "easy-sync-device-a-VAULT_A",
      "flash-osidian-sync-device-a-VAULT_A",
    );
    expect(adapter.savePluginData).toHaveBeenCalledWith(PLUGIN_ID, expect.objectContaining({
      ...legacySettings,
      [LEGACY_MIGRATION_MARKER]: {
        fromPluginId: LEGACY_PLUGIN_ID,
        vaultId: "VAULT_A",
        deviceId: "device-a",
        boundVaultId: "VAULT_A",
        outbox: "copied",
      },
    }));
    expect(adapter.getSecret).not.toHaveBeenCalled();
    expect(adapter.setSecret).not.toHaveBeenCalled();
    expect(result.migrated).toBe(true);
  });

  it("is idempotent once new settings and outbox state already exist", async () => {
    const adapter = migrationAdapter({
      loadPluginData: vi.fn().mockImplementation(async (id: string) => id === PLUGIN_ID ? migratedSettings : legacySettings),
      indexedDbExists: vi.fn().mockResolvedValue(true),
    });

    const result = await migrateLegacyPluginData(adapter);

    expect(result.migrated).toBe(false);
    expect(adapter.copyIndexedDb).not.toHaveBeenCalled();
    expect(adapter.savePluginData).not.toHaveBeenCalled();
  });

  it("fails closed when matching new settings lack a completed migration marker", async () => {
    const adapter = migrationAdapter({
      loadPluginData: vi.fn().mockImplementation(async (id: string) => id === PLUGIN_ID ? legacySettings : legacySettings),
      indexedDbExists: vi.fn().mockResolvedValue(true),
    });

    await expect(migrateLegacyPluginData(adapter)).rejects.toThrow("PLUGIN_ID_MIGRATION_CONFLICT");
    expect(adapter.copyIndexedDb).not.toHaveBeenCalled();
    expect(adapter.savePluginData).not.toHaveBeenCalled();
    expect(adapter.rollback).not.toHaveBeenCalled();
  });

  it("accepts later new-plugin setting changes when the migration marker and identity match", async () => {
    const unchangedLegacy = { ...legacySettings };
    let current: Record<string, unknown> | null = null;
    let targetExists = false;
    const adapter = migrationAdapter({
      loadPluginData: vi.fn().mockImplementation(async (id: string) => id === PLUGIN_ID ? current : unchangedLegacy),
      savePluginData: vi.fn().mockImplementation(async (_id: string, data: Record<string, unknown>) => { current = data; }),
      indexedDbExists: vi.fn().mockImplementation(async (name: string) => name.startsWith(PLUGIN_ID) ? targetExists : true),
    });

    await expect(migrateLegacyPluginData(adapter)).resolves.toEqual({ migrated: true });
    targetExists = true;
    current = { ...(current ?? {}), server: "wss://new-endpoint.example.test", debugLogging: true };

    await expect(migrateLegacyPluginData(adapter)).resolves.toEqual({ migrated: false });
    expect(adapter.copyIndexedDb).toHaveBeenCalledOnce();
    expect(adapter.savePluginData).toHaveBeenCalledOnce();
    expect(unchangedLegacy).toEqual(legacySettings);
  });

  it("records an absent legacy outbox and remains restart-safe", async () => {
    const unchangedLegacy = { ...legacySettings };
    let current: Record<string, unknown> | null = null;
    const adapter = migrationAdapter({
      loadPluginData: vi.fn().mockImplementation(async (id: string) => id === PLUGIN_ID ? current : unchangedLegacy),
      savePluginData: vi.fn().mockImplementation(async (_id: string, data: Record<string, unknown>) => { current = data; }),
      indexedDbExists: vi.fn().mockResolvedValue(false),
    });

    await expect(migrateLegacyPluginData(adapter)).resolves.toEqual({ migrated: true });
    expect(adapter.copyIndexedDb).not.toHaveBeenCalled();
    expect(current).toEqual(expect.objectContaining({
      [LEGACY_MIGRATION_MARKER]: expect.objectContaining({ outbox: "absent" }),
    }));
    await expect(migrateLegacyPluginData(adapter)).resolves.toEqual({ migrated: false });
    expect(adapter.savePluginData).toHaveBeenCalledOnce();
    expect(unchangedLegacy).toEqual(legacySettings);
  });

  it("does not accept a target database alone when new settings conflict with legacy settings", async () => {
    const adapter = migrationAdapter({
      loadPluginData: vi.fn().mockImplementation(async (id: string) => id === PLUGIN_ID ? { ...legacySettings, vaultId: "VAULT_B" } : legacySettings),
      indexedDbExists: vi.fn().mockResolvedValue(true),
    });

    await expect(migrateLegacyPluginData(adapter)).rejects.toThrow("PLUGIN_ID_MIGRATION_CONFLICT");
    expect(adapter.copyIndexedDb).not.toHaveBeenCalled();
    expect(adapter.savePluginData).not.toHaveBeenCalled();
    expect(adapter.rollback).not.toHaveBeenCalled();
  });

  it("rolls back the migration marker when IndexedDB outbox copy is interrupted and can retry", async () => {
    const copyIndexedDb = vi.fn()
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockResolvedValueOnce(undefined);
    const adapter = migrationAdapter({ copyIndexedDb });

    await expect(migrateLegacyPluginData(adapter)).rejects.toThrow("PLUGIN_ID_MIGRATION_FAILED");
    expect(adapter.rollback).toHaveBeenCalledOnce();
    expect(adapter.savePluginData).not.toHaveBeenCalled();

    await expect(migrateLegacyPluginData(adapter)).resolves.toEqual(expect.objectContaining({ migrated: true }));
    expect(copyIndexedDb).toHaveBeenCalledTimes(2);
  });

  it("rolls back copied durable state when saving new settings fails", async () => {
    const adapter = migrationAdapter({ savePluginData: vi.fn().mockRejectedValue(new Error("write interrupted")) });

    await expect(migrateLegacyPluginData(adapter)).rejects.toThrow("PLUGIN_ID_MIGRATION_FAILED");
    expect(adapter.copyIndexedDb).toHaveBeenCalledOnce();
    expect(adapter.rollback).toHaveBeenCalledOnce();
  });

  it("does not migrate when IndexedDB existence cannot be safely determined", async () => {
    const adapter = migrationAdapter({ indexedDbExists: vi.fn().mockResolvedValue(undefined) });

    await expect(migrateLegacyPluginData(adapter)).rejects.toThrow("PLUGIN_ID_MIGRATION_FAILED");
    expect(adapter.copyIndexedDb).not.toHaveBeenCalled();
    expect(adapter.savePluginData).not.toHaveBeenCalled();
    expect(adapter.rollback).toHaveBeenCalledOnce();
  });

  it("reports conflicting new and legacy settings without overwriting either", async () => {
    const adapter = migrationAdapter({
      loadPluginData: vi.fn().mockImplementation(async (id: string) => id === PLUGIN_ID ? { ...legacySettings, vaultId: "VAULT_B" } : legacySettings),
      indexedDbExists: vi.fn().mockResolvedValue(false),
    });

    await expect(migrateLegacyPluginData(adapter)).rejects.toThrow("PLUGIN_ID_MIGRATION_CONFLICT");
    expect(adapter.copyIndexedDb).not.toHaveBeenCalled();
    expect(adapter.savePluginData).not.toHaveBeenCalled();
    expect(adapter.rollback).not.toHaveBeenCalled();
  });

  it("registers both new and legacy import URI handlers during the migration window", async () => {
    const register = vi.fn();
    const receive = vi.fn();

    registerImportUriHandlers(register, receive);

    expect(register.mock.calls.map(([scheme]) => scheme).sort()).toEqual([
      "easy-sync-import",
      "flash-osidian-sync-import",
    ]);
    for (const [, handler] of register.mock.calls) handler({ data: "encrypted-transfer" });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenLastCalledWith("encrypted-transfer");
  });
});
