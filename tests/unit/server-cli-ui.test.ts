import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import QRCode from "qrcode";
import { colorsEnabled, errorRecoveryHint, formatCliHelp, formatFailure, formatHandoffOutput, formatHumanOutput, formatPreview, formatVaultResult, helpTopicForArgs, renderHandoffQr, selectTerminal } from "../../packages/server-cli/src/ui.js";

const stripAnsi = (value: string): string => value.replace(
  new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
  "",
);

describe("server CLI presentation", () => {
  it("keeps colors off for non-TTY, NO_COLOR, and dumb terminals", () => {
    expect(colorsEnabled(false, {})).toBe(false);
    expect(colorsEnabled(true, { NO_COLOR: "" })).toBe(false);
    expect(colorsEnabled(true, { TERM: "dumb" })).toBe(false);
    expect(colorsEnabled(true, { TERM: "xterm-256color" })).toBe(true);
  });

  it("groups plan details and highlights deployment paths only when color is enabled", () => {
    const preview = [
      "fos bootstrap plan",
      "mode: podman",
      "domain: sync.example.test",
      "install path: /opt/flash-osidian-sync",
      "data path: /var/lib/flash-osidian-sync",
      "systemd services: fos-nats, fos-caddy",
      "firewall management: selected",
    ].join("\n");

    const plain = formatPreview(preview);
    expect(plain).toContain("Configuration\n  mode: podman");
    expect(plain).toContain("Paths\n  install path: /opt/flash-osidian-sync");
    expect(plain).not.toContain("\u001b[");

    const colored = formatPreview(preview, true);
    expect(colored).toContain("\u001b[36m/opt/flash-osidian-sync\u001b[0m");
  });

  it("shows actionable recovery hints without changing machine-readable error codes", () => {
    expect(errorRecoveryHint("SSH_PRESERVATION_FAILED")).toMatch(/Keep this SSH session open/);
    expect(errorRecoveryHint("INPUT_CANCELLED")).toMatch(/Run fos status before retrying/);
    expect(formatFailure("SSH_PRESERVATION_FAILED")).toContain("fos: SSH_PRESERVATION_FAILED");
    expect(errorRecoveryHint("COMMAND_REQUIRED")).toContain("fos --help");
    expect(errorRecoveryHint("VAULT_ID_REQUIRED")).toContain("--vault-id ID");
  });

  it("routes every command and nested vault help request without interpreting command options", () => {
    const cases: Array<[string[], string]> = [
      [["--help"], "root"], [["help"], "root"], [["bootstrap", "--help"], "bootstrap"], [["plan", "--help"], "plan"],
      [["status", "--help"], "status"], [["vault", "--help"], "vault"], [["vault", "list", "--help"], "vault-list"],
      [["help", "vault", "create"], "vault-create"], [["vault", "inspect", "-h"], "vault-inspect"],
      [["vault", "add", "--help"], "vault-add"], [["vault", "rotate", "--help"], "vault-rotate"],
      [["vault", "revoke", "--help"], "vault-revoke"], [["vault", "verify", "--help"], "vault-verify"],
      [["import", "--help"], "import"], [["backup", "--help"], "backup"], [["restore-check", "--help"], "restore-check"],
      [["upgrade", "--help"], "upgrade"], [["uninstall", "--help"], "uninstall"],
    ];
    for (const [args, topic] of cases) expect(helpTopicForArgs(args)).toBe(topic);
    expect(helpTopicForArgs([])).toBe("root");
    expect(helpTopicForArgs(["vault"])).toBe("vault");
    expect(helpTopicForArgs(["vault", "list"])).toBeUndefined();
    expect(formatCliHelp("vault-list")).toContain("fos vault list [--mode MODE] [--admin-input FILE]");
    expect(formatCliHelp("uninstall")).toContain("--confirm DELETE_DATA");
    expect(formatCliHelp("plan")).not.toContain("--approve");
  });

  it("formats vault rows and human output while preserving plain output without ANSI", () => {
    const listing = formatVaultResult([{ vaultId: "research", storage: "file", history: 10, replicas: 1 }]);
    expect(listing).toContain("VAULT ID");
    expect(listing).toContain("research");
    expect(formatVaultResult([])).toBe("No vaults found.");
    expect(formatHumanOutput("fos backup artifact: /srv/fos-backups/daily.tar")).toBe("fos backup artifact: /srv/fos-backups/daily.tar");
    expect(formatHumanOutput("fos backup artifact: /srv/fos-backups/daily.tar", true)).toContain("\u001b[36m/srv/fos-backups/daily.tar\u001b[0m");
  });

  it("styles the complete synthetic Obsidian URI without changing it or the protected-file form", () => {
    const uri = "obsidian://flash-sync-import?data=2.synthetic-preview-payload";
    const contents = `Obsidian import URI: ${uri}\nQR preview\n`;
    expect(formatHandoffOutput(contents)).toBe(contents);

    const styled = formatHandoffOutput(contents, true);
    const plainText = stripAnsi(styled);
    expect(plainText).toBe(contents);
    expect(styled).toContain(`\u001b[36m${uri}\u001b[0m`);
  });

  it("packs the same synthetic QR modules into half-width, half-height terminal output", async () => {
    const uri = "obsidian://flash-sync-import?data=2.synthetic-preview-payload";
    const matrix = QRCode.create(uri, { errorCorrectionLevel: "M" }).modules;
    const full = await QRCode.toString(uri, { type: "terminal", errorCorrectionLevel: "M" });
    const compact = await renderHandoffQr(uri, true);
    const plain = await renderHandoffQr(uri, false);
    const protectedOutput = await renderHandoffQr(uri, true, true);
    const rows = (value: string): string[] => stripAnsi(value).replace(/\n$/, "").split("\n");
    const width = (value: string): number => Math.max(...rows(value).map((line) => [...line].length));

    expect(width(full)).toBe((matrix.size + 2) * 2);
    expect(width(compact)).toBe(matrix.size + 2);
    expect(rows(compact).length).toBeLessThanOrEqual(Math.ceil(rows(full).length / 2));
    expect(plain.includes(String.fromCharCode(27))).toBe(false);
    expect(plain.includes(String.fromCharCode(0x9b))).toBe(false);
    expect(protectedOutput.includes(String.fromCharCode(27))).toBe(false);
    expect(protectedOutput.includes(String.fromCharCode(0x9b))).toBe(false);
    expect(protectedOutput).toContain("▀");
    expect(QRCode.create(uri, { errorCorrectionLevel: "M" }).modules.data).toEqual(matrix.data);
  });

  it("restores terminal mode and pauses input when the selection is cancelled", async () => {
    const previousTerm = process.env.TERM;
    delete process.env.TERM;
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.defineProperty(input, "isTTY", { value: true });
    const rawModes: boolean[] = [];
    input.setRawMode = (enabled: boolean) => { rawModes.push(enabled); return input; };
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    Object.defineProperty(output, "isTTY", { value: true });
    const selection = selectTerminal("Choose mode", ["native", "docker"], input, output);
    const rejected = expect(selection).rejects.toThrow("INPUT_CANCELLED");
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", Buffer.from("\u0003"));

    await rejected;
    expect(rawModes).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  });
});
