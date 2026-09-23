## Purpose

Defines a versioned, secure handoff from the provisioning CLI to the Obsidian plugin and a local-only way to reproduce a vault handoff when its credential was explicitly retained.

## ADDED Requirements

### Requirement: Versioned import payloads
The system SHALL encode a complete vault connection configuration in a versioned payload used by an Obsidian import URI and terminal QR code. The configuration SHALL include `vaultId`, a `wss://` endpoint, vault username and password, all optional S3 fields as strings, and a positive inline limit. A generated handoff without S3 settings SHALL encode empty S3 fields and the plugin default inline limit. The producer and plugin SHALL reject malformed, oversized, invalid-vault-ID, non-WSS, invalid-S3-HTTPS, or nonpositive-inline-limit payloads before saving settings or attempting a connection.

#### Scenario: Default generated handoff
- **WHEN** the CLI produces a vault handoff without S3 configuration
- **THEN** its URI and QR code contain the vault ID, WSS endpoint, vault credential, empty S3 configuration, and the default inline limit

#### Scenario: Invalid payload is received
- **WHEN** the plugin receives a malformed or invalid import payload
- **THEN** it reports the import failure without replacing its saved configuration or secrets

### Requirement: Plaintext and encrypted import compatibility
The system SHALL encode a handoff with an empty encryption phrase as an explicit plaintext payload version and SHALL encode a handoff with a nonempty phrase as encrypted payload version 1. Encrypted version 1 creation SHALL reject phrases shorter than eight characters. The plugin SHALL recognize and import both versions; it SHALL require the phrase only for encrypted version 1 and SHALL reject unknown versions without interpreting their data.

#### Scenario: Plaintext handoff
- **WHEN** an operator generates a handoff with an empty phrase
- **THEN** the CLI produces the explicit plaintext version and the plugin imports it without requesting a phrase

#### Scenario: Encrypted handoff
- **WHEN** an operator generates a handoff with a phrase of at least eight characters
- **THEN** the CLI produces encrypted version 1 and the plugin requires that phrase to import it

#### Scenario: Short encryption phrase
- **WHEN** an operator supplies a nonempty phrase shorter than eight characters
- **THEN** handoff generation fails before printing a URI, QR code, or credential-bearing payload

### Requirement: Plugin import preserves credential boundaries
The plugin SHALL place an imported NATS password in Obsidian SecretStorage and SHALL save only its opaque SecretStorage key in ordinary plugin settings. It SHALL keep S3 credentials in SecretStorage when present. Before replacing a configured connection, it SHALL refuse an import whose vault ID differs from the device's bound vault ID. On a successful same-vault or first import, it SHALL persist the connection settings and attempt to connect using the imported configuration.

#### Scenario: Imported NATS password
- **WHEN** a valid handoff is imported
- **THEN** the NATS password is saved in SecretStorage and is absent from persisted plugin settings

#### Scenario: Different bound vault
- **WHEN** a device already bound to vault A receives a valid handoff for vault B
- **THEN** the plugin rejects the import and preserves the vault A settings and secrets

### Requirement: Regenerate retained vault handoff
The CLI SHALL provide a read-only `fos import --vault-id <vaultId>` command that reads a retained vault credential from its managed credential store and outputs a fresh Obsidian import URI and terminal QR code. It SHALL use the managed bootstrap endpoint unless `--wss-endpoint` supplies a valid override. It SHALL not contact or mutate the server. It SHALL reject a request for a missing, revoked, or unretained vault credential with guidance to rotate that vault credential; it SHALL never derive a password from server authorization data.

#### Scenario: Regenerate a retained vault handoff
- **WHEN** an operator runs `fos import --vault-id` for an active vault credential retained by `--keep`
- **THEN** the CLI produces a valid import URI and QR code without changing the server or the retained credential

#### Scenario: Credential was not retained
- **WHEN** an operator runs `fos import --vault-id` for a vault whose plaintext password was not retained
- **THEN** the CLI reports that the password cannot be recovered and instructs the operator to rotate the vault credential

#### Scenario: Administrator record selected
- **WHEN** an import request would resolve to an administrator credential record
- **THEN** the CLI rejects the request and emits no import URI or QR code

### Requirement: Protected local credential store
The CLI SHALL maintain its fixed managed credential store in a root-owned location with mode `0600`, and SHALL write replacements atomically. It SHALL store administrator credentials separately from vault records and SHALL retain a vault plaintext credential only after an explicit `--keep`. It SHALL not include plaintext credentials in plans, ordinary logs, command arguments, or unattended standard output.

#### Scenario: Bootstrap retention
- **WHEN** bootstrap completes successfully
- **THEN** the CLI persists the administrator credential in its separate protected record and persists the first vault credential only when `--keep` was supplied

#### Scenario: Later vault-user retention
- **WHEN** `fos vault add` or rotation completes with `--keep`
- **THEN** the CLI atomically stores only that vault's newly generated credential in the protected vault-record area

#### Scenario: One-time vault handoff
- **WHEN** bootstrap or vault-user creation completes without `--keep`
- **THEN** the CLI displays the import URI and QR code once but retains no plaintext vault credential for later import

