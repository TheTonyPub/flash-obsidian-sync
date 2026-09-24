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
    const svg = await QRCode.toString(`obsidian://flash-sync-import?data=${encodeURIComponent(payload)}`, { type: "svg" });
    expect(svg).toContain("<svg");
  });
});

describe("versioned configuration transfer", () => {
  it("uses explicit plaintext version 2 for an empty phrase", async () => {
    const payload = await encryptTransfer(config, "");

    expect(payload.startsWith("2.")).toBe(true);
    await expect(decryptTransfer(payload, "")).resolves.toEqual(config);
  });

  it("retains encrypted version 1 for a nonempty phrase", async () => {
    const payload = await encryptTransfer(config, "12345678");

    expect(payload.startsWith("1.")).toBe(true);
    await expect(decryptTransfer(payload, "12345678")).resolves.toEqual(config);
  });

  it("accepts only the empty phrase or an eight-character encrypted phrase", async () => {
    await expect(encryptTransfer(config, "")).resolves.toMatch(/^2\./);
    await expect(encryptTransfer(config, "1234567")).rejects.toThrow(/8 characters/);
    await expect(encryptTransfer(config, "12345678")).resolves.toMatch(/^1\./);
  });

  it("rejects unknown versions and malformed plaintext before returning settings", async () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

    await expect(decryptTransfer(`3.${encode(config)}`, "")).rejects.toThrow(/Unsupported transfer code/);
    await expect(decryptTransfer("2.not-base64-json", "")).rejects.toThrow();
    await expect(decryptTransfer(`2.${encode({ ...config, server: "ws://invalid" })}`, "")).rejects.toThrow(/WSS/);
    await expect(decryptTransfer(`2.${encode({ ...config, inlineLimit: 0 })}`, "")).rejects.toThrow(/inline limit/);
  });

  it("rejects malformed version 2 payloads without interpreting partial data", async () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const malformed = { vaultId: config.vaultId, server: config.server };

    await expect(decryptTransfer(`2.${encode(malformed)}`, "")).rejects.toThrow(/Invalid transfer settings/);
  });

  it("rejects oversized payloads at both production and decode boundaries", async () => {
    const oversized = { ...config, s3SecretKey: "x".repeat(5000) };
    const encoded = Buffer.from(JSON.stringify(oversized)).toString("base64url");

    await expect(encryptTransfer(oversized, "")).rejects.toThrow(/transfer code|payload/i);
    await expect(decryptTransfer(`2.${encoded}`, "")).rejects.toThrow(/Invalid transfer code/);
  });
});
