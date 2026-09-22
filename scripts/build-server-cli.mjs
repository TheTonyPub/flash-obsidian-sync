import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import process from "node:process";

const runtimeBanner = 'import { createRequire as __fosCreateRequire } from "node:module";\nconst require = __fosCreateRequire(import.meta.url);';
const shared = { bundle: true, platform: "node", format: "esm", target: "node22" };

if (process.argv[2] !== "worker") {
  await build({ ...shared, entryPoints: ["packages/server-cli/src/main.ts"],
    outfile: "packages/server-cli/dist/main.js", banner: { js: `#!/usr/bin/env node\n${runtimeBanner}` } });
  await chmod("packages/server-cli/dist/main.js", 0o755);
}
if (process.argv[2] !== "main") {
  await build({ ...shared, entryPoints: ["packages/server-cli/src/admin-worker.ts"],
    outfile: "packages/server-cli/dist/admin-worker.js", banner: { js: runtimeBanner } });
}
