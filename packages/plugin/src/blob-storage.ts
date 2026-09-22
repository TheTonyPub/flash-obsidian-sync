import { sha256Hex, type BlobReference } from "@flash-osidian-sync/protocol";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const DEFAULT_INLINE_LIMIT = 512 * 1024;

export interface BlobPort {
  upload(key: string, bytes: Uint8Array): Promise<void>;
  download(key: string): Promise<Uint8Array>;
}

export interface S3BlobSettings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretKeySecretKey: string;
  allowHttpForTests?: boolean;
}

export class S3BlobAdapter implements BlobPort {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async upload(key: string, bytes: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes,
      ContentType: "application/octet-stream" }));
  }

  async download(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error("Empty blob response");
    return response.Body.transformToByteArray();
  }
}

export async function connectS3Blob(settings: S3BlobSettings,
  secrets: { getSecret(key: string): string | null | Promise<string | null> }): Promise<S3BlobAdapter> {
  const endpoint = new URL(settings.endpoint);
  if (endpoint.protocol !== "https:" && !(settings.allowHttpForTests && endpoint.protocol === "http:")) {
    throw new Error("S3 HTTPS endpoint required");
  }
  if (!settings.bucket || !settings.region || !settings.accessKeyId) throw new Error("Incomplete S3 settings");
  const secretAccessKey = await secrets.getSecret(settings.secretKeySecretKey);
  if (!secretAccessKey) throw new Error("S3 secret missing");
  const client = new S3Client({ endpoint: endpoint.href, region: settings.region, forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey } });
  return new S3BlobAdapter(client, settings.bucket);
}

export function blobObjectKey(vaultId: string, hash: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(vaultId) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid blob identity");
  return `vaults/${vaultId}/blobs/sha256/${hash.slice(0, 2)}/${hash}`;
}

export function chooseStorage(path: string, bytes: Uint8Array, inlineLimit = DEFAULT_INLINE_LIMIT): "inline" | "blob" {
  if (!Number.isSafeInteger(inlineLimit) || inlineLimit < 1) throw new Error("Invalid inline limit");
  return path.endsWith(".md") && bytes.length <= inlineLimit ? "inline" : "blob";
}

export async function downloadVerified(blob: BlobPort, reference: BlobReference): Promise<Uint8Array> {
  const bytes = await blob.download(reference.key);
  if (bytes.length !== reference.size) throw new Error("Blob size mismatch");
  if (sha256Hex(bytes) !== reference.hash) throw new Error("Blob hash mismatch");
  return bytes;
}
