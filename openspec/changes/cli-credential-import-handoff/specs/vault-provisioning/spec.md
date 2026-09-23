## MODIFIED Requirements

### Requirement: Provision isolated vault
The CLI SHALL create or inspect a distinct `OBS_<vaultId>_FILES` JetStream KV bucket and dedicated NATS username/password per vault, using file storage, history 10, and replicas 1 initially. It SHALL generate each new vault password with cryptographically secure randomness and at least 128 bits of entropy. Plugin users SHALL have only the NATS subjects needed for their own KV operations; they SHALL NOT have bucket-administration rights. After successful creation and verification, it SHALL disclose a vault-only Obsidian import URI and terminal QR code containing the WSS endpoint and connection configuration. `--wss-endpoint` SHALL override the managed bootstrap endpoint only after URL validation; when neither is available, an interactive command SHALL request an endpoint and unattended execution SHALL fail before mutation.

#### Scenario: New vault
- **WHEN** an authorized operator creates a new vault ID
- **THEN** the CLI provisions the matching bucket and scoped user, verifies that user's own-bucket operations, produces an import URI and QR code using the resolved WSS URL, and discloses the new random password once through protected output after verification succeeds

#### Scenario: Existing vault
- **WHEN** an operator repeats creation for an existing vault ID
- **THEN** the CLI detects the existing bucket and user without resetting content or silently rotating the password

#### Scenario: Conflicting identifier
- **WHEN** different vault IDs would normalize to the same bucket or username
- **THEN** the CLI rejects the collision before modifying NATS

#### Scenario: No endpoint for unattended creation
- **WHEN** an unattended vault-user creation has no valid managed endpoint and omits `--wss-endpoint`
- **THEN** the CLI refuses before creating or rotating a vault credential

### Requirement: Administrator identity and protected secret handoff
Bootstrap SHALL generate a separate NATS administrator password with cryptographically secure randomness and at least 128 bits of entropy. The administrator identity SHALL be required for subsequent KV bucket and vault-user management, including creation, listing, inspection, rotation, and revocation. The CLI SHALL disclose generated administrator and first-vault credentials once after successful installation through protected output, never in plans, logs, command arguments, or world-readable files. Bootstrap SHALL always retain the administrator credential in its separate protected local record; it SHALL retain the first-vault plaintext credential only with `--keep`. Administrator credentials SHALL NOT be placed in plugin settings, import URIs, or QR codes.

#### Scenario: Successful interactive bootstrap
- **WHEN** installation and verification complete in an interactive terminal
- **THEN** the CLI displays the administrator and first-vault credentials once with their distinct purposes identified, and displays the vault-only import URI and QR code

#### Scenario: Successful noninteractive bootstrap
- **WHEN** unattended installation and verification complete
- **THEN** the CLI writes generated credentials only to an explicitly selected owner-readable destination and does not print them into general automation logs

#### Scenario: Missing administrator credential later
- **WHEN** an operator invokes a KV management command without valid administrator credentials
- **THEN** the command refuses the operation before changing any bucket or user

#### Scenario: Repeated bootstrap
- **WHEN** bootstrap is repeated for an existing installation
- **THEN** it neither regenerates nor redisplays existing passwords

### Requirement: Credential lifecycle
The CLI SHALL provide list, credential rotation, and revocation operations for vault users. It SHALL generate replacement passwords with cryptographically secure randomness and at least 128 bits of entropy, accept administrator secret input without echo or command-line argument leakage, avoid plaintext secret logs and world-readable files, and never grant administrator credentials to the plugin. Vault-user add and rotation SHALL honor `--keep` for the newly generated credential only; without it they SHALL produce a one-time import URI and QR code but retain no vault plaintext password. Revocation SHALL remove any retained record for that vault so it cannot be imported again. Rotation SHALL replace any retained record only after the replacement server credential is verified.

#### Scenario: Rotate one vault password
- **WHEN** an operator rotates a vault credential
- **THEN** the CLI updates only that vault's credential, reports a verified replacement connection while preserving bucket contents, and emits a new vault-only import URI and QR code

#### Scenario: Rotate a retained vault
- **WHEN** an operator rotates a retained vault credential with `--keep`
- **THEN** the CLI replaces the stored plaintext only after verification succeeds and the preceding handoff no longer authenticates

#### Scenario: Revoke one vault user
- **WHEN** an operator confirms revocation
- **THEN** new connections with that user's old credentials are rejected, its retained credential is removed, and other vault users remain usable

