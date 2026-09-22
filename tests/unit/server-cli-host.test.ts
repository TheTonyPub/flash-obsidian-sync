import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOwnedStateAdapter } from "../../packages/server-cli/src/host.js";
import { readOwnedStatus } from "../../packages/server-cli/src/state.js";

const roots: string[] = [];
const stateManifest = JSON.stringify({ version: 1, mode: "docker", domain: "sync.example.test", vaultId: "notes", resources: { paths: [], services: [], ports: [] } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fos-host-"));
  roots.push(root);
  const native = join(root, "etc", "flash-osidian-sync", "state.json");
  const compose = join(root, "opt", "flash-osidian-sync", "state.json");
  await mkdir(join(root, "etc", "flash-osidian-sync"), { recursive: true });
  await mkdir(join(root, "opt", "flash-osidian-sync"), { recursive: true });
  return { root, native, compose };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }))); });

describe("local fos state adapter", () => {
  it("reports no state, a valid owned manifest, and malformed state without mutating the fixture", async () => {
    const { native, compose } = await fixture();
    const adapter = createLocalOwnedStateAdapter({ nativeStatePath: native, composeStatePath: compose, owner: process.getuid?.() ?? 0 });
    await expect(readOwnedStatus(adapter)).resolves.toMatchObject({ kind: "NOT_INSTALLED" });

    await writeFile(compose, stateManifest, { mode: 0o600 });
    await expect(readOwnedStatus(adapter)).resolves.toMatchObject({ kind: "MANAGED", mode: "docker" });

    await writeFile(compose, "not json", { mode: 0o600 });
    await expect(readOwnedStatus(adapter)).resolves.toMatchObject({ kind: "CONFLICT" });
  });

  it("treats a symlinked state path as a conflict and writes a root-owned-mode atomic manifest only when requested", async () => {
    const { native, compose, root } = await fixture();
    const owner = process.getuid?.() ?? 0;
    const adapter = createLocalOwnedStateAdapter({ nativeStatePath: native, composeStatePath: compose, owner });
    const target = join(root, "outside.json");
    await writeFile(target, "outside");
    await symlink(target, compose);
    await expect(readOwnedStatus(adapter)).resolves.toMatchObject({ kind: "CONFLICT" });

    await (await import("node:fs/promises")).unlink(compose);
    await adapter.writeStateAtomically(compose, stateManifest, { owner: owner as 0, mode: 0o600 });
    const mode = (await (await import("node:fs/promises")).stat(compose)).mode & 0o777;
    expect(mode).toBe(0o600);
    await expect(readOwnedStatus(adapter)).resolves.toMatchObject({ kind: "MANAGED" });
  });
});
