import { webcrypto } from "node:crypto";

export interface HandoffConfig {
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
}

export interface HandoffResult { uri: string; qr: string; }

function validate(config: HandoffConfig): void {
  const strings: Array<keyof Omit<HandoffConfig, "inlineLimit">> = [
    "vaultId", "server", "username", "password", "s3Endpoint", "s3Bucket", "s3Region", "s3AccessKeyId", "s3SecretKey",
  ];
  if (strings.some((field) => typeof config[field] !== "string") || !/^[A-Za-z0-9_-]+$/.test(config.vaultId)
    || !config.server.startsWith("wss://") || (config.s3Endpoint !== "" && !config.s3Endpoint.startsWith("https://"))
    || !Number.isSafeInteger(config.inlineLimit) || config.inlineLimit <= 0 || (config.encryptionPhrase !== undefined && typeof config.encryptionPhrase !== "string")) {
    throw new Error("Invalid import handoff configuration");
  }
}

async function encryptedPayload(plain: Uint8Array, phrase: string): Promise<string> {
  if (phrase.length < 8) throw new Error("Code phrase must contain at least 8 characters");
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(phrase), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250_000, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return `1.${Buffer.from(new Uint8Array([...salt, ...iv, ...cipher])).toString("base64url")}`;
}

export async function buildImportHandoff(
  config: HandoffConfig,
  options: { renderQr(uri: string): Promise<string> | string; onProgress?(message: string): void },
): Promise<HandoffResult> {
  validate(config);
  const plain = new TextEncoder().encode(JSON.stringify({
    vaultId: config.vaultId, server: config.server, username: config.username, natsPassword: config.password,
    s3Endpoint: config.s3Endpoint, s3Bucket: config.s3Bucket, s3Region: config.s3Region,
    s3AccessKeyId: config.s3AccessKeyId, s3SecretKey: config.s3SecretKey, inlineLimit: config.inlineLimit,
  }));
  const phrase = config.encryptionPhrase ?? "";
  const payload = phrase === "" ? `2.${Buffer.from(plain).toString("base64url")}` : await encryptedPayload(plain, phrase);
  if (payload.length > 4096) throw new Error("Import handoff exceeds the 4096-character limit");
  const uri = `obsidian://flash-sync-import?data=${encodeURIComponent(payload)}`;
  options.onProgress?.("Rendering Obsidian import handoff");
  try { return { uri, qr: await options.renderQr(uri) }; }
  catch { throw new Error("Unable to render Obsidian import handoff"); }
}
