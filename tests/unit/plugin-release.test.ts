import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts/plugin-release.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(version = "1.2.3"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flash-sync-release-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "packages/plugin/dist"), { recursive: true });
  await writeFile(join(directory, "packages/plugin/manifest.json"), JSON.stringify({
    id: "flash-sync", name: "flash-sync", version,
  }));
  await writeFile(join(directory, "packages/plugin/dist/main.js"), "bundle");
  execFileSync("git", ["init", "--initial-branch=master"], { cwd: directory, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Release test"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", "master base"], { cwd: directory, stdio: "ignore" });
  const master = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/master", master], { cwd: directory });
  execFileSync("git", ["switch", "-c", "dev"], { cwd: directory, stdio: "ignore" });
  await writeFile(join(directory, "dev.txt"), "dev");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", "dev change"], { cwd: directory, stdio: "ignore" });
  const dev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/dev", dev], { cwd: directory });
  return directory;
}

function run(args: string[], cwd: string): string {
  return execFileSync("node", [script, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("plugin tag release tooling", () => {
  it.each([
    ["1.2.3", "stable", "master"],
    ["1.2.3-alpha.1", "prerelease", "dev"],
    ["1.2.3-beta.11", "prerelease", "dev"],
    ["1.2.3-dev.7", "development", "dev"],
  ])("validates %s and maps it to %s from %s", async (tag, channel, branch) => {
    const directory = await fixture();
    const commit = execFileSync("git", ["rev-parse", `origin/${branch}`], { cwd: directory, encoding: "utf8" }).trim();

    expect(run(["validate", "--tag", tag, "--commit", commit, "--repo", directory], directory))
      .toContain(`Validated ${tag} (${channel}, origin/${branch})`);
  });

  it.each([
    "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-alpha", "1.2.3-alpha.0",
    "1.2.3-alpha.01", "1.2.3-rc.1", "1.2.3-dev.1+build.2", "1.2.3+build.2",
  ])("rejects unsupported tag %s", async (tag) => {
    const directory = await fixture();
    expect(() => run(["validate", "--tag", tag, "--commit", "HEAD", "--repo", directory], directory)).toThrow();
  });

  it("rejects tag commits that are not reachable from the required branch", async () => {
    const directory = await fixture();
    const dev = execFileSync("git", ["rev-parse", "origin/dev"], { cwd: directory, encoding: "utf8" }).trim();
    const master = execFileSync("git", ["rev-parse", "origin/master"], { cwd: directory, encoding: "utf8" }).trim();

    expect(() => run(["validate", "--tag", "1.2.3", "--commit", dev, "--repo", directory], directory)).toThrow();
    expect(() => run(["validate", "--tag", "1.2.3-alpha.1", "--commit", master, "--repo", directory], directory)).not.toThrow();
  });

  it("creates and verifies a tag-versioned install directory with stylesheet only when present", async () => {
    const directory = await fixture();
    const dist = join(directory, "release");
    const commit = execFileSync("git", ["rev-parse", "origin/dev"], { cwd: directory, encoding: "utf8" }).trim();
    const output = join(directory, "github-output.txt");

    run(["validate", "--tag", "1.2.3-beta.2", "--commit", commit, "--repo", directory, "--github-output", output], directory);
    run(["package", "--tag", "1.2.3-beta.2", "--repo", directory, "--directory", dist], directory);
    run(["verify", "--tag", "1.2.3-beta.2", "--directory", dist], directory);

    const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ id: "flash-sync", name: "flash-sync", version: "1.2.3-beta.2" });
    expect(await readFile(join(dist, "main.js"), "utf8")).toBe("bundle");
    expect(JSON.parse(await readFile(join(directory, "packages/plugin/manifest.json"), "utf8")).version).toBe("1.2.3");
    expect(await readFile(output, "utf8")).toContain("channel=prerelease");

    await writeFile(join(directory, "packages/plugin/styles.css"), ".flash-sync {}");
    run(["package", "--tag", "1.2.3-beta.2", "--repo", directory, "--directory", dist], directory);
    run(["verify", "--tag", "1.2.3-beta.2", "--directory", dist], directory);
    expect(await readFile(join(dist, "styles.css"), "utf8")).toBe(".flash-sync {}");
  });

  it("rejects a source manifest whose stable version differs from the tag base", async () => {
    const directory = await fixture("1.2.4");
    const commit = execFileSync("git", ["rev-parse", "origin/master"], { cwd: directory, encoding: "utf8" }).trim();

    expect(() => run(["validate", "--tag", "1.2.3", "--commit", commit, "--repo", directory], directory)).toThrow();
  });

  it("rejects an install directory with a mismatched manifest version", async () => {
    const directory = await fixture();
    const dist = join(directory, "release");

    run(["package", "--tag", "1.2.3-dev.4", "--repo", directory, "--directory", dist], directory);
    await writeFile(join(dist, "manifest.json"), JSON.stringify({ id: "flash-sync", name: "flash-sync", version: "1.2.3" }));
    expect(() => run(["verify", "--tag", "1.2.3-dev.4", "--directory", dist], directory)).toThrow();
  });

  it("rejects extra source archives in the installation directory", async () => {
    const directory = await fixture();
    const dist = join(directory, "release");

    run(["package", "--tag", "1.2.3-dev.4", "--repo", directory, "--directory", dist], directory);
    await writeFile(join(dist, "source.zip"), "source");
    expect(() => run(["verify", "--tag", "1.2.3-dev.4", "--directory", dist], directory)).toThrow();
  });
});
