export interface SettingsDraftValues {
  vaultId: string;
  server: string;
  username: string;
  hasPassword: boolean;
  attachmentsEnabled: boolean;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  hasS3Secret: boolean;
  inlineLimitKiB: number;
}

export type SettingsField = keyof SettingsDraftValues;
export type SettingsValidationErrors = Partial<Record<SettingsField, string>>;

export interface SettingsValidationResult {
  configured: boolean;
  attachmentsConfigured: boolean;
  errors: SettingsValidationErrors;
  inlineLimit: number;
}

export function validateSettingsDraft(values: SettingsDraftValues, requireConnection = false): SettingsValidationResult {
  const errors: SettingsValidationErrors = {};
  const connectionStarted = requireConnection || Boolean(values.server || values.username || values.hasPassword);
  if (!/^[A-Za-z0-9_-]+$/.test(values.vaultId)) errors.vaultId = "Use letters, numbers, underscores, or hyphens.";
  if (connectionStarted) {
    let secureServer = false;
    try {
      const url = new URL(values.server);
      secureServer = url.protocol === "wss:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch { /* Report invalid URL below. */ }
    if (!secureServer) errors.server = "Enter a secure WSS URL without embedded credentials.";
    if (!values.username.trim()) errors.username = "Username is required.";
    if (!values.hasPassword) errors.hasPassword = "Password is required.";
  }

  const attachmentsStarted = values.attachmentsEnabled || Boolean(values.s3Endpoint || values.s3Bucket || values.s3AccessKeyId || values.hasS3Secret ||
    (values.s3Region && values.s3Region !== "us-east-1"));
  if (attachmentsStarted) {
    let secureEndpoint = false;
    try {
      const url = new URL(values.s3Endpoint);
      secureEndpoint = url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch { /* Report invalid endpoint below. */ }
    if (!secureEndpoint) errors.s3Endpoint = "Enter an HTTPS endpoint without embedded credentials.";
    if (!values.s3Bucket.trim()) errors.s3Bucket = "Bucket is required.";
    if (!values.s3Region.trim()) errors.s3Region = "Region is required.";
    if (!values.s3AccessKeyId.trim()) errors.s3AccessKeyId = "Access key ID is required.";
    if (!values.hasS3Secret) errors.hasS3Secret = "Secret key is required.";
  }
  const inlineLimit = Math.round(values.inlineLimitKiB * 1024);
  if (!Number.isSafeInteger(inlineLimit) || inlineLimit <= 0) errors.inlineLimitKiB = "Enter a positive whole number of KiB.";

  return {
    configured: connectionStarted && !errors.server && !errors.username && !errors.hasPassword && !errors.vaultId,
    attachmentsConfigured: attachmentsStarted && !errors.s3Endpoint && !errors.s3Bucket && !errors.s3Region &&
      !errors.s3AccessKeyId && !errors.hasS3Secret,
    errors,
    inlineLimit,
  };
}
