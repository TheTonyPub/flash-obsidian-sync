import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import QRCode from "qrcode";
import { cliHelp, runBackupCommand, runBootstrap, runImportCommand, runLifecycleCommand, runVaultCommand, type HostAdapter } from "./cli.js";
import { createLocalBackupAdapter } from "./backup.js";
import { createLocalCredentialStore, createLocalOwnedStateAdapter, localPathExists, readLocalPlatform, readLocalProtectedInput } from "./host.js";
import { buildImportHandoff } from "./handoff-builder.js";
import { createBootstrapApply, createLocalLifecycleAdapters, createLocalRuntime, createSecretOutputAdapter, createVaultAdminAdapter, createVaultUserAdapter, createVaultVerificationAdapter } from "./host-deployment.js";

const host: HostAdapter = {
  platform: readLocalPlatform,
  readProtectedInput: readLocalProtectedInput,
  pathExists: localPathExists,
};

const prompt = async (question: string): Promise<string> => {
  const terminal = createInterface({ input: stdin, output: stdout });
  try { return await terminal.question(question); }
  finally { terminal.close(); }
};

const runtime = createLocalRuntime();
const lifecycle = createLocalLifecycleAdapters(runtime, createLocalOwnedStateAdapter());
const credentialStore = createLocalCredentialStore();
const renderHandoff = (config: Parameters<typeof buildImportHandoff>[0]) => buildImportHandoff(config, {
  renderQr: (uri) => QRCode.toString(uri, { type: "terminal", errorCorrectionLevel: "M" }),
});

const promptSecret = async (question: string): Promise<string> => {
  if (!stdin.isTTY) throw new Error("ADMIN_INPUT_REQUIRED");
  stdout.write(question);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (): void => { stdin.off("data", receive); stdin.setRawMode(false); stdout.write("\n"); };
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

if (process.argv[2] === "--help" || process.argv[2] === "help") {
  stdout.write(`${cliHelp()}\n`);
} else if (process.argv[2] === "backup" || process.argv[2] === "restore-check") {
  runBackupCommand(process.argv.slice(2), { isRoot: () => process.getuid?.() === 0, adapter: createLocalBackupAdapter() }).then((result) => {
    stdout.write(`fos: backup ${result.artifact}${result.restored ? " restore verified" : ""}\n`);
  }).catch((error: unknown) => { stdout.write(`fos: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
} else if (process.argv[2] === "upgrade" || process.argv[2] === "uninstall") {
  runLifecycleCommand(process.argv.slice(2), { ...lifecycle, isRoot: () => process.getuid?.() === 0 }).then((result) => {
    stdout.write(`${result}\n`);
  }).catch((error: unknown) => {
    stdout.write(`fos: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "vault") {
  runVaultCommand(process.argv.slice(3), {
    host,
    createAdapter: (plan) => createVaultUserAdapter(runtime, plan),
    createAdminAdapter: (plan, administrator) => createVaultAdminAdapter(runtime, plan, administrator),
    createVerificationAdapter: (plan, credentials, crossVaultId) => createVaultVerificationAdapter(runtime, plan, credentials, crossVaultId),
    secretOutput: createSecretOutputAdapter(runtime),
    discloseInteractiveSecrets: stdin.isTTY ? (contents) => { stdout.write(`${contents}\n`); } : undefined,
    promptSecret,
    promptEndpoint: () => prompt("WSS endpoint: "),
    promptEncryptionPhrase: () => promptSecret("Optional QR encryption phrase (Enter for plaintext): "),
    credentialStore,
    renderHandoff,
    unattended: !stdin.isTTY,
  }).then((result) => {
    if (result !== undefined) stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    stdout.write(`fos: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "import") {
  runImportCommand(process.argv.slice(2), {
    credentialStore,
    renderHandoff,
    promptEndpoint: () => prompt("WSS endpoint: "),
    promptEncryptionPhrase: () => promptSecret("Optional QR encryption phrase (Enter for plaintext): "),
    discloseInteractiveSecrets: stdin.isTTY ? (contents) => { stdout.write(`${contents}\n`); } : undefined,
    secretOutput: createSecretOutputAdapter(runtime),
    unattended: !stdin.isTTY,
  }).catch((error: unknown) => {
    stdout.write(`fos: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {

runBootstrap(process.argv.slice(2), {
  host,
  state: createLocalOwnedStateAdapter(),
  apply: createBootstrapApply(runtime),
  secretOutput: createSecretOutputAdapter(runtime),
  discloseInteractiveSecrets: stdin.isTTY ? (contents) => { stdout.write(`${contents}\n`); } : undefined,
  credentialStore,
  renderHandoff,
  promptEncryptionPhrase: () => promptSecret("Optional QR encryption phrase (Enter for plaintext): "),
  prompt,
  showPreview: (preview) => { stdout.write(`${preview}\n`); },
}).then((result) => {
  if (process.argv[2] === "status" || !stdin.isTTY || process.argv[2] === "plan") stdout.write(`${result.preview}\n`);
  if (process.argv[2] !== "status" && !result.applied) stdout.write("Plan not applied.\n");
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stdout.write(`fos: ${message}\n`);
  process.exitCode = 1;
});
}
