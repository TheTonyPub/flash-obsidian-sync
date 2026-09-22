import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault } from "../../packages/server-cli/src/vault-verify.js";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), open: vi.fn() }));

vi.mock("@nats-io/transport-node", () => ({ connect: mocks.connect }));
vi.mock("@nats-io/kv", () => ({ Kvm: class { open(bucket: string) { return mocks.open(bucket); } } }));

import { createNativeVaultVerificationAdapter } from "../../packages/server-cli/src/native-admin.js";

describe("native scoped vault verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const ownBucket = {
      status: vi.fn().mockResolvedValue({}),
      watch: vi.fn().mockResolvedValue({ stop: vi.fn() }),
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ value: new TextEncoder().encode("fos-verify") }),
    };
    mocks.connect.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
    mocks.open.mockImplementation((bucket: string) => bucket === "OBS_notes_FILES" ? ownBucket : ({
      status: vi.fn().mockRejectedValue(new Error('Permissions Violation for Subscription to "$JS.API.STREAM.INFO.KV_OBS___FOS_CROSS_PROBE_FILES"')),
    }));
  });

  it("does not probe an unrelated bucket when only own-bucket checks are requested", async () => {
    await expect(verifyVault(createNativeVaultVerificationAdapter({ username: "fos-vault-notes", password: "secret" }),
      "notes", { username: "fos-vault-notes", password: "secret" })).resolves.toEqual({ ownBucket: true, crossBucket: "not-tested" });
    expect(mocks.open.mock.calls.every(([bucket]) => bucket === "OBS_notes_FILES")).toBe(true);
    expect(mocks.open).toHaveBeenCalledWith("OBS_notes_FILES");
  });

  it("checks permission denial against the explicitly named peer bucket", async () => {
    const credentials = { username: "fos-vault-notes", password: "secret" };
    await expect(verifyVault(createNativeVaultVerificationAdapter(credentials), "notes", credentials, "other")).resolves.toMatchObject({ crossBucket: "denied" });
    expect(mocks.open).toHaveBeenCalledWith("OBS_other_FILES");
  });

  it("does not treat a missing peer bucket as proof of permission denial", async () => {
    mocks.open.mockImplementation((bucket: string) => bucket === "OBS_notes_FILES" ? ({
      status: vi.fn().mockResolvedValue({}),
      watch: vi.fn().mockResolvedValue({ stop: vi.fn() }),
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ value: new TextEncoder().encode("fos-verify") }),
    }) : ({ status: vi.fn().mockRejectedValue(new Error("stream not found")) }));
    const credentials = { username: "fos-vault-notes", password: "secret" };
    await expect(verifyVault(createNativeVaultVerificationAdapter(credentials), "notes", credentials, "missing")).rejects.toThrow("VAULT_CROSS_BUCKET_PROBE_FAILED");
    expect(mocks.open).toHaveBeenCalledWith("OBS_missing_FILES");
  });

  it("preserves authentication connection timeouts instead of relabeling them as bad credentials", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connection timeout"));
    const credentials = { username: "fos-vault-notes", password: "secret" };
    await expect(verifyVault(createNativeVaultVerificationAdapter(credentials), "notes", credentials)).rejects.toThrow("connection timeout");
  });
});
