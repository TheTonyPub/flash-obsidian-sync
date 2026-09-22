import { describe, expect, it } from "vitest";
import { indexedDBDouble } from "../doubles/index.js";
import { LocalStore, type OutboxOperation } from "../../packages/plugin/src/local-store.js";

const operation = (operationId: string, content: string): OutboxOperation => ({
  operationId,
  fileId: "file-1",
  type: "modify",
  path: "notes/a.md",
  localHash: content,
  content,
  baseContent: "original",
  baseRevision: 1,
  baseHash: "original-hash",
  retryCount: 0,
  createdAt: 1,
});

const open = (name: string) => LocalStore.open(name, indexedDBDouble.indexedDB);

describe("IndexedDB local state", () => {
  it("persists file identity and pending work across a restart", async () => {
    const name = `state-${crypto.randomUUID()}`;
    const first = await open(name);
    await first.putFile({ fileId: "file-1", path: "notes/a.md", localHash: "h", state: "pending" });
    await first.queue(operation("op-1", "draft"));
    first.close();
    const second = await open(name);
    expect((await second.getFileByPath("notes/a.md"))?.fileId).toBe("file-1");
    expect((await second.pending()).map((item) => item.content)).toEqual(["draft"]);
    second.close();
  });

  it("coalesces unsent edits while retaining original base", async () => {
    const store = await open(`state-${crypto.randomUUID()}`);
    await store.queue(operation("op-1", "first"));
    await store.queue({ ...operation("op-2", "second"), createdAt: 2 });
    expect(await store.pending()).toEqual([{ ...operation("op-1", "second"), localHash: "second" }]);
    store.close();
  });

  it("retains pending operation until confirmed", async () => {
    const store = await open(`state-${crypto.randomUUID()}`);
    await store.queue(operation("op-1", "draft"));
    expect(await store.pending()).toHaveLength(1);
    await store.confirm("op-1");
    expect(await store.pending()).toEqual([]);
    store.close();
  });

  it("does not coalesce across different base revisions", async () => {
    const store = await open(`state-${crypto.randomUUID()}`);
    await store.queue(operation("op-1", "first"));
    await store.queue({ ...operation("op-2", "second"), baseRevision: 2, createdAt: 2 });
    expect(await store.pending()).toHaveLength(2);
    store.close();
  });

  it("keeps latest content when an unsent create is edited again", async () => {
    const store = await open(`state-${crypto.randomUUID()}`);
    await store.queue({ ...operation("op-1", "first"), type: "create", baseRevision: undefined, baseHash: undefined });
    await store.queue({ ...operation("op-2", "second"), baseRevision: undefined, baseHash: undefined, createdAt: 2 });
    expect(await store.pending()).toEqual([{
      ...operation("op-1", "second"), type: "create", baseRevision: undefined, baseHash: undefined,
    }]);
    store.close();
  });
});
