import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("published fos bundle", () => {
  it("starts CLI and loads admin worker dependencies without node_modules", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "fos-bundle-"));
    try {
      await cp("packages/server-cli/dist/main.js", join(isolated, "main.js"));
      await cp("packages/server-cli/dist/admin-worker.js", join(isolated, "admin-worker.js"));

      const status = spawnSync(process.execPath, [join(isolated, "main.js"), "status"], { encoding: "utf8" });
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toMatch(/NOT_INSTALLED|not installed/i);

      const worker = spawnSync(process.execPath, [join(isolated, "admin-worker.js")], { input: "{", encoding: "utf8" });
      expect(worker.stderr).toContain("SyntaxError");
      expect(worker.stderr).not.toContain("Cannot find module");
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
