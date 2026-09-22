import { describe, expect, it } from "vitest";
import { SyncStatus, statusSummary } from "../../packages/plugin/src/connection.js";
import { LocalStore } from "../../packages/plugin/src/local-store.js";
import { indexedDBDouble } from "../doubles/index.js";

describe("recoverable conflict visibility", () => {
  it("retains a discoverable copy after store restart", async () => {
    const name = `conflict-status-${crypto.randomUUID()}`;
    const store = await LocalStore.open(name, indexedDBDouble.indexedDB);
    await store.putConflict({ operationId: "op", originalFileId: "f", originalPath: "note.md",
      copyFileId: "copy", copyPath: "note.conflict-device.md", remoteRevision: 3 });
    store.close();
    const reopened = await LocalStore.open(name, indexedDBDouble.indexedDB);
    expect((await reopened.conflicts()).map((entry) => entry.copyPath)).toEqual(["note.conflict-device.md"]);
    reopened.close();
  });

  it("reports unresolved copy paths and notifies live UI", () => {
    const status = new SyncStatus();
    const seen: string[] = [];
    const unsubscribe = status.subscribe(() => seen.push(status.value));
    status.connected = true;
    status.reconciled = true;
    status.conflictPaths = ["note.conflict-device.md"];
    status.conflicts = 1;
    status.refresh();
    expect(status.value).toBe("CONFLICT");
    expect(status.conflictPaths).toEqual(["note.conflict-device.md"]);
    expect(seen).toEqual(["CONFLICT"]);
    expect(statusSummary(status)).toBe("CONFLICT · 1 copy to review");
    unsubscribe();
  });
});
