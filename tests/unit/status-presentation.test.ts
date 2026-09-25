import { describe, expect, it } from "vitest";
import { SyncStatus } from "../../packages/plugin/src/connection.js";
import { overviewStatusPresentation, statusPresentation } from "../../packages/plugin/src/status-presentation.js";

describe("status presentation", () => {
  function connected(): SyncStatus {
    const status = new SyncStatus();
    status.connected = true;
    status.reconciled = true;
    return status;
  }

  it("distinguishes neutral syncing from green synchronized success using the same Cloud Check icon", () => {
    const syncing = connected();
    syncing.pending = 1;
    syncing.refresh();
    const synced = connected();
    synced.refresh();

    expect(statusPresentation(syncing)).toMatchObject({ icon: "cloud-check", color: "neutral", label: "Syncing", tooltip: "Syncing", text: "Syncing" });
    expect(statusPresentation(synced)).toMatchObject({ icon: "cloud-check", color: "success", label: "Synchronized", tooltip: "Synchronized", text: "Synchronized" });
  });

  it("uses a distinct accessible presentation for offline, errors, and conflicts with a count", () => {
    const offline = new SyncStatus();
    offline.refresh();
    const error = connected();
    error.markError("write");
    const conflict = connected();
    conflict.markError("write");
    conflict.conflictPaths = ["note.conflict.md", "other.conflict.md"];
    conflict.refresh();

    expect(statusPresentation(offline)).toMatchObject({ icon: "cloud-off", color: "muted", label: "Disconnected" });
    expect(statusPresentation(error)).toMatchObject({ icon: "cloud-alert", color: "error", label: "Sync error" });
    expect(statusPresentation(conflict)).toMatchObject({ icon: "file-diff", color: "warning", label: "2 conflicts", text: "2 conflicts" });
  });

  it("withholds success for reconciliation, queued work, blob transfers, and durable conflicts", () => {
    for (const configure of [
      (status: SyncStatus) => { status.reconciled = false; },
      (status: SyncStatus) => { status.pending = 1; },
      (status: SyncStatus) => { status.blobsPending = 1; },
      (status: SyncStatus) => { status.conflictPaths = ["note.conflict.md"]; },
    ]) {
      const status = connected();
      configure(status);
      status.refresh();
      expect(statusPresentation(status).color).not.toBe("success");
    }
  });

  it("maps the overview dot to synchronized, working, error, and disconnected states", () => {
    const synced = connected(); synced.refresh();
    const pending = connected(); pending.pending = 1; pending.refresh();
    const conflict = connected(); conflict.conflictPaths = ["note.conflict.md"]; conflict.refresh();
    const error = connected(); error.markError("write");
    const offline = new SyncStatus(); offline.refresh();
    const conflictAndError = connected(); conflictAndError.conflictPaths = ["note.conflict.md"]; conflictAndError.markError("write");
    const auth = connected(); auth.value = "AUTH_ERROR"; auth.connectionState = "AUTH_ERROR"; auth.refresh();

    expect(overviewStatusPresentation(synced)).toMatchObject({ color: "green", label: "Synchronized" });
    expect(overviewStatusPresentation(pending)).toMatchObject({ color: "yellow", label: "Syncing" });
    expect(overviewStatusPresentation(conflict)).toMatchObject({ color: "yellow", label: "1 conflict" });
    expect(overviewStatusPresentation(error)).toMatchObject({ color: "red", label: "Sync error" });
    expect(overviewStatusPresentation(offline)).toMatchObject({ color: "gray", label: "Disconnected" });
    expect(overviewStatusPresentation(conflictAndError)).toMatchObject({ color: "yellow", label: "1 conflict" });
    expect(overviewStatusPresentation(auth)).toMatchObject({ color: "gray", label: "Authentication failed" });
  });
});
