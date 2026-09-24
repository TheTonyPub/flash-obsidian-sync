## Why

Provisioning creates the vault credentials that make a client usable, but the current handoff is plaintext instructions rather than a direct Obsidian import link and QR code. Operators also need a safe way to regenerate that handoff for a vault whose credential was deliberately retained locally, without exposing administrator access or recovering secrets from server password hashes.

## What Changes

- Generate an Obsidian import URI and terminal QR code after successful bootstrap and vault-user add or rotation, containing the vault ID, validated WSS endpoint, vault credential, empty optional S3 configuration, and the default inline limit.
- Add optional `--wss-endpoint` to vault-user creation and rotation. It overrides the managed bootstrap endpoint; an interactive command prompts when no endpoint is available, while unattended execution requires a supplied endpoint.
- Add `--keep` to persist a newly generated vault credential in the CLI-managed protected credential store. Without it, show the import handoff once and retain no vault plaintext credential.
- Persist bootstrap administrator credentials separately in the protected store, while persisting the first vault credential only when bootstrap receives `--keep`.
- Add read-only `fos import --vault-id <id>` to regenerate an import URI and QR code from a saved vault credential. It accepts an optional endpoint override and fails with rotation guidance when no saved vault plaintext credential exists.
- Extend the plugin import format so an empty encryption phrase produces an explicit plaintext version and a nonempty phrase continues to use encrypted version 1 payloads with the existing minimum eight-character phrase rule. Imported NATS passwords remain in Obsidian SecretStorage.
- Define credential retention, rotation, revocation, and redaction behavior for the new local store and handoff paths.

## Capabilities

### New Capabilities

- `credential-import-handoff`: Generate and consume versioned Obsidian credential import payloads and regenerate a vault handoff from an operator-retained credential.

### Modified Capabilities

- `vault-provisioning`: Require endpoint-aware QR/link handoff, opt-in vault credential retention, and safe lifecycle behavior for generated credentials.

## Impact

Affected CLI argument parsing, bootstrap and vault-user orchestration, protected local secret persistence, QR rendering, plugin transfer-code parsing/import UI, SecretStorage integration, and unit/integration tests. No deployment automation, server configuration discovery, or server-side secret recovery is introduced; runtime operations remain user-owned.
