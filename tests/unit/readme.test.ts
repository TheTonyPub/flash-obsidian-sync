import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));

describe("README", () => {
  it("documents release installation, source builds, and server connection", async () => {
    const readme = await readFile(readmePath, "utf8");

    expect(readme).toContain("Manual installation from a release");
    expect(readme).toContain("Build from source (optional)");
    expect(readme).toContain("Prerequisites");
    expect(readme).toContain("npm ci");
    expect(readme).toContain("npm run build:plugin");
    expect(readme).toContain(".obsidian/plugins/flash-sync");
    expect(readme).toContain("wss://");
    expect(readme).toContain("OBS_<vaultId>_FILES");
    expect(readme).toContain("S3 is optional");
    expect(readme).toContain("Check connection");
  });
});
