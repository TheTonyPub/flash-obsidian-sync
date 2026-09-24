import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptTransfer, type TransferConfig } from "../../packages/plugin/src/config-transfer.js";

const ui = vi.hoisted(() => {
  interface FakeApp {
    secretStorage: { getSecret: (key: string) => string | null; setSecret: (key: string, value: string) => void };
    workspace: { onLayoutReady: (callback: () => void) => void; getActiveViewOfType: (type: unknown) => null };
    vault: { adapter: { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string> }; configDir: string };
  }
  const notices: string[] = [];
  const modals: FakeModal[] = [];
  let focused: FakeElement | undefined;
  const recordFocus = (element: FakeElement): void => { focused = element; };

  class FakeElement {
    readonly children: FakeElement[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    readonly classList = { add: (...names: string[]) => { this.classes.push(...names); } };
    readonly classes: string[] = [];
    parentElement?: FakeElement;
    name = "";
    value = "";
    type = "";
    autocomplete = "";
    checked = false;
    disabled = false;
    hidden = false;
    inert = false;
    tabIndex = 0;
    id = "";
    private ownText = "";

    constructor(public tagName: string) {}

    get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); }
    set textContent(value: string) { this.ownText = value; this.empty(); }

    empty(): void { this.children.length = 0; }
    createDiv(options: Record<string, unknown> = {}): FakeElement { return this.createEl("div", options); }
    createSpan(options: Record<string, unknown> = {}): FakeElement { return this.createEl("span", options); }
    createEl(tag: string, options: Record<string, unknown> = {}): FakeElement {
      const element = new FakeElement(tag);
      element.parentElement = this;
      if (typeof options.text === "string") element.ownText = options.text;
      if (typeof options.cls === "string") element.classes.push(options.cls);
      const attrs = options.attr as Record<string, string> | undefined;
      for (const [key, value] of Object.entries(attrs ?? {})) element.setAttribute(key, value);
      this.children.push(element);
      return element;
    }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    addEventListener(name: string, listener: (event: Record<string, unknown>) => void): void {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    dispatch(name: string, values: Record<string, unknown> = {}): void {
      const event: Record<string, unknown> = { currentTarget: this, ...values };
      event.preventDefault = () => { event.defaultPrevented = true; };
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
    click(): void { this.dispatch("click"); }
    focus(): void { recordFocus(this); }
    querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
      const match = (element: FakeElement): boolean => {
        if (selector === "input") return element.tagName === "input";
        if (selector === "textarea") return element.tagName === "textarea";
        if (selector === "[role=tabpanel]") return element.getAttribute("role") === "tabpanel";
        if (selector === "button[role=tab]" || selector === 'button[role="tab"]')
          return element.tagName === "button" && element.getAttribute("role") === "tab";
        const tab = selector.match(/^button\[role="tab"\]\[aria-controls="(.+)"\]$/);
        if (tab) return element.tagName === "button" && element.getAttribute("role") === "tab" && element.getAttribute("aria-controls") === tab[1];
        return false;
      };
      return this.children.flatMap((child) => [...(match(child) ? [child as T] : []), ...child.querySelectorAll<T>(selector)]);
    }
    querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
      return this.querySelectorAll<T>(selector)[0] ?? null;
    }
    toggle(show: boolean): void { this.attributes.set("hidden", String(!show)); }
  }

  class FakePlugin {
    savedData: unknown = null;
    readonly settingTabs: FakePluginSettingTab[] = [];
    constructor(readonly app: FakeApp) {}
    async loadData(): Promise<unknown> { return this.savedData; }
    async saveData(data: unknown): Promise<void> { this.savedData = data; }
    addStatusBarItem(): { setText: (_text: string) => void } { return { setText: () => {} }; }
    addSettingTab(tab: FakePluginSettingTab): void { this.settingTabs.push(tab); }
    register(): void {}
    registerObsidianProtocolHandler(): void {}
    registerEditorExtension(): void {}
    registerDomEvent(): void {}
  }

  class FakePluginSettingTab {
    readonly containerEl = new FakeElement("div");
    constructor(readonly app: FakeApp, readonly plugin: unknown) {}
  }

  class FakeModal {
    readonly contentEl = new FakeElement("div");
    constructor(readonly app: unknown) { modals.push(this); }
    open(): void { (this as unknown as { onOpen?: () => void }).onOpen?.(); }
    close(): void { (this as unknown as { onClose?: () => void }).onClose?.(); }
  }

  class FakeText {
    readonly inputEl = new FakeElement("input");
    private change?: (value: string) => void;
    setValue(value: string): this { this.inputEl.value = value; return this; }
    setDisabled(value: boolean): this { this.inputEl.disabled = value; return this; }
    onChange(callback: (value: string) => void): this {
      this.change = callback;
      this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
      this.inputEl.addEventListener("change", () => callback(this.inputEl.value));
      return this;
    }
    changeTo(value: string): void { this.inputEl.value = value; this.change?.(value); }
  }

  class FakeButton {
    readonly element: FakeElement;
    private clickHandler?: () => unknown;
    constructor(parent: FakeElement) { this.element = parent.createEl("button"); }
    setButtonText(value: string): this { this.element.textContent = value; return this; }
    setDisabled(value: boolean): this { this.element.disabled = value; return this; }
    setCta(): this { this.element.classList.add("mod-cta"); return this; }
    onClick(callback: () => unknown): this { this.clickHandler = callback; this.element.addEventListener("click", () => { void this.clickHandler?.(); }); return this; }
  }

  class FakeSetting {
    readonly settingEl: FakeElement;
    readonly controlEl: FakeElement;
    constructor(parent: FakeElement) { this.settingEl = parent.createDiv(); this.controlEl = this.settingEl.createDiv(); }
    setName(value: string): this { this.settingEl.name = value; this.settingEl.setAttribute("data-setting-name", value); this.settingEl.createEl("span", { text: value }); return this; }
    setDesc(value: string): this { this.settingEl.createEl("p", { text: value }); return this; }
    addText(callback: (component: FakeText) => unknown): this { const component = new FakeText(); this.controlEl.children.push(component.inputEl); component.inputEl.parentElement = this.controlEl; callback(component); return this; }
    addTextArea(callback: (component: FakeText) => unknown): this { const component = new FakeText(); component.inputEl.tagName = "textarea"; this.controlEl.children.push(component.inputEl); component.inputEl.parentElement = this.controlEl; callback(component); return this; }
    addButton(callback: (component: FakeButton) => unknown): this { callback(new FakeButton(this.controlEl)); return this; }
    addToggle(callback: (component: { setValue: (value: boolean) => unknown; onChange: (fn: (value: boolean) => void) => unknown }) => unknown): this {
      const input = this.controlEl.createEl("input", { attr: { type: "checkbox" } });
      let change: ((value: boolean) => void) | undefined;
      callback({ setValue: (value) => { input.checked = value; return this; }, onChange: (fn) => { change = fn; return this; } });
      input.addEventListener("change", () => change?.(input.checked));
      return this;
    }
  }

  class FakeNotice { constructor(message: string) { notices.push(message); } }

  return { FakeElement, FakePlugin, FakePluginSettingTab, FakeModal, FakeSetting, FakeNotice, notices, modals,
    getFocused: () => focused, reset: () => { notices.length = 0; modals.length = 0; focused = undefined; } };
});

vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Plugin: ui.FakePlugin, PluginSettingTab: ui.FakePluginSettingTab, Modal: ui.FakeModal,
    Setting: ui.FakeSetting, Notice: ui.FakeNotice };
});

const connectVault = vi.hoisted(() => vi.fn(async () => { throw new Error("offline"); }));
vi.mock("../../packages/plugin/src/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/plugin/src/connection.js")>();
  return { ...actual, connectVault };
});

import EasySyncPlugin from "../../packages/plugin/src/main.js";

function findText(root: InstanceType<typeof ui.FakeElement>, text: string): InstanceType<typeof ui.FakeElement> {
  const visit = (element: InstanceType<typeof ui.FakeElement>): InstanceType<typeof ui.FakeElement> | undefined => {
    if (element.textContent === text) return element;
    for (const child of element.children) { const found = visit(child); if (found) return found; }
    return undefined;
  };
  const result = visit(root);
  if (!result) throw new Error(`No element with text: ${text}`);
  return result;
}

function findSettingInput(root: InstanceType<typeof ui.FakeElement>, name: string): InstanceType<typeof ui.FakeElement> {
  const rows = root.children.flatMap(function visit(element): InstanceType<typeof ui.FakeElement>[] {
    return [element, ...element.children.flatMap(visit)];
  }).filter((element) => element.getAttribute("data-setting-name") === name);
  const input = rows[0]?.querySelector("input");
  if (!input) throw new Error(`No input for setting: ${name}`);
  return input;
}

function findButton(root: InstanceType<typeof ui.FakeElement>, text: string): InstanceType<typeof ui.FakeElement> {
  const button = root.children.flatMap(function visit(element): InstanceType<typeof ui.FakeElement>[] {
    return [element, ...element.children.flatMap(visit)];
  }).find((element) => element.tagName === "button" && element.textContent === text);
  if (!button) throw new Error(`No button with text: ${text}`);
  return button;
}

async function createPlugin() {
  const secrets = new Map<string, string>();
  const app = {
    secretStorage: { getSecret: (key: string) => secrets.get(key) ?? null, setSecret: (key: string, value: string) => secrets.set(key, value) },
    workspace: { onLayoutReady: () => {}, getActiveViewOfType: () => null },
    vault: { adapter: { exists: async () => false, read: async () => "" }, configDir: ".obsidian" },
  };
  const plugin = new EasySyncPlugin(app as never, {} as never);
  await plugin.onload();
  const tab = (plugin as unknown as { settingTabs: Array<{ display: () => void; hide: () => void; containerEl: InstanceType<typeof ui.FakeElement> }> }).settingTabs[0];
  tab.display();
  return { plugin, tab, app, secrets };
}

afterEach(() => {
  ui.reset();
  connectVault.mockClear();
  vi.unstubAllGlobals();
});

describe("settings UI interactions", () => {
  it("shows a reactive attachment settings action for configuration and transfer errors", async () => {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", {});
    const { plugin, tab } = await createPlugin();
    const action = findButton(tab.containerEl, "Check attachment settings");
    expect(action.hidden).toBe(true);

    plugin.status.connectionState = "UNCONFIGURED";
    plugin.status.attachmentState = "CONFIGURATION_ERROR";
    plugin.status.attachmentError = "Incomplete S3 setup";
    plugin.status.refresh();
    expect(action.hidden).toBe(false);
    expect(findButton(tab.containerEl, "Import settings")).toBeDefined();

    plugin.status.connectionState = "CONNECTED";
    plugin.status.attachmentState = "TRANSFER_ERROR";
    plugin.status.attachmentError = "Object transfer failed";
    plugin.status.refresh();
    expect(action.hidden).toBe(false);
    expect(findButton(tab.containerEl, "Check attachment settings")).toBe(action);

    plugin.status.attachmentState = "NOT_CONFIGURED";
    plugin.status.attachmentError = "";
    plugin.status.refresh();
    expect(action.hidden).toBe(true);

    plugin.status.attachmentState = "TRANSFER_ERROR";
    plugin.status.attachmentError = "Object transfer failed";
    plugin.status.refresh();
    action.click();
    await vi.waitFor(() => expect(tab.containerEl.querySelector("[role=tabpanel]")?.id).toBe("flash-sync-panel-attachments"));
  });

  it("validates an empty Connection draft before connect and focuses the first invalid field", async () => {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", {});
    const { plugin, tab } = await createPlugin();
    expect(findText(tab.containerEl, "flash-sync").tagName).toBe("h2");
    const sectionLabel = findText(tab.containerEl, "Settings section");
    expect(sectionLabel.tagName).toBe("label");
    expect(sectionLabel.getAttribute("for")).toBe("flash-sync-section-select");

    findText(tab.containerEl, "Manual setup").click();
    const panel = tab.containerEl.querySelector("[role=tabpanel]") ?? tab.containerEl;
    findText(panel, "Save and reconnect").click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Enter a secure WSS URL"));

    expect(ui.getFocused()).toBe(findSettingInput(panel, "NATS WSS URL"));
    expect(plugin.config.server).toBe("");
    expect(connectVault).not.toHaveBeenCalled();
    expect(ui.notices).toEqual([]);
  });

  it("keeps dirty input across status refresh, preserves focus through keyboard tab navigation, and supports keep/discard", async () => {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", {});
    const { plugin, tab } = await createPlugin();
    tab.containerEl.querySelectorAll('button[role="tab"]')[0].dispatch("keydown", { key: "ArrowRight" });
    await vi.waitFor(() => expect(ui.getFocused()).toBe(tab.containerEl.querySelectorAll('button[role="tab"]')[1]));
    const panel = tab.containerEl.querySelector("[role=tabpanel]")!;
    const server = findSettingInput(panel, "NATS WSS URL");
    server.value = "wss://draft.example.test";
    server.dispatch("input");

    plugin.status.connectionState = "OFFLINE";
    plugin.status.refresh();
    expect(findSettingInput(panel, "NATS WSS URL").value).toBe("wss://draft.example.test");

    const connectionTab = tab.containerEl.querySelectorAll('button[role="tab"]')[1];
    connectionTab.dispatch("keydown", { key: "ArrowRight" });
    await vi.waitFor(() => expect(ui.modals).toHaveLength(1));
    findText(ui.modals[0].contentEl, "Keep editing").click();
    await vi.waitFor(() => expect(ui.getFocused()).toBe(tab.containerEl.querySelectorAll('button[role="tab"]')[1]));
    expect(tab.containerEl.querySelector("[role=tabpanel]")?.id).toBe("flash-sync-panel-connection");

    tab.containerEl.querySelectorAll('button[role="tab"]')[0].click();
    await vi.waitFor(() => expect(ui.modals).toHaveLength(2));
    findText(ui.modals[1].contentEl, "Discard").click();
    await vi.waitFor(() => expect(tab.containerEl.querySelectorAll('button[role="tab"]')[0].getAttribute("aria-selected")).toBe("true"));
    expect(tab.containerEl.textContent).toContain("Sync overview");
    expect(plugin.config.server).toBe("");

    findButton(tab.containerEl, "Edit connection").click();
    const connectionPanel = tab.containerEl.querySelector("[role=tabpanel]")!;
    const draftServer = findSettingInput(connectionPanel, "NATS WSS URL");
    draftServer.value = "wss://discard-on-close.example.test";
    draftServer.dispatch("input");
    tab.hide();
    tab.display();
    tab.containerEl.querySelectorAll('button[role="tab"]')[1].click();
    expect(findSettingInput(tab.containerEl, "NATS WSS URL").value).toBe("");
  });

  it("previews imported settings without exposing secrets or saving before explicit import", async () => {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", {});
    const { plugin, tab, secrets } = await createPlugin();
    const before = { ...plugin.config };
    const transfer: TransferConfig = { vaultId: "IMPORT_VAULT", server: "wss://sync.example.test", username: "alice",
      natsPassword: "nats-preview-secret", s3Endpoint: "https://s3.example.test", s3Bucket: "attachments",
      s3Region: "eu-west-1", s3AccessKeyId: "access-preview-secret", s3SecretKey: "s3-preview-secret", inlineLimit: 262144 };
    const code = await encryptTransfer(transfer, "");

    findButton(tab.containerEl, "Import settings").click();
    const modal = ui.modals.at(-1)!;
    const textarea = modal.contentEl.querySelector("textarea")!;
    textarea.value = code;
    textarea.dispatch("input");
    findButton(modal.contentEl, "Preview settings").click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain("Vault: IMPORT_VAULT"));

    expect(modal.contentEl.textContent).toContain("Server: wss://sync.example.test");
    expect(modal.contentEl.textContent).toContain("Attachments: attachments (https://s3.example.test)");
    expect(modal.contentEl.textContent).not.toContain(transfer.natsPassword);
    expect(modal.contentEl.textContent).not.toContain(transfer.s3AccessKeyId);
    expect(modal.contentEl.textContent).not.toContain(transfer.s3SecretKey);
    expect(modal.contentEl.textContent).toContain("Import and connect");
    expect(plugin.config).toEqual(before);
    expect(secrets.size).toBe(0);
    expect(connectVault).not.toHaveBeenCalled();
  });

  it("starts QR export protected and only removes phrase requirement after explicit opt-out", async () => {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("window", {});
    const { tab } = await createPlugin();
    tab.containerEl.querySelectorAll('button[role="tab"]')[3].click();
    const panel = tab.containerEl.querySelector("[role=tabpanel]")!;
    findButton(panel, "Export").click();
    expect(panel.textContent).toContain("Create protected QR");
    findButton(panel, "Create protected QR").click();

    const modal = ui.modals.at(-1)!;
    const checkbox = modal.contentEl.querySelectorAll("input").find((input) => input.getAttribute("type") === "checkbox")!;
    expect(checkbox.checked).toBe(false);
    findButton(modal.contentEl, "Create QR").click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain("at least eight characters"));

    checkbox.checked = true;
    checkbox.dispatch("change");
    expect(modal.contentEl.textContent).toContain("Unprotected — contains readable credentials.");
    findButton(modal.contentEl, "Create QR").click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain("NATS password is missing"));
    expect(modal.contentEl.children[2].textContent).not.toContain("at least eight characters");
  });
});
