import { describe, expect, it } from "vitest";
import { conflictCopyId, conflictCopyPath, resolveMarkdown } from "../../packages/plugin/src/conflict-resolution.js";

describe("conservative three-way Markdown resolution", () => {
  it("merges disjoint line edits without changing untouched lines", () => {
    expect(resolveMarkdown("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual({
      kind: "merged", content: "A\nb\nC\n",
    });
  });

  it("rejects overlapping edits without dropping either version", () => {
    expect(resolveMarkdown("a\nb\n", "a\nLOCAL\n", "a\nREMOTE\n")).toEqual({ kind: "conflict" });
  });

  it("accepts identical edits and exact CRLF bytes", () => {
    expect(resolveMarkdown("a\r\nb\r\n", "A\r\nb\r\n", "a\r\nB\r\n")).toEqual({
      kind: "merged", content: "A\r\nB\r\n",
    });
    expect(resolveMarkdown("x\n", "X\n", "X\n")).toEqual({ kind: "merged", content: "X\n" });
  });

  it("requires a trustworthy base", () => {
    expect(resolveMarkdown(undefined, "local", "remote")).toEqual({ kind: "conflict" });
  });

  it("uses stable operation-derived identity and readable copy path", () => {
    const id = conflictCopyId("original-file", "losing-op");
    expect(id).toMatch(/^c-[0-9a-f]{24}$/);
    expect(conflictCopyId("original-file", "losing-op")).toBe(id);
    expect(conflictCopyId("original-file", "other-op")).not.toBe(id);
    expect(conflictCopyPath("notes/idea.md", "device-a", 0, "losing-op")).toBe(
      "notes/idea.conflict-device-a-19700101T000000-losing-op.md",
    );
  });
});
