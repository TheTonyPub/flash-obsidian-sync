import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../packages/protocol/src/index.js";
import { blobObjectKey, chooseStorage, connectS3Blob, downloadVerified } from "../../packages/plugin/src/blob-storage.js";

describe("blob routing and integrity", () => {
  it("keeps small Markdown inline and routes binary or oversized text", () => {
    expect(chooseStorage("note.md", new TextEncoder().encode("hello"), 1024)).toBe("inline");
    expect(chooseStorage("note.md", new Uint8Array(1025), 1024)).toBe("blob");
    expect(chooseStorage("image.png", new Uint8Array(1), 1024)).toBe("blob");
  });

  it("uses a stable vault-scoped SHA-256 key", () => {
    expect(blobObjectKey("VAULT", "ab".repeat(32))).toBe(`vaults/VAULT/blobs/sha256/ab/${"ab".repeat(32)}`);
  });

  it("rejects corrupted downloaded bytes before local apply", async () => {
    const good = new TextEncoder().encode("good");
    const bad = new TextEncoder().encode("bad!");
    const hash = sha256Hex(good);
    expect(good.length).toBe(bad.length);
    await expect(downloadVerified({ upload: async () => {}, download: async () => bad },
      { algorithm: "sha256", hash, key: blobObjectKey("VAULT", hash), size: good.length })).rejects.toThrow(/hash/i);
  });

  it("requires HTTPS and reads the S3 secret from SecretStorage", async () => {
    const settings = { endpoint: "https://s3.example.test", bucket: "vault", region: "us-east-1",
      accessKeyId: "user", secretKeySecretKey: "s3-secret" };
    await expect(connectS3Blob(settings, { getSecret: async () => null })).rejects.toThrow(/secret/i);
    await expect(connectS3Blob({ ...settings, endpoint: "http://s3.example.test" },
      { getSecret: async () => "password" })).rejects.toThrow(/HTTPS/i);
  });
});
