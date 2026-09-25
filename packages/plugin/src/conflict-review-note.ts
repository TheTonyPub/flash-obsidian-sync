import { CONFLICT_REVIEW_FOLDER } from "./markdown-sync.js";

export { CONFLICT_REVIEW_FOLDER };

export interface ConflictReviewComparison {
  remote: Record<string, unknown>;
  local: Record<string, unknown>;
  stale: { remote: boolean; local: boolean };
}

export interface ConflictReviewInput {
  originalPath: string;
  copyPath: string;
  remoteRevision: number;
  detectionRemoteHash?: string;
  detectionCopyHash?: string;
  snapshotAt?: Date | number;
  comparison: ConflictReviewComparison;
}

const MAX_LCS_CELLS = 40_000;
const MAX_CHANGED_LINES = 2_000;

function value(version: Record<string, unknown>, name: string): string {
  return version[name] === undefined ? "unknown" : String(version[name]);
}

function metadata(title: string, version: Record<string, unknown>, stale: boolean, staleMessage: string): string[] {
  return [
    `## ${title}`,
    `- Path: \`${value(version, "path")}\``,
    `- Current hash: \`${value(version, "hash")}\``,
    `- Size: ${value(version, "size")}`,
    ...(version.revision === undefined ? [] : [`- Current revision: ${value(version, "revision")}`]),
    ...(stale ? [`- **Stale:** ${staleMessage}`] : []),
  ];
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    current = value === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function fencedDiff(lines: string[]): string {
  const body = lines.join("\n");
  const ticks = longestRun(body, "`");
  const tildes = longestRun(body, "~");
  const character = ticks <= tildes ? "`" : "~";
  const fence = character.repeat(Math.max(3, Math.min(ticks, tildes) + 1));
  return `${fence}diff\n${body}\n${fence}`;
}

function abbreviatedDiff(before: string[], after: string[]): string[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const changed = (lines: string[], marker: string): string[] => {
    const range = lines.slice(prefix, lines.length - suffix);
    if (range.length <= MAX_CHANGED_LINES) return range.map((line) => `${marker}${line}`);
    const half = MAX_CHANGED_LINES / 2;
    return [...range.slice(0, half).map((line) => `${marker}${line}`),
      `… ${range.length - MAX_CHANGED_LINES} changed lines omitted …`, ...range.slice(-half).map((line) => `${marker}${line}`)];
  };
  return [...changed(before, "-"), ...changed(after, "+")];
}

function lineDiff(remote: string, local: string): { content: string; abbreviated: boolean } {
  const before = remote.replaceAll("\r\n", "\n").split("\n");
  const after = local.replaceAll("\r\n", "\n").split("\n");
  if (before.length * after.length > MAX_LCS_CELLS) return { content: fencedDiff(abbreviatedDiff(before, after)), abbreviated: true };
  const table = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--)
    table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);

  const output: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { output.push(` ${before[i]}`); i++; j++; }
    else if (j < after.length && (i === before.length || table[i][j + 1] >= table[i + 1][j])) { output.push(`+${after[j++]}`); }
    else { output.push(`-${before[i++]}`); }
  }
  return { content: fencedDiff(output), abbreviated: false };
}

/** Produces an immutable, user-owned inspection snapshot. It is never read for resolution. */
export function formatConflictReviewNote(input: ConflictReviewInput): string {
  const { comparison } = input;
  const title = input.originalPath.split("/").at(-1) || input.originalPath;
  const remoteText = typeof comparison.remote.content === "string" ? comparison.remote.content : undefined;
  const localText = typeof comparison.local.content === "string" ? comparison.local.content : undefined;
  let comparisonBody: string;
  if (remoteText === undefined || localText === undefined) {
    comparisonBody = "## Comparison\n\nMetadata-only comparison (binary or oversized content).";
  } else if (remoteText === localText) {
    comparisonBody = "## Line-level comparison\n\nNo content differences.";
  } else {
    const diff = lineDiff(remoteText, localText);
    comparisonBody = `## Line-level comparison\n\nRemote original is shown with \`-\`; preserved local copy with \`+\`.${diff.abbreviated ? "\n\nDiff is abbreviated because this comparison has too many line pairs." : ""}\n\n${diff.content}`;
  }
  const snapshotAt = new Date(input.snapshotAt ?? Date.now()).toISOString();

  return [
    `# Conflict review: ${title}`,
    "",
    "This note is for inspection only and is not used to resolve the conflict.",
    `Snapshot created: ${snapshotAt}`,
    "",
    "## Detection",
    `- Original path: \`${input.originalPath}\``,
    `- Preserved copy path: \`${input.copyPath}\``,
    `- Detection remote revision: ${input.remoteRevision}`,
    `- Detection remote hash: \`${input.detectionRemoteHash ?? "unknown"}\``,
    `- Detection copy hash: \`${input.detectionCopyHash ?? "unknown"}\``,
    "",
    ...metadata("Remote original", comparison.remote, comparison.stale.remote, "Remote version changed since detection."),
    "",
    ...metadata("Preserved local copy", comparison.local, comparison.stale.local, "Local copy changed since detection."),
    "",
    comparisonBody,
    "",
  ].join("\n");
}
