import type { SyncStatus } from "./connection.js";

export type StatusPresentation = {
  icon: "cloud-check" | "cloud-alert" | "cloud-off" | "file-diff";
  color: "neutral" | "success" | "error" | "muted" | "warning";
  label: string;
  tooltip: string;
  text: string;
};

export type OverviewStatusPresentation = { color: "green" | "yellow" | "red" | "gray"; label: string };

export function overviewStatusPresentation(status: SyncStatus): OverviewStatusPresentation {
  const presentation = statusPresentation(status);
  const color = { neutral: "yellow", warning: "yellow", success: "green", error: "red", muted: "gray" } as const;
  return { color: color[presentation.color], label: presentation.label };
}

export function statusPresentation(status: SyncStatus): StatusPresentation {
  const conflicts = Math.max(status.conflicts, status.conflictPaths.length);
  if (status.value === "AUTH_ERROR") return { icon: "cloud-off", color: "muted", label: "Authentication failed", tooltip: "Authentication failed", text: "Authentication failed" };
  if (!status.connected || status.value === "OFFLINE") return { icon: "cloud-off", color: "muted", label: "Disconnected", tooltip: "Disconnected", text: "Disconnected" };
  if (conflicts > 0) {
    const text = `${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}`;
    return { icon: "file-diff", color: "warning", label: text, tooltip: `${text} to review`, text };
  }
  if (status.errors > 0 || status.value === "ERROR") return { icon: "cloud-alert", color: "error", label: "Sync error", tooltip: "Sync error", text: "Sync error" };
  if (!status.reconciled || status.pending > 0 || status.blobsPending > 0 || status.value === "RECONCILING" || status.value === "PENDING") {
    return { icon: "cloud-check", color: "neutral", label: "Syncing", tooltip: "Syncing", text: "Syncing" };
  }
  return { icon: "cloud-check", color: "success", label: "Synchronized", tooltip: "Synchronized", text: "Synchronized" };
}
