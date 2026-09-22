import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../../packages/plugin/manifest.json", import.meta.url));

describe("Flash Osidian Sync plugin identity", () => {
  it("uses the exact community-plugin manifest identity and installation path", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { id: string; name: string };

    expect(manifest).toEqual(expect.objectContaining({
      id: "flash-osidian-sync",
      name: "flash-osidian-sync",
    }));
    expect(`.obsidian/plugins/${manifest.id}`).toBe(".obsidian/plugins/flash-osidian-sync");
  });
});
