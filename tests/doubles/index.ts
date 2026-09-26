import { indexedDB as fakeIndexedDB, IDBKeyRange } from "fake-indexeddb";
import type { KvFileEntry, KvSnapshotSession } from "../../packages/plugin/src/connection.js";

export class VaultDouble {
  readonly files = new Map<string, Uint8Array>();
  readonly events: Array<{ type: string; path: string }> = [];
  private readonly modifyListeners = new Set<(path: string) => void>();

  onModify(listener: (path: string) => void): () => void {
    this.modifyListeners.add(listener);
    return () => this.modifyListeners.delete(listener);
  }

  write(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes.slice());
    this.events.push({ type: "modify", path });
    for (const listener of this.modifyListeners) listener(path);
  }

  read(path: string): Uint8Array | undefined {
    return this.files.get(path)?.slice();
  }

  listMarkdown(): Array<{ path: string; content: string }> {
    return [...this.files].filter(([path]) => path.endsWith(".md"))
      .map(([path, value]) => ({ path, content: new TextDecoder().decode(value) }));
  }

  listFiles(): Array<{ path: string; bytes: Uint8Array }> {
    return [...this.files].map(([path, value]) => ({ path, bytes: value.slice() }));
  }

  rename(from: string, to: string): void {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`Missing file: ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
    this.events.push({ type: "rename", path: to });
  }

  delete(path: string): void {
    this.files.delete(path);
    this.events.push({ type: "delete", path });
  }

  remove(path: string): void { this.delete(path); }
}

export class SecretStorageDouble {
  private readonly values = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export const indexedDBDouble = { indexedDB: fakeIndexedDB, IDBKeyRange };

export class NatsKvDouble {
  private revision = 0;
  private readonly entries = new Map<string, { value: Uint8Array; revision: number }>();
  private readonly listeners = new Set<(key: string, value: Uint8Array, revision: number) => void>();

  get(key: string): { value: Uint8Array; revision: number } | null {
    const entry = this.entries.get(key);
    return entry ? { value: entry.value.slice(), revision: entry.revision } : null;
  }

  list(): Array<{ key: string; value: Uint8Array; revision: number }> {
    return [...this.entries].map(([key, value]) => ({ key, value: value.value.slice(), revision: value.revision }));
  }

  put(key: string, value: Uint8Array, expectedRevision?: number): number {
    if (expectedRevision !== undefined && this.entries.get(key)?.revision !== expectedRevision) {
      throw new Error("Revision mismatch");
    }
    const revision = ++this.revision;
    this.entries.set(key, { value: value.slice(), revision });
    for (const listener of this.listeners) listener(key, value.slice(), revision);
    return revision;
  }

  create(key: string, value: Uint8Array): number {
    if (this.entries.has(key)) throw new Error("Revision mismatch");
    return this.put(key, value);
  }

  update(key: string, value: Uint8Array, revision: number): number {
    return this.put(key, value, revision);
  }

  watch(listener: (entry: { key: string; value: Uint8Array; revision: number }) => void): () => void {
    const wrapped = (key: string, value: Uint8Array, revision: number) => listener({ key, value, revision });
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }
}

/** Controllable one-subscription snapshot/live source for reconciliation contract tests. */
export class SnapshotKvSessionDouble implements KvSnapshotSession {
  private readonly snapshotQueue: KvFileEntry[] = [];
  private readonly entryQueue: KvFileEntry[] = [];
  private snapshotWake?: () => void;
  private entryWake?: () => void;
  private completeSnapshot!: () => void;
  private stopped = false;
  readonly snapshotComplete = new Promise<void>((resolve) => { this.completeSnapshot = resolve; });
  readonly snapshot = this.iterate(this.snapshotQueue, "snapshot");
  readonly entries = this.iterate(this.entryQueue, "entries");
  stopCalls = 0;

  constructor(readonly initialCount = 0) {}

  pushSnapshot(entry: KvFileEntry): void {
    if (this.stopped) throw new Error("Snapshot session is stopped");
    this.snapshotQueue.push(copyEntry(entry));
    this.entryQueue.push(copyEntry(entry));
    this.wake("snapshot");
    this.wake("entries");
  }

  completeInitialSnapshot(): void {
    if (this.snapshotQueue.length !== this.initialCount) {
      throw new Error(`Expected ${this.initialCount} initial entries, received ${this.snapshotQueue.length}`);
    }
    this.completed = true;
    this.completeSnapshot();
    this.wake("snapshot");
  }

  pushLive(entry: KvFileEntry): void {
    if (this.stopped) throw new Error("Snapshot session is stopped");
    this.entryQueue.push(copyEntry(entry));
    this.wake("entries");
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopCalls++;
    this.wake("snapshot");
    this.wake("entries");
  }

  private wake(kind: "snapshot" | "entries"): void {
    const wake = kind === "snapshot" ? this.snapshotWake : this.entryWake;
    if (kind === "snapshot") this.snapshotWake = undefined;
    else this.entryWake = undefined;
    wake?.();
  }

  private async *iterate(queue: KvFileEntry[], kind: "snapshot" | "entries"): AsyncGenerator<KvFileEntry> {
    while (!this.stopped) {
      const entry = queue.shift();
      if (entry) { yield entry; continue; }
      if (kind === "snapshot" && this.snapshotFinished) return;
      await new Promise<void>((resolve) => {
        if (kind === "snapshot") this.snapshotWake = resolve;
        else this.entryWake = resolve;
      });
    }
  }

  private get snapshotFinished(): boolean {
    // Test-only signal: completion is set by completeInitialSnapshot; race-safe across empty snapshots.
    return this.completed;
  }

  private completed = false;
}

function copyEntry(entry: KvFileEntry): KvFileEntry {
  return { ...entry, value: entry.value.slice() };
}
