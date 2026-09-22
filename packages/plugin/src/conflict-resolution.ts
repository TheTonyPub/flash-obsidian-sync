import { sha256Hex } from "@easy-sync/protocol";
import { diff3Merge } from "node-diff3";

function lines(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

export function resolveMarkdown(base: string | undefined, local: string, remote: string):
  { kind: "merged"; content: string } | { kind: "conflict" } {
  if (local === remote) return { kind: "merged", content: local };
  if (base === undefined) return { kind: "conflict" };
  if (local === base) return { kind: "merged", content: remote };
  if (remote === base) return { kind: "merged", content: local };
  const baseLines = lines(base);
  const localLines = lines(local);
  const remoteLines = lines(remote);
  if (baseLines.length === localLines.length && baseLines.length === remoteLines.length) {
    const merged: string[] = [];
    let safe = true;
    for (let i = 0; i < baseLines.length; i++) {
      if (localLines[i] === remoteLines[i]) merged.push(localLines[i]!);
      else if (localLines[i] === baseLines[i]) merged.push(remoteLines[i]!);
      else if (remoteLines[i] === baseLines[i]) merged.push(localLines[i]!);
      else { safe = false; break; }
    }
    if (safe) return { kind: "merged", content: merged.join("") };
  }
  const chunks = diff3Merge(localLines, baseLines, remoteLines, { excludeFalseConflicts: true });
  if (chunks.some((chunk) => chunk.conflict)) return { kind: "conflict" };
  return { kind: "merged", content: chunks.flatMap((chunk) => chunk.ok ?? []).join("") };
}

export function conflictCopyId(fileId: string, operationId: string): string {
  return `c-${sha256Hex(new TextEncoder().encode(`${fileId}:${operationId}`)).slice(0, 24)}`;
}

export function conflictCopyPath(path: string, deviceId: string, createdAt: number, operationId: string): string {
  const stamp = new Date(createdAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const safe = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.replace(/\.md$/, `.conflict-${safe(deviceId)}-${stamp}-${safe(operationId)}.md`);
}
