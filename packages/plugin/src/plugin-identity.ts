export const PLUGIN_ID = "flash-sync";

export type ImportUriHandler = (params: { data?: string }) => void;
export type ImportUriRegistrar = (scheme: string, handler: ImportUriHandler) => void;

export function registerImportUriHandlers(register: ImportUriRegistrar, receive: (data: string) => void): void {
  register(`${PLUGIN_ID}-import`, (params) => receive(params.data ?? ""));
}
