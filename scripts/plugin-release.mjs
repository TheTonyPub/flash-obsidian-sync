import { execFileSync } from "node:child_process";
import { access, appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const TAG_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|dev)\.([1-9]\d*))?$/;
const PLUGIN_ID = "flash-sync";

export function parseTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) throw new Error(`Unsupported plugin tag: ${tag}`);
  const baseVersion = `${match[1]}.${match[2]}.${match[3]}`;
  const suffix = match[4];
  const channel = !suffix ? "stable" : suffix === "dev" ? "development" : "prerelease";
  return { tag, baseVersion, channel, branch: channel === "stable" ? "master" : "dev" };
}

async function readManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read plugin manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.id !== PLUGIN_ID || manifest.name !== PLUGIN_ID) {
    throw new Error(`Plugin manifest id and name must both be ${PLUGIN_ID}`);
  }
  return manifest;
}

async function validateManifestBase(repository, releaseTag) {
  const manifest = await readManifest(join(repository, "packages/plugin/manifest.json"));
  if (manifest.version !== releaseTag.baseVersion) {
    throw new Error(`Plugin manifest version ${manifest.version} does not match tag base ${releaseTag.baseVersion}`);
  }
  return manifest;
}

export function validateBranchReachability(repository, commit, branch) {
  try {
    execFileSync("git", ["-C", repository, "merge-base", "--is-ancestor", commit, `refs/remotes/origin/${branch}`], { stdio: "ignore" });
  } catch {
    throw new Error(`Tag commit ${commit} is not reachable from origin/${branch}`);
  }
}

async function validate({ tag, commit, repository, githubOutput }) {
  const releaseTag = parseTag(tag);
  await validateManifestBase(repository, releaseTag);
  validateBranchReachability(repository, commit, releaseTag.branch);
  if (githubOutput) {
    await appendFile(githubOutput, `tag=${tag}\nbase_version=${releaseTag.baseVersion}\nchannel=${releaseTag.channel}\nbranch=${releaseTag.branch}\n`);
  }
  process.stdout.write(`Validated ${tag} (${releaseTag.channel}, origin/${releaseTag.branch})\n`);
}

async function packageDistribution({ tag, repository, directory }) {
  const releaseTag = parseTag(tag);
  const manifest = await validateManifestBase(repository, releaseTag);
  const output = resolve(directory);
  const mainSource = join(repository, "packages/plugin/dist/main.js");
  await access(mainSource);
  await mkdir(output, { recursive: true });
  const mainTarget = join(output, "main.js");
  const manifestTarget = join(output, "manifest.json");
  const styleSource = join(repository, "packages/plugin/styles.css");
  const styleTarget = join(output, "styles.css");
  await copyFile(mainSource, mainTarget);
  await writeFile(manifestTarget, `${JSON.stringify({ ...manifest, version: tag }, null, 2)}\n`);
  try {
    await access(styleSource);
    await copyFile(styleSource, styleTarget);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await rm(styleTarget, { force: true });
  }
  process.stdout.write(`Packaged ${tag} in ${output}\n`);
}

async function verifyDistribution({ tag, directory }) {
  const releaseTag = parseTag(tag);
  const output = resolve(directory);
  const files = (await readdir(output)).sort();
  const allowed = files.includes("styles.css") ? ["main.js", "manifest.json", "styles.css"] : ["main.js", "manifest.json"];
  if (JSON.stringify(files) !== JSON.stringify(allowed)) {
    throw new Error(`Unexpected installation files: ${files.join(", ")}`);
  }
  if ((await readFile(join(output, "main.js"))).length === 0) throw new Error("main.js is empty");
  const manifest = await readManifest(join(output, "manifest.json"));
  if (manifest.version !== tag) throw new Error(`Distribution manifest version ${manifest.version} does not match tag ${tag}`);
  if (manifest.version.split("-")[0] !== releaseTag.baseVersion) throw new Error("Distribution manifest base version does not match tag");
  if (files.includes("styles.css") && (await readFile(join(output, "styles.css"))).length === 0) {
    throw new Error("styles.css is empty");
  }
  process.stdout.write(`Verified installation files for ${tag}\n`);
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Expected --option value pairs");
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const values = options(args);
  const tag = values.tag;
  if (!tag) throw new Error("Missing --tag");
  if (command === "validate") {
    if (!values.commit) throw new Error("Missing --commit");
    await validate({ tag, commit: values.commit, repository: resolve(values.repo ?? "."), githubOutput: values["github-output"] });
  } else if (command === "package") {
    if (!values.directory) throw new Error("Missing --directory");
    await packageDistribution({ tag, repository: resolve(values.repo ?? "."), directory: values.directory });
  } else if (command === "verify") {
    if (!values.directory) throw new Error("Missing --directory");
    await verifyDistribution({ tag, directory: values.directory });
  } else {
    throw new Error("Usage: plugin-release.mjs validate|package|verify --tag TAG [options]");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
