import { performance } from "node:perf_hooks";

export interface DomainTlsAdapter {
  resolveDomain(domain: string): Promise<readonly string[]>;
  portReachable(port: 80 | 443): Promise<boolean>;
  verifyCertificate(domain: string, timeoutMs?: number): Promise<boolean>;
  verifyWss(url: string, timeoutMs?: number): Promise<boolean>;
}

export interface DomainEndpoint {
  url: string;
}

export interface EndpointReadinessOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable monotonic clock and wait function for deterministic verification tests. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DomainProxyConfiguration {
  domain: string;
  caddyfile: string;
  natsConfig: string;
  /** True only when no NATS port is host-published or publicly routed. */
  natsPrivate: boolean;
}

const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;
const ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

export function renderDomainCaddyfile(domain: string, upstream: string, email = "mail@hello.com"): string {
  if (!/^[^\s{}@]+@[^\s{}@]+$/.test(email)) throw new Error("CADDY_EMAIL_INVALID");
  return `{
    acme_ca ${ACME_DIRECTORY}
    email   ${email}
}
${domain} {
  reverse_proxy ${upstream}
}
`;
}

async function waitForReadiness(check: (timeoutMs: number) => Promise<boolean>, failureCode: string, deadline: number,
  options: { now: () => number; sleep: (milliseconds: number) => Promise<void>; delayMs: number; maxDelayMs: number }): Promise<number> {
  let delayMs = options.delayMs;
  while (options.now() < deadline) {
    const remainingMs = deadline - options.now();
    if (remainingMs < 1) break;
    if (await check(Math.floor(remainingMs))) {
      if (options.now() < deadline) return delayMs;
      break;
    }
    const sleepMs = deadline - options.now();
    if (sleepMs <= 0) break;
    await options.sleep(Math.min(delayMs, sleepMs));
    delayMs = Math.min(delayMs * 2, options.maxDelayMs);
  }
  throw new Error(failureCode);
}

export async function verifyDomainEndpoint(domain: string, host: DomainTlsAdapter, readiness: EndpointReadinessOptions = {}): Promise<DomainEndpoint> {
  if ((await host.resolveDomain(domain)).length === 0) throw new Error("DOMAIN_DNS_UNRESOLVED");
  if (!await host.portReachable(80)) throw new Error("HTTP_PORT_UNREACHABLE");
  if (!await host.portReachable(443)) throw new Error("HTTPS_PORT_UNREACHABLE");
  const timeoutMs = readiness.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const initialDelayMs = readiness.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = readiness.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(initialDelayMs) || initialDelayMs <= 0
    || !Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) throw new Error("ENDPOINT_READINESS_OPTIONS_INVALID");
  const now = readiness.now ?? (() => performance.now());
  const sleep = readiness.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  const waitOptions = { now, sleep, delayMs: initialDelayMs, maxDelayMs };
  const nextDelay = await waitForReadiness((remainingMs) => host.verifyCertificate(domain, remainingMs), "TLS_CERTIFICATE_UNVERIFIED", deadline, waitOptions);
  const url = `wss://${domain}`;
  await waitForReadiness((remainingMs) => host.verifyWss(url, remainingMs), "WSS_ENDPOINT_UNVERIFIED", deadline, { ...waitOptions, delayMs: nextDelay });
  return { url };
}

export function inspectDomainProxyConfiguration(config: DomainProxyConfiguration): void {
  if (!/^\{\s*acme_ca\s+https:\/\/acme-v02\.api\.letsencrypt\.org\/directory\s+email\s+[^\s{}]+\s*\}/m.test(config.caddyfile)) {
    throw new Error("CADDY_ACME_CONFIGURATION_MISSING");
  }
  const domainBlock = new RegExp(`^${escapeRegExp(config.domain)}\\s*\\{`, "m");
  if (!domainBlock.test(config.caddyfile)) throw new Error("CADDY_DOMAIN_MISMATCH");
  if (!/reverse_proxy\s+(?:127\.0\.0\.1|nats):9222\b/.test(config.caddyfile)) {
    throw new Error("CADDY_WSS_PROXY_MISSING");
  }
  if (/\b(?:handle|route|@\w+\s+path)\b[^\n]*\/monitoring|reverse_proxy\s+(?:127\.0\.0\.1|nats):8222\b/.test(config.caddyfile)) {
    throw new Error("PUBLIC_MONITORING_ROUTE");
  }
  if (!config.natsPrivate) throw new Error("NATS_NETWORK_NOT_PRIVATE");
  if (!/websocket\s*\{[\s\S]*?listen:\s*"(?:127\.0\.0\.1|0\.0\.0\.0):9222"/.test(config.natsConfig)) {
    throw new Error("NATS_WEBSOCKET_CONFIG_INVALID");
  }
  if (!/no_tls:\s*true/.test(config.natsConfig)) throw new Error("NATS_PROXY_TLS_CONFIG_INVALID");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
