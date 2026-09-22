import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { decryptTransfer, encryptTransfer, type TransferConfig } from "../../packages/plugin/src/config-transfer.js";

const config: TransferConfig = {
  vaultId: "VAULT_A", server: "wss://sync.example.com", username: "alice", natsPassword: "nats-secret",
  s3Endpoint: "https://s3.example.com", s3Bucket: "vault", s3Region: "eu-west-1",
  s3AccessKeyId: "access", s3SecretKey: "s3-secret", inlineLimit: 262144,
};

describe("encrypted configuration transfer", () => {
  it("round trips credentials without exposing them in the QR payload", async () => {
    const payload = await encryptTransfer(config, "correct horse battery staple");
    expect(payload).not.toContain("nats-secret");
    expect(payload).not.toContain("s3-secret");
    expect(payload).not.toContain("alice");
    expect(await decryptTransfer(payload, "correct horse battery staple")).toEqual(config);
  });

  it("accepts an eight-character code phrase and rejects seven characters", async () => {
    const payload = await encryptTransfer(config, "12345678");
    expect(await decryptTransfer(payload, "12345678")).toEqual(config);
    await expect(encryptTransfer(config, "1234567")).rejects.toThrow();
  });

  it("rejects an incorrect phrase, malformed payload, and invalid endpoint", async () => {
    const payload = await encryptTransfer(config, "correct horse battery staple");
    await expect(decryptTransfer(payload, "wrong phrase")).rejects.toThrow();
    await expect(decryptTransfer("invalid", "phrase")).rejects.toThrow();
    await expect(encryptTransfer({ ...config, server: "ws://sync.example.com" }, "phrase")).rejects.toThrow();
  });

  it("fits a normal encrypted transfer link into a QR code", async () => {
    const payload = await encryptTransfer(config, "correct horse battery staple");
    const svg = await QRCode.toString(`obsidian://easy-sync-import?data=${encodeURIComponent(payload)}`, { type: "svg" });
    expect(svg).toContain("<svg");
  });
});
