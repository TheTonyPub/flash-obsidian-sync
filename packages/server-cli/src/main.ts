import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runBackupCommand, runBootstrap, runImportCommand, runLifecycleCommand, runVaultCommand, type HostAdapter } from "./cli.js";
import { createLocalBackupAdapter } from "./backup.js";
import { createLocalCredentialStore, createLocalOwnedStateAdapter, localPathExists, readLocalPlatform, readLocalProtectedInput } from "./host.js";
import { buildImportHandoff } from "./handoff-builder.js";
import { readOwnedStatus } from "./state.js";
import { createBootstrapApply, createLocalLifecycleAdapters, createLocalRuntime, createSecretOutputAdapter, createVaultAdminAdapter, createVaultUserAdapter, createVaultVerificationAdapter } from "./host-deployment.js";
import { colorsEnabled, formatChoicePrompt, formatCliHelp, formatFailure, formatHandoffOutput, formatHumanOutput, formatPreview, formatVaultResult, helpTopicForArgs, renderHandoffQr, selectTerminal, withSpinner } from "./ui.js";

const interactive = Boolean(stdin.isTTY);
const useColor = colorsEnabled(Boolean(interactive && stdout.isTTY));
const paint = (value: string, code: string): string => useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
let interruptHandled = false;
process.on("SIGINT", () => {
  interruptHandled = true;
  try { if (stdin.isTTY && stdin.isRaw) stdin.setRawMode(false); }
  catch { /* The terminal may already have left raw mode. */ }
  stdin.pause();
  stdout.write(`${formatFailure("INPUT_CANCELLED", useColor, Boolean(interactive && stdout.isTTY))}\n`, () => process.exit(130));
});

const host: HostAdapter = {
  platform: readLocalPlatform,
  readProtectedInput: readLocalProtectedInput,
  pathExists: localPathExists,
};

const prompt = async (question: string): Promise<string> => {
  if (!stdin.isTTY && process.argv[2] === "plan") throw new Error("PLAN_INPUT_REQUIRED");
  if (interactive && /Installation mode/.test(question)) {
    const choices = ["native", "docker", "podman"] as const;
    if (stdout.isTTY && process.env.TERM !== "dumb") {
      return selectTerminal(paint("Choose installation mode", "1;36"), choices, stdin, stdout);
    }
    while (true) {
      const answer = (await ask(formatChoicePrompt("Choose installation mode", choices))).trim().toLowerCase();
      const selected = choices.find((choice) => choice === answer) ?? choices[Number(answer) - 1];
      if (selected) return selected;
      stdout.write("Enter 1, 2, or 3.\n");
    }
  }
  if (interactive && /\(yes\/no\)/i.test(question)) {
    while (true) {
      const answer = (await ask(`${paint(question.replace(/\s*\(yes\/no\)\s*$/, ""), "36")} [y/n]: `)).trim().toLowerCase();
      if (["yes", "y"].includes(answer)) return "yes";
      if (["no", "n"].includes(answer)) return "no";
      stdout.write(`${paint("Enter y or n.", "31")}\n`);
    }
  }
  return ask(interactive ? paint(question, "36") : question);
};

const ask = async (question: string): Promise<string> => {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        reject(new Error("INPUT_CANCELLED"));
      };
      terminal.once("SIGINT", cancel);
      terminal.once("close", cancel);
      terminal.question(question).then((answer) => {
        if (settled) return;
        settled = true;
        terminal.off("SIGINT", cancel);
        terminal.off("close", cancel);
        resolve(answer);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        terminal.off("SIGINT", cancel);
        terminal.off("close", cancel);
        reject(error);
      });
    });
  } finally { terminal.close(); }
};

const runtime = createLocalRuntime();
const lifecycle = createLocalLifecycleAdapters(runtime, createLocalOwnedStateAdapter());
const credentialStore = createLocalCredentialStore();
const protectedHandoffOutput = process.argv.slice(2).some((arg) => arg === "--secrets-output" || arg.startsWith("--secrets-output="));
const renderHandoff = (config: Parameters<typeof buildImportHandoff>[0]) => buildImportHandoff(config, {
  renderQr: (uri) => renderHandoffQr(uri, Boolean(stdout.isTTY && useColor), protectedHandoffOutput),
});
const discloseHandoff = stdin.isTTY
  ? (contents: string): void => { stdout.write(`${formatHandoffOutput(contents, useColor)}\n`); }
  : undefined;

const promptSecret = async (question: string): Promise<string> => {
  if (!stdin.isTTY) throw new Error("ADMIN_INPUT_REQUIRED");
  stdout.write(question);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (): void => { stdin.off("data", receive); stdin.setRawMode(false); stdin.pause(); stdout.write("\n"); };
    const receive = (chunk: Buffer) => {
      const character = chunk.toString("utf8");
      if (character === "\r" || character === "\n") {
        finish(); resolve(value); return;
      }
      if (character === "\u0003") { finish(); reject(new Error("INPUT_CANCELLED")); return; }
      if (character === "\u007f") { value = value.slice(0, -1); return; }
      value += character;
    };
    stdin.on("data", receive);
  });
};

const cliArgs = process.argv.slice(2);
const helpTopic = helpTopicForArgs(cliArgs);
if (helpTopic) {
  stdout.write(`${formatCliHelp(helpTopic, Boolean(stdout.isTTY && useColor))}\n`);
} else if (process.argv[2] === "backup" || process.argv[2] === "restore-check") {
  runBackupCommand(process.argv.slice(2), { isRoot: () => process.getuid?.() === 0, adapter: createLocalBackupAdapter() }).then((result) => {
    const text = `fos: backup artifact: ${result.artifact}${result.restored ? "\nrestore verified" : ""}`;
    stdout.write(`${stdout.isTTY ? formatHumanOutput(text, useColor) : text}\n`);
  }).catch((error: unknown) => { stdout.write(`${formatFailure(error instanceof Error ? error.message : String(error), useColor, Boolean(stdout.isTTY))}\n`); process.exitCode = 1; });
} else if (process.argv[2] === "upgrade" || process.argv[2] === "uninstall") {
  runLifecycleCommand(process.argv.slice(2), { ...lifecycle, isRoot: () => process.getuid?.() === 0 }).then((result) => {
    stdout.write(`${stdout.isTTY ? formatHumanOutput(result, useColor) : result}\n`);
  }).catch((error: unknown) => {
    stdout.write(`${formatFailure(error instanceof Error ? error.message : String(error), useColor, Boolean(stdout.isTTY))}\n`);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "vault") {
  const vaultArgs = process.argv.slice(3).filter((arg) => arg !== "--json");
  runVaultCommand(vaultArgs, {
    host,
    resolveMode: async () => {
      const state = await createLocalOwnedStateAdapter();
      const status = await readOwnedStatus(state);
      return status.kind === "MANAGED" ? status.mode : undefined;
    },
    createAdapter: (plan) => createVaultUserAdapter(runtime, plan),
    createAdminAdapter: (plan, administrator) => createVaultAdminAdapter(runtime, plan, administrator),
    createVerificationAdapter: (plan, credentials, crossVaultId) => createVaultVerificationAdapter(runtime, plan, credentials, crossVaultId),
    secretOutput: createSecretOutputAdapter(runtime),
    discloseInteractiveSecrets: discloseHandoff,
    promptSecret,
    promptEndpoint: () => prompt("WSS endpoint: "),
    promptEncryptionPhrase: () => promptSecret("Optional QR encryption phrase (Enter for plaintext): "),
    credentialStore,
    renderHandoff,
    unattended: !stdin.isTTY,
  }).then((result) => {
    const json = process.argv.slice(3).includes("--json") || !stdout.isTTY;
    if (json && result !== undefined) stdout.write(`${JSON.stringify(result)}\n`);
    else if (result !== undefined) stdout.write(`${formatVaultResult(result, useColor)}\n`);
    else if (vaultArgs[0] === "revoke" && stdout.isTTY) stdout.write(`${paint("Vault user revoked.", "32")}\n`);
  }).catch((error: unknown) => {
    stdout.write(`${formatFailure(error instanceof Error ? error.message : String(error), useColor, Boolean(stdout.isTTY))}\n`);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "import") {
  runImportCommand(process.argv.slice(2), {
    credentialStore,
    renderHandoff,
    promptEndpoint: () => prompt("WSS endpoint: "),
    promptEncryptionPhrase: () => promptSecret("Optional QR encryption phrase (Enter for plaintext): "),
    discloseInteractiveSecrets: discloseHandoff,
    secretOutput: createSecretOutputAdapter(runtime),
    unattended: !stdin.isTTY,
  }).catch((error: unknown) => {
    stdout.write(`${formatFailure(error instanceof Error ? error.message : String(error), useColor, Boolean(stdout.isTTY))}\n`);
    process.exitCode = 1;
  });
} else {

if (interactive && stdout.isTTY && process.argv[2] === "bootstrap") stdout.write(`${paint("◆ fos", "1;36")} ${paint("server bootstrap", "2")}\n\n`);
const applyBootstrap = createBootstrapApply(runtime);
let previewShown = false;

runBootstrap(process.argv.slice(2), {
  host,
  state: createLocalOwnedStateAdapter(),
  apply: async (plan, credentials) => {
    if (!interactive) return applyBootstrap(plan, credentials);
    return withSpinner("Applying bootstrap plan", () => applyBootstrap(plan, credentials), stdout);
  },
  secretOutput: createSecretOutputAdapter(runtime),
  discloseInteractiveSecrets: discloseHandoff,
  credentialStore,
  renderHandoff,
  promptEncryptionPhrase: () => promptSecret("Optional QR encryption phrase (Enter for plaintext): "),
  prompt,
  showPreview: (preview) => {
    if (process.argv[2] === "status" || process.argv[2] === "plan") return;
    previewShown = true;
    stdout.write(`${interactive && stdout.isTTY ? formatPreview(preview, useColor) : preview}\n`);
  },
}).then((result) => {
  if (process.argv[2] === "status" || process.argv[2] === "plan" || !previewShown && !stdin.isTTY) {
    stdout.write(`${interactive && stdout.isTTY ? formatPreview(result.preview, useColor) : result.preview}\n`);
  }
  if (process.argv[2] !== "status" && !result.applied) stdout.write(`${interactive && stdout.isTTY ? paint("Plan not applied.", "2") : "Plan not applied."}\n`);
  else if (interactive && stdout.isTTY && result.applied) stdout.write(`${paint("Bootstrap complete.", "32")}\n`);
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!interruptHandled) stdout.write(`${formatFailure(message, useColor, Boolean(interactive && stdout.isTTY))}\n`);
  process.exitCode = 1;
});
}
