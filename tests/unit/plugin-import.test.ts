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
    s3SecretKeySecretKey: "", inlineLimit: 262144, debugLogging: false,
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

    await expect(plugin.importConfig(decoded)).resolves.toBeUndefined();

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
    const encrypted = await encryptTransfer({ ...transfer, s3Endpoint: "", s3SecretKey: "" }, "12345678");
    const decoded = await decryptTransfer(encrypted, "12345678");

    await expect(plugin.importConfig(decoded)).resolves.toBeUndefined();
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
});
