import { Kvm, type KV } from "@nats-io/kv";
import { wsconnect, type NatsConnection } from "@nats-io/nats-core";
import { errorSummary, type PluginLogger } from "./diagnostics.js";

export interface VaultConnectionConfig {
  vaultId: string;
  bucket: string;
  server: string;
  username: string;
  passwordSecretKey: string;
}

export interface SecretStore {
  getSecret(key: string): Promise<string | null>;
}

export interface RemoteEntry {
  value: Uint8Array;
  revision: number;
}

export interface KvPort {
  readonly maxValueBytes?: number;
  get(key: string): RemoteEntry | null | undefined | Promise<RemoteEntry | null | undefined>;
  list(): Array<{ key: string; value: Uint8Array; revision: number }> | Promise<Array<{ key: string; value: Uint8Array; revision: number }>>;
  put(key: string, value: Uint8Array): number | Promise<number>;
  watch(listener: (entry: { key: string; value: Uint8Array; revision: number }) => void):
    (() => void) | Promise<() => void>;
  create?(key: string, value: Uint8Array): number | Promise<number>;
  update?(key: string, value: Uint8Array, revision: number): number | Promise<number>;
  close?(): Promise<void>;
}

export type StatusValue = "INITIALIZING" | "OFFLINE" | "AUTH_ERROR" | "RECONCILING" | "PENDING" | "LIVE" | "CONFLICT" | "ERROR" | "SYNCED";
export type ConnectionState = "UNCONFIGURED" | "CONNECTING" | "CONNECTED" | "OFFLINE" | "AUTH_ERROR";
export type AttachmentState = "NOT_CONFIGURED" | "CONFIGURED" | "CONFIGURATION_ERROR" | "TRANSFER_ERROR";

export class SyncStatus {
  value: StatusValue = "INITIALIZING";
  connectionState: ConnectionState = "UNCONFIGURED";
  connectionError = "";
  attachmentState: AttachmentState = "NOT_CONFIGURED";
  attachmentError = "";
  connected = false;
  reconciled = false;
  pending = 0;
  conflicts = 0;
  private readonly errorKeys = new Set<string>();
  get errors(): number { return this.errorKeys.size; }
  conflictPaths: string[] = [];
  blobsPending = 0;
  lastError = "";
  onReconnect?: () => void;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markError(key: string): void { this.errorKeys.add(key); this.refresh(); }
  clearError(key: string): void { this.errorKeys.delete(key); this.refresh(); }

  refresh(): void {
    if (this.value === "AUTH_ERROR") { this.emit(); return; }
    if (!this.connected) this.value = "OFFLINE";
    else if (this.conflicts > 0) this.value = "CONFLICT";
    else if (this.errors > 0) this.value = "ERROR";
    else if (!this.reconciled) this.value = "RECONCILING";
    else if (this.pending > 0 || this.blobsPending > 0) this.value = "PENDING";
    else this.value = "SYNCED";
    this.emit();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

export function statusSummary(status: SyncStatus): string {
  return status.conflictPaths.length
    ? `${status.value} · ${status.conflictPaths.length} ${status.conflictPaths.length === 1 ? "copy" : "copies"} to review`
    : status.value;
}

export type KvConnector = (options: { servers: string; user: string; pass: string }, bucket: string, status?: SyncStatus) => Promise<KvPort>;

export async function connectVault(
  config: VaultConnectionConfig,
  secrets: SecretStore,
  connector: KvConnector,
  status: SyncStatus,
): Promise<KvPort> {
  if (!config.server.startsWith("wss://")) throw new Error("WSS endpoint required");
  if (!/^[A-Za-z0-9_-]+$/.test(config.vaultId) || config.bucket !== `OBS_${config.vaultId}_FILES`) {
    throw new Error("Invalid vault bucket binding");
  }
  const pass = await secrets.getSecret(config.passwordSecretKey);
  if (!pass) {
    status.value = "AUTH_ERROR";
    status.connectionState = "AUTH_ERROR";
    status.connectionError = "NATS password missing";
    throw new Error("NATS password missing");
  }
  try {
    const kv = await connector({ servers: config.server, user: config.username, pass }, config.bucket, status);
    status.connected = true;
    status.connectionState = "CONNECTED";
    status.connectionError = "";
    status.value = "RECONCILING";
    return kv;
  } catch (error) {
    status.connected = false;
    const authError = /auth|permission|authorization/i.test(String(error));
    status.connectionState = authError ? "AUTH_ERROR" : "OFFLINE";
    status.connectionError = errorSummary(error);
    status.value = authError ? "AUTH_ERROR" : "OFFLINE";
    throw error;
  }
}

export class NatsKvAdapter implements KvPort {
  constructor(private readonly kv: KV, private readonly connection: NatsConnection,
    private readonly bucketMaxValueSize = 0, private readonly logger?: PluginLogger,
    private readonly bucketName?: string) {}

  get maxValueBytes(): number {
    const limits = [this.connection.info?.max_payload ?? 0, this.bucketMaxValueSize].filter((value) => value > 0);
    return limits.length ? Math.min(...limits) : 512 * 1024;
  }

  close(): Promise<void> {
    return this.connection.close();
  }

  async get(key: string): Promise<RemoteEntry | null> {
    const entry = await this.kv.get(key);
    return entry ? { value: entry.value, revision: entry.revision } : null;
  }

  async list(): Promise<Array<{ key: string; value: Uint8Array; revision: number }>> {
    const entries: Array<{ key: string; value: Uint8Array; revision: number }> = [];
    for await (const key of await this.kv.keys()) {
      const value = await this.get(key);
      if (value) entries.push({ key, ...value });
    }
    return entries;
  }

  put(key: string, value: Uint8Array): Promise<number> {
    return this.kv.put(key, value);
  }

  create(key: string, value: Uint8Array): Promise<number> {
    return this.kv.create(key, value);
  }

  update(key: string, value: Uint8Array, revision: number): Promise<number> {
    return this.kv.update(key, value, revision);
  }

  async watch(listener: (entry: { key: string; value: Uint8Array; revision: number }) => void): Promise<() => void> {
    const iterator = await this.kv.watch();
    void (async () => {
      for await (const entry of iterator) {
        if (entry.operation === "PUT") listener({ key: entry.key, value: entry.value, revision: entry.revision });
      }
    })().catch((error: unknown) => {
      this.logger?.error("nats.watch_failed", error, { bucket: this.bucketName });
      /* Reconciliation reopens the watch after reconnect. */
    });
    return () => iterator.stop();
  }
}

export const connectExistingNatsBucket = async (
  options: { servers: string; user: string; pass: string }, bucket: string,
  status?: SyncStatus, logger?: PluginLogger,
): Promise<KvPort> => {
  logger?.debug("nats.connect", { bucket });
  const connection = await wsconnect({ ...options, ignoreClusterUpdates: true });
  try {
    const kv = await new Kvm(connection).open(bucket);
    const maxValueSize = await kv.status().then((value) => value.maxValueSize).catch((error: unknown) => {
      logger?.error("nats.bucket.status", error, { bucket });
      return 0;
    });
    logger?.debug("nats.connected", { bucket, maxValueSize });
    if (status) {
      void (async () => {
        for await (const event of connection.status()) {
          if (event.type === "disconnect") { logger?.debug("nats.disconnected", { bucket }); status.connected = false; status.connectionState = "OFFLINE"; status.refresh(); }
          if (event.type === "reconnect") { logger?.debug("nats.reconnected", { bucket }); status.connected = true; status.connectionState = "CONNECTED"; status.connectionError = ""; status.reconciled = false; status.refresh(); status.onReconnect?.(); }
          if (event.type === "error") {
            logger?.error("nats.error", event.error, { bucket });
            status.lastError = errorSummary(event.error);
            if (/auth|permission|authorization/i.test(String(event.error))) {
              status.connected = false;
              status.connectionState = "AUTH_ERROR";
              status.connectionError = errorSummary(event.error);
              status.value = "AUTH_ERROR";
            }
            status.refresh();
          }
        }
      })().catch((error: unknown) => logger?.error("nats.status", error, { bucket }));
      void connection.closed().then((error) => {
        if (error) logger?.error("nats.closed", error, { bucket });
        else logger?.debug("nats.closed", { bucket });
        if (error) status.lastError = errorSummary(error);
        status.connected = false;
        status.connectionState = error && /auth|permission|authorization/i.test(String(error)) ? "AUTH_ERROR" : "OFFLINE";
        if (error) status.connectionError = errorSummary(error);
        status.value = error && /auth|permission|authorization/i.test(String(error)) ? "AUTH_ERROR" : "OFFLINE";
        status.refresh();
      });
    }
    return new NatsKvAdapter(kv, connection, maxValueSize, logger, bucket);
  } catch (error) {
    logger?.error("nats.open_bucket", error, { bucket });
    await connection.close();
    throw error;
  }
};
