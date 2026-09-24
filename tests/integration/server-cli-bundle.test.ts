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

      const helpCases: Array<[string[], RegExp]> = [
        [["--help"], /Commands\s+[\s\S]*bootstrap[\s\S]*vault/],
        [["help", "bootstrap"], /fos bootstrap[\s\S]*--approve/],
        [["plan", "--help"], /fos plan[\s\S]*without applying/],
        [["status", "--help"], /fos status[\s\S]*managed installation/],
        [["vault", "--help"], /fos vault[\s\S]*list[\s\S]*verify/],
        [["vault", "list", "--help"], /fos vault list[\s\S]*no vault ID is required[\s\S]*--admin-input/],
        [["help", "vault", "create"], /fos vault create[\s\S]*--vault-id ID/],
        [["vault", "inspect", "--help"], /fos vault inspect[\s\S]*--vault-id ID/],
        [["vault", "add", "--help"], /fos vault add[\s\S]*--secrets-output FILE/],
        [["vault", "rotate", "--help"], /fos vault rotate[\s\S]*--keep/],
        [["vault", "revoke", "--help"], /fos vault revoke[\s\S]*--vault-id ID/],
        [["vault", "verify", "--help"], /--vault-input FILE[\s\S]*required/],
        [["import", "--help"], /fos import[\s\S]*retained vault credential/],
        [["backup", "--help"], /--destination PATH[\s\S]*--retention DAYS/],
        [["restore-check", "--help"], /verify it can be restored/],
        [["upgrade", "--help"], /fos upgrade[\s\S]*--approve/],
        [["uninstall", "--help"], /--confirm DELETE_DATA/],
      ];
      for (const [args, expected] of helpCases) {
        const help = spawnSync(process.execPath, [join(isolated, "main.js"), ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toMatch(expected);
        expect(help.stdout).not.toContain("\u001b[");
      }
      const bareRoot = spawnSync(process.execPath, [join(isolated, "main.js")], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      expect(bareRoot.status, bareRoot.stderr).toBe(0);
      expect(bareRoot.stdout).toMatch(/fos[\s\S]*Commands/);
      const bareVault = spawnSync(process.execPath, [join(isolated, "main.js"), "vault"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      expect(bareVault.status, bareVault.stderr).toBe(0);
      expect(bareVault.stdout).toMatch(/fos vault[\s\S]*list[\s\S]*verify/);
      const incompletePlan = spawnSync(process.execPath, [join(isolated, "main.js"), "plan"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      expect(incompletePlan.status).toBe(1);
      expect(incompletePlan.stdout).toContain("PLAN_INPUT_REQUIRED");
      expect(incompletePlan.stdout).not.toContain("Installation mode");

      const worker = spawnSync(process.execPath, [join(isolated, "admin-worker.js")], { input: "{", encoding: "utf8" });
      expect(worker.stderr).toContain("SyntaxError");
      expect(worker.stderr).not.toContain("Cannot find module");
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
