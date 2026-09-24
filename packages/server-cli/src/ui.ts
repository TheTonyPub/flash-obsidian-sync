import QRCode from "qrcode";

const ansi = {
  bold: "\u001b[1m",
  boldCyan: "\u001b[1;36m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
};

type HelpTopic = "root" | "bootstrap" | "plan" | "status" | "vault" | "vault-list" | "vault-create" | "vault-inspect" | "vault-add" | "vault-rotate" | "vault-revoke" | "vault-verify" | "import" | "backup" | "restore-check" | "upgrade" | "uninstall";
interface HelpPage { title: string; summary: string; usage: string[]; commands?: Array<[string, string]>; options?: Array<[string, string]>; examples?: string[] }

const commonVaultOptions: Array<[string, string]> = [
  ["--vault-id ID", "Target vault ID (required except for list)"],
  ["--mode MODE", "Override managed installation mode"],
  ["--admin-input FILE", "Protected administrator input; otherwise use stored credentials or prompt"],
];
const mutationVaultOptions: Array<[string, string]> = [
  ...commonVaultOptions, ["--wss-endpoint URL", "Override managed sync endpoint"], ["--keep", "Retain credential for import handoffs"],
  ["--secrets-output FILE", "Write handoff to a protected file; required with --admin-input"], ["-h, --help", "Show help"],
];
const backupOptions: Array<[string, string]> = [
  ["--destination PATH", "Absolute protected backup directory (required)"],
  ["--retention DAYS", "Retention from 1 to 365 days (required)"], ["-h, --help", "Show help without starting a backup"],
];
const planOptions: Array<[string, string]> = [
  ["--mode MODE", "native, docker, or podman; required when no terminal prompt is available"],
  ["--domain DOMAIN", "Public endpoint domain; required when no terminal prompt is available"],
  ["--email EMAIL", "ACME email address (optional)"], ["--vault-id ID", "Initial vault ID; required when no terminal prompt is available"],
  ["--manage-firewall", "Include firewall rules in the plan"], ["--dedicated-service-accounts", "Include dedicated service accounts in the plan"],
  ["--backup-destination PATH", "Include backup scheduling in the plan"], ["--backup-retention DAYS", "Backup retention, 1–365 days; required with destination"],
  ["-h, --help", "Show help without applying a plan"],
];
const helpPages: Record<HelpTopic, HelpPage> = {
  root: { title: "fos", summary: "Manage a Flash Obsidian Sync server.", usage: ["fos <command> [options]", "fos <command> --help", "fos help [command]"], commands: [
    ["bootstrap", "Preview and install a server"], ["plan", "Print the bootstrap plan"], ["status", "Show managed installation status"], ["vault", "Manage vaults and credentials"],
    ["import", "Create an Obsidian import handoff"], ["backup", "Create an explicit backup"], ["restore-check", "Back up and verify a restore"], ["upgrade", "Preview or apply an upgrade"], ["uninstall", "Preview or remove managed services"], ["help", "Show command help"],
  ], options: [["-h, --help", "Show help without running a command"], ["--json", "Print supported vault results as JSON"]], examples: [
    "fos bootstrap --mode podman --domain sync.example.org --vault-id main", "fos vault list", "fos backup --destination /srv/fos-backups --retention 14",
  ] },
  bootstrap: { title: "fos bootstrap", summary: "Preview configuration, then explicitly approve installation.", usage: ["fos bootstrap [options]"], options: [
    ["--mode MODE", "native, docker, or podman; prompted interactively, read from --input unattended"], ["--domain DOMAIN", "Public endpoint domain; prompted interactively, read from --input unattended"], ["--email EMAIL", "ACME email address (optional)"], ["--vault-id ID", "Initial vault ID; prompted interactively, read from --input unattended"],
    ["--wss-endpoint URL", "WebSocket sync endpoint (default: wss://DOMAIN)"], ["--keep", "Retain generated credentials for import handoffs (default: off)"], ["--approve", "Apply unattended plan; interactive mode still asks"],
    ["--non-interactive", "Disable prompts; requires --input, --secrets-output, and --approve (default: off)"], ["--manage-firewall", "Add rules for detected SSH and web ports (default: off)"], ["--dedicated-service-accounts", "Create dedicated service accounts (default: off)"],
    ["--backup-destination PATH", "Opt in to scheduled backup destination (default: not configured)"], ["--backup-retention DAYS", "Backup retention, 1–365 days (required with destination)"], ["--secrets-output FILE", "Write credentials to a protected file (required with --non-interactive)"],
    ["--input FILE", "Root-owned JSON input with mode, domain, and vaultId (required with --non-interactive)"], ["-h, --help", "Show help without applying a plan"],
  ], examples: ["fos bootstrap --mode podman --domain sync.example.org --vault-id main", "fos bootstrap --non-interactive --input /root/fos-input.json --secrets-output /root/fos-secrets.json --approve"] },
  plan: { title: "fos plan", summary: "Show the bootstrap plan without applying it.", usage: ["fos plan [options]"], options: planOptions },
  status: { title: "fos status", summary: "Show whether a managed installation is present.", usage: ["fos status"], options: [["-h, --help", "Show help"]] },
  vault: { title: "fos vault", summary: "Manage vaults and vault user credentials. Managed mode is used when available.", usage: ["fos vault <command> [options]", "fos vault <command> --help"], commands: [
    ["list", "List vaults"], ["create", "Create a vault bucket"], ["inspect", "Show one vault"], ["add", "Add a vault user and handoff"], ["rotate", "Rotate a vault credential"], ["revoke", "Revoke a vault user"], ["verify", "Verify vault access"],
  ], options: [["--mode MODE", "Override managed installation mode"], ["--admin-input FILE", "Protected administrator input; otherwise stored credentials or prompt"], ["--json", "Print result as JSON"], ["-h, --help", "Show help without contacting the server"]], examples: ["fos vault list", "fos vault list --mode podman", "fos vault create --vault-id research"] },
  "vault-list": { title: "fos vault list", summary: "List vault buckets; no vault ID is required.", usage: ["fos vault list [--mode MODE] [--admin-input FILE] [--json]"], options: [
    ["--mode MODE", "Override managed mode; otherwise use the installed managed mode"], ["--admin-input FILE", "Override stored credentials; otherwise use stored credentials or prompt interactively"], ["--json", "Print JSON"], ["-h, --help", "Show help without contacting the server"],
  ], examples: ["fos vault list", "fos vault list --mode docker", "fos vault list --admin-input /root/fos-admin-input"] },
  "vault-create": { title: "fos vault create", summary: "Create a vault bucket if it does not already exist.", usage: ["fos vault create --vault-id ID [--mode MODE] [--admin-input FILE] [--json]"], options: [...commonVaultOptions, ["--json", "Print JSON"], ["-h, --help", "Show help"]], examples: ["fos vault create --vault-id research"] },
  "vault-inspect": { title: "fos vault inspect", summary: "Show a vault bucket if it exists.", usage: ["fos vault inspect --vault-id ID [--mode MODE] [--admin-input FILE] [--json]"], options: [...commonVaultOptions, ["--json", "Print JSON"], ["-h, --help", "Show help"]], examples: ["fos vault inspect --vault-id research"] },
  "vault-add": { title: "fos vault add", summary: "Create a vault user and deliver an import handoff.", usage: ["fos vault add --vault-id ID [options]"], options: mutationVaultOptions, examples: ["fos vault add --vault-id research --keep"] },
  "vault-rotate": { title: "fos vault rotate", summary: "Rotate a vault credential and issue a new handoff.", usage: ["fos vault rotate --vault-id ID [options]"], options: mutationVaultOptions, examples: ["fos vault rotate --vault-id research"] },
  "vault-revoke": { title: "fos vault revoke", summary: "Revoke a vault user credential.", usage: ["fos vault revoke --vault-id ID [--mode MODE] [--admin-input FILE]"], options: [...commonVaultOptions, ["-h, --help", "Show help"]], examples: ["fos vault revoke --vault-id research"] },
  "vault-verify": { title: "fos vault verify", summary: "Verify vault access; optionally test access from another vault.", usage: ["fos vault verify --vault-id ID --vault-input FILE [options]"], options: [
    ...commonVaultOptions, ["--vault-input FILE", "Protected vault credential input (required)"], ["--cross-vault-id ID", "Also check peer-vault access"], ["-h, --help", "Show help"],
  ], examples: ["fos vault verify --vault-id research --vault-input /root/research-credential"] },
  import: { title: "fos import", summary: "Generate an Obsidian import handoff from a retained vault credential.", usage: ["fos import --vault-id ID [--wss-endpoint URL] [--secrets-output FILE]"], options: [
    ["--vault-id ID", "Vault ID (required)"], ["--wss-endpoint URL", "Override managed sync endpoint"], ["--secrets-output FILE", "Write handoff to a protected file (required in non-interactive mode)"], ["-h, --help", "Show help"],
  ], examples: ["fos import --vault-id research"] },
  backup: { title: "fos backup", summary: "Create a root-owned backup. This is an explicit operation.", usage: ["fos backup --destination PATH --retention DAYS"], options: backupOptions, examples: ["fos backup --destination /srv/fos-backups --retention 14"] },
  "restore-check": { title: "fos restore-check", summary: "Create a backup and verify it can be restored.", usage: ["fos restore-check --destination PATH --retention DAYS"], options: backupOptions, examples: ["fos restore-check --destination /srv/fos-backups --retention 14"] },
  upgrade: { title: "fos upgrade", summary: "Preview an upgrade; use --approve to apply it.", usage: ["fos upgrade [--approve]"], options: [["--approve", "Apply the upgrade"], ["-h, --help", "Show help without changing the installation"]], examples: ["fos upgrade", "fos upgrade --approve"] },
  uninstall: { title: "fos uninstall", summary: "Preview removal; deleting data requires separate typed confirmation.", usage: ["fos uninstall [--approve] [--delete-data --confirm DELETE_DATA]"], options: [
    ["--approve", "Apply removal"], ["--delete-data", "Delete managed data (requires --confirm DELETE_DATA)"], ["--confirm DELETE_DATA", "Exact confirmation required with --delete-data"], ["-h, --help", "Show help without changing the installation"],
  ], examples: ["fos uninstall", "fos uninstall --approve", "fos uninstall --approve --delete-data --confirm DELETE_DATA"] },
};

const helpAliases: Record<string, HelpTopic> = {
  "vault list": "vault-list", "vault create": "vault-create", "vault inspect": "vault-inspect", "vault add": "vault-add", "vault rotate": "vault-rotate", "vault revoke": "vault-revoke", "vault verify": "vault-verify",
};

export function helpTopicForArgs(args: readonly string[]): HelpTopic | undefined {
  if (args.length === 0) return "root";
  if (args.length === 1 && args[0] === "vault") return "vault";
  const words = (args[0] === "help" ? args.slice(1) : args).filter((arg) => !arg.startsWith("-"));
  const hasHelp = args.includes("--help") || args.includes("-h") || args[0] === "help";
  if (!hasHelp) return undefined;
  if (words.length === 0) return "root";
  return helpAliases[words.slice(0, 2).join(" ")] ?? (words[0] as HelpTopic);
}

export function formatCliHelp(topic: HelpTopic, color = false): string {
  const page = helpPages[topic] ?? helpPages.root;
  const output = [paint(page.title, ansi.bold, color), page.summary, "", paint("Usage", ansi.cyan, color), ...page.usage.map((line) => "  " + line)];
  if (page.commands?.length) output.push("", paint("Commands", ansi.cyan, color), ...page.commands.map(([name, description]) => "  " + name.padEnd(18) + " " + description));
  if (page.options?.length) output.push("", paint("Options", ansi.cyan, color), ...page.options.map(([name, description]) => "  " + name.padEnd(30) + " " + description));
  if (page.examples?.length) output.push("", paint("Examples", ansi.cyan, color), ...page.examples.map((example) => "  " + example));
  return output.join("\n");
}

export function formatVaultResult(result: unknown, color = false): string {
  if (Array.isArray(result)) {
    if (result.length === 0) return paint("No vaults found.", ansi.bold, color);
    const rows = result as Array<{ vaultId: string; storage: string; history: number; replicas: number }>;
    const widths = [Math.max(8, ...rows.map((item) => item.vaultId.length)), 7, 7, 8];
    const row = (values: string[]): string => values.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
    return [paint(row(["VAULT ID", "STORAGE", "HISTORY", "REPLICAS"]), ansi.cyan, color), ...rows.map((item) => row([item.vaultId, item.storage, String(item.history), String(item.replicas)]))].join("\n");
  }
  if (result && typeof result === "object" && "verified" in result) return paint("Vault access verified.", ansi.green, color);
  if (result && typeof result === "object" && "bucket" in result) {
    const created = "created" in result && Boolean(result.created);
    return paint(created ? "Vault created." : "Vault already exists.", created ? ansi.green : ansi.cyan, color) + "\n" + formatVaultResult((result as { bucket: unknown }).bucket, color);
  }
  if (result && typeof result === "object" && "vaultId" in result) {
    const bucket = result as { vaultId: string; name: string; storage: string; history: number; replicas: number };
    return ["Vault", "  ID: " + bucket.vaultId, "  Name: " + bucket.name, "  Storage: " + bucket.storage, "  History: " + bucket.history, "  Replicas: " + bucket.replicas].join("\n");
  }
  return "";
}

export function formatHumanOutput(value: string, color = false): string {
  return value.split("\n").map((line) => {
    const match = line.match(/((?:artifact|path|destination):\s*)(.+)$/i);
    if (match) return line.slice(0, match.index) + paint(match[1], ansi.cyan, color) + paint(match[2], ansi.cyan, color);
    if (/^fos (?:upgrade|uninstall) (?:complete|preview)|^fos backup/i.test(line)) return paint(line, ansi.bold, color);
    return line;
  }).join("\n");
}

/** Styles only the interactive Obsidian URI line; the full URI remains contiguous and copyable. */
export function formatHandoffOutput(value: string, color = false): string {
  if (!color) return value;
  return value.split("\n").map((line) => {
    const match = line.match(/^(Obsidian import URI: )(obsidian:\/\/\S+)$/);
    if (!match) return line;
    return paint(match[1]!, ansi.boldCyan, true) + paint(match[2]!, ansi.cyan, true);
  }).join("\n");
}

/** Compact terminal QR for colored TTYs; protected files always receive plain UTF-8. */
export function renderHandoffQr(uri: string, coloredTerminal: boolean, protectedOutput = false): Promise<string> {
  return coloredTerminal && !protectedOutput
    ? QRCode.toString(uri, { type: "terminal", small: true, errorCorrectionLevel: "M" })
    : QRCode.toString(uri, { type: "utf8", errorCorrectionLevel: "M" });
}

export function colorsEnabled(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTTY && env.NO_COLOR === undefined && env.TERM !== "dumb";
}

function paint(value: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${value}${ansi.reset}` : value;
}

export function formatPreview(preview: string, color = false): string {
  const lines = preview.split("\n");
  const title = lines.shift() ?? "fos plan";
  const sections: Record<string, string[]> = {
    Configuration: [],
    Paths: [],
    Services: [],
    "Access and recovery": [],
  };
  const sectionFor = (line: string): keyof typeof sections => {
    if (/^(install|data|log) path:/.test(line)) return "Paths";
    if (/^(systemd services|compose project):/.test(line)) return "Services";
    if (/^(firewall management|dedicated service accounts|backup schedule|credentials):/.test(line)) return "Access and recovery";
    return "Configuration";
  };

  for (const line of lines) {
    const section = sections[sectionFor(line)];
    const separator = line.indexOf(": ");
    if (color && /^(install|data|log) path:/.test(line) && separator >= 0) {
      section.push(`${line.slice(0, separator + 2)}${paint(line.slice(separator + 2), ansi.cyan, true)}`);
    } else {
      section.push(line);
    }
  }

  const output = [paint(title, ansi.bold, color)];
  for (const [name, entries] of Object.entries(sections)) {
    if (entries.length) output.push("", paint(name, ansi.cyan, color), ...entries.map((line) => `  ${line}`));
  }
  return output.join("\n");
}

export function errorRecoveryHint(message: string): string | undefined {
  if (message === "COMMAND_REQUIRED") return "Run fos --help to see the available commands.";
  if (message === "VAULT_ACTION_REQUIRED") return "Run fos vault --help to see the available actions.";
  if (message === "INSTALL_MODE_REQUIRED") return "Run this on a managed installation or pass --mode native, docker, or podman.";
  if (message === "ROOT_REQUIRED") return "Rerun the command as root, for example with sudo.";
  if (message.includes("UNKNOWN_OPTION:") || message.includes("UNKNOWN_VAULT_OPTION:")) return "Run the matching command with --help to review supported options.";
  if (message === "VAULT_ID_REQUIRED") return "Add --vault-id ID. Run the selected vault action with --help to see its required inputs.";
  if (message === "PLAN_INPUT_REQUIRED") return "Supply --mode, --domain, and --vault-id, or run fos plan in an interactive terminal.";
  if (message === "NONINTERACTIVE_INPUT_REQUIRED") return "Provide a protected --input file with mode, domain, and vaultId.";
  if (message === "SSH_PRESERVATION_FAILED") {
    return "Keep this SSH session open, restore a separate root session, then rerun the bootstrap.";
  }
  if (message === "INPUT_CANCELLED") return "Cancellation interrupted the command. Run fos status before retrying.";
  if (message.endsWith("_INPUT_REQUIRED")) return "Run this command in an interactive terminal or provide the required input flags.";
  if (message === "APPLY_ADAPTER_REQUIRED" || message === "STATE_ADAPTER_REQUIRED") {
    return "Run the packaged fos CLI as root and retry.";
  }
  return undefined;
}

export function formatFailure(message: string, color = false, includeHint = color): string {
  const hint = includeHint ? errorRecoveryHint(message) : undefined;
  const prefix = paint("fos:", ansi.red, color);
  return `${prefix} ${message}${hint ? `\n  ${hint}` : ""}`;
}

export function formatChoicePrompt(question: string, choices: readonly string[]): string {
  return `${question}\n${choices.map((choice, index) => `  ${index + 1}) ${choice}`).join("\n")}\nChoose [1-${choices.length}]: `;
}

export async function selectTerminal<T extends string>(
  question: string,
  choices: readonly T[],
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<T> {
  if (!input.isTTY || !output.isTTY || process.env.TERM === "dumb" || typeof input.setRawMode !== "function") {
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  }
  let selected = 0;
  const draw = (): void => {
    output.write(`${choices.map((choice, index) => `  ${index === selected ? "›" : " "} ${choice}`).join("\n")}\n`);
    output.write("  Use ↑/↓ and Enter, or press 1-3. Ctrl+C cancels.\n");
  };
  const redraw = (): void => {
    output.write(`\u001b[${choices.length + 1}A\r\u001b[0J`);
    draw();
  };

  return new Promise<T>((resolve, reject) => {
    input.setRawMode(true);
    input.resume();
    let escape = "";
    let finished = false;
    const finish = (value?: T): void => {
      if (finished) return;
      finished = true;
      input.off("data", receive);
      process.off("SIGINT", cancelOnSignal);
      input.setRawMode(false);
      input.pause();
      if (value) {
        output.write(`\u001b[${choices.length + 1}A\r\u001b[0J${paintForTerminal(`✓ ${value}`, "32", output)}\n`);
        resolve(value);
      } else {
        output.write(`\u001b[${choices.length + 1}A\r\u001b[0J`);
        reject(new Error("INPUT_CANCELLED"));
      }
    };
    const cancelOnSignal = (): void => finish();
    const receive = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") { finish(); return; }
        if (escape) {
          escape += character;
          if (escape === "\u001b[A") { selected = (selected + choices.length - 1) % choices.length; redraw(); escape = ""; }
          else if (escape === "\u001b[B") { selected = (selected + 1) % choices.length; redraw(); escape = ""; }
          else if (escape.length >= 3) escape = "";
          continue;
        }
        if (character === "\u001b") { escape = character; continue; }
        if (character >= "1" && character <= String(choices.length)) { finish(choices[Number(character) - 1]); return; }
        if (character === "\r" || character === "\n") { finish(choices[selected]); return; }
      }
    };
    process.once("SIGINT", cancelOnSignal);
    input.on("data", receive);
    output.write(`${question}\n`);
    draw();
  });
}

function paintForTerminal(value: string, code: string, output: NodeJS.WriteStream): string {
  return colorsEnabled(Boolean(output.isTTY)) ? `\u001b[${code}m${value}\u001b[0m` : value;
}

export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  output: NodeJS.WriteStream,
): Promise<T> {
  if (!output.isTTY || process.env.TERM === "dumb") return task();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  output.write(`${frames[frame]} ${label}`);
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    output.write(`\r${frames[frame]} ${label}`);
  }, 100);
  try {
    const result = await task();
    clearInterval(timer);
    output.write(`\r\u001b[2K${paintForTerminal(`✓ ${label} complete`, "32", output)}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    output.write(`\r\u001b[2K${paintForTerminal(`✗ ${label} failed`, "31", output)}\n`);
    throw error;
  }
}
