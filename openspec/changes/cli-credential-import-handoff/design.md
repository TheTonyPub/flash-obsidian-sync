## Context

See [proposal.md](proposal.md) for motivation and the two delta specs for the behavior contract. The plugin already has a version-1 encrypted transfer payload, an import URI handler, and SecretStorage-backed NATS settings. The CLI generates vault credentials and only renders a one-time plaintext handoff; NATS authorization contains bcrypt hashes, so server state cannot reproduce a vault password.

## Goals / Non-Goals

**Goals:**

- Give an operator a scannable, vault-only configuration handoff immediately after successful credential creation.
- Make later handoff regeneration possible only for a plaintext vault credential deliberately retained by the operator.
- Retain administrator and vault credentials under different protected records, and preserve established noninteractive secret-output safeguards.
- Keep encrypted version-1 plugin links interoperable while adding an intentional plaintext version for empty phrases.

**Non-Goals:**

- DNS or reverse-DNS endpoint discovery, server-side password recovery, cloud secret-manager integration, or deployment automation.
- S3 provisioning or inclusion of user-provided S3 secrets in a default handoff.
- Automatic rotation, revocation confirmation design, or importing administrator credentials into Obsidian.

## Decisions

### Resolve and validate the WSS endpoint before any credential mutation

The CLI will resolve the endpoint in this order: a supplied `--wss-endpoint`, then the endpoint retained by successful bootstrap. It validates a canonical `wss://` URL before creating or rotating a vault user. The interactive path prompts for a value when neither source is available; unattended paths fail before mutation and require a protected output destination for secret-bearing results.

Persisting a managed endpoint avoids unreliable IP-to-domain inference and keeps later `fos import` local. An explicit override supports endpoint migration or a bootstrap record that predates endpoint retention. The command does not probe or discover an endpoint while resolving this value.

### Treat an import URI and QR code as a secret handoff

The CLI creates a payload, then renders one `obsidian://flash-sync-import?data=...` URI and a terminal QR representation of that exact URI. Both outputs carry the vault password and follow the existing one-time disclosure rules: an interactive terminal receives them only after server verification; unattended execution writes them only to its explicit owner-readable secret output. Plans, normal progress logs, errors, and command arguments contain no plaintext secret or full URI.

This preserves the requested QR workflow without making automation logs a credential channel. A QR library that emits terminal text will be isolated behind a rendering adapter so output can be checked without exposing real credentials in tests.

### Use explicit, independently validated transfer versions

Version `1.<base64url>` remains AES-GCM/PBKDF2 encrypted and requires a nonempty phrase of at least eight characters. The new plaintext payload is `2.<base64url(JSON)>`; it contains the same validated transfer object but has no encryption phrase. Decode selects the version before decoding content, applies the existing field validation to both, and rejects unknown versions.

The explicit prefix prevents an empty phrase from silently weakening version 1. It also lets a future version change the representation without accepting ambiguous input. Import continues to save `natsPassword` and an optional S3 secret only through Obsidian SecretStorage; data settings contain generated secret keys only.

### Store CLI credentials by role under the managed installation state directory

The server CLI will add a credential-store adapter rooted at its fixed managed state location. It keeps the bootstrap administrator credential and resolved bootstrap endpoint in a root-owned `0600` administrator record, and each retained vault credential in a separate root-owned `0600` vault record keyed by exact `vaultId`. Reads validate record type, vault ID, username binding, and endpoint before use. Replacements write a temporary sibling file, set ownership and mode, then atomically rename it; write failure leaves the preceding valid record intact.

Separate files prevent a vault lookup from falling through to the administrator credential. Bootstrap writes its administrator record only after successful installation and verification. Bootstrap, add, and rotation write a vault record only when `--keep` is present; add/rotation write it after the generated credential has passed verification. Revocation deletes that exact vault record after successful server revocation. `fos import` reads only the vault record and performs no server call.

An alternative single credentials document was rejected because role separation, vault-targeted revocation, and failure recovery are simpler to audit with independently atomic records. Retaining every generated vault password was rejected because the requested one-time handoff must remain the default.

### Keep lifecycle mutations ordered around verified server state

Creation/rotation proceeds as endpoint validation, administrator authentication, server authorization update, own-vault verification, handoff rendering, and conditional local persistence. If any stage before local persistence fails, no new retained record is written. When a rotation succeeds without `--keep`, any earlier retained plaintext record for that vault is removed because it is obsolete. Revocation removes the record only after the server reports success; if local cleanup fails, the command reports a remediation failure and must not claim that the old handoff is unusable.

The server password hash remains the source of authorization and is never used as a recovery mechanism. `fos import` failing for a missing record tells the operator to rotate the vault credential and use `--keep` if future regeneration is needed.

## Risks / Trade-offs

- [The URI or QR is visible to terminal/screen observers] → Treat it as a password-bearing secret, disclose once only, avoid log output, and use protected files for unattended workflows.
- [A root credential record is copied from a host] → Root ownership and `0600` reduce local exposure, while operational backups remain user-owned; the design offers no remote-secret recovery path.
- [An old import link remains valid after rotation] → Rotation replaces server authorization; the plugin reports authentication failure until it imports the new handoff.
- [Endpoint moves while a retained record contains the previous managed endpoint] → `--wss-endpoint` gives an operator a validated, local override without changing the record.
- [Plaintext transfer payload is forwarded accidentally] → It is explicit version 2 and only created for an empty phrase; operators can choose version 1 encryption with a phrase of at least eight characters.

## Migration Plan

1. Add version-2 decode support before making the CLI generate it, retaining existing version-1 export/import behavior.
2. Add the credential-store adapter and tests for mode, ownership options, atomic replacement, role separation, and redaction.
3. Extend bootstrap and vault-user actions with endpoint resolution, QR/URI handoff, and `--keep`; preserve current protected-output behavior in unattended mode.
4. Add `fos import` as a local-read command and document that installations created before this change have no recoverable vault plaintext credential. An operator can rotate a vault with `--keep` to enable future import generation.
5. Roll back by ceasing new version-2 generation while retaining the protected records and version-1 compatibility. Do not delete records automatically; credential deletion/revocation remains an explicit lifecycle action.
