import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export interface RecordOrigin {
  deviceId: string;
  operationId: string;
  clientTime: number;
}

export interface BlobReference {
  algorithm: "sha256";
  hash: string;
  key: string;
  size: number;
  etag?: string;
}

export interface RemoteFileRecord {
  schemaVersion: 1;
  fileId: string;
  path: string;
  kind: "text" | "blob";
  deleted: boolean;
  contentHash: string;
  size: number;
  mime?: string;
  content?: string;
  blob?: BlobReference;
  origin: RecordOrigin;
  basedOnRevision?: number;
  deletion?: { reason?: string };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[A-Za-z0-9_-]+$/;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("record must be an object");
  }
  return value as Record<string, unknown>;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function size(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function normalizePath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Invalid path");
  const path = value.replaceAll("\\", "/").normalize("NFC");
  if (path.startsWith("/") || path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Invalid path");
  }
  return path;
}

export function createFileId(): string {
  return crypto.randomUUID();
}

export function recordKey(record: Pick<RemoteFileRecord, "fileId">): string {
  return `f.${id(record.fileId, "fileId")}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function validateRecord(value: unknown): RemoteFileRecord {
  const record = object(value);
  if (record.schemaVersion !== 1) throw new Error("Unsupported schemaVersion");
  id(record.fileId, "fileId");
  if (normalizePath(record.path as string) !== record.path) throw new Error("Non-normalized path");
  if (record.kind !== "text" && record.kind !== "blob") throw new Error("Invalid kind");
  if (typeof record.deleted !== "boolean") throw new Error("Invalid deleted");
  if (typeof record.contentHash !== "string" || !hashPattern.test(record.contentHash)) throw new Error("Invalid contentHash");
  size(record.size, "size");
  if (record.mime !== undefined && typeof record.mime !== "string") throw new Error("Invalid mime");
  const origin = object(record.origin);
  id(origin.deviceId, "deviceId");
  id(origin.operationId, "operationId");
  if (typeof origin.clientTime !== "number" || !Number.isFinite(origin.clientTime)) throw new Error("Invalid clientTime");
  if (record.basedOnRevision !== undefined) size(record.basedOnRevision, "basedOnRevision");
  if (record.deletion !== undefined) object(record.deletion);

  if (record.deleted) {
    if (record.content !== undefined || record.blob !== undefined) throw new Error("Invalid deleted content");
  } else if (record.kind === "text") {
    if (typeof record.content !== "string" || record.blob !== undefined) throw new Error("Invalid text content or blob");
    const bytes = encoder.encode(record.content);
    if (bytes.length !== record.size) throw new Error("Invalid size");
    if (sha256Hex(bytes) !== record.contentHash) throw new Error("Invalid contentHash");
  } else {
    if (record.content !== undefined) throw new Error("Invalid blob content");
    const blob = object(record.blob);
    if (blob.algorithm !== "sha256" || blob.hash !== record.contentHash || !hashPattern.test(blob.hash as string)) {
      throw new Error("Invalid blob hash");
    }
    if (blob.size !== record.size) throw new Error("Invalid blob size");
    if (typeof blob.key !== "string" || !blob.key) throw new Error("Invalid blob key");
    if (blob.etag !== undefined && typeof blob.etag !== "string") throw new Error("Invalid blob etag");
  }
  return value as RemoteFileRecord;
}

export function encodeRecord(record: RemoteFileRecord): Uint8Array {
  validateRecord(record);
  return encoder.encode(JSON.stringify(record));
}

export function decodeRecord(bytes: Uint8Array): RemoteFileRecord {
  return validateRecord(JSON.parse(decoder.decode(bytes)));
}
