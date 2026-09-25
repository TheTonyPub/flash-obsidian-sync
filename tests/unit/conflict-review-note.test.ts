import { describe, expect, it } from "vitest";
import { CONFLICT_REVIEW_FOLDER, formatConflictReviewNote } from "../../packages/plugin/src/conflict-review-note.js";

describe("conflict review notes", () => {
  it("formats an inspectable line-level comparison with detection and current metadata", () => {
    const note = formatConflictReviewNote({
      originalPath: "notes/idea.md", copyPath: "notes/idea.conflict.md", remoteRevision: 7,
      detectionRemoteHash: "detected-remote", detectionCopyHash: "detected-copy",
      snapshotAt: new Date("2026-09-25T08:00:00.000Z"),
      comparison: {
        remote: { path: "notes/idea.md", hash: "remote-now", size: 12, revision: 8, content: "one\ntwo\n" },
        local: { path: "notes/idea.conflict.md", hash: "copy-now", size: 14, content: "one\nlocal\n" },
        stale: { remote: true, local: false },
      },
    });

    expect(CONFLICT_REVIEW_FOLDER).toBe("Flash Sync Conflict Reviews");
    expect(note).toContain("# Conflict review: idea.md");
    expect(note).toContain("Snapshot created: 2026-09-25T08:00:00.000Z");
    expect(note).toContain("Remote version changed since detection.");
    expect(note).toContain("Detection remote hash: `detected-remote`");
    expect(note).toContain("Current hash: `remote-now`");
    expect(note).toContain("Remote original");
    expect(note).toContain("Preserved local copy");
    expect(note).toContain("-two");
    expect(note).toContain("+local");
    expect(note).toContain("This note is for inspection only and is not used to resolve the conflict.");
  });

  it("keeps binary or oversized comparisons metadata-only", () => {
    const note = formatConflictReviewNote({
      originalPath: "image.png", copyPath: "image.conflict.png", remoteRevision: 4,
      comparison: {
        remote: { path: "image.png", hash: "remote", size: 900_000, revision: 4 },
        local: { path: "image.conflict.png", hash: "copy", size: 900_001 },
        stale: { remote: false, local: false },
      },
    });

    expect(note).toContain("Metadata-only comparison (binary or oversized content).");
    expect(note).not.toContain("```diff");
  });

  it("states when text versions are identical without emitting unchanged diff lines", () => {
    const note = formatConflictReviewNote({
      originalPath: "same.md", copyPath: "same.conflict.md", remoteRevision: 5,
      comparison: {
        remote: { path: "same.md", hash: "same", size: 5, content: "same\n" },
        local: { path: "same.conflict.md", hash: "same", size: 5, content: "same\n" },
        stale: { remote: false, local: false },
      },
    });

    expect(note).toContain("No content differences.");
    expect(note).not.toContain("```diff");
  });

  it("uses a safe fence and a bounded fallback for large line comparisons", () => {
    const remote = Array.from({ length: 300 }, (_, index) => index === 5 ? "```" : `remote-${index}`).join("\n");
    const local = Array.from({ length: 300 }, (_, index) => index === 5 ? "~~~" : `local-${index}`).join("\n");
    const note = formatConflictReviewNote({
      originalPath: "large.md", copyPath: "large.conflict.md", remoteRevision: 1,
      comparison: {
        remote: { path: "large.md", hash: "remote", size: remote.length, content: remote },
        local: { path: "large.conflict.md", hash: "copy", size: local.length, content: local },
        stale: { remote: false, local: false },
      },
    });

    expect(note).toContain("Diff is abbreviated because this comparison has too many line pairs.");
    const openingFence = note.match(/\n([`~]{4,})diff\n/)?.[1];
    expect(openingFence).toBeDefined();
    expect(note).toContain(`\n${openingFence}\n`);
  });
});
