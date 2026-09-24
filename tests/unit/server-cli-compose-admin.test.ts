import { describe, expect, it, vi } from "vitest";
import { runComposeAdmin, runComposeAdminWorker } from "../../packages/server-cli/src/compose-admin.js";
import { createComposeVaultAdminAdapter, createComposeVaultVerificationAdapter } from "../../packages/server-cli/src/compose-vault-admin.js";
import { createVault } from "../../packages/server-cli/src/vault-admin.js";
import { verifyVault } from "../../packages/server-cli/src/vault-verify.js";

describe("fos compose admin client", () => {
  it("runs one ephemeral pinned client on fos-internal with stdin-only input", async () => {
    const runtime = { runContainer: vi.fn().mockResolvedValue("ok") };
    await expect(runComposeAdmin(runtime, "flash-osidian-sync", "nats --help\n")).resolves.toBe("ok");
    const [args, stdin] = runtime.runContainer.mock.calls[0]!;
    expect(args).toContain("docker.io/natsio/nats-box:0.19.7@sha256:ffce8bd103383f179f8c7f11cf645726acf5d17280706c530c3b342dbe16334c");
    expect(args).toContain("--rm"); expect(args).toContain("-i"); expect(args).toContain("flash-osidian-sync_fos-internal");
    expect(args.join(" ")).not.toContain("--env"); expect(args.join(" ")).not.toContain("--volume");
    expect(stdin).toBe("nats --help\n");
  });
  it("refuses an empty admin script", async () => {
    const runtime = { runContainer: vi.fn() };
    await expect(runComposeAdmin(runtime, "flash-osidian-sync", "")).rejects.toThrow("ADMIN_SCRIPT_REQUIRED");
  });
  it("sends create/list/inspect/verify requests including credentials only through stdin JSON", async () => {
    const runtime = { runContainer: vi.fn().mockResolvedValue("{}") };
    await runComposeAdminWorker(runtime, "flash-osidian-sync", "/opt/fos/admin-worker.js", {
      action: "create", username: "fos-admin", password: "secret", vaultId: "notes",
    });
    const [args, stdin] = runtime.runContainer.mock.calls[0]!;
    expect(args).toContain("docker.io/library/node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34");
    expect(args).toContain("--pull"); expect(args).toContain("missing");
    expect(args.join(" ")).not.toContain("secret");
    expect(args.join(" ")).toContain("readonly");
    expect(JSON.parse(stdin)).toMatchObject({ action: "create", username: "fos-admin", password: "secret", vaultId: "notes" });
  });
  it("authenticates and creates a bucket over the private Compose network", async () => {
    const runtime = { runContainer: vi.fn().mockResolvedValueOnce("[]").mockResolvedValueOnce("[]").mockResolvedValueOnce("{}") };
    const administrator = { username: "fos-admin", password: "admin-secret" };
    const adapter = createComposeVaultAdminAdapter(runtime, "/opt/fos/admin-worker.js", administrator);

    await expect(createVault(adapter, administrator, "notes")).resolves.toMatchObject({ created: true, bucket: { name: "OBS_notes_FILES" } });

    const calls = runtime.runContainer.mock.calls;
    expect(calls.every((call) => !(call[0] as string[]).join(" ").includes("admin-secret"))).toBe(true);
    expect(calls.map((call) => JSON.parse(call[1] as string).action)).toEqual(["list", "list", "create"]);
  });
  it("uses the scoped credential only in stdin for the worker verification probe", async () => {
    const runtime = { runContainer: vi.fn().mockResolvedValue('{"crossBucket":"not-tested"}') };
    const credentials = { username: "fos-vault-notes", password: "vault-secret" };
    const adapter = createComposeVaultVerificationAdapter(runtime, "/opt/fos/admin-worker.js", credentials);

    await expect(verifyVault(adapter, "notes", credentials)).resolves.toEqual({ ownBucket: true, crossBucket: "not-tested" });

    const [args, stdin] = runtime.runContainer.mock.calls[0]!;
    expect(args.join(" ")).not.toContain("vault-secret");
    expect(JSON.parse(stdin)).toMatchObject({ action: "verify", ...credentials, vaultId: "notes" });
    expect(JSON.parse(stdin).crossVaultId).toBeUndefined();
  });
  it("sends an explicit peer ID for a real cross-bucket verification", async () => {
    const runtime = { runContainer: vi.fn().mockResolvedValue('{"crossBucket":"denied"}') };
    const credentials = { username: "fos-vault-notes", password: "vault-secret" };
    const adapter = createComposeVaultVerificationAdapter(runtime, "/opt/fos/admin-worker.js", credentials, "other");

    await expect(verifyVault(adapter, "notes", credentials, "other")).resolves.toEqual({ ownBucket: true, crossBucket: "denied" });
    const [args, stdin] = runtime.runContainer.mock.calls[0]!;
    expect(args.join(" ")).not.toContain("vault-secret");
    expect(JSON.parse(stdin)).toMatchObject({ action: "verify", ...credentials, vaultId: "notes", crossVaultId: "other" });
  });
  it("preserves a failed cross-bucket probe instead of reporting an authentication failure", async () => {
    const runtime = { runContainer: vi.fn().mockRejectedValue(new Error("VAULT_CROSS_BUCKET_PROBE_FAILED")) };
    const credentials = { username: "fos-vault-notes", password: "vault-secret" };
    const adapter = createComposeVaultVerificationAdapter(runtime, "/opt/fos/admin-worker.js", credentials, "other");

    await expect(verifyVault(adapter, "notes", credentials, "other")).rejects.toThrow("VAULT_CROSS_BUCKET_PROBE_FAILED");
  });
});
