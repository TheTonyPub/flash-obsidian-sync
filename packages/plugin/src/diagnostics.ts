export type LogFields = Record<string, string | number | boolean | undefined>;

export interface PluginLogger {
  debug(event: string, fields?: LogFields): void;
  error(event: string, cause: unknown, fields?: LogFields): void;
}

function redact(text: string): string {
  return text.replace(/\b(?:wss?|https?):\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch { return "[URL redacted]"; }
  });
}

export function errorSummary(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !visited.has(current) && messages.length < 5) {
    visited.add(current);
    messages.push(redact(current instanceof Error ? current.message : String(current)));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.filter(Boolean).join(" → ") || "Unknown error";
}

export function createLogger(debugEnabled: () => boolean, sink: Pick<Console, "debug" | "error"> = console): PluginLogger {
  return {
    debug(event, fields) {
      if (debugEnabled()) sink.debug(`[flash-osidian-sync] ${event}`, fields ?? {});
    },
    error(event, cause, fields) {
      sink.error(`[flash-osidian-sync] ${event}: ${errorSummary(cause)}`, fields ?? {});
    },
  };
}
