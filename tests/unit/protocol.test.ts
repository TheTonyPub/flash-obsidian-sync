import { describe, expect, it } from "vitest";
import {
  createFileId,
  canonicalizeRemotePath,
  decodePathOwnershipRecord,
  decodeRecord,
  encodePathOwnershipRecord,
  encodeRecord,
  normalizePath,
  pathOwnershipKey,
  recordKey,
  sha256Hex,
  type RemoteFileRecord,
} from "../../packages/protocol/src/index.js";

const liveText: RemoteFileRecord = {
  schemaVersion: 1,
  fileId: "file-1",
  path: "notes/hello.md",
  kind: "text",
  deleted: false,
  contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  size: 5,
  content: "hello",
  origin: { deviceId: "device-1", operationId: "op-1", clientTime: 1 },
};

describe("remote record codec", () => {
  it("round trips a valid text record", () => {
    expect(decodeRecord(encodeRecord(liveText))).toEqual(liveText);
  });

  it("rejects malformed JSON and unknown schema versions", () => {
    expect(() => decodeRecord(new TextEncoder().encode("{"))).toThrow(SyntaxError);
    expect(() => encodeRecord({ ...liveText, schemaVersion: 2 } as unknown as RemoteFileRecord)).toThrow(/schemaVersion/);
  });

  it("rejects invalid field combinations and paths", () => {
    expect(() => encodeRecord({ ...liveText, deleted: true })).toThrow(/deleted/);
    expect(() => encodeRecord({ ...liveText, kind: "blob" })).toThrow(/blob/);
    expect(() => encodeRecord({ ...liveText, path: "../escape.md" })).toThrow(/path/);
  });

  it("checks exact UTF-8 content size and hash", async () => {
    const content = "привет";
    const bytes = new TextEncoder().encode(content);
    const record = { ...liveText, content, size: bytes.length, contentHash: await sha256Hex(bytes) };
    expect(decodeRecord(encodeRecord(record))).toEqual(record);
    expect(() => encodeRecord({ ...record, size: content.length })).toThrow(/size/);
    expect(() => encodeRecord({ ...record, contentHash: "0".repeat(64) })).toThrow(/contentHash/);
  });
});

describe("identity, paths, hashing", () => {
  it("normalizes slashes and Unicode without changing file identity", () => {
    expect(normalizePath("notes\\cafe\u0301.md")).toBe("notes/café.md");
    const renamed = { ...liveText, path: "renamed.md" };
    expect(recordKey(renamed)).toBe("f.file-1");
  });

  it.each(["/absolute.md", "../escape.md", "a/../b.md", "a//b.md", ".obsidian/settings.json", "a/./b.md"])(
    "rejects unsafe path %s",
    (path) => expect(() => normalizePath(path)).toThrow(/path/),
  );

  it("creates unique stable IDs", () => {
    const first = createFileId();
    const second = createFileId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it("hashes exact bytes, including line endings", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(new TextEncoder().encode("a\r\n"))).not.toBe(
      await sha256Hex(new TextEncoder().encode("a\n")),
    );
  });

  it.each([
    ["notes/cafe\u0301.md", "notes/café.md"],
    ["Notes\\Straße.MD", "notes/strasse.md"],
    ["Σ/ς/σ.md", "σ/σ/σ.md"],
  ])("canonicalizes remote path %s identically on every client", (input, expected) => {
    expect(canonicalizeRemotePath(input)).toBe(expected);
  });

  it("maps Desktop and Mobile spellings to one ownership identity", () => {
    const desktop = canonicalizeRemotePath("Journal\\Café\\Straße.md");
    const mobile = canonicalizeRemotePath("journal/cafe\u0301/STRASSE.MD");
    expect(desktop).toBe("journal/café/strasse.md");
    expect(mobile).toBe(desktop);
  });

  it("validates path ownership records against their canonical key", () => {
    const owner = { schemaVersion: 1 as const, canonicalPath: "notes/strasse.md", fileId: "file-1", operationId: "op-1", state: "reserved" as const };
    const key = pathOwnershipKey("Notes/Straße.md");
    expect(key).toMatch(/^p\.[0-9a-f]{64}$/);
    expect(decodePathOwnershipRecord(encodePathOwnershipRecord(owner), key)).toEqual(owner);
    expect(() => decodePathOwnershipRecord(encodePathOwnershipRecord(owner), `p.${"0".repeat(64)}`)).toThrow(/key mismatch/);
    expect(() => encodePathOwnershipRecord({ ...owner, state: "invalid" } as never)).toThrow(/state/);
  });
});
