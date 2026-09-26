# vault-provisioning Specification

## Purpose

Defines administrator-only creation and maintenance of isolated NATS KV vaults and credentials while protecting existing vault content.

## Requirements

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
Bootstrap SHALL generate a separate NATS administrator password with cryptographically secure randomness and at least 128 bits of entropy. The administrator identity SHALL be required for subsequent KV bucket and vault-user management, including creation, listing, inspection, rotation, and revocation. The CLI SHALL disclose generated administrator and first-vault credentials once after successful installation through protected output, never in plans, logs, command arguments, or world-readable files. An explicitly selected `--secrets-output` destination SHALL take precedence over terminal disclosure. Bootstrap SHALL always retain the administrator credential in its separate protected local record; it SHALL retain the first-vault plaintext credential only with `--keep`. Administrator credentials SHALL NOT be placed in plugin settings, import URIs, or QR codes.

#### Scenario: Successful interactive bootstrap
- **WHEN** installation and verification complete in an interactive terminal
- **THEN** the CLI displays the administrator and first-vault credentials once with their distinct purposes identified, and displays the vault-only import URI and QR code unless `--secrets-output` was selected, in which case it writes the handoff there without credential disclosure to the terminal

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

#### Scenario: List vaults without an identifier
- **WHEN** an operator runs `fos vault list` on a configured installation without a vault ID
- **THEN** the CLI resolves the managed installation mode, authenticates the administrator, and lists vaults without requiring `--vault-id`

#### Scenario: Rotate one vault password
- **WHEN** an operator rotates a vault credential
- **THEN** the CLI updates only that vault's credential, reports a verified replacement connection while preserving bucket contents, and emits a new vault-only import URI and QR code

#### Scenario: Rotate a retained vault
- **WHEN** an operator rotates a retained vault credential with `--keep`
- **THEN** the CLI replaces the stored plaintext only after verification succeeds and the preceding handoff no longer authenticates

#### Scenario: Revoke one vault user
- **WHEN** an operator confirms revocation
- **THEN** new connections with that user's old credentials are rejected, its retained credential is removed, and other vault users remain usable

### Requirement: Safe managed authorization updates
The CLI SHALL update managed NATS authorization without losing the prior valid configuration if validation, writing, or service update fails. In container modes, it SHALL make the updated authorization available to NATS while preserving persistent vault data and other services; connected clients may briefly reconnect. Native mode SHALL reload the updated authorization.

#### Scenario: Container authorization update
- **WHEN** an operator adds, rotates, or revokes a vault credential in Docker or Podman mode
- **THEN** the CLI atomically updates authorization, makes NATS use the new file, preserves bucket data and Caddy, and restores the prior authorization if the update fails

#### Scenario: Native authorization update
- **WHEN** an operator adds, rotates, or revokes a vault credential in native mode
- **THEN** the CLI reloads NATS with the validated authorization while preserving bucket data

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
- **THEN** the CLI delivers the import URI and QR code once through the selected protected output but retains no plaintext vault credential for later import

### Requirement: Protected bootstrap recovery output
When `--secrets-output` is explicitly supplied, the CLI SHALL write generated bootstrap credentials to that protected destination even in an interactive terminal, and SHALL not disclose those credentials to terminal output. If managed-state or credential-record persistence fails after services are applied, the CLI SHALL attempt to deliver credentials through the selected protected output and SHALL preserve the original failure as the reported error.

#### Scenario: Interactive bootstrap with explicit protected output
- **WHEN** an operator runs bootstrap in a terminal and supplies `--secrets-output`
- **THEN** the CLI atomically writes the credential handoff to the owner-readable protected destination and suppresses credential disclosure to the terminal

#### Scenario: Bootstrap persistence failure
- **WHEN** service application succeeds but managed-state or protected credential-record persistence fails
- **THEN** the CLI attempts credential delivery through the selected output and reports the persistence failure even if recovery delivery also fails

### Requirement: Verify access boundaries
The CLI SHALL verify each provisioned user's own-bucket operations before successful bootstrap and credential handoff. It SHALL report own-bucket verification separately from cross-vault verification. A cross-vault check SHALL require an explicitly identified, already-provisioned peer vault and protected administrator authentication to confirm that peer exists; only an actual permission denial against the peer counts as success. A missing peer or timeout SHALL not count as denial. The CLI SHALL also verify unauthenticated access denial and report failures without deleting local/remote vault data.

#### Scenario: First vault has no peer
- **WHEN** bootstrap provisions the first vault on an otherwise empty NATS server
- **THEN** it verifies that user's own-bucket status, watch, write, and read before disclosing credentials, and reports cross-vault isolation as not yet tested

#### Scenario: Two-vault isolation
- **WHEN** two vaults are provisioned on one NATS instance and the operator identifies the peer vault for verification
- **THEN** each user can perform its own KV read, write, watch, and status operations, while read/write/watch against the other vault is denied

#### Scenario: Unauthenticated client
- **WHEN** a client connects without credentials or with an incorrect password
- **THEN** no vault data can be accessed
