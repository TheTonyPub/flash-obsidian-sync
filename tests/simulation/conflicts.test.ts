import { describe, expect, it } from "vitest";
import { decodeRecord, sha256Hex } from "../../packages/protocol/src/index.js";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { MarkdownSyncEngine } from "../../packages/plugin/src/markdown-sync.js";
import { indexedDBDouble, NatsKvDouble, VaultDouble } from "../doubles/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("two-replica offline conflict simulations", () => {
  for (const offlineFirst of ["a", "b"] as const) {
    for (const overlap of [false, true]) {
      it(`${offlineFirst} offline, ${overlap ? "overlap" : "disjoint"} edits`, async () => {
        const kv = new NatsKvDouble();
        const replicas = [];
        for (const id of ["a", "b"]) {
          const vault = new VaultDouble();
          if (id === "a") vault.write("note.md", encoder.encode("first\nsecond\n"));
          const store = await LocalStore.open(`sim-${id}-${crypto.randomUUID()}`, indexedDBDouble.indexedDB);
          const status = new SyncStatus();
          const engine = new MarkdownSyncEngine({ deviceId: id, vault, store, kv, status, debounceMs: 0 });
          await engine.start();
          replicas.push({ id, vault, store, status, engine });
        }
        const offline = replicas.find((replica) => replica.id === offlineFirst)!;
        const online = replicas.find((replica) => replica.id !== offlineFirst)!;
        const local = overlap ? "LOCAL\nsecond\n" : "first\nLOCAL\n";
        const remote = "REMOTE\nsecond\n";
        offline.engine.stop();
        offline.vault.write("note.md", encoder.encode(local));
        const savedGet = kv.get.bind(kv);
        kv.get = () => { throw new Error("offline"); };
        await offline.engine.capture("note.md", local);
        kv.get = savedGet;
        online.vault.write("note.md", encoder.encode(remote));
        await online.engine.capture("note.md", remote);
        expect(decodeRecord(kv.list()[0]!.value).content).toBe(remote);
        await offline.engine.start();
        const canonical = overlap ? remote : "REMOTE\nLOCAL\n";
        const record = decodeRecord(kv.list().find((item) => item.key.startsWith("f."))!.value);
        expect(record.content).toBe(canonical);
        expect(record.contentHash).toBe(sha256Hex(encoder.encode(canonical)));
        expect(decoder.decode(offline.vault.read("note.md"))).toBe(canonical);
        const conflicts = await offline.store.conflicts();
        if (overlap) {
          expect(conflicts).toHaveLength(1);
          expect(decoder.decode(offline.vault.read(conflicts[0]!.copyPath))).toBe(local);
          expect(offline.status.value).toBe("CONFLICT");
        } else {
          expect(conflicts).toHaveLength(0);
          expect(await offline.store.pending()).toHaveLength(0);
        }
        for (const replica of replicas) replica.engine.stop();
        for (const replica of replicas) { await replica.engine.settle(); replica.store.close(); }
      });
    }
  }
});
