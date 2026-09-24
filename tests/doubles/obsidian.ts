export const pluginInstances: Plugin[] = [];

export class Plugin {
  savedData: unknown = null;

  constructor(readonly app: unknown) { pluginInstances.push(this); }

  async loadData(): Promise<unknown> { return this.savedData; }
  async saveData(data: unknown): Promise<void> { this.savedData = data; }
  addStatusBarItem(): { setText: (_text: string) => void } { return { setText: () => {} }; }
  addSettingTab(): void {}
  register(): void {}
  registerObsidianProtocolHandler(): void {}
  registerEditorExtension(): void {}
  registerDomEvent(): void {}
}

export class PluginSettingTab {
  constructor(readonly app: unknown, readonly plugin: unknown) {}
}

export class Modal {
  constructor(readonly app: unknown) {}
}

export class Notice {}
export class Setting {}
export class SecretComponent {}
export class MarkdownView {}
export class TFile {}
