import { EditorView } from "@codemirror/view";
import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TFile } from "obsidian";
import QRCode from "qrcode";
import { normalizePath } from "@easy-sync/protocol";
import { connectExistingNatsBucket, connectVault, SyncStatus, statusSummary, type KvPort } from "./connection.js";
import { LocalStore } from "./local-store.js";
import { MarkdownSyncEngine, type MarkdownVault } from "./markdown-sync.js";
import { connectS3Blob, DEFAULT_INLINE_LIMIT, type BlobPort } from "./blob-storage.js";
import { createLogger, errorSummary } from "./diagnostics.js";
import { decryptTransfer, encryptTransfer, type TransferConfig } from "./config-transfer.js";

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
  private readonly logger = createLogger(() => this.config?.debugLogging ?? false);

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
    this.register(this.status.subscribe(() => statusBar.setText(`easy-sync: ${statusSummary(this.status)}`)));
    statusBar.setText(`easy-sync: ${statusSummary(this.status)}`);
    this.settingsTab = new EasySyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerObsidianProtocolHandler("easy-sync-import", (params) => {
      new ImportConfigModal(this.app, this, params.data ?? "").open();
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

  async importConfig(transfer: TransferConfig): Promise<void> {
    if (this.config.boundVaultId && this.config.boundVaultId !== transfer.vaultId) {
      throw new Error("This device is bound to a different vault");
    }
    await this.disconnect();
    const natsKey = `easy-sync-nats-${crypto.randomUUID()}`;
    this.app.secretStorage.setSecret(natsKey, transfer.natsPassword);
    const s3Key = transfer.s3SecretKey ? `easy-sync-s3-${crypto.randomUUID()}` : "";
    if (s3Key) this.app.secretStorage.setSecret(s3Key, transfer.s3SecretKey);
    Object.assign(this.config, {
      vaultId: transfer.vaultId, server: transfer.server, username: transfer.username, passwordSecretKey: natsKey,
      s3Endpoint: transfer.s3Endpoint, s3Bucket: transfer.s3Bucket, s3Region: transfer.s3Region,
      s3AccessKeyId: transfer.s3AccessKeyId, s3SecretKeySecretKey: s3Key, inlineLimit: transfer.inlineLimit,
    });
    await this.saveSettings();
    this.settingsTab?.display();
    await this.connectNow();
    this.settingsTab?.display();
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

  async connectNow(): Promise<void> {
    await this.disconnect();
    const config = this.config;
    if (!config.server || !config.username || !config.passwordSecretKey || !config.vaultId) return;
    this.status.lastError = "";
    this.status.refresh();
    this.logger.debug("plugin.connect", { vaultId: config.vaultId, bucket: `OBS_${config.vaultId}_FILES` });
    if (config.boundVaultId && config.boundVaultId !== config.vaultId) {
      new Notice("easy-sync: vault binding cannot be changed");
      return;
    }
    try {
      const kv = await connectVault({
        vaultId: config.vaultId, bucket: `OBS_${config.vaultId}_FILES`, server: config.server,
        username: config.username, passwordSecretKey: config.passwordSecretKey,
      }, { getSecret: async (key) => this.app.secretStorage.getSecret(key) },
      (options, bucket, status) => connectExistingNatsBucket(options, bucket, status, this.logger), this.status);
      this.kv = kv;
      const store = await LocalStore.open(`easy-sync-${config.deviceId}-${config.vaultId}`);
      this.store = store;
      if (config.s3Endpoint && config.s3Bucket && config.s3AccessKeyId && config.s3SecretKeySecretKey) {
        try {
          this.blob = await connectS3Blob({ endpoint: config.s3Endpoint, bucket: config.s3Bucket,
            region: config.s3Region, accessKeyId: config.s3AccessKeyId,
            secretKeySecretKey: config.s3SecretKeySecretKey }, this.app.secretStorage);
          this.status.clearError("s3-config");
        } catch (error) {
          this.status.markError("s3-config");
          this.status.lastError = errorSummary(error);
          this.logger.error("s3.connect_failed", error);
          new Notice(`easy-sync S3: ${this.status.lastError}`);
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
    } catch (error) {
      await this.disconnect();
      this.status.lastError = errorSummary(error);
      this.status.refresh();
      this.logger.error("plugin.connect_failed", error, { vaultId: config.vaultId, bucket: `OBS_${config.vaultId}_FILES` });
      new Notice(`easy-sync: ${this.status.lastError.slice(0, 220)}`);
    }
  }
}

class ExportConfigModal extends Modal {
  constructor(app: App, private readonly plugin: EasySyncPlugin) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Transfer easy-sync settings" });
    contentEl.createEl("p", { text: "Set a code phrase of at least 8 characters. The QR contains encrypted NATS and S3 credentials. Enter the phrase separately on your iPhone." });
    let phrase = "";
    const result = contentEl.createDiv();
    new Setting(contentEl).setName("Code phrase")
      .addText((input) => { input.inputEl.type = "password"; input.onChange((value) => { phrase = value; }); });
    new Setting(contentEl).addButton((button) => button.setButtonText("Create QR").onClick(async () => {
      result.empty();
      try {
        const payload = await this.plugin.exportConfig(phrase);
        const uri = `obsidian://easy-sync-import?data=${encodeURIComponent(payload)}`;
        const image = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 400 });
        result.createEl("img", { attr: { src: image, alt: "Encrypted easy-sync settings QR" } });
        result.createEl("p", { text: "Scan with iPhone Camera. Open the Obsidian link, then enter the code phrase." });
        new Setting(result).addButton((copy) => copy.setButtonText("Copy transfer link").onClick(async () => {
          await navigator.clipboard.writeText(uri);
          new Notice("Encrypted transfer link copied");
        }));
      } catch (error) {
        result.createEl("p", { text: errorSummary(error) });
      }
    }));
  }
}

class ImportConfigModal extends Modal {
  constructor(app: App, private readonly plugin: EasySyncPlugin, private readonly initialPayload: string) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Import easy-sync settings" });
    let payload = this.initialPayload;
    let phrase = "";
    const result = contentEl.createDiv();
    new Setting(contentEl).setName("Transfer code")
      .setDesc("Filled automatically when opened from the QR. You can also paste the encrypted code.")
      .addTextArea((input) => input.setValue(payload).onChange((value) => { payload = value.trim(); }));
    new Setting(contentEl).setName("Code phrase")
      .addText((input) => { input.inputEl.type = "password"; input.onChange((value) => { phrase = value; }); });
    new Setting(contentEl).addButton((button) => button.setButtonText("Connect").onClick(async () => {
      result.empty();
      button.setDisabled(true);
      try {
        const transfer = await decryptTransfer(payload, phrase);
        await this.plugin.importConfig(transfer);
        this.close();
        new Notice("easy-sync settings imported");
      } catch (error) {
        result.createEl("p", { text: `Unable to import: ${errorSummary(error)}` });
      } finally { button.setDisabled(false); }
    }));
  }
}

class EasySyncSettingTab extends PluginSettingTab {
  private unsubscribe?: () => void;
  constructor(app: App, private readonly plugin: EasySyncPlugin) { super(app, plugin); }

  hide(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.config;
    new Setting(containerEl).setName("Vault ID").setDesc("Use the existing ID when joining a vault.")
      .addText((text) => text.setValue(settings.vaultId).setDisabled(!!settings.boundVaultId)
        .onChange(async (value) => { settings.vaultId = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("NATS WSS URL")
      .addText((text) => text.setValue(settings.server).onChange(async (value) => { settings.server = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("NATS username")
      .addText((text) => text.setValue(settings.username).onChange(async (value) => { settings.username = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("NATS password")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(settings.passwordSecretKey)
        .onChange(async (value) => { settings.passwordSecretKey = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("S3 HTTPS endpoint")
      .addText((text) => text.setValue(settings.s3Endpoint).onChange(async (value) => {
        settings.s3Endpoint = value.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("S3 bucket")
      .addText((text) => text.setValue(settings.s3Bucket).onChange(async (value) => {
        settings.s3Bucket = value.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("S3 region")
      .addText((text) => text.setValue(settings.s3Region).onChange(async (value) => {
        settings.s3Region = value.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("S3 access key ID")
      .addText((text) => text.setValue(settings.s3AccessKeyId).onChange(async (value) => {
        settings.s3AccessKeyId = value.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("S3 secret key")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(settings.s3SecretKeySecretKey)
        .onChange(async (value) => { settings.s3SecretKeySecretKey = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Inline Markdown limit, bytes")
      .addText((text) => text.setValue(String(settings.inlineLimit)).onChange(async (value) => {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          settings.inlineLimit = parsed; await this.plugin.saveSettings();
        }
      }));
    new Setting(containerEl).setName("Debug logging")
      .setDesc("Write connection, reconciliation, and outbox events to the developer console. Errors are always logged.")
      .addToggle((toggle) => toggle.setValue(settings.debugLogging).onChange(async (value) => {
        settings.debugLogging = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("Connect")
      .addButton((button) => button.setButtonText("Connect").onClick(async () => { await this.plugin.connectNow(); }));
    new Setting(containerEl).setName("Transfer settings to iPhone")
      .addButton((button) => button.setButtonText("Show encrypted QR").onClick(() => {
        new ExportConfigModal(this.app, this.plugin).open();
      }));
    new Setting(containerEl).setName("Import settings")
      .addButton((button) => button.setButtonText("Paste transfer code").onClick(() => {
        new ImportConfigModal(this.app, this.plugin, "").open();
      }));
    const statusSetting = new Setting(containerEl).setName("Status");
    const lastErrorSetting = new Setting(containerEl).setName("Last error");
    const conflictsEl = containerEl.createDiv();
    const update = () => {
      statusSetting.setDesc(statusSummary(this.plugin.status));
      lastErrorSetting.setDesc(this.plugin.status.lastError || "None");
      conflictsEl.empty();
      for (const path of this.plugin.status.conflictPaths) {
        new Setting(conflictsEl).setName(path).setDesc("Local version retained here")
          .addButton((button) => button.setButtonText("Open copy").onClick(async () => {
            await this.app.workspace.openLinkText(path, "", false);
          }));
      }
    };
    this.unsubscribe?.();
    this.unsubscribe = this.plugin.status.subscribe(update);
    update();
  }
}
