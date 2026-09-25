import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptTransfer, encryptTransfer, type TransferConfig } from "../../packages/plugin/src/config-transfer.js";
import { pluginInstances } from "../doubles/obsidian.js";

const connectVault = vi.hoisted(() => vi.fn(async () => {
  throw new Error("connection attempt");
}));

vi.mock("../../packages/plugin/src/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/plugin/src/connection.js")>();
  return { ...actual, connectVault };
});

import EasySyncPlugin from "../../packages/plugin/src/main.js";

const transfer: TransferConfig = {
  vaultId: "VAULT_A", server: "wss://sync.example.com", username: "alice", natsPassword: "nats-secret",
  s3Endpoint: "https://s3.example.com", s3Bucket: "vault", s3Region: "eu-west-1",
  s3AccessKeyId: "access", s3SecretKey: "s3-secret", inlineLimit: 262144,
};

function createApp() {
  const secrets = new Map<string, string>();
  const secretStorage = {
    getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
    setSecret: vi.fn((key: string, value: string) => { secrets.set(key, value); }),
    deleteSecret: vi.fn((key: string) => { secrets.delete(key); }),
  };
  return { secretStorage, app: { secretStorage } };
}

function configure(plugin: EasySyncPlugin, boundVaultId = "") {
  plugin.config = {
    vaultId: "OLD_VAULT", boundVaultId, deviceId: "device", server: "wss://old.example.com", username: "old-user",
    passwordSecretKey: "old-password", s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1", s3AccessKeyId: "",
    s3SecretKeySecretKey: "", inlineLimit: 262144, debugLogging: false, statusBarMode: "extended",
  };
}

afterEach(() => {
  connectVault.mockClear();
  pluginInstances.length = 0;
  vi.unstubAllGlobals();
});

describe("plugin configuration import", () => {
  it("stores NATS and optional S3 passwords only in SecretStorage before connecting", async () => {
    const { app, secretStorage } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    const plaintext = await encryptTransfer(transfer, "");
    const decoded = await decryptTransfer(plaintext, "");

    await expect(plugin.importConfig(decoded)).resolves.toMatchObject({ kind: "connection-error" });

    expect(secretStorage.setSecret).toHaveBeenCalledWith(expect.stringMatching(/^flash-sync-nats-/), "nats-secret");
    expect(secretStorage.setSecret).toHaveBeenCalledWith(expect.stringMatching(/^flash-sync-s3-/), "s3-secret");
    const persistedData = pluginInstances.at(-1)?.savedData;
    const persisted = JSON.stringify(persistedData);
    expect(persisted).not.toContain("nats-secret");
    expect(persisted).not.toContain("s3-secret");
    expect(persistedData).toEqual(expect.objectContaining({
      passwordSecretKey: expect.stringMatching(/^flash-sync-nats-/),
      s3SecretKeySecretKey: expect.stringMatching(/^flash-sync-s3-/),
    }));
    expect(connectVault).toHaveBeenCalledTimes(1);
  });

  it("imports encrypted version 1 and attempts a connection", async () => {
    const { app } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    const encrypted = await encryptTransfer({ ...transfer, s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1",
      s3AccessKeyId: "", s3SecretKey: "" }, "12345678");
    const decoded = await decryptTransfer(encrypted, "12345678");

    await expect(plugin.importConfig(decoded)).resolves.toMatchObject({ kind: "connection-error" });
    expect(connectVault).toHaveBeenCalledTimes(1);
  });

  it("preserves existing settings and secrets when the bound vault differs", async () => {
    const { app, secretStorage } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin, "BOUND_VAULT");
    const before = { ...plugin.config };

    await expect(plugin.importConfig(transfer)).rejects.toThrow(/bound to a different vault/);

    expect(plugin.config).toEqual(before);
    expect(secretStorage.setSecret).not.toHaveBeenCalled();
    expect(connectVault).not.toHaveBeenCalled();
  });

  it("saves only active section fields and never serializes replacement secrets", async () => {
    const { app, secretStorage } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    const draft = { ...plugin.config, server: "wss://new.example.com", username: "new-user",
      natsPassword: "replacement-password", s3Endpoint: "https://stale-draft.example.com",
      s3Bucket: "stale-draft", s3AccessKeyId: "stale-access", s3Secret: "stale-secret" };

    const outcome = await plugin.applyDraft(draft as never, "connection");

    expect(outcome.kind).toBe("connection-error");
    const saved = JSON.stringify(pluginInstances.at(-1)?.savedData);
    expect(saved).toContain("wss://new.example.com");
    expect(saved).not.toContain("replacement-password");
    expect(saved).not.toContain("stale-secret");
    expect(saved).not.toContain("stale-draft");
    expect(plugin.config.s3Endpoint).toBe("");
    expect(secretStorage.setSecret).toHaveBeenCalledWith(expect.stringMatching(/^flash-sync-nats-/), "replacement-password");
  });

  it("keeps active configuration and runtime when settings persistence fails", async () => {
    const { app, secretStorage } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    const before = { ...plugin.config };
    vi.spyOn(plugin, "saveData").mockRejectedValueOnce(new Error("failed to store replacement-password safely"));
    const disconnect = vi.spyOn(plugin as unknown as { disconnect: () => Promise<void> }, "disconnect").mockResolvedValue();

    const outcome = await plugin.applyDraft({ ...plugin.config, server: "wss://new.example.com",
      natsPassword: "replacement-password", s3Secret: "" } as never, "connection");

    expect(outcome).toMatchObject({ kind: "persistence-error" });
    expect(JSON.stringify(outcome)).not.toContain("replacement-password");
    expect(plugin.config).toEqual(before);
    expect(disconnect).not.toHaveBeenCalled();
    expect(connectVault).not.toHaveBeenCalled();
    expect(secretStorage.setSecret).toHaveBeenCalledWith(expect.stringMatching(/^flash-sync-nats-/), "replacement-password");
  });

  it("serializes concurrent connection retries", async () => {
    const { app, secretStorage } = createApp();
    secretStorage.setSecret("old-password", "stored-password");
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    let rejectFirst!: (error: Error) => void;
    const firstAttempt = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    connectVault.mockImplementationOnce(() => firstAttempt).mockRejectedValueOnce(new Error("offline"));

    const first = plugin.connectNow();
    const second = plugin.connectNow();
    await vi.waitFor(() => expect(connectVault).toHaveBeenCalledTimes(1));
    expect(connectVault).toHaveBeenCalledTimes(1);
    rejectFirst(new Error("offline"));
    await Promise.all([first, second]);
    expect(connectVault).toHaveBeenCalledTimes(2);
  });

  it("rejects a partial attachment import before changing settings or secrets", async () => {
    const { app, secretStorage } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    const before = { ...plugin.config };
    const partial = { ...transfer, s3Endpoint: "https://s3.example.com", s3SecretKey: "" };

    const outcome = await plugin.importConfig(partial);

    expect(outcome).toMatchObject({ kind: "validation-error" });
    expect(plugin.config).toEqual(before);
    expect(secretStorage.setSecret).not.toHaveBeenCalled();
    expect(pluginInstances.at(-1)?.savedData).toBeNull();
    expect(connectVault).not.toHaveBeenCalled();
  });

  it("rejects invalid settings without disconnecting the current runtime", async () => {
    const { app } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    const disconnect = vi.spyOn(plugin as unknown as { disconnect: () => Promise<void> }, "disconnect").mockResolvedValue();
    const before = { ...plugin.config };

    const outcome = await plugin.applyDraft({ ...plugin.config, server: "https://not-secure.example.com",
      natsPassword: "replacement-password", s3Secret: "" } as never, "connection");

    expect(outcome).toMatchObject({ kind: "validation-error" });
    expect(plugin.config).toEqual(before);
    expect(disconnect).not.toHaveBeenCalled();
    expect(connectVault).not.toHaveBeenCalled();
  });

  it("applies debug-only settings without reconnecting", async () => {
    const { app } = createApp();
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);

    const outcome = await plugin.applyDraft({ ...plugin.config, debugLogging: true,
      natsPassword: "", s3Secret: "" } as never, "advanced");

    expect(outcome).toEqual({ kind: "applied" });
    expect(plugin.config.debugLogging).toBe(true);
    expect(connectVault).not.toHaveBeenCalled();
  });

  it("snapshots an apply draft before waiting behind a queued retry", async () => {
    const { app, secretStorage } = createApp();
    secretStorage.setSecret("old-password", "stored-password");
    const plugin = new EasySyncPlugin(app as never, {} as never);
    configure(plugin);
    let rejectFirst!: (error: Error) => void;
    const firstAttempt = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    connectVault.mockImplementationOnce(() => firstAttempt);
    const retry = plugin.connectNow();
    await vi.waitFor(() => expect(connectVault).toHaveBeenCalledTimes(1));
    const draft = { ...plugin.config, server: "wss://submitted.example.com", natsPassword: "", s3Secret: "" };
    const apply = plugin.applyDraft(draft as never, "connection");
    draft.server = "wss://mutated-later.example.com";
    rejectFirst(new Error("offline"));

    await Promise.all([retry, apply]);

    expect(plugin.config.server).toBe("wss://submitted.example.com");
  });
});
