import { EditorView } from "@codemirror/view";
import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import QRCode from "qrcode";
import { normalizePath } from "@flash-osidian-sync/protocol";
import { connectExistingNatsBucket, connectVault, SyncStatus, statusSummary, type KvPort } from "./connection.js";
import { LocalStore } from "./local-store.js";
import { MarkdownSyncEngine, type MarkdownVault } from "./markdown-sync.js";
import { connectS3Blob, DEFAULT_INLINE_LIMIT, type BlobPort } from "./blob-storage.js";
import { createLogger, errorSummary } from "./diagnostics.js";
import { decryptTransfer, encryptTransfer, transferVersion, type TransferConfig } from "./config-transfer.js";
import { PLUGIN_ID, registerImportUriHandlers } from "./plugin-identity.js";
import { validateSettingsDraft, type SettingsField, type SettingsValidationErrors } from "./settings-validation.js";
import type { ConflictRecord } from "./local-store.js";

interface EasySyncSettings {
  vaultId: string;
  boundVaultId: string;
  deviceId: string;
  server: string;
  username: string;
  passwordSecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretKeySecretKey: string;
  inlineLimit: number;
  debugLogging: boolean;
}

type SettingsSection = "overview" | "connection" | "attachments" | "device-transfer" | "advanced";
type SettingsApplyResult =
  | { kind: "applied" }
  | { kind: "not-configured" }
  | { kind: "validation-error"; errors: SettingsValidationErrors }
  | { kind: "persistence-error"; message: string }
  | { kind: "connection-error"; message: string };

interface SettingsDraft extends EasySyncSettings {
  natsPassword: string;
  s3Secret: string;
  attachmentsEnabled: boolean;
}

function draftFor(settings: EasySyncSettings): SettingsDraft {
  return { ...settings, natsPassword: "", s3Secret: "", attachmentsEnabled: Boolean(settings.s3Endpoint || settings.s3Bucket ||
    settings.s3AccessKeyId || settings.s3SecretKeySecretKey || (settings.s3Region && settings.s3Region !== "us-east-1")) };
}

function validateDraft(draft: SettingsDraft, passwordAvailable: boolean, s3SecretAvailable: boolean, requireConnection = false) {
  return validateSettingsDraft({
    vaultId: draft.vaultId,
    server: draft.server,
    username: draft.username,
    hasPassword: Boolean(draft.natsPassword || (draft.passwordSecretKey && passwordAvailable)),
    attachmentsEnabled: draft.attachmentsEnabled,
    s3Endpoint: draft.s3Endpoint,
    s3Bucket: draft.s3Bucket,
    s3Region: draft.s3Region,
    s3AccessKeyId: draft.s3AccessKeyId,
    hasS3Secret: Boolean(draft.s3Secret || (draft.s3SecretKeySecretKey && s3SecretAvailable)),
    inlineLimitKiB: draft.inlineLimit / 1024,
  }, requireConnection);
}

function validIncluded(path: string): boolean {
  try { return normalizePath(path) === path; }
  catch { return false; }
}

class ObsidianMarkdownVault implements MarkdownVault {
  constructor(private readonly app: App) {}

  async read(path: string): Promise<Uint8Array | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async listMarkdown(): Promise<Array<{ path: string; content: string }>> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => validIncluded(file.path));
    return Promise.all(files.map(async (file) => ({ path: file.path, content: await this.app.vault.read(file) })));
  }

  async listFiles(): Promise<Array<{ path: string; bytes: Uint8Array }>> {
    return Promise.all(this.app.vault.getFiles().filter((file) => validIncluded(file.path))
      .map(async (file) => ({ path: file.path, bytes: new Uint8Array(await this.app.vault.readBinary(file)) })));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const markdown = path.endsWith(".md");
    const content = markdown ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : undefined;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      if (markdown) await this.app.vault.modify(file, content!);
      else await this.app.vault.modifyBinary(file, bytes.slice().buffer as ArrayBuffer);
      return;
    }
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    }
    if (markdown) await this.app.vault.create(path, content!);
    else await this.app.vault.createBinary(path, bytes.slice().buffer as ArrayBuffer);
  }

  onModify(listener: (path: string) => void): () => void {
    const reference = this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && validIncluded(file.path)) listener(file.path);
    });
    const created = this.app.vault.on("create", (file) => {
      if (file instanceof TFile && validIncluded(file.path)) listener(file.path);
    });
    return () => { this.app.vault.offref(reference); this.app.vault.offref(created); };
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof TFile)) throw new Error("File to rename is missing");
    const parts = to.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    }
    await this.app.fileManager.renameFile(file, to);
  }

  async remove(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.trash(file, false);
  }

  onRename(listener: (from: string, to: string) => void): () => void {
    const reference = this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && validIncluded(oldPath) && validIncluded(file.path)) listener(oldPath, file.path);
    });
    return () => this.app.vault.offref(reference);
  }

  onDelete(listener: (path: string) => void): () => void {
    const reference = this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && validIncluded(file.path)) listener(file.path);
    });
    return () => this.app.vault.offref(reference);
  }
}

export default class EasySyncPlugin extends Plugin {
  config!: EasySyncSettings;
  private engine?: MarkdownSyncEngine;
  private store?: LocalStore;
  private kv?: KvPort;
  private blob?: BlobPort;
  private settingsTab?: EasySyncSettingTab;
  readonly status = new SyncStatus();
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly logger = createLogger(() => this.config?.debugLogging ?? false, console,
    (message) => this.redactDiagnostic(message));

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private redactDiagnostic(message: string, additionalSecrets: string[] = []): string {
    let result = message;
    for (const key of [this.config?.passwordSecretKey, this.config?.s3SecretKeySecretKey]) {
      if (!key) continue;
      try {
        const secret = this.app.secretStorage.getSecret(key);
        if (secret) result = result.replaceAll(secret, "[redacted]");
      } catch { /* Keep diagnostics safe when SecretStorage is unavailable. */ }
    }
    for (const secret of additionalSecrets) if (secret) result = result.replaceAll(secret, "[redacted]");
    return result;
  }

  safeDiagnostic(error: unknown, additionalSecrets: string[] = []): string {
    return this.redactDiagnostic(errorSummary(error), additionalSecrets).replace(/[\r\n\t]+/g, " ").slice(0, 220);
  }

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<EasySyncSettings> | null;
    this.config = {
      vaultId: saved?.vaultId || crypto.randomUUID().replaceAll("-", "").toUpperCase(),
      boundVaultId: saved?.boundVaultId ?? "",
      deviceId: saved?.deviceId ?? crypto.randomUUID(),
      server: saved?.server ?? "",
      username: saved?.username ?? "",
      passwordSecretKey: saved?.passwordSecretKey ?? "",
      s3Endpoint: saved?.s3Endpoint ?? "",
      s3Bucket: saved?.s3Bucket ?? "",
      s3Region: saved?.s3Region ?? "us-east-1",
      s3AccessKeyId: saved?.s3AccessKeyId ?? "",
      s3SecretKeySecretKey: saved?.s3SecretKeySecretKey ?? "",
      inlineLimit: saved?.inlineLimit ?? DEFAULT_INLINE_LIMIT,
      debugLogging: saved?.debugLogging ?? false,
    };
    await this.saveSettings();
    const statusBar = this.addStatusBarItem();
    this.register(this.status.subscribe(() => statusBar.setText(`${PLUGIN_ID}: ${statusSummary(this.status)}`)));
    statusBar.setText(`${PLUGIN_ID}: ${statusSummary(this.status)}`);
    this.settingsTab = new EasySyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    registerImportUriHandlers(((scheme, handler) => {
      this.registerObsidianProtocolHandler(scheme, handler as never);
    }), (data) => {
      new ImportConfigModal(this.app, this, data).open();
    });
    this.registerEditorExtension(EditorView.updateListener.of((update) => {
      if (!update.docChanged || !this.engine) return;
      const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (file && validIncluded(file.path) && file.path.endsWith(".md")) this.engine.scheduleCapture(file.path, update.state.doc.toString());
    }));
    this.app.workspace.onLayoutReady(() => { void this.connectNow(); });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) this.reconcileAfter("visibilitychange");
    });
    this.registerDomEvent(window, "online", () => { this.reconcileAfter("online"); });
  }

  async onunload(): Promise<void> {
    await this.disconnect();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.config);
  }

  async exportConfig(phrase: string): Promise<string> {
    const settings = this.config;
    const natsPassword = this.app.secretStorage.getSecret(settings.passwordSecretKey);
    if (!natsPassword) throw new Error("NATS password is missing from SecretStorage");
    const s3SecretKey = settings.s3SecretKeySecretKey
      ? this.app.secretStorage.getSecret(settings.s3SecretKeySecretKey) : "";
    if (settings.s3Endpoint && !s3SecretKey) throw new Error("S3 secret key is missing from SecretStorage");
    const transfer: TransferConfig = {
      vaultId: settings.vaultId, server: settings.server, username: settings.username, natsPassword,
      s3Endpoint: settings.s3Endpoint, s3Bucket: settings.s3Bucket, s3Region: settings.s3Region,
      s3AccessKeyId: settings.s3AccessKeyId, s3SecretKey: s3SecretKey ?? "", inlineLimit: settings.inlineLimit,
    };
    return encryptTransfer(transfer, phrase);
  }

  async importConfig(transfer: TransferConfig): Promise<SettingsApplyResult> {
    if (this.config.boundVaultId && this.config.boundVaultId !== transfer.vaultId) {
      throw new Error("This device is bound to a different vault");
    }
    const draft = draftFor(this.config);
    Object.assign(draft, {
      vaultId: transfer.vaultId, server: transfer.server, username: transfer.username,
      s3Endpoint: transfer.s3Endpoint, s3Bucket: transfer.s3Bucket, s3Region: transfer.s3Region,
      s3AccessKeyId: transfer.s3AccessKeyId, inlineLimit: transfer.inlineLimit,
      natsPassword: transfer.natsPassword, s3Secret: transfer.s3SecretKey,
    });
    return this.applyDraft(draft, "all");
  }

  async applyDraft(draft: SettingsDraft, section: SettingsSection | "all"): Promise<SettingsApplyResult> {
    const submittedDraft = { ...draft };
    return this.serialize(async () => {
      if (this.config.boundVaultId && this.config.boundVaultId !== submittedDraft.vaultId) {
        return { kind: "validation-error", errors: { vaultId: "This device is bound to a different vault." } };
      }
      const previous = this.config;
      const candidate = draftFor(previous);
      const connectionFields = section === "connection" || section === "all";
      const attachmentFields = section === "attachments" || section === "all";
      const advancedFields = section === "advanced" || section === "all";
      if (connectionFields) Object.assign(candidate, { vaultId: submittedDraft.vaultId, server: submittedDraft.server,
        username: submittedDraft.username, natsPassword: submittedDraft.natsPassword });
      if (attachmentFields) Object.assign(candidate, { s3Endpoint: submittedDraft.s3Endpoint, s3Bucket: submittedDraft.s3Bucket,
        s3Region: submittedDraft.s3Region, s3AccessKeyId: submittedDraft.s3AccessKeyId, s3Secret: submittedDraft.s3Secret,
        attachmentsEnabled: submittedDraft.attachmentsEnabled });
      if (advancedFields) Object.assign(candidate, { inlineLimit: submittedDraft.inlineLimit, debugLogging: submittedDraft.debugLogging });
      const passwordAvailable = Boolean(candidate.natsPassword || (candidate.passwordSecretKey &&
        this.app.secretStorage.getSecret(candidate.passwordSecretKey)));
      const s3SecretAvailable = Boolean(candidate.s3Secret || (candidate.s3SecretKeySecretKey &&
        this.app.secretStorage.getSecret(candidate.s3SecretKeySecretKey)));
      const validation = validateDraft(candidate, Boolean(passwordAvailable), Boolean(s3SecretAvailable),
        section === "connection" || section === "all");
      const scopedFields: Record<typeof section, SettingsField[]> = {
        overview: [], connection: ["vaultId", "server", "username", "hasPassword"],
        attachments: ["s3Endpoint", "s3Bucket", "s3Region", "s3AccessKeyId", "hasS3Secret"],
        "device-transfer": [], advanced: ["inlineLimitKiB"], all: ["vaultId", "server", "username", "hasPassword",
          "s3Endpoint", "s3Bucket", "s3Region", "s3AccessKeyId", "hasS3Secret", "inlineLimitKiB"],
      };
      const errors = Object.fromEntries(Object.entries(validation.errors)
        .filter(([field]) => scopedFields[section].includes(field as SettingsField))) as SettingsValidationErrors;
      if (Object.keys(errors).length) return { kind: "validation-error", errors };
      candidate.inlineLimit = validation.inlineLimit;

      const next: EasySyncSettings = { ...previous };
      if (connectionFields) Object.assign(next, { vaultId: candidate.vaultId, server: candidate.server,
        username: candidate.username });
      if (attachmentFields) Object.assign(next, { s3Endpoint: candidate.s3Endpoint, s3Bucket: candidate.s3Bucket,
        s3Region: candidate.s3Region, s3AccessKeyId: candidate.s3AccessKeyId });
      if (advancedFields) Object.assign(next, { inlineLimit: candidate.inlineLimit, debugLogging: candidate.debugLogging });
      try {
        if (connectionFields && candidate.natsPassword) {
          next.passwordSecretKey = `${PLUGIN_ID}-nats-${crypto.randomUUID()}`;
          this.app.secretStorage.setSecret(next.passwordSecretKey, candidate.natsPassword);
        }
        if (attachmentFields && validation.attachmentsConfigured && candidate.s3Secret) {
          next.s3SecretKeySecretKey = `${PLUGIN_ID}-s3-${crypto.randomUUID()}`;
          this.app.secretStorage.setSecret(next.s3SecretKeySecretKey, candidate.s3Secret);
        } else if (attachmentFields && !validation.attachmentsConfigured) {
          next.s3SecretKeySecretKey = "";
        }
        this.config = next;
        await this.saveData(next);
      } catch (error) {
        this.config = previous;
        return { kind: "persistence-error", message: this.safeDiagnostic(error, [candidate.natsPassword, candidate.s3Secret]) };
      }
      this.config = next;
      this.settingsTab?.onApplied(next, section);

      const reconnectFields: Array<keyof EasySyncSettings> = ["vaultId", "server", "username", "passwordSecretKey",
        "s3Endpoint", "s3Bucket", "s3Region", "s3AccessKeyId", "s3SecretKeySecretKey", "inlineLimit"];
      const reconnectNeeded = reconnectFields.some((field) => previous[field] !== next[field]);
      if (attachmentFields && !validation.attachmentsConfigured) {
        this.status.attachmentState = "NOT_CONFIGURED";
        this.status.attachmentError = "";
      } else if (attachmentFields && validation.attachmentsConfigured && reconnectNeeded) {
        this.status.attachmentState = "CONFIGURED";
        this.status.attachmentError = "";
      }
      if (!reconnectNeeded) return { kind: "applied" };
      if (connectionFields && !validation.configured) {
        await this.disconnect();
        this.status.connectionState = "UNCONFIGURED";
        this.status.connectionError = "";
        this.status.connected = false;
        this.status.refresh();
        return { kind: "not-configured" };
      }
      const result = await this.connectNowUnlocked();
      return result.kind === "connection-error" || result.kind === "validation-error" ? result : { kind: "applied" };
    });
  }

  private reconcileAfter(trigger: string): void {
    if (!this.engine) return;
    this.logger.debug("reconcile.trigger", { trigger });
    void this.engine.reconcile().catch((error: unknown) => {
      this.status.lastError = errorSummary(error);
      this.status.refresh();
      this.logger.error("reconcile.trigger_failed", error, { trigger });
    });
  }

  private async disconnect(): Promise<void> {
    this.engine?.stop();
    await this.engine?.settle();
    this.engine = undefined;
    await this.kv?.close?.();
    this.kv = undefined;
    this.store?.close();
    this.store = undefined;
    this.blob = undefined;
  }

  async connectNow(): Promise<SettingsApplyResult> {
    return this.serialize(() => this.connectNowUnlocked());
  }

  private async connectNowUnlocked(): Promise<SettingsApplyResult> {
    const config = this.config;
    const draft = draftFor(config);
    const validation = validateDraft(draft, Boolean(config.passwordSecretKey && this.app.secretStorage.getSecret(config.passwordSecretKey)),
      Boolean(config.s3SecretKeySecretKey && this.app.secretStorage.getSecret(config.s3SecretKeySecretKey)));
    const connectionStarted = Boolean(config.server || config.username || config.passwordSecretKey);
    if (!connectionStarted) {
      this.status.connectionState = "UNCONFIGURED";
      this.status.connectionError = "";
      this.status.connected = false;
      this.status.refresh();
      return { kind: "not-configured" };
    }
    const connectionErrors = ["vaultId", "server", "username", "hasPassword"] as SettingsField[];
    const invalidConnection = connectionErrors.some((field) => validation.errors[field]);
    if (invalidConnection || validation.errors.inlineLimitKiB) {
      this.status.connectionState = "OFFLINE";
      this.status.connectionError = this.redactDiagnostic(Object.values(validation.errors).find(Boolean) ?? "Invalid connection settings.");
      this.status.connected = false;
      this.status.refresh();
      return { kind: "validation-error", errors: validation.errors };
    }
    const attachmentError = validation.errors.s3Endpoint || validation.errors.s3Bucket || validation.errors.s3Region ||
      validation.errors.s3AccessKeyId || validation.errors.hasS3Secret;
    if (attachmentError) {
      this.status.attachmentState = "CONFIGURATION_ERROR";
      this.status.attachmentError = attachmentError;
    }
    this.status.connectionState = "CONNECTING";
    this.status.connectionError = "";
    this.status.refresh();
    await this.disconnect();
    this.status.lastError = "";
    this.logger.debug("plugin.connect", { vaultId: config.vaultId, bucket: `OBS_${config.vaultId}_FILES` });
    if (config.boundVaultId && config.boundVaultId !== config.vaultId) {
      new Notice(`${PLUGIN_ID}: vault binding cannot be changed`);
      return { kind: "validation-error", errors: { vaultId: "This device is bound to a different vault." } };
    }
    try {
      const kv = await connectVault({
        vaultId: config.vaultId, bucket: `OBS_${config.vaultId}_FILES`, server: config.server,
        username: config.username, passwordSecretKey: config.passwordSecretKey,
      }, { getSecret: async (key) => this.app.secretStorage.getSecret(key) },
      (options, bucket, status) => connectExistingNatsBucket(options, bucket, status, this.logger), this.status);
      this.kv = kv;
      const store = await LocalStore.open(`${PLUGIN_ID}-${config.deviceId}-${config.vaultId}`);
      this.store = store;
      if (validation.attachmentsConfigured) {
        try {
          this.blob = await connectS3Blob({ endpoint: config.s3Endpoint, bucket: config.s3Bucket,
            region: config.s3Region, accessKeyId: config.s3AccessKeyId,
            secretKeySecretKey: config.s3SecretKeySecretKey }, this.app.secretStorage);
          this.status.clearError("s3-config");
          this.status.attachmentState = "CONFIGURED";
          this.status.attachmentError = "";
        } catch (error) {
          this.status.markError("s3-config");
          this.status.attachmentState = "CONFIGURATION_ERROR";
          this.status.attachmentError = this.redactDiagnostic(errorSummary(error));
          this.status.lastError = this.status.attachmentError;
          this.logger.error("s3.connect_failed", error);
          new Notice(`${PLUGIN_ID} S3: ${this.status.lastError}`);
        }
      }
      const engine = new MarkdownSyncEngine({ deviceId: config.deviceId, vaultId: config.vaultId,
        vault: new ObsidianMarkdownVault(this.app), store, kv, blob: this.blob,
        inlineLimit: config.inlineLimit, status: this.status, logger: this.logger });
      this.engine = engine;
      await engine.start();
      if (!config.boundVaultId) {
        config.boundVaultId = config.vaultId;
        await this.saveSettings();
      }
      this.logger.debug("plugin.connected", { vaultId: config.vaultId });
      return { kind: "applied" };
    } catch (error) {
      await this.disconnect();
      const message = this.safeDiagnostic(error);
      this.status.lastError = message;
      this.status.connectionError = message;
      this.status.connectionState = this.status.value === "AUTH_ERROR" ? "AUTH_ERROR" : "OFFLINE";
      this.status.refresh();
      this.logger.error("plugin.connect_failed", error, { vaultId: config.vaultId, bucket: `OBS_${config.vaultId}_FILES` });
      return { kind: "connection-error", message };
    }
  }

  async getConflicts(): Promise<ConflictRecord[]> {
    return this.store ? this.store.conflicts() : [];
  }
}

class ExportConfigModal extends Modal {
  constructor(app: App, private readonly plugin: EasySyncPlugin) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Transfer ${PLUGIN_ID} settings` });
    contentEl.createEl("p", { text: "Protect transfer codes with a phrase of at least eight characters. The phrase must be entered separately on the receiving device." });
    let phrase = "";
    let disableProtection = false;
    const result = contentEl.createDiv();
    new Setting(contentEl).setName("Code phrase")
      .addText((input) => { input.inputEl.type = "password"; input.inputEl.autocomplete = "new-password";
        input.onChange((value) => { phrase = value; }); });
    const unsafeLabel = contentEl.createEl("label", { cls: "flash-sync-unprotected" });
    const disableCheckbox = unsafeLabel.createEl("input", { attr: { type: "checkbox" } });
    unsafeLabel.createSpan({ text: " Disable protection" });
    const warning = contentEl.createEl("p", { cls: "flash-sync-warning" });
    warning.textContent = "";
    disableCheckbox.addEventListener("change", () => {
      disableProtection = disableCheckbox.checked;
      warning.textContent = disableProtection ? "Unprotected — contains readable credentials." : "";
    });
    new Setting(contentEl).addButton((button) => button.setButtonText("Create QR").onClick(async () => {
      result.empty();
      if (!disableProtection && phrase.length < 8) {
        result.createEl("p", { text: "Enter a code phrase with at least eight characters." });
        return;
      }
      try {
        const payload = await this.plugin.exportConfig(disableProtection ? "" : phrase);
        const uri = `obsidian://${PLUGIN_ID}-import?data=${encodeURIComponent(payload)}`;
        const image = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 400 });
        result.createEl("img", { attr: { src: image, alt: `${PLUGIN_ID} settings QR` } });
        result.createEl("p", { text: disableProtection
          ? "Unprotected — contains readable credentials. Scan with iPhone Camera and open the Obsidian link."
          : "Scan with iPhone Camera. Open the Obsidian link, then enter the code phrase." });
        new Setting(result).addButton((copy) => copy.setButtonText("Copy transfer link").onClick(async () => {
          await navigator.clipboard.writeText(uri);
          new Notice("Transfer link copied");
        }));
      } catch (error) {
        result.createEl("p", { text: this.plugin.safeDiagnostic(error) });
      }
    }));
  }
}

class ImportConfigModal extends Modal {
  constructor(app: App, private readonly plugin: EasySyncPlugin, private readonly initialPayload: string) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Import ${PLUGIN_ID} settings` });
    let payload = this.initialPayload;
    let phrase = "";
    let decoded: TransferConfig | undefined;
    const result = contentEl.createDiv();
    const preview = contentEl.createDiv({ cls: "flash-sync-transfer-preview" });
    const transferSetting = new Setting(contentEl);
    const phraseSetting = new Setting(contentEl);
    const updatePhraseRequirement = (): void => {
      try {
        phraseSetting.settingEl.toggle(transferVersion(payload) === 1);
      } catch { phraseSetting.settingEl.toggle(false); }
      decoded = undefined;
      preview.empty();
      result.empty();
    };
    transferSetting.setName("Transfer code")
      .setDesc("Paste a transfer code, or open a transfer link from another device.")
      .addTextArea((input) => input.setValue(payload).onChange((value) => { payload = value.trim(); updatePhraseRequirement(); }));
    phraseSetting.setName("Code phrase")
      .setDesc("Required for protected transfer codes.")
      .addText((input) => { input.inputEl.type = "password"; input.inputEl.autocomplete = "current-password";
        input.onChange((value) => { phrase = value; decoded = undefined; }); });
    updatePhraseRequirement();
    new Setting(contentEl).addButton((button) => {
      button.setButtonText("Preview settings").onClick(async () => {
        result.empty(); preview.empty(); button.setDisabled(true);
        try {
          decoded = await decryptTransfer(payload, phrase);
          const validation = validateSettingsDraft({ vaultId: decoded.vaultId, server: decoded.server,
            username: decoded.username, hasPassword: Boolean(decoded.natsPassword),
            attachmentsEnabled: Boolean(decoded.s3Endpoint || decoded.s3Bucket || decoded.s3AccessKeyId || decoded.s3SecretKey),
            s3Endpoint: decoded.s3Endpoint,
            s3Bucket: decoded.s3Bucket, s3Region: decoded.s3Region, s3AccessKeyId: decoded.s3AccessKeyId,
            hasS3Secret: Boolean(decoded.s3SecretKey), inlineLimitKiB: decoded.inlineLimit / 1024 });
          if (Object.keys(validation.errors).length) throw new Error(Object.values(validation.errors)[0]);
          preview.createEl("h3", { text: "Settings preview" });
          preview.createEl("p", { text: `Vault: ${decoded.vaultId}` });
          preview.createEl("p", { text: `Server: ${decoded.server}` });
          preview.createEl("p", { text: decoded.s3Endpoint ? `Attachments: ${decoded.s3Bucket} (${decoded.s3Endpoint})` : "Attachments: not configured; files stay local." });
          preview.createEl("p", { text: "Passwords and access keys are hidden." });
          if (this.plugin.config.boundVaultId && this.plugin.config.boundVaultId !== decoded.vaultId) {
            result.createEl("p", { text: "This device is bound to a different vault. Import is blocked." });
            decoded = undefined;
          } else {
            new Setting(preview).addButton((apply) => apply.setButtonText("Import and connect").onClick(async () => {
              if (!decoded) return;
              apply.setDisabled(true);
              try {
                let outcome: SettingsApplyResult;
                try { outcome = await this.plugin.importConfig(decoded); }
                catch (error) { result.createEl("p", { text: `Unable to import: ${this.plugin.safeDiagnostic(error)}` }); return; }
                if (outcome.kind === "applied") {
                  new Notice(`${PLUGIN_ID} settings saved and connected`);
                  this.close();
                } else if (outcome.kind === "connection-error") {
                  result.createEl("p", { text: "Settings saved. Connection failed." });
                  result.createEl("p", { text: outcome.message });
                  new Setting(result).addButton((retry) => retry.setButtonText("Retry connection").onClick(async () => {
                    retry.setDisabled(true);
                    try {
                      const retried = await this.plugin.connectNow();
                      if (retried.kind === "applied") this.close();
                      else result.createEl("p", { text: retried.kind === "connection-error"
                        ? `Connection is still unavailable. Settings remain saved. ${retried.message}`
                        : "Connection is still unavailable. Settings remain saved." });
                    } catch (error) {
                      result.createEl("p", { text: `Retry failed. Settings remain saved. ${this.plugin.safeDiagnostic(error)}` });
                    } finally { retry.setDisabled(false); }
                  }));
                } else {
                  result.createEl("p", { text: outcome.kind === "validation-error" ? Object.values(outcome.errors)[0] ?? "Invalid settings." :
                    outcome.kind === "persistence-error" ? `Could not save settings: ${outcome.message}` : "Settings were not connected." });
                }
              } finally { apply.setDisabled(false); }
            }));
          }
        } catch (error) { result.createEl("p", { text: `Unable to preview: ${this.plugin.safeDiagnostic(error)}` }); }
        finally { button.setDisabled(false); }
      });
    });
  }
}

class DraftSwitchModal extends Modal {
  constructor(app: App, private readonly from: string, private readonly resolveChoice: (choice: "apply" | "discard" | "keep") => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Unapplied changes" });
    this.contentEl.createEl("p", { text: `Apply changes in ${this.from}, discard them, or keep editing. Closing settings discards unapplied changes.` });
    const actions = this.contentEl.createDiv({ cls: "flash-sync-actions" });
    const apply = actions.createEl("button", { text: "Apply", attr: { type: "button" } });
    apply.classList.add("mod-cta");
    apply.addEventListener("click", () => this.finish("apply"));
    actions.createEl("button", { text: "Discard", attr: { type: "button" } }).addEventListener("click", () => this.finish("discard"));
    actions.createEl("button", { text: "Keep editing", attr: { type: "button" } }).addEventListener("click", () => this.finish("keep"));
  }
  onClose(): void { this.resolveChoice("keep"); }
  private finish(choice: "apply" | "discard" | "keep"): void { this.resolveChoice(choice); this.close(); }
}

class EasySyncSettingTab extends PluginSettingTab {
  private unsubscribe?: () => void;
  private drafts = new Map<SettingsSection, SettingsDraft>();
  private activeSection: SettingsSection = "overview";
  private panel?: HTMLElement;
  private summary?: HTMLElement;
  private conflictRegion?: HTMLElement;
  private overviewActions?: HTMLElement;
  private attachmentSettingsAction?: HTMLButtonElement;
  private fieldRows = new Map<SettingsField, { input: HTMLInputElement; row: Setting; help: string }>();
  private transferMode: "import" | "export" = "import";
  private busy = false;
  private navigationDecisionPending = false;

  constructor(app: App, private readonly plugin: EasySyncPlugin) { super(app, plugin); }

  hide(): void {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.drafts.clear(); this.fieldRows.clear();
  }

  onApplied(settings: EasySyncSettings, section: SettingsSection | "all"): void {
    if (section === "all") this.drafts.clear();
    else {
      this.drafts.delete(section);
      for (const [key, draft] of this.drafts) {
        if (!this.isDirty(key, draft)) this.drafts.delete(key);
      }
    }
    this.updateSummary();
    if (this.panel && (section === "all" || section === this.activeSection)) this.renderSection();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const root = containerEl.createDiv({ cls: "flash-sync-settings" });
    // Obsidian's settings pane hides the first h1; use its visible native section heading style.
    root.createEl("h2", { text: PLUGIN_ID, cls: "flash-sync-heading" });
    root.createEl("p", { text: `Vault ID: ${this.plugin.config.vaultId}`, cls: "flash-sync-vault-id" });
    this.summary = undefined;
    const nav = root.createDiv({ cls: "flash-sync-nav" });
    const tabs = nav.createDiv({ cls: "flash-sync-nav-buttons", attr: { role: "tablist", "aria-label": "Sync settings" } });
    const selectorId = "flash-sync-section-select";
    nav.createEl("label", { text: "Settings section", cls: "flash-sync-nav-select-label", attr: { for: selectorId } });
    const selector = nav.createEl("select", { cls: "flash-sync-nav-select", attr: { id: selectorId, "aria-label": "Settings section" } });
    const sections: Array<[SettingsSection, string]> = [["overview", "Overview"], ["connection", "Connection"],
      ["attachments", "Attachments"], ["device-transfer", "Device transfer"], ["advanced", "Advanced"]];
    for (const [section, label] of sections) {
      const button = tabs.createEl("button", { text: label, attr: { type: "button", role: "tab", "aria-controls": `flash-sync-panel-${section}` } });
      button.addEventListener("click", () => { void this.selectSection(section); });
      button.addEventListener("keydown", (event) => {
        const keyEvent = event as KeyboardEvent;
        const currentIndex = sections.findIndex(([candidate]) => candidate === this.activeSection);
        const nextIndex = keyEvent.key === "Home" ? 0 : keyEvent.key === "End" ? sections.length - 1
          : keyEvent.key === "ArrowRight" ? (currentIndex + 1) % sections.length
            : keyEvent.key === "ArrowLeft" ? (currentIndex + sections.length - 1) % sections.length : -1;
        if (nextIndex < 0) return;
        keyEvent.preventDefault();
        void this.selectSection(sections[nextIndex][0]).then(() => {
          this.containerEl.querySelector<HTMLButtonElement>(`button[role="tab"][aria-controls="flash-sync-panel-${this.activeSection}"]`)?.focus();
        });
      });
      selector.createEl("option", { text: label, attr: { value: section } });
    }
    selector.value = this.activeSection;
    selector.addEventListener("change", () => { void this.selectSection(selector.value as SettingsSection); });
    this.panel = root.createDiv({ cls: "flash-sync-panel", attr: { id: `flash-sync-panel-${this.activeSection}`, role: "tabpanel" } });
    this.panel.inert = this.busy;
    this.renderSection();
    this.updateNavigation(tabs);
    this.unsubscribe?.();
    this.unsubscribe = this.plugin.status.subscribe(() => this.updateSummary());
  }

  private updateNavigation(tabs: HTMLElement): void {
    for (const button of Array.from(tabs.querySelectorAll<HTMLButtonElement>("button[role=tab]"))) {
      const selected = button.getAttribute("aria-controls") === `flash-sync-panel-${this.activeSection}`;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  }

  private currentDraft(section = this.activeSection): SettingsDraft {
    let draft = this.drafts.get(section);
    if (!draft) { draft = draftFor(this.plugin.config); this.drafts.set(section, draft); }
    return draft;
  }

  private isDirty(section: SettingsSection, draft = this.currentDraft(section)): boolean {
    const fields: Record<SettingsSection, Array<keyof SettingsDraft>> = {
      overview: [], connection: ["vaultId", "server", "username", "passwordSecretKey", "natsPassword"],
      attachments: ["s3Endpoint", "s3Bucket", "s3Region", "s3AccessKeyId", "s3SecretKeySecretKey", "s3Secret"],
      "device-transfer": [], advanced: ["inlineLimit", "debugLogging"],
    };
    if (section === "attachments" && draft.attachmentsEnabled !== Boolean(this.plugin.config.s3Endpoint || this.plugin.config.s3Bucket ||
      this.plugin.config.s3AccessKeyId || this.plugin.config.s3SecretKeySecretKey ||
      (this.plugin.config.s3Region && this.plugin.config.s3Region !== "us-east-1"))) return true;
    return fields[section].some((field) => draft[field] !== (field in this.plugin.config ? this.plugin.config[field as keyof EasySyncSettings] : ""));
  }

  private async selectSection(next: SettingsSection): Promise<void> {
    if (this.busy || this.navigationDecisionPending || next === this.activeSection) return;
    if (this.isDirty(this.activeSection)) {
      this.navigationDecisionPending = true;
      let choice: "apply" | "discard" | "keep";
      try {
        choice = await new Promise<"apply" | "discard" | "keep">((resolve) => {
          new DraftSwitchModal(this.app, this.activeSection, resolve).open();
        });
      } finally { this.navigationDecisionPending = false; }
      if (choice === "keep") return;
      if (choice === "discard") this.drafts.delete(this.activeSection);
      if (choice === "apply") {
        const outcome = await this.applyActiveDraft();
        if (outcome.kind === "validation-error" || outcome.kind === "persistence-error") return;
      }
    }
    this.activeSection = next;
    this.display();
  }

  private updateSummary(): void {
    if (!this.summary) return;
    this.summary.empty();
    const status = this.plugin.status;
    const connection = status.connectionState === "CONNECTED"
      ? (status.pending > 0 ? `Connected · ${status.pending} pending` : status.blobsPending > 0 ? "Connected · attachments transferring" : "Connected")
      : status.connectionState === "CONNECTING" ? "Connecting…"
        : status.connectionState === "AUTH_ERROR" ? "Authentication error"
          : status.connectionState === "UNCONFIGURED" ? "Not configured" : "Offline";
    const attachment = status.attachmentState === "NOT_CONFIGURED" ? "Not configured · files remain local"
      : status.attachmentState === "CONFIGURED" ? "Configured" : status.attachmentState === "CONFIGURATION_ERROR"
        ? "Configuration error" : "Transfer error";
    if (this.activeSection !== "overview") {
      this.summary.createEl("p", { text: `Sync server: ${connection} · Attachments: ${attachment}` });
      const details = (label: string, message: string): void => {
        const disclosure = this.summary!.createEl("details");
        disclosure.createEl("summary", { text: label });
        disclosure.createEl("p", { text: this.plugin.safeDiagnostic(message) });
      };
      if (status.connectionError) details("Connection details", status.connectionError);
      if (status.attachmentError) details("Attachment details", status.attachmentError);
      return;
    }
    const row = (label: string, value: string): void => {
      const item = this.summary!.createDiv({ cls: "flash-sync-status-row" });
      item.createEl("span", { text: label });
      item.createEl("span", { text: value });
    };
    row("Sync server", connection);
    row("Attachments", attachment);
    row("Pending Markdown changes", String(status.pending));
    row("Attachment transfers", String(status.blobsPending));
    const details = (label: string, message: string): void => {
      const disclosure = this.summary!.createEl("details", { cls: "flash-sync-error" });
      disclosure.createEl("summary", { text: label });
      disclosure.createEl("p", { text: this.plugin.safeDiagnostic(message) });
    };
    if (status.connectionError) details("Connection details", status.connectionError);
    if (status.attachmentError) details("Attachment details", status.attachmentError);
    if (status.lastError && !status.connectionError && !status.attachmentError) details("Technical details", status.lastError);
    if (this.activeSection === "overview") {
      this.updateAttachmentSettingsAction();
      if (this.conflictRegion) void this.renderConflicts();
    }
  }

  private renderSection(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.empty();
    panel.id = `flash-sync-panel-${this.activeSection}`;
    this.summary = undefined;
    this.overviewActions = undefined;
    this.attachmentSettingsAction = undefined;
    this.fieldRows.clear();
    if (this.activeSection !== "overview") {
      this.summary = panel.createDiv({ cls: "flash-sync-section-status" });
      this.updateSummary();
    }
    if (this.activeSection === "overview") this.renderOverview(panel);
    else if (this.activeSection === "connection") this.renderConnection(panel);
    else if (this.activeSection === "attachments") this.renderAttachments(panel);
    else if (this.activeSection === "device-transfer") this.renderTransfer(panel);
    else this.renderAdvanced(panel);
  }

  private renderOverview(panel: HTMLElement): void {
    panel.createEl("h2", { text: "Sync overview" });
    this.summary = panel.createDiv({ cls: "flash-sync-overview-status" });
    this.updateSummary();
    const actions = panel.createDiv({ cls: "flash-sync-actions" });
    this.overviewActions = actions;
    if (this.plugin.status.connectionState === "UNCONFIGURED") {
      const importButton = actions.createEl("button", { text: "Import settings", attr: { type: "button" } });
      importButton.classList.add("mod-cta");
      importButton.addEventListener("click", () => {
        new ImportConfigModal(this.app, this.plugin, "").open();
      });
      actions.createEl("button", { text: "Manual setup", attr: { type: "button" } }).addEventListener("click", () => {
        this.activeSection = "connection"; this.display();
      });
    } else {
      actions.createEl("button", { text: "Retry connection", attr: { type: "button" } }).addEventListener("click", (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        void this.plugin.connectNow().finally(() => { button.disabled = false; });
      });
      actions.createEl("button", { text: "Edit connection", attr: { type: "button" } }).addEventListener("click", () => {
        this.activeSection = "connection"; this.display();
      });
    }
    this.updateAttachmentSettingsAction();
    this.conflictRegion = panel.createDiv({ cls: "flash-sync-conflicts" });
    void this.renderConflicts();
  }

  private updateAttachmentSettingsAction(): void {
    const actions = this.overviewActions;
    if (!actions || this.activeSection !== "overview") return;
    if (!this.attachmentSettingsAction) {
      const button = actions.createEl("button", { text: "Check attachment settings", attr: { type: "button" } });
      button.addEventListener("click", () => {
        if (this.busy) return;
        this.activeSection = "attachments";
        this.display();
      });
      this.attachmentSettingsAction = button;
    }
    const state = this.plugin.status.attachmentState;
    this.attachmentSettingsAction.hidden = state !== "CONFIGURATION_ERROR" && state !== "TRANSFER_ERROR";
  }

  private async renderConflicts(): Promise<void> {
    const region = this.conflictRegion;
    if (!region) return;
    const conflicts = await this.plugin.getConflicts();
    if (region !== this.conflictRegion || this.activeSection !== "overview") return;
    region.empty();
    region.createEl("h3", { text: `Conflicts (${conflicts.length})` });
    for (const conflict of conflicts) {
      const name = conflict.originalPath.split("/").at(-1) || conflict.originalPath;
      const row = new Setting(region).setName(name)
        .setDesc("Both copies are preserved. Resolve is coming later; merge or rename them manually.");
      row.addButton((button) => button.setButtonText("Open copy").onClick(async () => {
        await this.app.workspace.openLinkText(conflict.copyPath, "", false);
      }));
      row.addButton((button) => button.setButtonText("Resolve").setDisabled(true));
      const paths = region.createEl("details");
      paths.createEl("summary", { text: "Show full paths" });
      paths.createEl("p", { text: `Original: ${conflict.originalPath}` });
      paths.createEl("p", { text: `Copy: ${conflict.copyPath}` });
      paths.createEl("p", { text: "Resolve is coming later." });
    }
  }

  private addText(panel: HTMLElement, field: SettingsField, name: string, help: string, value: string,
    update: (value: string) => void, password = false, disabled = false): void {
    const row = new Setting(panel).setName(name).setDesc(help);
    row.addText((text) => {
      text.setValue(value).setDisabled(disabled);
      if (password) { text.inputEl.type = "password"; text.inputEl.autocomplete = "new-password"; }
      text.onChange((next) => { update(next); this.clearFieldError(field); });
      this.fieldRows.set(field, { input: text.inputEl, row, help });
    });
  }

  private clearFieldError(field: SettingsField): void {
    const row = this.fieldRows.get(field);
    if (row) row.row.setDesc(row.help);
  }

  private async applyActiveDraft(): Promise<SettingsApplyResult> {
    const draft = this.currentDraft();
    this.busy = true;
    if (this.panel) { this.panel.inert = true; this.panel.setAttribute("aria-busy", "true"); }
    let outcome: SettingsApplyResult;
    try { outcome = await this.plugin.applyDraft(draft, this.activeSection); }
    finally {
      this.busy = false;
      if (this.panel) { this.panel.inert = false; this.panel.removeAttribute("aria-busy"); }
    }
    if (outcome.kind === "validation-error") {
      for (const [field, message] of Object.entries(outcome.errors) as Array<[SettingsField, string]>) {
        const row = this.fieldRows.get(field);
        if (row) row.row.setDesc(message);
      }
      const first = Object.keys(outcome.errors)[0] as SettingsField | undefined;
      this.fieldRows.get(first!)?.input.focus();
      return outcome;
    }
    if (outcome.kind === "persistence-error") {
      new Notice(`Could not save settings: ${outcome.message}`);
      return outcome;
    }
    if (outcome.kind === "connection-error") new Notice("Settings saved. Connection failed.");
    else if (outcome.kind === "not-configured") new Notice("Settings saved. Sync is not configured.");
    else new Notice("Settings saved.");
    return outcome;
  }

  private addDraftActions(panel: HTMLElement): void {
    const note = panel.createEl("p", { cls: "flash-sync-draft-note", text: "Changes stay here until applied. Closing settings discards unapplied changes." });
    const actions = panel.createDiv({ cls: "flash-sync-actions" });
    const apply = actions.createEl("button", { text: this.activeSection === "advanced" ? "Save changes" : "Save and reconnect",
      attr: { type: "button" } });
    if (this.activeSection !== "advanced") apply.classList.add("mod-cta");
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      try { await this.applyActiveDraft(); }
      finally { apply.disabled = false; }
    });
    const discard = actions.createEl("button", { text: "Discard", attr: { type: "button" } });
    discard.addEventListener("click", () => {
      this.drafts.delete(this.activeSection);
      this.renderSection();
      note.textContent = "Draft discarded. Closing settings discards any unapplied changes.";
    });
  }

  private renderConnection(panel: HTMLElement): void {
    panel.createEl("h2", { text: "Connection" });
    const draft = this.currentDraft();
    this.addText(panel, "vaultId", "Vault ID", this.plugin.config.boundVaultId
      ? "Locked after first successful connection to protect this vault identity."
      : "Use the same ID on each device joining this vault.", draft.vaultId, (value) => { draft.vaultId = value.trim(); }, false, !!this.plugin.config.boundVaultId);
    this.addText(panel, "server", "NATS WSS URL", "Secure WebSocket URL for your NATS server.", draft.server,
      (value) => { draft.server = value.trim(); });
    this.addText(panel, "username", "NATS username", "Per-vault account created by your server administrator.", draft.username,
      (value) => { draft.username = value.trim(); });
    const passwordSaved = Boolean(draft.passwordSecretKey && this.app.secretStorage.getSecret(draft.passwordSecretKey));
    this.addText(panel, "hasPassword", "NATS password", passwordSaved
      ? "Saved securely. Enter a replacement to change it; the replacement is saved when you apply."
      : "Required. The password is saved in Obsidian SecretStorage when you apply.", "",
      (value) => { draft.natsPassword = value; }, true);
    this.addDraftActions(panel);
  }

  private renderAttachments(panel: HTMLElement): void {
    panel.createEl("h2", { text: "Attachments" });
    panel.createEl("p", { text: "Optional. Without S3, images and oversized files remain local while Markdown sync continues." });
    const draft = this.currentDraft();
    const toggle = panel.createEl("label", { cls: "flash-sync-checkbox" });
    const checkbox = toggle.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = draft.attachmentsEnabled;
    toggle.createSpan({ text: " Configure S3 attachment storage" });
    const fields = panel.createDiv();
    const renderFields = (): void => {
      fields.empty(); this.fieldRows.clear();
      if (!draft.attachmentsEnabled) return;
      this.addText(fields, "s3Endpoint", "S3 HTTPS endpoint", "HTTPS endpoint for S3-compatible storage.", draft.s3Endpoint,
        (value) => { draft.s3Endpoint = value.trim(); });
      this.addText(fields, "s3Bucket", "Bucket", "Bucket for attachment and oversized-file objects.", draft.s3Bucket,
        (value) => { draft.s3Bucket = value.trim(); });
      this.addText(fields, "s3Region", "Region", "S3 signing region.", draft.s3Region,
        (value) => { draft.s3Region = value.trim(); });
      this.addText(fields, "s3AccessKeyId", "Access key ID", "Stored with this vault’s settings.", draft.s3AccessKeyId,
        (value) => { draft.s3AccessKeyId = value.trim(); });
      const saved = Boolean(draft.s3SecretKeySecretKey && this.app.secretStorage.getSecret(draft.s3SecretKeySecretKey));
      this.addText(fields, "hasS3Secret", "Secret access key", saved
        ? "Saved securely. Enter a replacement to change it; the replacement is saved when you apply."
        : "Required. The secret key is saved in Obsidian SecretStorage when you apply.", "",
        (value) => { draft.s3Secret = value; }, true);
    };
    checkbox.addEventListener("change", () => {
      draft.attachmentsEnabled = checkbox.checked;
      if (!checkbox.checked) {
        Object.assign(draft, { s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1", s3AccessKeyId: "", s3Secret: "" });
      }
      renderFields();
    });
    renderFields();
    this.addDraftActions(panel);
  }

  private renderTransfer(panel: HTMLElement): void {
    panel.createEl("h2", { text: "Device transfer" });
    const mode = panel.createDiv({ cls: "flash-sync-transfer-modes" });
    for (const [value, label] of [["import", "Import"], ["export", "Export"]] as const) {
      const button = mode.createEl("button", { text: label, attr: { type: "button", "aria-pressed": String(value === this.transferMode) } });
      button.addEventListener("click", () => { this.transferMode = value; this.renderSection(); });
    }
    if (this.transferMode === "import") {
      panel.createEl("p", { text: "Preview settings before they are saved. Secrets stay hidden in the preview." });
      new Setting(panel).addButton((button) => button.setButtonText("Paste transfer code").setCta().onClick(() => {
        new ImportConfigModal(this.app, this.plugin, "").open();
      }));
    } else {
      panel.createEl("p", { text: "Export includes the currently applied connection and optional attachment settings." });
      new Setting(panel).addButton((button) => button.setButtonText("Create protected QR").setCta().onClick(() => {
        new ExportConfigModal(this.app, this.plugin).open();
      }));
    }
  }

  private renderAdvanced(panel: HTMLElement): void {
    panel.createEl("h2", { text: "Advanced" });
    const draft = this.currentDraft();
    const row = new Setting(panel).setName("Inline Markdown limit (KiB)")
      .setDesc("Values above this size use S3. Changing this value reconnects sync.");
    row.addText((text) => text.setValue(String(draft.inlineLimit / 1024)).onChange((value) => {
      draft.inlineLimit = Number(value) * 1024;
      this.clearFieldError("inlineLimitKiB");
    }));
    this.fieldRows.set("inlineLimitKiB", { input: row.controlEl.querySelector("input")!, row, help: "Values above this size use S3. Changing this value reconnects sync." });
    new Setting(panel).setName("Debug logging")
      .setDesc("Write connection, reconciliation, and pending-change events to the developer console. Errors are always recorded.")
      .addToggle((toggle) => toggle.setValue(draft.debugLogging).onChange((value) => { draft.debugLogging = value; }));
    this.addDraftActions(panel);
  }
}
