export const LEGACY_PLUGIN_ID = "easy-sync";
export const PLUGIN_ID = "flash-osidian-sync";
export const LEGACY_MIGRATION_MARKER = "legacyMigration";

type PluginSettings = Record<string, unknown>;

export interface LegacyMigrationMarker {
  fromPluginId: typeof LEGACY_PLUGIN_ID;
  vaultId: string;
  deviceId: string;
  boundVaultId: string;
  outbox: "copied" | "absent";
}

export interface PluginIdentityMigrationAdapter {
  loadPluginData(pluginId: string): Promise<PluginSettings | null | undefined>;
  savePluginData(pluginId: string, data: PluginSettings): Promise<void>;
  indexedDbExists?(name: string): Promise<boolean | undefined>;
  copyIndexedDb(source: string, target: string): Promise<void>;
  rollback(): Promise<void>;
  // Secret values deliberately remain in Obsidian SecretStorage. Settings only
  // contain their keys, so migration must never read or write secrets.
  getSecret?(key: string): Promise<string | null>;
  setSecret?(key: string, value: string): Promise<void>;
}

export interface PluginIdentityMigrationResult {
  migrated: boolean;
}

function storeName(settings: PluginSettings, pluginId: string): string | undefined {
  const deviceId = settings.deviceId;
  const vaultId = settings.vaultId;
  return typeof deviceId === "string" && deviceId && typeof vaultId === "string" && vaultId
    ? `${pluginId}-${deviceId}-${vaultId}`
    : undefined;
}

function identity(settings: PluginSettings): Pick<LegacyMigrationMarker, "vaultId" | "deviceId" | "boundVaultId"> | undefined {
  const { vaultId, deviceId, boundVaultId } = settings;
  return typeof vaultId === "string" && typeof deviceId === "string" && typeof boundVaultId === "string"
    ? { vaultId, deviceId, boundVaultId }
    : undefined;
}

function sameIdentity(left: PluginSettings, right: PluginSettings): boolean {
  const leftIdentity = identity(left);
  const rightIdentity = identity(right);
  return !!leftIdentity && !!rightIdentity
    && leftIdentity.vaultId === rightIdentity.vaultId
    && leftIdentity.deviceId === rightIdentity.deviceId
    && leftIdentity.boundVaultId === rightIdentity.boundVaultId;
}

function migrationMarker(settings: PluginSettings): LegacyMigrationMarker | undefined {
  const value = settings[LEGACY_MIGRATION_MARKER];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const marker = value as Record<string, unknown>;
  return marker.fromPluginId === LEGACY_PLUGIN_ID
    && typeof marker.vaultId === "string"
    && typeof marker.deviceId === "string"
    && typeof marker.boundVaultId === "string"
    && (marker.outbox === "copied" || marker.outbox === "absent")
    ? {
      fromPluginId: LEGACY_PLUGIN_ID,
      vaultId: marker.vaultId,
      deviceId: marker.deviceId,
      boundVaultId: marker.boundVaultId,
      outbox: marker.outbox,
    }
    : undefined;
}

function markerFor(settings: PluginSettings, outbox: LegacyMigrationMarker["outbox"]): LegacyMigrationMarker | undefined {
  const value = identity(settings);
  return value ? { fromPluginId: LEGACY_PLUGIN_ID, ...value, outbox } : undefined;
}

function markerMatchesLegacy(marker: LegacyMigrationMarker, legacy: PluginSettings): boolean {
  const legacyIdentity = identity(legacy);
  return !!legacyIdentity
    && marker.vaultId === legacyIdentity.vaultId
    && marker.deviceId === legacyIdentity.deviceId
    && marker.boundVaultId === legacyIdentity.boundVaultId;
}

export async function migrateLegacyPluginData(
  adapter: PluginIdentityMigrationAdapter,
): Promise<PluginIdentityMigrationResult> {
  // New settings are the committed migration marker. Never overwrite a user's
  // already-configured new installation.
  const current = await adapter.loadPluginData(PLUGIN_ID);
  const legacy = await adapter.loadPluginData(LEGACY_PLUGIN_ID);
  if (current && !legacy) return { migrated: false };
  if (!legacy) return { migrated: false };

  const source = storeName(legacy, LEGACY_PLUGIN_ID);
  const target = storeName(legacy, PLUGIN_ID);
  const targetExists = target ? await adapter.indexedDbExists?.(target) : undefined;
  if (current) {
    if (!sameIdentity(current, legacy)) {
      throw new Error("PLUGIN_ID_MIGRATION_CONFLICT: new and legacy plugin identities differ");
    }
    // The marker and matching target store prove a prior migration even when
    // ordinary new-plugin settings (for example the endpoint) were edited.
    const marker = migrationMarker(current);
    if (marker && markerMatchesLegacy(marker, legacy)
      && (marker.outbox === "absent" || targetExists === true)) return { migrated: false };
    // Without both pieces of completion evidence, connecting could start with
    // an empty new outbox while legacy pending operations still exist.
    throw new Error("PLUGIN_ID_MIGRATION_CONFLICT: legacy durable state is not proven migrated");
  }
  try {
    let outbox: LegacyMigrationMarker["outbox"] = "copied";
    if (source && target) {
      const sourceExists = await adapter.indexedDbExists?.(source);
      if (targetExists === true) {
        throw new Error("target IndexedDB already exists without migrated settings");
      }
      if (adapter.indexedDbExists && (sourceExists === undefined || targetExists === undefined)) {
        throw new Error("cannot safely determine IndexedDB migration state");
      }
      if (sourceExists === false) outbox = "absent";
      else await adapter.copyIndexedDb(source, target);
    }
    const marker = markerFor(legacy, outbox);
    await adapter.savePluginData(PLUGIN_ID, marker ? { ...legacy, [LEGACY_MIGRATION_MARKER]: marker } : legacy);
    return { migrated: true };
  } catch (error) {
    try {
      await adapter.rollback();
    } catch (rollbackError) {
      throw new Error(`PLUGIN_ID_MIGRATION_FAILED: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw new Error(`PLUGIN_ID_MIGRATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type ImportUriHandler = (params: { data?: string }) => void;
export type ImportUriRegistrar = (scheme: string, handler: ImportUriHandler) => void;

export function registerImportUriHandlers(register: ImportUriRegistrar, receive: (data: string) => void): void {
  const handler: ImportUriHandler = (params) => receive(params.data ?? "");
  register("easy-sync-import", handler);
  register("flash-osidian-sync-import", handler);
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export async function indexedDbExists(name: string, factory: IDBFactory = indexedDB): Promise<boolean | undefined> {
  const databases = (factory as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases;
  // The standard API has no non-creating existence probe. Callers fail closed
  // when this extension is unavailable, preserving the legacy source database.
  if (!databases) return undefined;
  return (await databases.call(factory)).some((database) => database.name === name);
}

export async function copyIndexedDbDatabase(sourceName: string, targetName: string, factory: IDBFactory = indexedDB): Promise<void> {
  const source = await request(factory.open(sourceName));
  let targetCreated = false;
  try {
    const storeDefinitions = Array.from(source.objectStoreNames).map((name) => {
      const store = source.transaction(name).objectStore(name);
      return {
        name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames).map((indexName) => {
          const index = store.index(indexName);
          return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }),
      };
    });
    const copied = await Promise.all(storeDefinitions.map(async ({ name }) => {
      const transaction = source.transaction(name, "readonly");
      const records = await request(transaction.objectStore(name).getAll());
      await transactionDone(transaction);
      return [name, records] as const;
    }));
    const opening = factory.open(targetName, Math.max(source.version, 1));
    opening.onupgradeneeded = () => {
      targetCreated = true;
      const database = opening.result;
      for (const definition of storeDefinitions) {
        const store = database.createObjectStore(definition.name, { keyPath: definition.keyPath, autoIncrement: definition.autoIncrement });
        for (const index of definition.indexes) {
          store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      }
    };
    const target = await request(opening);
    try {
      if (!targetCreated) throw new Error("target IndexedDB already exists");
      const transaction = target.transaction(storeDefinitions.map(({ name }) => name), "readwrite");
      for (const [name, records] of copied) {
        const store = transaction.objectStore(name);
        for (const record of records) store.put(record);
      }
      await transactionDone(transaction);
    } finally { target.close(); }
  } catch (error) {
    if (targetCreated) await request(factory.deleteDatabase(targetName));
    throw error;
  } finally { source.close(); }
}

export async function deleteIndexedDbDatabase(name: string, factory: IDBFactory = indexedDB): Promise<void> {
  await request(factory.deleteDatabase(name));
}
