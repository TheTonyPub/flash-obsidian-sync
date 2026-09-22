import { describe, expect, it, vi } from "vitest";
import {
  inspectDomainProxyConfiguration,
  verifyDomainEndpoint,
  type DomainTlsAdapter,
  type EndpointReadinessOptions,
} from "../../packages/server-cli/src/tls.js";

function endpointHost(overrides: Partial<DomainTlsAdapter> = {}): DomainTlsAdapter {
  return {
    resolveDomain: vi.fn().mockResolvedValue(["203.0.113.10"]),
    portReachable: vi.fn().mockResolvedValue(true),
    verifyCertificate: vi.fn().mockResolvedValue(true),
    verifyWss: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function readinessClock(timeoutMs = 1_000) {
  let time = 0;
  const sleep = vi.fn(async (milliseconds: number) => { time += milliseconds; });
  const options: EndpointReadinessOptions = { timeoutMs, initialDelayMs: 100, maxDelayMs: 200, now: () => time, sleep };
  return { options, sleep };
}

describe("fos domain endpoint verification", () => {
  it("requires DNS and public HTTP/HTTPS reachability before certificate verification", async () => {
    const unresolved = endpointHost({ resolveDomain: vi.fn().mockResolvedValue([]) });
    await expect(verifyDomainEndpoint("sync.example.test", unresolved)).rejects.toThrow("DOMAIN_DNS_UNRESOLVED");
    expect(unresolved.portReachable).not.toHaveBeenCalled();

    const httpBlocked = endpointHost({ portReachable: vi.fn().mockResolvedValueOnce(false) });
    await expect(verifyDomainEndpoint("sync.example.test", httpBlocked)).rejects.toThrow("HTTP_PORT_UNREACHABLE");
    expect(httpBlocked.portReachable).toHaveBeenCalledWith(80);

    const httpsBlocked = endpointHost({ portReachable: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    await expect(verifyDomainEndpoint("sync.example.test", httpsBlocked)).rejects.toThrow("HTTPS_PORT_UNREACHABLE");
    expect(httpsBlocked.portReachable).toHaveBeenNthCalledWith(2, 443);
  });

  it("reports Caddy certificate-acquisition failure and never accepts unverified TLS/WSS", async () => {
    const certificateFailed = endpointHost({ verifyCertificate: vi.fn().mockResolvedValue(false) });
    const certificateClock = readinessClock(250);
    await expect(verifyDomainEndpoint("sync.example.test", certificateFailed, certificateClock.options)).rejects.toThrow("TLS_CERTIFICATE_UNVERIFIED");
    expect(certificateFailed.verifyWss).not.toHaveBeenCalled();

    const wssFailed = endpointHost({ verifyWss: vi.fn().mockResolvedValue(false) });
    const wssClock = readinessClock(250);
    await expect(verifyDomainEndpoint("sync.example.test", wssFailed, wssClock.options)).rejects.toThrow("WSS_ENDPOINT_UNVERIFIED");
    expect(wssFailed.verifyWss).toHaveBeenCalledWith("wss://sync.example.test", 250);
  });

  it("retries only certificate and WSS readiness with exponential backoff", async () => {
    const verifyCertificate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const verifyWss = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const host = endpointHost({
      verifyCertificate,
      verifyWss,
    });
    const clock = readinessClock();

    await expect(verifyDomainEndpoint("sync.example.test", host, clock.options)).resolves.toEqual({ url: "wss://sync.example.test" });
    expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200, 200]);
    expect(host.resolveDomain).toHaveBeenCalledTimes(1);
    expect(host.portReachable).toHaveBeenCalledTimes(2);
    expect(host.verifyCertificate).toHaveBeenCalledTimes(3);
    expect(host.verifyWss).toHaveBeenCalledTimes(2);
    expect(verifyCertificate.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([1_000, 900, 700]);
    expect(verifyWss.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([700, 500]);
  });

  it("stops certificate retries at the shared readiness deadline", async () => {
    const verifyCertificate = vi.fn().mockResolvedValue(false);
    const host = endpointHost({ verifyCertificate });
    const clock = readinessClock(350);

    await expect(verifyDomainEndpoint("sync.example.test", host, clock.options)).rejects.toThrow("TLS_CERTIFICATE_UNVERIFIED");
    expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200, 50]);
    expect(host.resolveDomain).toHaveBeenCalledTimes(1);
    expect(host.portReachable).toHaveBeenCalledTimes(2);
    expect(host.verifyWss).not.toHaveBeenCalled();
    expect(verifyCertificate.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([350, 250, 50]);
  });

  it("stops WSS retries at the same readiness deadline after verified TLS", async () => {
    const verifyWss = vi.fn().mockResolvedValue(false);
    const host = endpointHost({ verifyWss });
    const clock = readinessClock(250);

    await expect(verifyDomainEndpoint("sync.example.test", host, clock.options)).rejects.toThrow("WSS_ENDPOINT_UNVERIFIED");
    expect(clock.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 150]);
    expect(host.verifyCertificate).toHaveBeenCalledTimes(1);
    expect(host.verifyWss).toHaveBeenCalledTimes(2);
    expect(host.verifyCertificate).toHaveBeenCalledWith("sync.example.test", 250);
    expect(verifyWss.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([250, 150]);
  });

  it("accepts a verified public TLS endpoint only after WSS succeeds", async () => {
    const host = endpointHost();
    await expect(verifyDomainEndpoint("sync.example.test", host)).resolves.toEqual({ url: "wss://sync.example.test" });
  });
});

describe("fos generated domain proxy configuration", () => {
  const caddyfile = `{
    acme_ca https://acme-v02.api.letsencrypt.org/directory
    email   mail@hello.com
}
sync.example.test {
  reverse_proxy nats:9222
}
`;
  const natsConfig = `http_port: 8222
websocket {
  listen: "0.0.0.0:9222"
  no_tls: true
}
`;

  it("allows only the domain WSS proxy when NATS remains on a private network", () => {
    expect(() => inspectDomainProxyConfiguration({
      domain: "sync.example.test", caddyfile, natsConfig, natsPrivate: true,
    })).not.toThrow();
  });

  it("requires the configured Let's Encrypt ACME endpoint in a Caddy global block", () => {
    expect(() => inspectDomainProxyConfiguration({
      domain: "sync.example.test",
      caddyfile: caddyfile.replace("acme_ca https://acme-v02.api.letsencrypt.org/directory\n", ""),
      natsConfig,
      natsPrivate: true,
    })).toThrow("CADDY_ACME_CONFIGURATION_MISSING");
  });

  it("rejects public monitoring and public NATS exposure without assuming a Caddy path rewrite", () => {
    expect(() => inspectDomainProxyConfiguration({
      domain: "sync.example.test",
      caddyfile: caddyfile.replace("sync.example.test {", "sync.example.test {\n  handle /monitoring* { reverse_proxy nats:8222 }").replace("  reverse_proxy nats:9222", "  reverse_proxy nats:9222"),
      natsConfig,
      natsPrivate: true,
    })).toThrow("PUBLIC_MONITORING_ROUTE");

    expect(() => inspectDomainProxyConfiguration({
      domain: "sync.example.test", caddyfile, natsConfig, natsPrivate: false,
    })).toThrow("NATS_NETWORK_NOT_PRIVATE");

    expect(() => inspectDomainProxyConfiguration({
      domain: "sync.example.test", caddyfile, natsConfig: `${natsConfig}http_base_path: "/monitoring"\n`, natsPrivate: true,
    })).not.toThrow();
  });
});
