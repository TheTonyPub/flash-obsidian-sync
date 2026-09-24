import { describe, expect, it } from "vitest";
import { validateSettingsDraft, type SettingsDraftValues } from "../../packages/plugin/src/settings-validation.js";

const defaults: SettingsDraftValues = {
  vaultId: "VAULT_1", server: "", username: "", hasPassword: false, attachmentsEnabled: false,
  s3Endpoint: "", s3Bucket: "", s3Region: "us-east-1", s3AccessKeyId: "", hasS3Secret: false,
  inlineLimitKiB: 512,
};

describe("settings draft validation", () => {
  it("allows an unconfigured connection and optional attachments", () => {
    const result = validateSettingsDraft(defaults);
    expect(result.errors).toEqual({});
    expect(result.configured).toBe(false);
    expect(result.attachmentsConfigured).toBe(false);
    expect(result.inlineLimit).toBe(512 * 1024);
  });

  it("reports incomplete connection and partial attachment fields independently", () => {
    const result = validateSettingsDraft({ ...defaults, server: "http://sync.example", s3Endpoint: "https://s3.example" });
    expect(result.errors).toMatchObject({ server: expect.any(String), username: expect.any(String),
      hasPassword: expect.any(String), s3Bucket: expect.any(String), s3AccessKeyId: expect.any(String),
      hasS3Secret: expect.any(String) });
    expect(result.configured).toBe(false);
    expect(result.attachmentsConfigured).toBe(false);
  });

  it("accepts complete secure settings and converts displayed KiB to bytes", () => {
    const result = validateSettingsDraft({ ...defaults, server: "wss://sync.example", username: "alice",
      hasPassword: true, attachmentsEnabled: true, s3Endpoint: "https://s3.example", s3Bucket: "vault", s3AccessKeyId: "access",
      hasS3Secret: true, inlineLimitKiB: 256 });
    expect(result.errors).toEqual({});
    expect(result.configured).toBe(true);
    expect(result.attachmentsConfigured).toBe(true);
    expect(result.inlineLimit).toBe(256 * 1024);
  });

  it("does not treat a default region alone as configured S3", () => {
    const result = validateSettingsDraft({ ...defaults, s3Region: "us-east-1" });
    expect(result.errors).toEqual({});
    expect(result.attachmentsConfigured).toBe(false);
  });

  it("treats a non-default region without the remaining S3 fields as partial configuration", () => {
    const result = validateSettingsDraft({ ...defaults, s3Region: "eu-west-1" });
    expect(result.errors).toMatchObject({ s3Endpoint: expect.any(String), s3Bucket: expect.any(String),
      s3AccessKeyId: expect.any(String), hasS3Secret: expect.any(String) });
  });

  it("rejects incomplete secure URLs and URLs with embedded credentials", () => {
    expect(validateSettingsDraft({ ...defaults, server: "wss://", username: "alice", hasPassword: true }).errors.server)
      .toMatch(/secure WSS/);
    expect(validateSettingsDraft({ ...defaults, server: "wss://alice:secret@sync.example", username: "alice", hasPassword: true }).errors.server)
      .toMatch(/embedded credentials/);
    expect(validateSettingsDraft({ ...defaults, s3Endpoint: "https://user:secret@s3.example", s3Bucket: "vault",
      s3AccessKeyId: "access", hasS3Secret: true }).errors.s3Endpoint).toMatch(/embedded credentials/);
  });

  it("requires a complete connection when the Connection section is applied", () => {
    const result = validateSettingsDraft(defaults, true);
    expect(result.errors).toMatchObject({ server: expect.any(String), username: expect.any(String), hasPassword: expect.any(String) });
  });

  it("reports missing S3 fields after the user enables attachment configuration", () => {
    const result = validateSettingsDraft({ ...defaults, attachmentsEnabled: true });
    expect(result.errors).toMatchObject({ s3Endpoint: expect.any(String), s3Bucket: expect.any(String),
      s3AccessKeyId: expect.any(String), hasS3Secret: expect.any(String) });
  });
});
