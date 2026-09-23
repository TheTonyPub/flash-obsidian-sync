import { describe, expect, it, vi } from "vitest";
import { decryptTransfer } from "../../packages/plugin/src/config-transfer.js";

const handoffModulePath = "../../packages/server-cli/src/handoff-builder.js";

type HandoffConfig = {
  vaultId: string;
  server: string;
  username: string;
  password: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretKey: string;
  inlineLimit: number;
  encryptionPhrase?: string;
};
type HandoffResult = { uri: string; qr: string };
type TransferPayload = Omit<HandoffConfig, "password"> & { natsPassword: string };
type HandoffModule = {
  buildImportHandoff(config: HandoffConfig, options: { renderQr(uri: string): Promise<string> | string; onProgress?(message: string): void }): Promise<HandoffResult>;
};

async function loadHandoff(): Promise<HandoffModule> {
  return await import(handoffModulePath) as HandoffModule;
}

const config: HandoffConfig = {
  vaultId: "notes", server: "wss://sync.example.test", username: "fos-vault-notes", password: "vault-secret",
  s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1", s3AccessKeyId: "", s3SecretKey: "", inlineLimit: 262144,
};

describe("CLI import handoff builder", () => {
  it("builds a valid plaintext v2 URI with default empty S3 fields and inline limit", async () => {
    const { buildImportHandoff } = await loadHandoff();
    const renderQr = vi.fn((uri: string) => `QR:${uri}`);
    const result = await buildImportHandoff(config, { renderQr });
    const uri = new URL(result.uri);
    const payload = uri.searchParams.get("data")!;
    const decoded = JSON.parse(Buffer.from(payload.slice(2), "base64url").toString("utf8")) as TransferPayload;

    expect(uri.protocol).toBe("obsidian:");
    expect(uri.host).toBe("flash-sync-import");
    expect(uri.pathname).toBe("");
    expect(payload.startsWith("2.")).toBe(true);
    const { password, ...withoutPassword } = config;
    expect(decoded).toEqual({ ...withoutPassword, natsPassword: password });
    expect(decoded).not.toHaveProperty("password");
    expect(result.qr).toBe(`QR:${result.uri}`);
  });

  it("passes exactly the generated URI to the QR renderer and never includes administrator credentials", async () => {
    const { buildImportHandoff } = await loadHandoff();
    const renderQr = vi.fn((uri: string) => uri);
    const onProgress = vi.fn();
    const result = await buildImportHandoff(config, { renderQr, onProgress });

    expect(renderQr).toHaveBeenCalledOnce();
    expect(renderQr).toHaveBeenCalledWith(result.uri);
    expect(result.uri).not.toContain("administrator-secret");
    expect(result.qr).not.toContain("administrator-secret");
    expect(onProgress.mock.calls.flat().join(" ")).not.toContain("vault-secret");
  });

  it("encrypts with v1 when an optional phrase is supplied and remains plugin-decryptable", async () => {
    const { buildImportHandoff } = await loadHandoff();
    const phrase = "phrase-123";
    const onProgress = vi.fn();
    const result = await buildImportHandoff({ ...config, encryptionPhrase: phrase }, { renderQr: vi.fn(() => "QR"), onProgress });
    const payload = new URL(result.uri).searchParams.get("data")!;

    expect(payload.startsWith("1.")).toBe(true);
    expect(onProgress.mock.calls.flat().join(" ")).not.toContain(phrase);
    await expect(decryptTransfer(payload, phrase)).resolves.toEqual(expect.objectContaining({
      vaultId: config.vaultId, server: config.server, username: config.username, natsPassword: config.password,
    }));
  });

  it.each(["x", "1234567"]) ("rejects a non-empty encryption phrase shorter than eight characters before rendering (%s)", async (phrase) => {
    const { buildImportHandoff } = await loadHandoff();
    const renderQr = vi.fn();

    await expect(buildImportHandoff({ ...config, encryptionPhrase: phrase }, { renderQr })).rejects.toThrow(/8|phrase/i);
    expect(renderQr).not.toHaveBeenCalled();
  });

  it("rejects invalid handoff configuration without leaking the vault password", async () => {
    const { buildImportHandoff } = await loadHandoff();
    const renderQr = vi.fn();

    await expect(buildImportHandoff({ ...config, server: "ws://invalid" }, { renderQr }))
      .rejects.toSatisfy((error: unknown) => !String(error).includes("vault-secret"));
    expect(renderQr).not.toHaveBeenCalled();
  });

  it("redacts the URI when QR rendering fails", async () => {
    const { buildImportHandoff } = await loadHandoff();
    const renderQr = vi.fn((uri: string) => { throw new Error(`QR renderer failed for ${uri}`); });

    try {
      await buildImportHandoff(config, { renderQr });
      throw new Error("expected QR renderer failure");
    } catch (error) {
      const message = String(error);
      const renderedUri = renderQr.mock.calls[0]?.[0] as string;
      expect(message).not.toContain("obsidian://flash-sync-import");
      expect(message).not.toContain("2.");
      expect(message).not.toContain(renderedUri);
      expect(message).toMatch(/QR|render/i);
    }
    expect(renderQr).toHaveBeenCalledOnce();
  });
});
