import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_ID, registerImportUriHandlers } from "../../packages/plugin/src/plugin-identity.js";
import EasySyncPlugin from "../../packages/plugin/src/main.js";
import { Plugin, pluginInstances } from "../doubles/obsidian.js";

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, setIcon: () => {} };
});

const manifestPath = fileURLToPath(new URL("../../packages/plugin/manifest.json", import.meta.url));

function statusBarFixture(): HTMLElement {
  const item = {
    style: { color: "" },
    tabIndex: 0,
    classList: { add: () => {}, remove: () => {} },
    empty: () => {},
    setAttribute: () => {},
    addEventListener: () => {},
    createSpan: () => item,
  };
  return item as unknown as HTMLElement;
}

afterEach(() => {
  pluginInstances.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Flash Sync plugin identity", () => {
  it("uses the exact community-plugin manifest identity and installation path", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { id: string; name: string };

    expect(manifest).toEqual(expect.objectContaining({
      id: "flash-sync",
      name: "flash-sync",
    }));
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(`.obsidian/plugins/${manifest.id}`).toBe(".obsidian/plugins/flash-sync");
  });

  it("registers only the flash-sync import URI", () => {
    const register = vi.fn();

    registerImportUriHandlers(register, vi.fn());

    expect(register.mock.calls.map(([scheme]) => scheme)).toEqual(["flash-sync-import"]);
  });

  it("starts with fresh settings without reading or copying legacy plugin data", async () => {
    const exists = vi.fn(async () => true);
    const read = vi.fn(async () => JSON.stringify({
      vaultId: "LEGACY_VAULT",
      boundVaultId: "LEGACY_VAULT",
      deviceId: "legacy-device",
      server: "wss://legacy.example.test",
    }));
    const databases = vi.fn(async () => [{ name: "easy-sync-legacy-device-LEGACY_VAULT" }]);
    const open = vi.fn();
    const app = {
      vault: { adapter: { exists, read }, configDir: ".obsidian" },
      workspace: { onLayoutReady: vi.fn(), getActiveViewOfType: vi.fn() },
      secretStorage: { getSecret: vi.fn(), setSecret: vi.fn() },
    };
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", {});
    vi.stubGlobal("indexedDB", { databases, open });
    vi.spyOn(Plugin.prototype, "addStatusBarItem").mockReturnValue(statusBarFixture() as never);
    const plugin = new EasySyncPlugin(app as never, {} as never);

    await plugin.onload();

    expect(exists).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(databases).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(plugin.config.server).toBe("");
    expect(plugin.config.vaultId).toMatch(/^[A-F0-9]{32}$/);
    expect(pluginInstances.at(-1)?.savedData).toMatchObject({ server: "", vaultId: plugin.config.vaultId });
  });
});
