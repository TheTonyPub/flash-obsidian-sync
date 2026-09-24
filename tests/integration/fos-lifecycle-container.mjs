import assert from "node:assert/strict";
import console from "node:console";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const cli = join(root, "main.js");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
});
const expectSuccess = (...args) => {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

assert.match(expectSuccess("--help"), /Commands/);
assert.match(expectSuccess("status"), /NOT_INSTALLED/);

const backupDirectory = "/tmp/fos-lifecycle-e2e-backups";
await mkdir("/etc/flash-osidian-sync", { recursive: true });
await mkdir("/var/lib/flash-osidian-sync/nats", { recursive: true });
await mkdir("/var/lib/flash-osidian-sync/caddy-data", { recursive: true });
await mkdir("/var/lib/flash-osidian-sync/caddy-config", { recursive: true });
await writeFile("/etc/flash-osidian-sync/Caddyfile", "fixture-caddy-marker\n");
await writeFile("/var/lib/flash-osidian-sync/nats/fixture.txt", "fixture-nats-marker\n");
await writeFile("/var/lib/flash-osidian-sync/caddy-data/fixture.txt", "fixture-caddy-data-marker\n");
await writeFile("/var/lib/flash-osidian-sync/caddy-config/fixture.txt", "fixture-caddy-config-marker\n");

const backupOutput = expectSuccess("backup", "--destination", backupDirectory, "--retention", "2");
assert.match(backupOutput, /artifact: \/tmp\/fos-lifecycle-e2e-backups\/backup-/);
const backupMatch = backupOutput.match(/artifact: (.+)$/);
assert.ok(backupMatch);
const backupArtifact = backupMatch[1];
const backupManifest = JSON.parse(await readFile(join(backupArtifact, "manifest.json"), "utf8"));
assert.equal(backupManifest.sources.length, 4);
assert.equal(await readFile(join(backupArtifact, "payload/etc/flash-osidian-sync/Caddyfile"), "utf8"), "fixture-caddy-marker\n");
const destinationInfo = await stat(backupDirectory);
assert.equal(destinationInfo.uid, 0);
assert.equal(destinationInfo.mode & 0o077, 0);

const restoreOutput = expectSuccess("restore-check", "--destination", backupDirectory, "--retention", "2");
assert.match(restoreOutput, /restore verified/);
const restoreDirectories = (await readdir(backupDirectory)).filter((name) => name.startsWith(".restore-check-"));
assert.equal(restoreDirectories.length, 1);
const restored = join(backupDirectory, restoreDirectories[0]);
assert.equal(await readFile(join(restored, "etc/flash-osidian-sync/Caddyfile"), "utf8"), "fixture-caddy-marker\n");
assert.equal(await readFile(join(restored, "var/lib/flash-osidian-sync/nats/fixture.txt"), "utf8"), "fixture-nats-marker\n");

const installDirectory = "/opt/flash-osidian-sync";
const installPaths = [
  join(installDirectory, "compose.yaml"),
  join(installDirectory, "Caddyfile"),
  join(installDirectory, "nats-server.conf"),
  join(installDirectory, "state.json"),
  "/var/lib/flash-osidian-sync/nats",
  "/var/lib/flash-osidian-sync/caddy-data",
  "/var/lib/flash-osidian-sync/caddy-config",
  "/var/log/flash-osidian-sync",
];
for (const path of installPaths.filter((entry) => !entry.endsWith("state.json"))) {
  if (path.endsWith(".yaml") || path.endsWith(".conf") || path.endsWith("Caddyfile")) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture managed resource\n");
  } else {
    await mkdir(path, { recursive: true });
  }
}
const manifest = {
  version: 1,
  mode: "podman",
  domain: "fixture.invalid",
  vaultId: "fixture",
  resources: {
    paths: installPaths,
    services: [],
    ports: ["80", "443"],
    composeProject: "flash-osidian-sync",
  },
};
const statePath = join(installDirectory, "state.json");
await writeFile(statePath, JSON.stringify(manifest), { mode: 0o600 });
await chmod(statePath, 0o600);
assert.match(expectSuccess("status"), /MANAGED — podman/);

const upgradePreview = expectSuccess("upgrade");
assert.match(upgradePreview, /fos upgrade preview: podman;/);
const uninstallPreview = expectSuccess("uninstall");
assert.match(uninstallPreview, /fos uninstall preview: remove owned services\/configuration; preserve data/);
assert.match(expectSuccess("status"), /MANAGED — podman/);
assert.equal(JSON.parse(await readFile(statePath, "utf8")).mode, "podman");

console.log("fos lifecycle E2E passed: isolated status, protected backup, verified restore, upgrade preview, uninstall preview; no service or host mutation");
