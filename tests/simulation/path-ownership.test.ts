import { describe, expect, it } from "vitest";
import {
  canonicalizeRemotePath, decodePathOwnershipRecord, decodeRecord, encodePathOwnershipRecord, encodeRecord,
  pathOwnershipKey, sha256Hex,
} from "../../packages/protocol/src/index.js";
import { SyncStatus, type KvPort } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const readText = (vault: VaultDouble, path: string) => {
  const value = vault.read(path);
  return value && new TextDecoder().decode(value);
};
async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition not reached before timeout");
}

async function replica(id: string, kv: KvPort, options: { name?: string; vault?: VaultDouble; start?: boolean } = {}) {
  const vault = options.vault ?? new VaultDouble();
  const store = await LocalStore.open(options.name ?? `path-ownership-${id}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
  const status = new SyncStatus();
  const engine = new MarkdownSyncEngine({ deviceId: id, kv, vault, store, status, debounceMs: 0 });
  if (options.start) await engine.start();
  return { vault, store, status, engine };
}

function liveFiles(kv: NatsKvDouble) {
  return kv.list().filter(({ key }) => key.startsWith("f.")).map(({ value }) => decodeRecord(value)).filter((entry) => !entry.deleted);
}

type Boundary = "reservation" | "file-cas" | "ownership-finalization" | "old-path-release" | "delete-tombstone";

class FailAfterKv implements KvPort {
  online = true;
  armed = false;
  tripped = false;
  constructor(private readonly backend: NatsKvDouble, private readonly shouldFail: (key: string, value: Uint8Array) => boolean) {}
  private checkOnline(): void { if (!this.online) throw new Error("NATS offline after injected crash"); }
  get(key: string) { this.checkOnline(); return this.backend.get(key); }
  list() { this.checkOnline(); return this.backend.list(); }
  watch(listener: (entry: { key: string; value: Uint8Array; revision: number }) => void) {
    this.checkOnline();
    return this.backend.watch((entry) => { if (this.online) listener(entry); });
  }
  put(key: string, value: Uint8Array) { return this.mutate(() => this.backend.put(key, value), key, value); }
  create(key: string, value: Uint8Array) { return this.mutate(() => this.backend.create(key, value), key, value); }
  update(key: string, value: Uint8Array, revision: number) {
    return this.mutate(() => this.backend.update(key, value, revision), key, value);
  }
  private mutate(write: () => number, key: string, value: Uint8Array): number {
    this.checkOnline();
    const revision = write();
    if (this.armed && !this.tripped && this.shouldFail(key, value)) {
      this.tripped = true;
      this.online = false;
      throw new Error("Injected process loss after durable KV write");
    }
    return revision;
  }
}

function matchesBoundary(boundary: Boundary, key: string, value: Uint8Array): boolean {
  if (boundary === "file-cas") return key.startsWith("f.");
  let decoded: Record<string, unknown> | undefined;
  try { decoded = JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>; } catch { /* legacy f record */ }
  if (boundary === "delete-tombstone") return key.startsWith("f.") && decoded?.deleted === true;
  if (!key.startsWith("p.")) return false;
  if (boundary === "reservation") return decoded?.state === "reserved";
  if (boundary === "ownership-finalization") return decoded?.state === "owned";
  return decoded?.state === "released";
}

describe("remote path ownership contract", () => {
  it.each([
    ["same spelling", "notes/shared.md", "notes/shared.md"],
    ["case-fold equivalent", "notes/shared.md", "NOTES/SHARED.md"],
    ["NFC equivalent", "notes/café.md", "notes/cafe\u0301.md"],
    ["case-fold and NFC equivalent", "notes/café.md", "NOTES/CAFE\u0301.MD"],
  ])("allows one identity to claim %s paths and preserves both payloads", async (_label, path, secondPath) => {
      const kv = new NatsKvDouble();
      const first = await replica("desktop", kv);
      const second = await replica("mobile", kv);
      first.vault.write(path, bytes("desktop payload"));
      second.vault.write(secondPath, bytes("mobile payload"));

      await Promise.all([
        first.engine.capture(path, "desktop payload"),
        second.engine.capture(secondPath, "mobile payload"),
      ]);

      expect(liveFiles(kv)).toHaveLength(1);
      expect(kv.list().filter(({ key }) => key.startsWith("p.")).filter(({ value }) => {
        try { return JSON.parse(new TextDecoder().decode(value)).state === "owned"; } catch { return false; }
      })).toHaveLength(1);
      const saved = [first.vault, second.vault].flatMap((vault) => vault.listFiles().map(({ bytes: content }) => new TextDecoder().decode(content)));
      const copies = [first.vault, second.vault].flatMap((vault) => vault.listFiles().map(({ path: filePath }) => filePath));
      expect(saved).toContain("desktop payload");
      expect(saved).toContain("mobile payload");
      expect(copies.some((filePath) => filePath.includes("conflict"))).toBe(true);
      first.engine.stop(); second.engine.stop(); first.store.close(); second.store.close();
  });

  it("uses bounded key operations for a claim and never lists the remote bucket", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("bounded", kv);
    let keyOperations = 0;
    const get = kv.get.bind(kv);
    const create = kv.create.bind(kv);
    const update = kv.update.bind(kv);
    const rawList = kv.list.bind(kv);
    kv.get = ((key) => { keyOperations++; return get(key); }) as typeof kv.get;
    kv.create = ((key, value) => { keyOperations++; return create(key, value); }) as typeof kv.create;
    kv.update = ((key, value, revision) => { keyOperations++; return update(key, value, revision); }) as typeof kv.update;
    kv.list = (() => { throw new Error("claim attempted a vault-wide KV listing"); }) as typeof kv.list;
    state.vault.write("folder/new.md", bytes("payload"));

    await expect(state.engine.capture("folder/new.md", "payload")).resolves.toBeUndefined();
    expect(keyOperations).toBeLessThanOrEqual(8);
    expect(rawList().filter(({ key }) => key.startsWith("p.")).map(({ value }) => {
      try { return JSON.parse(new TextDecoder().decode(value)).state; } catch { return undefined; }
    })).toEqual(["owned"]);
    state.engine.stop(); state.store.close();
  });

  it("keeps a case-only rename on the same owner key and file identity", async () => {
    const kv = new NatsKvDouble();
    const state = await replica("case-rename", kv);
    state.vault.write("Notes/Plan.md", bytes("content"));
    await state.engine.capture("Notes/Plan.md", "content");
    const before = await state.store.getFileByPath("Notes/Plan.md");
    const ownerKeysBefore = kv.list().filter(({ key }) => key.startsWith("p.")).map(({ key }) => key);
    expect(ownerKeysBefore).toHaveLength(1);
    state.vault.rename("Notes/Plan.md", "notes/plan.md");
    await state.engine.rename("Notes/Plan.md", "notes/plan.md");
    const after = await state.store.getFileByPath("notes/plan.md");

    expect(after?.fileId).toBe(before?.fileId);
    expect(liveFiles(kv).find(({ fileId }) => fileId === before?.fileId)?.path).toBe("notes/plan.md");
    expect(kv.list().filter(({ key }) => key.startsWith("p.")).map(({ key }) => key)).toEqual(ownerKeysBefore);
    state.engine.stop(); state.store.close();
  });

  it("filters p. records from the file watch and lets a peer finalize matching remote evidence", async () => {
    const kv = new NatsKvDouble();
    const path = "observed.md";
    const fileId = "watch-file";
    const operationId = "watch-operation";
    const pKey = pathOwnershipKey(path);
    kv.create(pKey, encodePathOwnershipRecord({ schemaVersion: 1, canonicalPath: canonicalizeRemotePath(path),
      fileId, operationId, state: "reserved" }));
    const observer = await replica("observer", kv, { start: true });
    const content = "watched content";
    const contentBytes = bytes(content);
    kv.create(`f.${fileId}`, encodeRecord({ schemaVersion: 1, fileId, path, kind: "text", deleted: false,
      contentHash: sha256Hex(contentBytes), size: contentBytes.length, content,
      origin: { deviceId: "origin", operationId, clientTime: 1 } }));

    await eventually(async () => decodePathOwnershipRecord((await kv.get(pKey))!.value, pKey).state === "owned");
    expect(observer.status.conflicts).toBe(0);
    expect(readText(observer.vault, path)).toBe(content);
    observer.engine.stop(); observer.store.close();
  });

  it.each<Boundary>(["reservation", "file-cas", "ownership-finalization", "old-path-release", "delete-tombstone"])(
    "recovers the %s interruption from the durable outbox after restart without yielding the path",
    async (boundary) => {
      const backend = new NatsKvDouble();
      const faulting = new FailAfterKv(backend, (key, value) => matchesBoundary(boundary, key, value));
      const storeName = `path-restart-${boundary}-${crypto.randomUUID()}`;
      const vault = new VaultDouble();
      const origin = await replica("origin", faulting, { name: storeName, vault });

      if (boundary === "old-path-release" || boundary === "delete-tombstone") {
        vault.write("previous.md", bytes("original"));
        await origin.engine.capture("previous.md", "original");
        faulting.tripped = false;
        faulting.online = true;
      }
      faulting.armed = true;
      if (boundary === "old-path-release") {
        origin.vault.rename("previous.md", "next.md");
        await origin.engine.rename("previous.md", "next.md");
      } else if (boundary === "delete-tombstone") {
        origin.vault.delete("previous.md");
        await origin.engine.remove("previous.md");
      } else {
        vault.write("next.md", bytes("must survive restart"));
        await origin.engine.capture("next.md", "must survive restart");
      }

      expect(faulting.tripped).toBe(true);
      expect((await origin.store.pending()).length).toBeGreaterThan(0);
      origin.engine.stop(); origin.store.close();

      const competitor = await replica("competitor", backend, { start: boundary === "delete-tombstone" });
      let reusedFileId: string | undefined;
      if (boundary === "delete-tombstone") {
        competitor.vault.write("previous.md", bytes("competing content"));
        await competitor.engine.capture("previous.md", "competing content");
        const reused = liveFiles(backend).find(({ path }) => path === "previous.md");
        expect(reused).toBeDefined();
        expect(reused?.deleted).toBe(false);
        reusedFileId = reused?.fileId;
        const ownedPaths = backend.list().filter(({ key }) => key.startsWith("p.")).map(({ value }) => {
          try { return JSON.parse(new TextDecoder().decode(value)) as { state?: string; fileId?: string }; }
          catch { return {}; }
        }).filter((entry) => entry.state === "owned");
        expect(ownedPaths).toHaveLength(1);
        expect(ownedPaths[0]?.fileId).toBe(reusedFileId);
      } else {
        competitor.vault.write("next.md", bytes("competing content"));
        await competitor.engine.capture("next.md", "competing content");
        expect(liveFiles(backend).filter(({ path }) => path === "next.md")).toHaveLength(boundary === "reservation" ? 0 : 1);
      }
      competitor.engine.stop(); competitor.store.close();

      faulting.online = true;
      const restarted = await replica("origin", faulting, { name: storeName, vault, start: true });
      await eventually(async () => (await restarted.store.pending()).length === 0);
      if (boundary !== "delete-tombstone") {
        expect(liveFiles(backend).filter(({ path }) => path === "next.md")).toHaveLength(1);
        expect(readText(restarted.vault, "next.md")).toBe(boundary === "old-path-release" ? "original" : "must survive restart");
      } else {
        const fileRecords = backend.list().filter(({ key }) => key.startsWith("f.")).map(({ value }) => decodeRecord(value));
        expect(fileRecords.some(({ path, deleted }) => path === "previous.md" && deleted)).toBe(true);
        expect(fileRecords.some(({ path, fileId, deleted }) => path === "previous.md" && fileId === reusedFileId && !deleted)).toBe(true);
        expect(readText(restarted.vault, "previous.md")).toBe("competing content");
        const ownedPaths = backend.list().filter(({ key }) => key.startsWith("p.")).map(({ value }) => {
          try { return JSON.parse(new TextDecoder().decode(value)) as { state?: string; fileId?: string }; }
          catch { return {}; }
        }).filter((entry) => entry.state === "owned");
        expect(ownedPaths).toHaveLength(1);
        expect(ownedPaths[0]?.fileId).toBe(reusedFileId);
      }
      restarted.engine.stop(); restarted.store.close();
    },
  );
});
