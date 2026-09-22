import { describe, expect, it, vi } from "vitest";
import { previewLifecycle, runLifecycle, type LifecycleAdapter } from "../../packages/server-cli/src/lifecycle.js";

function adapter(): LifecycleAdapter {
  return { inventory: vi.fn().mockResolvedValue([{ kind: "path", value: "/var/lib/flash-osidian-sync/nats", owned: true }]),
    backup: vi.fn().mockResolvedValue(undefined), upgrade: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined),
    removeOwned: vi.fn().mockResolvedValue(undefined), removeData: vi.fn().mockResolvedValue(undefined) };
}

describe("fos lifecycle safety", () => {
  it("previews upgrade/uninstall and excludes data deletion by default", async () => {
    const host = adapter();
    await expect(previewLifecycle("uninstall", host)).resolves.toContain("preserve data");
    expect(host.removeOwned).not.toHaveBeenCalled();
  });
  it("rolls an upgrade back and never removes unrelated resources", async () => {
    const host = adapter();
    host.upgrade = vi.fn().mockRejectedValue(new Error("failed"));
    await expect(runLifecycle("upgrade", { confirmed: true }, host)).rejects.toThrow("failed");
    expect(host.rollback).toHaveBeenCalledOnce();
    expect(host.removeOwned).not.toHaveBeenCalled();
  });
  it("requires separate typed confirmation before deleting data", async () => {
    const host = adapter();
    await expect(runLifecycle("uninstall", { confirmed: true, deleteData: true, typedConfirmation: "no" }, host)).rejects.toThrow("DATA_DELETION_CONFIRMATION_REQUIRED");
    expect(host.removeOwned).not.toHaveBeenCalled();
    expect(host.removeData).not.toHaveBeenCalled();
  });
  it("rejects unrelated resources before lifecycle mutation", async () => {
    const host = adapter();
    host.inventory = vi.fn().mockResolvedValue([{ kind: "service", value: "other.service", owned: false }]);
    await expect(runLifecycle("uninstall", { confirmed: true }, host)).rejects.toThrow("RESOURCE_CONFLICT");
    expect(host.removeOwned).not.toHaveBeenCalled();
  });
});
