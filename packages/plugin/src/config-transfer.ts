export interface TransferConfig {
  vaultId: string;
  server: string;
  username: string;
  natsPassword: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretKey: string;
  inlineLimit: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const iterations = 250_000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid transfer code");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function validate(value: unknown): TransferConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid transfer settings");
  const data = value as Record<string, unknown>;
  const fields = ["vaultId", "server", "username", "natsPassword", "s3Endpoint", "s3Bucket",
    "s3Region", "s3AccessKeyId", "s3SecretKey"] as const;
  if (fields.some((field) => typeof data[field] !== "string")) throw new Error("Invalid transfer settings");
  if (!/^[A-Za-z0-9_-]+$/.test(data.vaultId as string)) throw new Error("Invalid vault ID");
  if (!(data.server as string).startsWith("wss://")) throw new Error("WSS endpoint required");
  if (data.s3Endpoint && !(data.s3Endpoint as string).startsWith("https://")) throw new Error("S3 HTTPS endpoint required");
  if (!Number.isSafeInteger(data.inlineLimit) || (data.inlineLimit as number) <= 0) throw new Error("Invalid inline limit");
  return data as unknown as TransferConfig;
}

async function key(phrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(phrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt.slice(), iterations, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptTransfer(config: TransferConfig, phrase: string): Promise<string> {
  if (phrase.length < 8) throw new Error("Code phrase must contain at least 8 characters");
  const plain = encoder.encode(JSON.stringify(validate(config)));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(phrase, salt), plain));
  return `1.${base64url(new Uint8Array([...salt, ...iv, ...cipher]))}`;
}

export async function decryptTransfer(payload: string, phrase: string): Promise<TransferConfig> {
  if (!payload.startsWith("1.") || payload.length > 4096) throw new Error("Unsupported transfer code");
  const packed = unbase64url(payload.slice(2));
  if (packed.length < 45) throw new Error("Invalid transfer code");
  const salt = packed.slice(0, 16);
  const iv = packed.slice(16, 28);
  const cipher = packed.slice(28);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(phrase, salt), cipher);
  return validate(JSON.parse(decoder.decode(plain)));
}
