import { indexedDB as fakeIndexedDB, IDBKeyRange } from "fake-indexeddb";

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
