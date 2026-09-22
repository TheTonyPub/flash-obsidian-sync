import { describe, expect, it, vi } from "vitest";
import { applyFirewallOption, applyServiceIdentity, planHostOptions, type HostOptionsAdapter } from "../../packages/server-cli/src/host-options.js";

function host(overrides: Partial<HostOptionsAdapter> = {}): HostOptionsAdapter {
  return {
    activeSshPort: vi.fn().mockResolvedValue(2222),
    previewFirewall: vi.fn().mockResolvedValue(undefined),
    applyFirewall: vi.fn().mockResolvedValue(undefined),
    verifySsh: vi.fn().mockResolvedValue(true),
    rollbackFirewall: vi.fn().mockResolvedValue(undefined),
    identityExists: vi.fn().mockResolvedValue(true),
    createDedicatedIdentity: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("fos optional host controls", () => {
  it("leaves firewall and identities untouched unless explicitly selected", async () => {
    const options = planHostOptions({ firewall: { enabled: false }, identity: { kind: "existing", user: "sync", group: "sync" } });
    const adapter = host();
    await applyFirewallOption(options.firewall, adapter);
    expect(adapter.previewFirewall).not.toHaveBeenCalled();
    expect(adapter.applyFirewall).not.toHaveBeenCalled();
  });

  it("preserves active SSH port and requires confirmation before firewall changes", async () => {
    const adapter = host();
    const options = planHostOptions({ firewall: { enabled: true, confirmed: false }, identity: { kind: "existing", user: "sync", group: "sync" } });
    await expect(applyFirewallOption(options.firewall, adapter)).rejects.toThrow("FIREWALL_CONFIRMATION_REQUIRED");
    expect(adapter.applyFirewall).not.toHaveBeenCalled();

    await applyFirewallOption({ enabled: true, confirmed: true }, adapter);
    expect(adapter.previewFirewall).toHaveBeenCalledWith([2222, 80, 443]);
    expect(adapter.applyFirewall).toHaveBeenCalledWith([2222, 80, 443]);
    expect(adapter.verifySsh).toHaveBeenCalledWith(2222);
  });

  it("rolls firewall back if SSH cannot be verified and gates dedicated identities", async () => {
    const firewall = host({ verifySsh: vi.fn().mockResolvedValue(false) });
    await expect(applyFirewallOption({ enabled: true, confirmed: true }, firewall)).rejects.toThrow("SSH_PRESERVATION_FAILED");
    expect(firewall.rollbackFirewall).toHaveBeenCalledOnce();

    const identity = host();
    await expect(applyServiceIdentity({ kind: "dedicated", confirmed: false }, identity)).rejects.toThrow("IDENTITY_CONFIRMATION_REQUIRED");
    expect(identity.createDedicatedIdentity).not.toHaveBeenCalled();
    await applyServiceIdentity({ kind: "dedicated", confirmed: true }, identity);
    expect(identity.createDedicatedIdentity).toHaveBeenCalledWith("fos-nats", "fos-nats");
    expect(identity.createDedicatedIdentity).toHaveBeenCalledWith("fos-caddy", "fos-caddy");
  });
});
