## 1. Transfer-payload contract tests

- [x] 1.1 **Owner: gpt-5.6-luna medium.** Extend the configuration-transfer unit tests with failing cases for explicit plaintext version 2, retained encrypted version 1, phrase boundaries, unknown versions, malformed payloads, and validation before settings mutation.
- [x] 1.2 **Owner: gpt-5.6-luna medium.** Add failing plugin import tests proving NATS and optional S3 secrets enter SecretStorage only, bound-vault mismatch preserves existing state, and valid plaintext/encrypted imports attempt connection.

## 2. Versioned plugin transfer implementation

- [x] 2.1 **Owner: gpt-5.6-terra low.** Implement strict version dispatch and plaintext version-2 encoding/decoding while preserving version-1 encrypted behavior and the eight-character nonempty phrase requirement.
- [x] 2.2 **Owner: gpt-5.6-terra low.** Adapt the plugin import flow and UI to select the required phrase behavior by payload version, retain SecretStorage boundaries, and show actionable invalid-import errors.
- [x] 2.3 **Owner: gpt-5.6-luna medium.** Run the targeted configuration-transfer and plugin identity/import tests; fix only failures attributable to this change.

## 3. Protected CLI credential-store tests

- [x] 3.1 **Owner: gpt-5.6-luna medium.** Add failing server-CLI tests for fixed-path role-separated records, `0600` root-owned atomic writes, exact vault lookup, bootstrap administrator retention, opt-in vault retention, and redacted failures.
- [x] 3.2 **Owner: gpt-5.6-luna medium.** Add failing lifecycle tests for rotation replacing/removing stale retained credentials only after verification and revocation deleting the matching retained record after successful server revocation.

## 4. Credential-store and handoff implementation

- [x] 4.1 **Owner: gpt-5.6-terra low.** Implement the managed credential-store adapter with independent administrator and vault record schemas, exact record validation, atomic write options, and redaction-safe errors.
- [x] 4.2 **Owner: gpt-5.6-terra low.** Add a shared CLI handoff builder that creates the versioned Obsidian URI and terminal QR through an injectable renderer, keeping credential-bearing output inside existing protected disclosure/output paths.
- [x] 4.3 **Owner: gpt-5.6-luna medium.** Run targeted credential-store and handoff tests, including output assertions that never print real plaintext credentials.

## 5. Endpoint-aware vault lifecycle commands

- [x] 5.1 **Owner: gpt-5.6-luna medium.** Add failing CLI tests for `--wss-endpoint` validation and precedence, managed bootstrap endpoint fallback, interactive missing-endpoint prompt, unattended pre-mutation failure, and no endpoint discovery from an IP.
- [x] 5.2 **Owner: gpt-5.6-luna medium.** Add failing bootstrap and vault-user tests for `--keep`, one-time vault-only QR/URI output, separate administrator persistence, and administrator exclusion from all plugin handoffs.
- [x] 5.3 **Owner: gpt-5.6-terra low.** Extend bootstrap, vault-user add, and rotation orchestration to resolve the endpoint before mutation, persist records at the specified lifecycle points, and render the handoff only after verification.
- [x] 5.4 **Owner: gpt-5.6-terra low.** Ensure revoke removes only the successful target vault's retained record and leaves administrator records and other vault records untouched.
- [x] 5.5 **Owner: gpt-5.6-luna medium.** Run targeted bootstrap, vault-user, and host-deployment tests covering creation, rotation, revocation, retention, protected output, and failure ordering.

## 6. Read-only import command

- [x] 6.1 **Owner: gpt-5.6-luna medium.** Add failing command tests for `fos import --vault-id`, endpoint override/fallback validation, local-only execution, rejected administrator lookup, missing/unretained/revoked credential rotation guidance, and secret-safe unattended output.
- [x] 6.2 **Owner: gpt-5.6-terra low.** Implement `fos import` as a local credential-store read plus URI/QR handoff operation, with no server adapter or mutation path.
- [x] 6.3 **Owner: gpt-5.6-luna medium.** Run the targeted import-command tests and verify the command cannot invoke server operations in its test doubles.

## 7. Documentation and final verification

- [x] 7.1 **Owner: gpt-5.6-terra low.** Update CLI help and the user-run NATS/plugin setup documentation with endpoint selection, `--keep`, secure QR/link handling, `fos import`, plaintext/encrypted phrase behavior, SecretStorage, and rotation/revocation recovery guidance.
- [x] 7.2 **Owner: gpt-5.6-luna medium.** Run the relevant workspace test suite, type checks, and lint/build checks; verify version-1 compatibility, version-2 import, no plaintext in persisted settings/log fixtures, and all modified CLI output paths.
- [x] 7.3 **Owner: gpt-5.6-terra medium.** Review the final diff against both delta specs, confirm no server deployment or endpoint-discovery scope entered the implementation, and record evidence for the accepted lifecycle and rollback behavior.
