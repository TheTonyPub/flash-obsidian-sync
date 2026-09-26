import { Kvm, type KV } from "@nats-io/kv";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
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

/** One versioned file record delivered by a discovery session. */
export interface KvFileEntry extends RemoteEntry {
  key: string;
}

/** A single discovery session that emits the initial current state and then live updates. */
export interface KvSnapshotSession {
  /** Number of entries belonging to the initial snapshot, captured when the session opens. */
  readonly initialCount: number;
  /** Resolves when every entry in the session's initial snapshot has been emitted. */
  readonly snapshotComplete: Promise<void>;
  /** Initial current-state entries, including tombstones. */
  readonly snapshot: AsyncIterable<KvFileEntry>;
  /** All entries from this session, including the snapshot and subsequent updates. */
  readonly entries: AsyncIterable<KvFileEntry>;
  /** Stop delivery and release the underlying ephemeral subscription. */
  stop(): void | Promise<void>;
}

export interface KvPort {
  readonly maxValueBytes?: number;
  get(key: string): RemoteEntry | null | undefined | Promise<RemoteEntry | null | undefined>;
  list(): Array<{ key: string; value: Uint8Array; revision: number }> | Promise<Array<{ key: string; value: Uint8Array; revision: number }>>;
  put(key: string, value: Uint8Array): number | Promise<number>;
  watch(listener: (entry: { key: string; value: Uint8Array; revision: number }) => void):
    (() => void) | Promise<() => void>;
  /** Optional until adapters implement the primary snapshot discovery path. */
  openSnapshotSession?(): KvSnapshotSession | Promise<KvSnapshotSession>;
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
    else if (Math.max(this.conflicts, this.conflictPaths.length) > 0) this.value = "CONFLICT";
    else if (this.errors > 0) this.value = "ERROR";
    else if (!this.reconciled) this.value = "RECONCILING";
    else if (this.pending > 0 || this.blobsPending > 0) this.value = "PENDING";
    else this.value = "SYNCED";
    this.emit();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

export function statusSummary(status: SyncStatus): string {
  const conflicts = Math.max(status.conflicts, status.conflictPaths.length);
  return conflicts
    ? `${status.value} · ${conflicts} ${conflicts === 1 ? "copy" : "copies"} to review`
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
  private readonly snapshotSessionStops = new Set<() => Promise<void>>();

  constructor(private readonly kv: KV, private readonly connection: NatsConnection,
    private readonly bucketMaxValueSize = 0, private readonly logger?: PluginLogger,
    private readonly bucketName?: string) {}

  get maxValueBytes(): number {
    const limits = [this.connection.info?.max_payload ?? 0, this.bucketMaxValueSize].filter((value) => value > 0);
    return limits.length ? Math.min(...limits) : 512 * 1024;
  }

  async close(): Promise<void> {
    try {
      await Promise.all([...this.snapshotSessionStops].map((stop) => stop()));
    } finally {
      await this.connection.close();
    }
  }

  async get(key: string): Promise<RemoteEntry | null> {
    const entry = await this.kv.get(key);
    return entry ? { value: entry.value, revision: entry.revision } : null;
  }

  async list(): Promise<Array<{ key: string; value: Uint8Array; revision: number }>> {
    const startedAt = performance.now();
    const keys: string[] = [];
    for await (const key of await this.kv.keys()) {
      keys.push(key);
    }
    // KV keys only returns names, so retrieving their values serially makes a
    // reconciliation take one round trip per file. Keep the result ordered by
    // key discovery while limiting pressure on the NATS connection.
    const values: Array<RemoteEntry | null> = new Array(keys.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < keys.length) {
        const index = next++;
        values[index] = await this.get(keys[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, keys.length) }, worker));
    const entries = keys.flatMap((key, index) => {
      const value = values[index];
      return value ? [{ key, ...value }] : [];
    });
    this.logger?.debug("nats.list.complete", {
      keys: keys.length, entries: entries.length, durationMs: Math.round(performance.now() - startedAt),
    });
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

  async openSnapshotSession(): Promise<KvSnapshotSession> {
    if (!this.bucketName) throw new Error("KV bucket name required for snapshot discovery");

    const stream = `KV_${this.bucketName}`;
    const manager = await jetstreamManager(this.connection, { checkAPI: false });
    let created = false;
    let consumerName: string | undefined;
    try {
      const consumerInfo = await manager.consumers.add(stream, {
        name: `flash-sync-snapshot-${crypto.randomUUID()}`,
        ack_policy: AckPolicy.None,
        deliver_policy: DeliverPolicy.LastPerSubject,
        filter_subject: `$KV.${this.bucketName}.f.>`,
      });
      created = true;
      const consumerId = consumerInfo.name;
      if (!consumerId) throw new Error("JetStream did not return the ephemeral consumer name");
      consumerName = consumerId;

      const initialCount = consumerInfo.num_pending;
      // Pull delivery retains pending messages until consume requests them, avoiding a push-subscription setup gap.
      const consumer = await jetstream(this.connection).consumers.get(stream, consumerId);
      const messages = await consumer.consume();
      const snapshotQueue = new AsyncEntryQueue<KvFileEntry>();
      const entriesQueue = new AsyncEntryQueue<KvFileEntry>();
      let snapshotSeen = 0;
      let snapshotResolved = false;
      let resolveSnapshot!: () => void;
      let rejectSnapshot!: (error: unknown) => void;
      const snapshotComplete = new Promise<void>((resolve, reject) => {
        resolveSnapshot = resolve;
        rejectSnapshot = reject;
      });
      void snapshotComplete.catch(() => {});
      if (initialCount === 0) {
        snapshotResolved = true;
        resolveSnapshot();
      }

      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        this.snapshotSessionStops.delete(stop);
        messages.stop();
        snapshotQueue.close();
        entriesQueue.close();
        if (!snapshotResolved) rejectSnapshot(new Error("Snapshot session stopped before completion"));
        await manager.consumers.delete(stream, consumerId);
      };
      this.snapshotSessionStops.add(stop);

      void (async () => {
        try {
          for await (const message of messages) {
            const subjectPrefix = `$KV.${this.bucketName}.`;
            if (!message.subject.startsWith(subjectPrefix)) continue;
            const key = message.subject.slice(subjectPrefix.length);
            if (!key.startsWith("f.")) continue;
            const entry = { key, value: message.data, revision: message.info.streamSequence };
            entriesQueue.push(entry);
            if (snapshotSeen < initialCount) {
              snapshotSeen += 1;
              snapshotQueue.push(entry);
              if (snapshotSeen === initialCount) {
                snapshotResolved = true;
                resolveSnapshot();
              }
            }
          }
          if (stopped) {
            snapshotQueue.close();
            entriesQueue.close();
          } else {
            const error = new Error("Snapshot session delivery ended");
            if (!snapshotResolved) rejectSnapshot(error);
            snapshotQueue.close(error);
            entriesQueue.close(error);
            await stop().catch((cleanupError: unknown) => {
              this.logger?.error("nats.snapshot_session_cleanup_failed", cleanupError, { bucket: this.bucketName });
            });
          }
        } catch (error) {
          this.logger?.error("nats.snapshot_session_failed", error, { bucket: this.bucketName });
          if (!snapshotResolved) rejectSnapshot(error);
          snapshotQueue.close(error);
          entriesQueue.close(error);
          await stop().catch((cleanupError: unknown) => {
            this.logger?.error("nats.snapshot_session_cleanup_failed", cleanupError, { bucket: this.bucketName });
          });
        }
      })();

      return {
        initialCount,
        snapshotComplete,
        snapshot: { [Symbol.asyncIterator]: () => snapshotQueue.take(initialCount) },
        entries: { [Symbol.asyncIterator]: () => entriesQueue.take() },
        stop,
      };
    } catch (error) {
      if (created && consumerName) await manager.consumers.delete(stream, consumerName).catch(() => false);
      throw error;
    }
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

class AsyncEntryQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  private ended = false;
  private failure?: unknown;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  take(limit = Number.POSITIVE_INFINITY): AsyncIterator<T> {
    let taken = 0;
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (taken >= limit) return { value: undefined, done: true };
        if (this.values.length > 0) {
          taken += 1;
          return { value: this.values.shift()!, done: false };
        }
        if (this.ended) {
          if (this.failure) throw this.failure;
          return { value: undefined, done: true };
        }
        const value = await new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
        if (!value.done) taken += 1;
        return value;
      },
    };
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
