import { commitOwnedState, prepareOwnedState, readOwnedStatus, type OwnedStateAdapter, type OwnedStatus, type StateReconciliation } from "./state.js";
import { createCredentialHandoff, generateBootstrapCredentials, type BootstrapCredentials, type SecretOutputAdapter } from "./credentials.js";
import { addVaultUser, revokeVaultUser, rotateVaultUser, type VaultUserAdapter } from "./vault-users.js";
import { createVault, inspectVault, listVaults, type VaultAdminAdapter, type VaultBucket, type VaultCreateResult } from "./vault-admin.js";
import { verifyVault, type VaultVerificationAdapter } from "./vault-verify.js";
import { planHostOptions, type HostOptions } from "./host-options.js";
import { planBackupSchedule, restoreCheck, runBackup, type BackupAdapter, type BackupSchedule } from "./backup.js";
import { previewLifecycle, runLifecycle, type LifecycleAdapter } from "./lifecycle.js";
import { previewUpgrade, runUpgrade, type UpgradeAdapter } from "./upgrade.js";
import { type HandoffConfig, type HandoffResult } from "./handoff-builder.js";
import type { CredentialRecord, CredentialStore } from "./credential-store.js";

export type InstallMode = "native" | "docker" | "podman";

export interface HostPlatform {
  distribution: string;
  release: string;
  architecture: string;
}

export interface HostAdapter {
  platform(): HostPlatform | Promise<HostPlatform>;
  readProtectedInput?(path: string): Promise<{ content: string; mode: number; uid: number }>;
  pathExists?(path: string): Promise<boolean>;
}

export interface BootstrapRequest {
  command: "bootstrap" | "plan" | "status";
  mode?: InstallMode;
  domain?: string;
  email?: string;
  vaultId?: string;
  host?: string;
  nonInteractive: boolean;
  input?: string;
  secretsOutput?: string;
  approve: boolean;
  manageFirewall: boolean;
  dedicatedServiceAccounts: boolean;
  backupDestination?: string;
  backupRetention?: number;
  wssEndpoint?: string;
  keep: boolean;
}

export interface BootstrapPlan {
  mode: InstallMode;
  domain: string;
  email?: string;
  vaultId: string;
  installPath: "/etc/flash-osidian-sync" | "/opt/flash-osidian-sync";
  dataPath: "/var/lib/flash-osidian-sync";
  logPath: "/var/log/flash-osidian-sync";
  systemdServices: readonly ["fos-nats", "fos-caddy"];
  composeProject?: "flash-osidian-sync";
  preview: string;
  hostOptions?: HostOptions;
  backupSchedule?: BackupSchedule;
}

export interface RunBootstrapOptions {
  host: HostAdapter;
  prompt?: (question: string) => Promise<string>;
  showPreview?: (preview: string) => Promise<void> | void;
  state?: OwnedStateAdapter;
  apply?: (plan: BootstrapPlan, credentials: BootstrapCredentials) => Promise<void> | void;
  secretOutput?: SecretOutputAdapter;
  discloseInteractiveSecrets?: (contents: string) => Promise<void> | void;
  credentialStore?: Partial<CredentialStore>;
  renderHandoff?: (config: HandoffConfig) => Promise<HandoffResult>;
  promptEncryptionPhrase?: () => Promise<string>;
}

export interface BootstrapResult {
  preview: string;
  applied: boolean;
  state?: StateReconciliation;
  status?: OwnedStatus;
}

type VaultAction = "add" | "rotate" | "revoke" | "create" | "list" | "inspect" | "verify";

export interface RunVaultCommandOptions {
  host: HostAdapter;
  createAdapter(plan: BootstrapPlan): VaultUserAdapter;
  createAdminAdapter?(plan: BootstrapPlan, administrator: { username: string; password: string }): VaultAdminAdapter;
  createVerificationAdapter?(plan: BootstrapPlan, credentials: { username: string; password: string }, crossVaultId?: string): VaultVerificationAdapter;
  secretOutput?: SecretOutputAdapter;
  discloseInteractiveSecrets?: (contents: string) => Promise<void> | void;
  promptSecret?: (question: string) => Promise<string>;
  promptEndpoint?: () => Promise<string>;
  credentialStore?: Partial<CredentialStore>;
  renderHandoff?: (config: HandoffConfig) => Promise<HandoffResult>;
  promptEncryptionPhrase?: () => Promise<string>;
  unattended?: boolean;
}

export interface RunImportCommandOptions {
  credentialStore: Partial<CredentialStore>;
  renderHandoff: (config: HandoffConfig) => Promise<HandoffResult>;
  promptEndpoint?: () => Promise<string>;
  promptEncryptionPhrase?: () => Promise<string>;
  discloseInteractiveSecrets?: (contents: string) => Promise<void> | void;
  secretOutput?: SecretOutputAdapter;
  unattended?: boolean;
}

export type VaultCommandResult = VaultCreateResult | readonly VaultBucket[] | VaultBucket | { verified: true; ownBucket: true; crossBucket: "not-tested" | "denied" } | undefined;

export interface RunBackupCommandOptions {
  isRoot(): boolean;
  adapter: BackupAdapter;
  restoreTarget?: (destination: string) => string;
}

export interface RunLifecycleCommandOptions {
  lifecycle: LifecycleAdapter;
  upgrade: UpgradeAdapter;
  isRoot(): boolean;
}

const supportedPlatforms: Record<string, readonly string[]> = {
  debian: ["13"],
  ubuntu: ["24.04", "26.04"],
};
const domainPattern = /^(?=.{1,253}$)(?=.{1,63}(?:\.|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const vaultPattern = /^[A-Za-z0-9_-]+$/;
const legacyManagedPaths = [
  "/etc/easy-sync-server",
  "/opt/easy-sync-server",
  "/var/lib/easy-sync-server",
  "/var/log/easy-sync-server",
] as const;

function failure(code: string): Error {
  return new Error(code);
}

export function cliHelp(): string {
  return [
    "fos - self-hosted flash-sync server administration",
    "",
    "Bootstrap: fos bootstrap [--mode native|docker|podman] [--domain DOMAIN] [--vault-id ID] [--wss-endpoint wss://HOST] [--keep]",
    "Vault users: fos vault add|rotate --mode MODE --vault-id ID [--wss-endpoint wss://HOST] [--keep]",
    "Vault revoke: fos vault revoke --mode MODE --vault-id ID",
    "Regenerate a retained vault handoff: fos import --vault-id ID [--wss-endpoint wss://HOST] [--secrets-output PATH]",
    "",
    "Handoff endpoint order is --wss-endpoint, then the managed bootstrap endpoint. Interactive commands prompt if needed; unattended commands require an endpoint and --secrets-output.",
    "--keep retains only the generated vault credential for later fos import. Bootstrap always retains its administrator credential. Do not use administrator credentials in Obsidian.",
    "An empty phrase creates explicit plaintext version 2. An optional interactive phrase of at least 8 characters creates encrypted version 1. QR codes and import links contain vault credentials; keep them private.",
  ].join("\n");
}

function value(args: string[], index: number, option: string): string {
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw failure(`VALUE_REQUIRED:${option}`);
  return next;
}

export function parseBootstrapRequest(args: string[], host?: HostAdapter): BootstrapRequest {
  void host;
  const command = args[0] === "status" ? "status" : args[0] === "plan" ? "plan" : args[0] === "bootstrap" ? "bootstrap" : undefined;
  if (!command) throw failure("COMMAND_REQUIRED");
  const request: BootstrapRequest = { command, nonInteractive: false, approve: false, manageFirewall: false, dedicatedServiceAccounts: false, keep: false };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    switch (option) {
      case "--mode": {
        const mode = value(args, index, option);
        if (mode !== "native" && mode !== "docker" && mode !== "podman") throw failure("INVALID_MODE");
        request.mode = mode; index += 1; break;
      }
      case "--domain": request.domain = value(args, index, option); index += 1; break;
      case "--email": request.email = value(args, index, option); index += 1; break;
      case "--vault-id": request.vaultId = value(args, index, option); index += 1; break;
      case "--host": request.host = value(args, index, option); index += 1; break;
      case "--input": request.input = value(args, index, option); index += 1; break;
      case "--secrets-output": request.secretsOutput = value(args, index, option); index += 1; break;
      case "--non-interactive": request.nonInteractive = true; break;
      case "--approve": request.approve = true; break;
      case "--manage-firewall": request.manageFirewall = true; break;
      case "--dedicated-service-accounts": request.dedicatedServiceAccounts = true; break;
      case "--backup-destination": request.backupDestination = value(args, index, option); index += 1; break;
      case "--backup-retention": request.backupRetention = Number(value(args, index, option)); index += 1; break;
      case "--wss-endpoint": request.wssEndpoint = validateEndpoint(value(args, index, option)); index += 1; break;
      case "--keep": request.keep = true; break;
      default: throw failure(`UNKNOWN_OPTION:${option}`);
    }
  }
  return request;
}

function validateEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "wss:" || !parsed.hostname) throw new Error();
    return parsed.toString().replace(/\/$/, "");
  } catch { throw failure("WSS_ENDPOINT_REQUIRED"); }
}

const credentialRoot = "/var/lib/flash-osidian-sync/credentials";
const writeOptions = { owner: 0, mode: 0o600 } as const;

function administratorRecord(endpoint: string, credentials: { username: string; password: string }): CredentialRecord {
  return { kind: "administrator", username: credentials.username, password: credentials.password, endpoint };
}

function vaultRecord(endpoint: string, vaultId: string, credentials: { username: string; password: string }): CredentialRecord {
  return { kind: "vault", vaultId, username: credentials.username, password: credentials.password, endpoint };
}

async function writeAdministrator(store: Partial<CredentialStore> | undefined, endpoint: string, credentials: { username: string; password: string }): Promise<void> {
  if (!store?.writeAdministrator) return;
  try { await store.writeAdministrator(store.administratorPath ?? `${credentialRoot}/administrator.json`, administratorRecord(endpoint, credentials), writeOptions); }
  catch { throw failure("Credential store write failed"); }
}

async function writeVault(store: Partial<CredentialStore> | undefined, endpoint: string, vaultId: string, credentials: { username: string; password: string }): Promise<void> {
  if (!store?.writeVault) return;
  try { await store.writeVault(store.vaultPath?.(vaultId) ?? `${credentialRoot}/vaults/${vaultId}.json`, vaultRecord(endpoint, vaultId, credentials), writeOptions); }
  catch { throw failure("Credential store write failed"); }
}

async function removeVault(store: Partial<CredentialStore> | undefined, vaultId: string): Promise<void> {
  if (!store?.removeVault) return;
  try { await store.removeVault(vaultId); }
  catch { throw failure("CREDENTIAL_STORE_REMOVE_FAILED"); }
}

function validateUnattended(request: BootstrapRequest): void {
  if (!request.nonInteractive) return;
  if (!request.input) throw failure("NONINTERACTIVE_INPUT_REQUIRED");
  if (!request.secretsOutput) throw failure("NONINTERACTIVE_SECRETS_OUTPUT_REQUIRED");
  if (!request.approve) throw failure("CONFIRMATION_REQUIRED");
}

async function collectUnattended(request: BootstrapRequest, host: HostAdapter): Promise<BootstrapRequest> {
  if (!request.input || !host.readProtectedInput) throw failure("PROTECTED_INPUT_READER_REQUIRED");
  const input = await host.readProtectedInput(request.input);
  if (input.uid !== 0 || (input.mode & 0o077) !== 0) throw failure("UNPROTECTED_INPUT");
  let values: unknown;
  try { values = JSON.parse(input.content); }
  catch { throw failure("INVALID_NONINTERACTIVE_INPUT"); }
  if (!values || typeof values !== "object" || Array.isArray(values)) throw failure("INVALID_NONINTERACTIVE_INPUT");
  const data = values as Record<string, unknown>;
  if (typeof data.mode !== "string" || typeof data.domain !== "string" || typeof data.vaultId !== "string"
    || (data.email !== undefined && typeof data.email !== "string")) throw failure("INVALID_NONINTERACTIVE_INPUT");
  if (data.manageFirewall !== undefined && typeof data.manageFirewall !== "boolean") throw failure("INVALID_NONINTERACTIVE_INPUT");
  if (data.dedicatedServiceAccounts !== undefined && typeof data.dedicatedServiceAccounts !== "boolean") throw failure("INVALID_NONINTERACTIVE_INPUT");
  if (data.backupDestination !== undefined && typeof data.backupDestination !== "string") throw failure("INVALID_NONINTERACTIVE_INPUT");
  if (data.backupRetention !== undefined && typeof data.backupRetention !== "number") throw failure("INVALID_NONINTERACTIVE_INPUT");
  return { ...request, mode: data.mode as InstallMode, domain: data.domain, email: data.email as string | undefined, vaultId: data.vaultId,
    manageFirewall: data.manageFirewall ?? request.manageFirewall, dedicatedServiceAccounts: data.dedicatedServiceAccounts ?? request.dedicatedServiceAccounts,
    backupDestination: data.backupDestination as string | undefined ?? request.backupDestination, backupRetention: data.backupRetention as number | undefined ?? request.backupRetention };
}

export async function buildBootstrapPlan(request: BootstrapRequest, host: HostAdapter): Promise<BootstrapPlan> {
  const platform = await host.platform();
  if (platform.architecture !== "amd64" || !supportedPlatforms[platform.distribution]?.includes(platform.release)) {
    throw failure("UNSUPPORTED_PLATFORM");
  }
  if (!request.domain || !domainPattern.test(request.domain)) throw failure("DOMAIN_REQUIRED");
  if (!request.vaultId || !vaultPattern.test(request.vaultId)) throw failure("VAULT_ID_REQUIRED");
  if (!request.mode || !["native", "docker", "podman"].includes(request.mode)) throw failure("MODE_REQUIRED");
  if (host.pathExists && (await Promise.all(legacyManagedPaths.map((path) => host.pathExists!(path)))).some(Boolean)) {
    throw failure("LEGACY_MANAGED_PATH_EXISTS");
  }
  const installPath = request.mode === "native" ? "/etc/flash-osidian-sync" as const : "/opt/flash-osidian-sync" as const;
  const dataPath = "/var/lib/flash-osidian-sync" as const;
  const logPath = "/var/log/flash-osidian-sync" as const;
  const systemdServices = ["fos-nats", "fos-caddy"] as const;
  const composeProject = request.mode === "native" ? undefined : "flash-osidian-sync" as const;
  const hostOptions = planHostOptions({ firewall: { enabled: request.manageFirewall, confirmed: request.manageFirewall },
    identity: request.dedicatedServiceAccounts ? { kind: "dedicated", confirmed: true } : { kind: "existing", user: "fos-nats", group: "fos-nats" } });
  const backupSchedule = request.backupDestination ? planBackupSchedule({ enabled: true, destination: request.backupDestination,
    retention: request.backupRetention ?? 7, interval: "daily" }) : undefined;
  const preview = [
    "fos bootstrap plan",
    `mode: ${request.mode}`,
    `domain: ${request.domain}`,
    `vault: ${request.vaultId}`,
    `install path: ${installPath}`,
    `data path: ${dataPath}`,
    `log path: ${logPath}`,
    `systemd services: ${systemdServices.join(", ")}`,
    ...(composeProject ? [`compose project: ${composeProject}`] : []),
    `firewall management: ${request.manageFirewall ? "selected" : "manual"}`,
    `dedicated service accounts: ${request.dedicatedServiceAccounts ? "selected" : "required existing accounts"}`,
    ...(backupSchedule ? [`backup schedule: daily to ${backupSchedule.destination}, retention ${backupSchedule.retention}`] : ["backup schedule: not selected"]),
    "credentials: generated during apply and delivered only through the protected handoff",
  ].join("\n");
  return { mode: request.mode, domain: request.domain, email: request.email, vaultId: request.vaultId,
    installPath, dataPath, logPath, systemdServices, composeProject, preview, hostOptions, backupSchedule };
}

async function collectInteractive(request: BootstrapRequest, prompt: NonNullable<RunBootstrapOptions["prompt"]>): Promise<BootstrapRequest> {
  const yes = async (question: string) => (await prompt(question)).trim().toLowerCase() === "yes";
  return {
    ...request,
    mode: request.mode ?? (await prompt("Installation mode (native, docker, podman): ")).trim() as InstallMode,
    domain: request.domain ?? (await prompt("Endpoint domain: ")).trim(),
    email: request.email ?? (await prompt("ACME email: ")).trim(),
    vaultId: request.vaultId ?? (await prompt("Initial vault ID: ")).trim(),
    manageFirewall: request.manageFirewall || await yes("Manage UFW firewall rules? (yes/no): "),
    dedicatedServiceAccounts: request.dedicatedServiceAccounts || await yes("Create dedicated fos service accounts? (yes/no): "),
  };
}

async function managedEndpoint(store: Partial<CredentialStore> | undefined): Promise<string | undefined> {
  if (!store?.readAdministrator) return undefined;
  const record = await store.readAdministrator();
  return record?.endpoint ? validateEndpoint(record.endpoint) : undefined;
}

async function resolveVaultEndpoint(
  explicit: string | undefined,
  options: RunVaultCommandOptions,
): Promise<string> {
  if (explicit) return validateEndpoint(explicit);
  const managed = await managedEndpoint(options.credentialStore);
  if (managed) return managed;
  if (options.unattended) throw failure("WSS_ENDPOINT_REQUIRED");
  if (!options.promptEndpoint) throw failure("WSS_ENDPOINT_REQUIRED");
  return validateEndpoint(await options.promptEndpoint());
}

async function renderVaultHandoff(
  config: HandoffConfig,
  render: ((config: HandoffConfig) => Promise<HandoffResult>) | undefined,
): Promise<HandoffResult> {
  if (!render) return { uri: "", qr: "" };
  return render(config);
}

async function handoffPhrase(prompt: (() => Promise<string>) | undefined, unattended: boolean): Promise<string> {
  if (unattended || !prompt) return "";
  const phrase = await prompt();
  if (phrase !== "" && phrase.length < 8) throw failure("CODE_PHRASE_MINIMUM_8");
  return phrase;
}

function vaultHandoffContents(username: string, password: string, handoff: HandoffResult): string {
  return `${vaultSecretHandoff(username, password)}${handoff.uri ? `Obsidian import URI: ${handoff.uri}\n${handoff.qr}\n` : ""}`;
}

export async function runBootstrap(args: string[], options: RunBootstrapOptions): Promise<BootstrapResult> {
  let request = parseBootstrapRequest(args, options.host);
  if (request.host) throw failure("REMOTE_TARGET_UNSUPPORTED");
  if (request.command === "status") {
    if (!options.state) throw failure("STATUS_ADAPTER_REQUIRED");
    const status = await readOwnedStatus(options.state);
    return { preview: status.diagnostic, applied: false, status };
  }
  validateUnattended(request);
  if (request.nonInteractive) {
    request = await collectUnattended(request, options.host);
  } else {
    if (!options.prompt) throw failure("INTERACTIVE_PROMPT_REQUIRED");
    request = await collectInteractive(request, options.prompt);
  }
  const plan = await buildBootstrapPlan(request, options.host);
  if (request.command === "plan") return { preview: plan.preview, applied: false };
  if (!request.nonInteractive) {
    await options.showPreview?.(plan.preview);
    request.approve = (await options.prompt!("Apply this plan? (yes/no): ")).trim().toLowerCase() === "yes";
  }
  if (!request.approve) return { preview: plan.preview, applied: false };
  if (!options.apply) throw failure("APPLY_ADAPTER_REQUIRED");
  if (!options.state) throw failure("STATE_ADAPTER_REQUIRED");
  if (request.nonInteractive && !options.secretOutput) throw failure("SECRETS_OUTPUT_ADAPTER_REQUIRED");
  if (!request.nonInteractive && !options.discloseInteractiveSecrets) throw failure("INTERACTIVE_SECRETS_OUTPUT_REQUIRED");
  const endpoint = request.wssEndpoint ?? validateEndpoint(`wss://${plan.domain}`);
  const encryptionPhrase = await handoffPhrase(options.promptEncryptionPhrase, request.nonInteractive);
  const prepared = await prepareOwnedState(plan, options.state);
  if (!prepared.changed) throw failure("CREDENTIAL_RECOVERY_UNAVAILABLE");
  const credentials = generateBootstrapCredentials(plan.vaultId);
  await options.apply(plan, credentials);
  const handoff = createCredentialHandoff(credentials);
  const disclose = async (rendered?: HandoffResult): Promise<void> => {
    const append = (contents: string) => `${contents}${rendered?.uri ? `Obsidian import URI: ${rendered.uri}\n${rendered.qr}\n` : ""}`;
    if (request.nonInteractive) await handoff.writeUnattended(request.secretsOutput!, {
      writeFileAtomically: (path, contents, options_) => options.secretOutput!.writeFileAtomically(path, append(contents), options_),
    });
    else await handoff.discloseInteractive((contents) => options.discloseInteractiveSecrets!(append(contents)));
  };

  let state: StateReconciliation;
  try { state = await commitOwnedState(prepared, options.state); }
  catch {
    try { await disclose(); }
    catch { /* State commit remains the reported failure after best-effort recovery disclosure. */ }
    throw failure("Managed state commit failed");
  }

  try {
    await writeAdministrator(options.credentialStore, endpoint, credentials.administrator);
    if (request.keep) await writeVault(options.credentialStore, endpoint, plan.vaultId, credentials.vault);
  } catch {
    try { await disclose(); }
    catch { /* The original persistence failure remains the actionable outcome. */ }
    throw failure("Credential store write failed");
  }

  let rendered: HandoffResult;
  try {
    rendered = await renderVaultHandoff({
      vaultId: plan.vaultId, server: endpoint, username: credentials.vault.username, password: credentials.vault.password,
      s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1", s3AccessKeyId: "", s3SecretKey: "", inlineLimit: 262144, encryptionPhrase,
    }, options.renderHandoff);
  } catch {
    try { await disclose(); }
    catch { /* Rendering remains the reported failure after best-effort recovery disclosure. */ }
    throw failure("Import handoff rendering failed");
  }
  await disclose(rendered);
  return { preview: plan.preview, applied: true, state };
}

function vaultOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : value(args, index, name);
}

function vaultAction(args: string[]): VaultAction {
  if (args[0] === "add" || args[0] === "rotate" || args[0] === "revoke" || args[0] === "create" || args[0] === "list" || args[0] === "inspect" || args[0] === "verify") return args[0];
  throw failure("VAULT_ACTION_REQUIRED");
}

function vaultPlan(mode: InstallMode, vaultId: string): BootstrapPlan {
  return {
    mode, domain: "localhost", vaultId,
    installPath: mode === "native" ? "/etc/flash-osidian-sync" : "/opt/flash-osidian-sync",
    dataPath: "/var/lib/flash-osidian-sync", logPath: "/var/log/flash-osidian-sync",
    systemdServices: ["fos-nats", "fos-caddy"],
    ...(mode === "native" ? {} : { composeProject: "flash-osidian-sync" }),
    preview: "",
    hostOptions: planHostOptions({ firewall: { enabled: false }, identity: { kind: "existing", user: "fos-nats", group: "fos-nats" } }),
  };
}

async function protectedSecret(options: RunVaultCommandOptions, path: string | undefined, prompt: string, code: string): Promise<string> {
  if (path) {
    if (!options.host.readProtectedInput) throw failure("PROTECTED_INPUT_READER_REQUIRED");
    const input = await options.host.readProtectedInput(path);
    if (input.uid !== 0 || (input.mode & 0o077) !== 0) throw failure(`UNPROTECTED_${code}_INPUT`);
    if (!input.content.trim()) throw failure(`${code}_INPUT_REQUIRED`);
    return input.content.trim();
  }
  if (!options.promptSecret) throw failure(`${code}_INPUT_REQUIRED`);
  const value = await options.promptSecret(prompt);
  if (!value) throw failure(`${code}_INPUT_REQUIRED`);
  return value;
}

function vaultSecretHandoff(username: string, password: string): string {
  return `Flash Osidian Sync vault credential (shown once)\nVault username: ${username}\nVault password: ${password}\nStore this password in Obsidian plugin settings.\n`;
}

function importHandoffContents(handoff: HandoffResult): string {
  return `Obsidian import URI: ${handoff.uri}\n${handoff.qr}\n`;
}

function importedVault(record: CredentialRecord | undefined, vaultId: string): CredentialRecord {
  if (!record || record.kind !== "vault" || record.vaultId !== vaultId || record.username !== `fos-vault-${vaultId}` || !record.password) {
    throw failure("VAULT_CREDENTIAL_UNAVAILABLE: rotate the vault credential and use --keep to enable import handoffs");
  }
  return record;
}

/** Regenerates a handoff from an explicitly retained local vault credential without contacting the server. */
export async function runImportCommand(args: string[], options: RunImportCommandOptions): Promise<void> {
  if (args[0] !== "import") throw failure("IMPORT_COMMAND_REQUIRED");
  let vaultId: string | undefined;
  let endpoint: string | undefined;
  let output: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--vault-id") { vaultId = value(args, index, option); index += 1; }
    else if (option === "--wss-endpoint") { endpoint = validateEndpoint(value(args, index, option)); index += 1; }
    else if (option === "--secrets-output") { output = value(args, index, option); index += 1; }
    else throw failure(`UNKNOWN_IMPORT_OPTION:${option}`);
  }
  if (!vaultId || !vaultPattern.test(vaultId)) throw failure("VAULT_ID_REQUIRED");
  if (options.unattended && (!output || !options.secretOutput)) throw failure("IMPORT_SECRETS_OUTPUT_REQUIRED");
  if (!options.unattended && !options.discloseInteractiveSecrets) throw failure("INTERACTIVE_SECRETS_OUTPUT_REQUIRED");
  if (!options.credentialStore.readVault) throw failure("VAULT_CREDENTIAL_UNAVAILABLE: rotate the vault credential and use --keep to enable import handoffs");
  const record = importedVault(await options.credentialStore.readVault(vaultId), vaultId);
  const resolvedEndpoint = endpoint
    ?? await managedEndpoint(options.credentialStore)
    ?? (record.endpoint ? validateEndpoint(record.endpoint) : undefined)
    ?? (options.unattended || !options.promptEndpoint ? undefined : validateEndpoint(await options.promptEndpoint()));
  if (!resolvedEndpoint) throw failure("WSS_ENDPOINT_REQUIRED");
  const encryptionPhrase = await handoffPhrase(options.promptEncryptionPhrase, !!options.unattended);
  const handoff = await options.renderHandoff({
    vaultId, server: resolvedEndpoint, username: record.username, password: record.password,
    s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1", s3AccessKeyId: "", s3SecretKey: "", inlineLimit: 262144, encryptionPhrase,
  });
  const contents = importHandoffContents(handoff);
  if (options.unattended) await options.secretOutput!.writeFileAtomically(output!, contents, writeOptions);
  else await options.discloseInteractiveSecrets!(contents);
}

/** Executes operator vault-user actions without ever accepting the administrator secret as an argument. */
export async function runVaultCommand(args: string[], options: RunVaultCommandOptions): Promise<VaultCommandResult> {
  const action = vaultAction(args);
  const mode = vaultOption(args, "--mode") as InstallMode | undefined;
  const vaultId = vaultOption(args, "--vault-id");
  const input = vaultOption(args, "--admin-input");
  const vaultInput = vaultOption(args, "--vault-input");
  const crossVaultId = vaultOption(args, "--cross-vault-id");
  const output = vaultOption(args, "--secrets-output");
  const endpointOption = vaultOption(args, "--wss-endpoint");
  const keep = args.includes("--keep");
  if (!mode || (action !== "list" && !vaultId)) throw failure("VAULT_ID_REQUIRED");
  if (mode !== "native" && mode !== "docker" && mode !== "podman") throw failure("INVALID_MODE");
  const plan = vaultPlan(mode, vaultId ?? "list");
  const handoffEndpoint = action === "add" || action === "rotate" ? await resolveVaultEndpoint(endpointOption, options) : undefined;
  if ((action === "add" || action === "rotate") && !options.createVerificationAdapter) throw failure("VAULT_VERIFICATION_ADAPTER_REQUIRED");
  const encryptionPhrase = action === "add" || action === "rotate"
    ? await handoffPhrase(options.promptEncryptionPhrase, !!input || !!options.unattended) : "";
  if (action === "verify") {
    if (crossVaultId !== undefined) {
      if (!options.createAdminAdapter) throw failure("VAULT_ADMIN_ADAPTER_REQUIRED");
      const adminPassword = await protectedSecret(options, input, "Administrator password: ", "ADMIN");
      const administrator = { username: "fos-admin", password: adminPassword };
      if (crossVaultId === vaultId) throw failure("CROSS_VAULT_ID_INVALID");
      const peer = await inspectVault(options.createAdminAdapter(plan, administrator), administrator, crossVaultId);
      if (!peer) throw failure("CROSS_VAULT_NOT_FOUND");
    }
    const password = await protectedSecret(options, vaultInput, "Vault password: ", "VAULT");
    if (!options.createVerificationAdapter) throw failure("VAULT_VERIFICATION_ADAPTER_REQUIRED");
    const verification = await verifyVault(options.createVerificationAdapter(plan, { username: `fos-vault-${vaultId}`, password }, crossVaultId), vaultId!,
      { username: `fos-vault-${vaultId}`, password }, crossVaultId);
    return { verified: true, ...verification };
  }
  const password = await protectedSecret(options, input, "Administrator password: ", "ADMIN");
  const administrator = { username: "fos-admin", password };
  if (action === "create" || action === "list" || action === "inspect") {
    if (!options.createAdminAdapter) throw failure("VAULT_ADMIN_ADAPTER_REQUIRED");
    const adapter = options.createAdminAdapter(plan, administrator);
    if (action === "create") return createVault(adapter, administrator, vaultId!);
    if (action === "inspect") return inspectVault(adapter, administrator, vaultId!);
    return listVaults(adapter, administrator);
  }
  const adapter = options.createAdapter(plan);
  const target = vaultId!;
  if (action === "revoke") { await revokeVaultUser(adapter, administrator, target); await removeVault(options.credentialStore, target); return undefined; }
  if (input && !output) throw failure("VAULT_SECRETS_OUTPUT_REQUIRED");
  if (!input && !options.discloseInteractiveSecrets) throw failure("INTERACTIVE_SECRETS_OUTPUT_REQUIRED");
  const retained = action === "rotate" && options.credentialStore?.readVault
    ? await options.credentialStore.readVault(target) : undefined;
  const result = action === "add"
    ? await addVaultUser(adapter, administrator, target, (size) => crypto.getRandomValues(new Uint8Array(size)))
    : await rotateVaultUser(adapter, administrator, target, (size) => crypto.getRandomValues(new Uint8Array(size)));
  if (!result.credential) return;
  await verifyVault(options.createVerificationAdapter!(plan, { username: result.credential.username, password: result.credential.password }), target,
    { username: result.credential.username, password: result.credential.password });
  const rendered = await renderVaultHandoff({
    vaultId: target, server: handoffEndpoint!, username: result.credential.username, password: result.credential.password,
    s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1", s3AccessKeyId: "", s3SecretKey: "", inlineLimit: 262144,
    encryptionPhrase,
  }, options.renderHandoff);
  if (keep) await writeVault(options.credentialStore, handoffEndpoint!, target, result.credential);
  else if (action === "rotate" && retained) await removeVault(options.credentialStore, target);
  const handoff = vaultHandoffContents(result.credential.username, result.credential.password, rendered);
  if (input) await options.secretOutput!.writeFileAtomically(output!, handoff, writeOptions);
  else await options.discloseInteractiveSecrets!(handoff);
}

/** Runs a read-only preview unless explicit approval is supplied. Data deletion needs a separate exact confirmation. */
export async function runLifecycleCommand(args: string[], options: RunLifecycleCommandOptions): Promise<string> {
  if (!options.isRoot()) throw failure("ROOT_REQUIRED");
  const action = args[0];
  if (action !== "upgrade" && action !== "uninstall") throw failure("LIFECYCLE_COMMAND_REQUIRED");
  const approved = args.includes("--approve");
  const deleteData = args.includes("--delete-data");
  const confirmation = vaultOption(args, "--confirm");
  if (action === "upgrade") {
    if (!approved) return previewUpgrade(options.upgrade);
    await runUpgrade(options.upgrade, { confirmed: true });
    return "fos upgrade complete";
  }
  if (!approved) return previewLifecycle("uninstall", options.lifecycle);
  await runLifecycle("uninstall", { confirmed: true, deleteData, typedConfirmation: confirmation }, options.lifecycle);
  return deleteData ? "fos uninstall complete; data deleted" : "fos uninstall complete; data preserved";
}

/** Runs explicit root-only backup operations; bootstrap never invokes this command. */
export async function runBackupCommand(args: string[], options: RunBackupCommandOptions): Promise<{ artifact: string; restored?: readonly string[] }> {
  if (!options.isRoot()) throw failure("ROOT_REQUIRED");
  const command = args[0];
  if (command !== "backup" && command !== "restore-check") throw failure("BACKUP_COMMAND_REQUIRED");
  const destination = vaultOption(args, "--destination");
  const retention = Number(vaultOption(args, "--retention"));
  if (!destination) throw failure("BACKUP_DESTINATION_REQUIRED");
  const schedule = planBackupSchedule({ enabled: true, destination, retention, interval: "daily" });
  const artifact = await runBackup(schedule, options.adapter);
  if (command === "backup") return { artifact: artifact.path };
  const target = options.restoreTarget?.(destination) ?? `${destination}/.restore-check-${crypto.randomUUID()}`;
  const result = await restoreCheck(schedule, artifact, target, options.adapter);
  return { artifact: artifact.path, restored: result.restoredSources };
}
