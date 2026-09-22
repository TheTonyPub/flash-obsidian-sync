import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function guide(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("fos operator guides", () => {
  it("links separate installation and usage guides from README and NATS setup", async () => {
    const [readme, nats, install, usage] = await Promise.all([
      guide("../../README.md"),
      guide("../../docs/nats-setup.md"),
      guide("../../docs/fos-install.md"),
      guide("../../docs/fos-usage.md"),
    ]);
    expect(readme).toContain("docs/fos-install.md");
    expect(readme).toContain("docs/fos-usage.md");
    expect(nats).toContain("fos-install.md");
    expect(nats).toContain("fos-usage.md");
    expect(install).toContain("npm ci");
    expect(install).toContain("npm run build:server-cli");
    expect(install).toContain("npm install --global ./packages/server-cli");
    expect(usage).toContain("fos bootstrap");
    expect(usage).toContain("fos vault create");
  });
});
