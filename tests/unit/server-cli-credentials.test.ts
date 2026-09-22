import { describe, expect, it, vi } from "vitest";
import {
  createCredentialHandoff,
  formatSecretHandoff,
  generateBootstrapCredentials,
  renderNatsAuthorization,
  verifyCredentialPassword,
} from "../../packages/server-cli/src/credentials.js";

const randomSequence = (): (() => Uint8Array) => {
  let next = 0;
  return () => Uint8Array.from({ length: 32 }, () => next++);
};

describe("fos credential lifecycle", () => {
  it("generates distinct 256-bit administrator and vault passwords with bcrypt hashes", () => {
    const credentials = generateBootstrapCredentials("notes", randomSequence());

    expect(credentials.administrator.username).toBe("fos-admin");
    expect(credentials.vault.username).toBe("fos-vault-notes");
    expect(credentials.administrator.password).toHaveLength(43);
    expect(credentials.vault.password).toHaveLength(43);
    expect(credentials.administrator.password).not.toBe(credentials.vault.password);
    expect(credentials.administrator.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(credentials.vault.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(verifyCredentialPassword(credentials.administrator)).toBe(true);
    expect(verifyCredentialPassword(credentials.vault)).toBe(true);
  });

  it("renders bcrypt hashes only into managed NATS authorization", () => {
    const credentials = generateBootstrapCredentials("notes", randomSequence());
    const config = renderNatsAuthorization(credentials);

    expect(config).toContain('user: "fos-admin"');
    expect(config).toContain('user: "fos-vault-notes"');
    expect(config).toContain('password: "$2');
    expect(config).not.toContain(credentials.administrator.password);
    expect(config).not.toContain(credentials.vault.password);
    expect(config).not.toContain("bcrypt:");
    expect(config).toContain('$KV.OBS_notes_FILES.>');
    expect(config).toContain('$JS.API.STREAM.INFO.KV_OBS_notes_FILES');
    expect(config).toContain('subscribe: { allow: ["_INBOX.>", "$KV.OBS_notes_FILES.>"] }');
  });

  it("discloses secrets once through an interactive writer", async () => {
    const credentials = generateBootstrapCredentials("notes", randomSequence());
    const handoff = createCredentialHandoff(credentials);
    const output = vi.fn();

    await handoff.discloseInteractive(output);
    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(formatSecretHandoff(credentials));
    await expect(handoff.discloseInteractive(output)).rejects.toThrow("SECRETS_ALREADY_DELIVERED");
  });

  it("writes unattended secrets once with root-owned 0600 permissions", async () => {
    const credentials = generateBootstrapCredentials("notes", randomSequence());
    const handoff = createCredentialHandoff(credentials);
    const output = { writeFileAtomically: vi.fn().mockResolvedValue(undefined) };

    await handoff.writeUnattended("/root/fos-secrets", output);
    expect(output.writeFileAtomically).toHaveBeenCalledWith(
      "/root/fos-secrets", formatSecretHandoff(credentials), { owner: 0, mode: 0o600 },
    );
    await expect(handoff.writeUnattended("/root/fos-secrets", output)).rejects.toThrow("SECRETS_ALREADY_DELIVERED");
  });
});
