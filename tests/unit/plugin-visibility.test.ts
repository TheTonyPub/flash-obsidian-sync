import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import EasySyncPlugin from "../../packages/plugin/src/main.js";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  Platform: { isMobile: false },
  setIcon: () => {},
}));

function plugin(): EasySyncPlugin {
  return new EasySyncPlugin({} as never, {} as never);
}

describe("desktop visibility reconciliation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a healthy desktop sync running without a return-to-window rescan", () => {
    Platform.isMobile = false;
    const subject = plugin() as unknown as {
      engine: object; status: { connected: boolean; reconciled: boolean }; hiddenAt: number; lastReconciledAt: number; initialReconcileInFlight: boolean;
      shouldReconcileOnVisibility: () => boolean;
    };
    subject.engine = {};
    subject.status.connected = true;
    subject.status.reconciled = true;
    subject.hiddenAt = Date.now() - 1_000;
    subject.lastReconciledAt = Date.now() - 1_000;

    expect(subject.shouldReconcileOnVisibility()).toBe(false);
    subject.initialReconcileInFlight = true;
    expect(subject.shouldReconcileOnVisibility()).toBe(false);
  });

  it("reconciles on mobile and after a stale or unhealthy desktop session", () => {
    const subject = plugin() as unknown as {
      engine: object; status: { connected: boolean; reconciled: boolean }; hiddenAt: number; lastReconciledAt: number; initialReconcileInFlight: boolean;
      shouldReconcileOnVisibility: () => boolean;
    };
    subject.engine = {};
    subject.status.connected = true;
    subject.status.reconciled = true;
    subject.hiddenAt = Date.now() - 301_000;
    subject.lastReconciledAt = Date.now() - 301_000;
    Platform.isMobile = false;
    expect(subject.shouldReconcileOnVisibility()).toBe(true);

    subject.hiddenAt = Date.now();
    subject.lastReconciledAt = Date.now();
    Platform.isMobile = true;
    expect(subject.shouldReconcileOnVisibility()).toBe(true);

    Platform.isMobile = false;
    subject.status.reconciled = false;
    expect(subject.shouldReconcileOnVisibility()).toBe(true);
  });
});
