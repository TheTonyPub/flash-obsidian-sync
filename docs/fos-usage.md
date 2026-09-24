# Use fos

`fos` configures synchronization infrastructure on the server where it runs. It does not connect to a remote server over SSH. An operator may SSH into the host first, then run the commands there.

## First installation

Point a DNS record at the server and allow inbound TCP 80 and 443 for Caddy certificate issuance and renewal. Use a domain endpoint; this change does not support IP-only TLS endpoints. NATS client and WebSocket listeners remain private. Caddy is the only public service and terminates TLS.

Start by reviewing the selected plan, then run the guided installer:

```sh
sudo fos plan
sudo fos bootstrap --wss-endpoint wss://sync.example.com --keep
```

The interactive flow asks for native, Docker Compose, or Podman Compose mode, the domain, the first vault ID, and optional operations such as firewall and backup management. It displays a redacted plan and asks before making host changes. First bootstrap creates a random NATS administrator credential and a separate first-vault credential. Save both from the protected handoff; the administrator credential is required for future bucket and user management, while only the vault credential belongs in Obsidian.

In a terminal, use the up/down arrow keys and Enter to choose an installation mode; keys `1` through `3` also select a mode. Answer yes/no prompts with `y` or `n`. Press Ctrl+C to cancel; the CLI restores terminal input before it exits. Plan paths appear in a separate highlighted section. Set `NO_COLOR=1` or `TERM=dumb` to disable color. The optional QR encryption phrase is entered without echo.

If firewall management is selected, `fos` adds allow rules for the detected SSH port and ports 80 and 443. It does not enable UFW. An inactive UFW remains inactive and does not start filtering traffic.

## Command help

`fos --help` lists commands. Each command and nested vault action has its own help page; help exits before contacting a service or changing the host:

```sh
fos help
fos bootstrap --help
fos vault --help
fos vault list --help
fos vault verify --help
```

The interactive CLI uses color only when stdout is a terminal and `NO_COLOR` is unset and `TERM` is not `dumb`. Help and human-readable output are plain text when redirected. Structured vault results use JSON when redirected; use `--json` to request JSON explicitly in a terminal.

## Command reference

| Command | Purpose and required inputs |
| --- | --- |
| `fos bootstrap` | Preview and install. In a terminal, mode, domain, and initial vault ID can be prompted or supplied as options; `--approve` still displays an interactive confirmation. In unattended mode, supply `--input` with root-owned JSON containing `mode`, `domain`, and `vaultId`, plus `--secrets-output` and `--approve`. Optional flags select firewall rules, service accounts, backup scheduling, endpoint, or retained credential. |
| `fos plan` | Print the deployment plan without applying it. Supply mode, domain, and vault ID when running without an interactive terminal; use `fos plan --help` for preview-specific options. |
| `fos status` | Report managed installation state. |
| `fos vault list` | List all vault buckets. No `--vault-id` is needed. Uses the managed installation mode when available; otherwise pass `--mode`. |
| `fos vault create --vault-id ID` | Create a bucket if missing. |
| `fos vault inspect --vault-id ID` | Show one bucket if present. |
| `fos vault add --vault-id ID` | Create a vault user and issue a protected handoff. |
| `fos vault rotate --vault-id ID` | Replace a vault credential and issue a new handoff. |
| `fos vault revoke --vault-id ID` | Revoke a vault user's access. |
| `fos vault verify --vault-id ID --vault-input FILE` | Verify that the supplied vault credential has access only to its own bucket. `--cross-vault-id ID` additionally checks a named peer. |
| `fos import --vault-id ID` | Regenerate a handoff from a retained local vault credential. |
| `fos backup --destination PATH --retention DAYS` | Create an explicit protected backup. |
| `fos restore-check --destination PATH --retention DAYS` | Create a backup and test restoring it. |
| `fos upgrade` | Preview an upgrade. `--approve` applies it. |
| `fos uninstall` | Preview removal. `--approve` applies it; data deletion additionally needs `--delete-data --confirm DELETE_DATA`. |

Vault commands accept `--mode native|docker|podman` to override mode detection. Otherwise they use the managed installation mode. Administrator credentials are read from the protected local credential store when available; `--admin-input FILE` overrides that source, and an interactive prompt is the fallback. If no managed installation mode is available, the command reports `INSTALL_MODE_REQUIRED`. Commands that target an individual vault still require its ID and any action-specific credential inputs.

Use `--help` on any command for its complete options, required inputs, and examples. Options such as `--admin-input`, `--vault-input`, `--input`, and `--secrets-output` refer to protected files and must not contain credentials in shell arguments.

For automation, place inputs in a root-readable protected file and direct generated secrets to a root-only file:

```sh
sudo fos bootstrap --non-interactive \
  --input /root/fos-input.json \
  --secrets-output /root/fos-secrets.json \
  --approve
sudo chmod 600 /root/fos-secrets.json
```

Do not put passwords, import links, QR text, or encryption phrases in command arguments, shell history, repositories, or normal logs. Protect and remove secret files according to your server's credential-handling policy after securely recording the values.

## Vault handoff and recovery

In Docker and Podman modes, adding, rotating, or revoking a vault user recreates only the NATS container so it reads the atomically replaced authorization file. Connected clients briefly reconnect. Caddy and persistent vault data remain in place. Native mode uses a NATS configuration reload.

After successful bootstrap, `fos vault add`, or `fos vault rotate`, `fos` emits a vault-only Obsidian import URI and terminal QR code through the same protected handoff as the generated vault credential. On a colored terminal, the QR uses a compact half-block layout; protected handoff files always use plain UTF-8 QR output without terminal control codes. It never includes the administrator credential. Obsidian stores the imported NATS password and any S3 secret in SecretStorage; ordinary plugin settings store opaque secret keys.

`--wss-endpoint wss://host` is validated before a credential changes and overrides the managed bootstrap endpoint. Without an override, `fos` uses the managed bootstrap endpoint; an interactive command prompts if none exists, while unattended operation fails before a mutation. `vault create` only creates a bucket and does not issue a handoff.

Use `--keep` with bootstrap, vault add, or rotation to retain the newly generated vault plaintext credential in the protected local store. Bootstrap always retains its separate administrator credential. Without `--keep`, the vault password is available only in the one-time handoff. Regenerate a retained vault handoff locally, without contacting the server:

```sh
sudo fos import --vault-id VAULT_ID
```

`fos import` accepts `--wss-endpoint` for an endpoint migration. In unattended use, add a root-only `--secrets-output PATH`; it never writes the URI or QR to ordinary stdout. If no retained vault credential exists, rotate that vault with `--keep`; NATS password hashes cannot recover the old password.

Press Enter at the optional handoff phrase prompt to create explicit plaintext version 2. A nonempty phrase must have at least eight characters and creates encrypted version 1. Treat either URI or QR as a password-bearing secret; store the phrase separately when encryption is used.

After a rotation, import the new handoff on each device; the old credential no longer authenticates. Revoking a vault user removes only that vault's retained record after successful server revocation, so later `fos import` requires a new rotation with `--keep`.

## Day-to-day commands

```sh
sudo fos status
sudo fos vault list
sudo fos vault inspect --vault-id VAULT_ID
sudo fos vault create --vault-id VAULT_ID
sudo fos vault verify --vault-id VAULT_ID --vault-input /root/vault-input
sudo fos backup --destination /srv/flash-osidian-sync-backups --retention 7
sudo fos restore-check --destination /srv/flash-osidian-sync-backups --retention 7
```

Vault creation, inspection, rotation, revocation, listing, and other KV management require administrator authentication through an interactive prompt or protected input. `vault verify` requires the vault password and checks that vault's own scoped access; cross-vault isolation is only tested when an existing peer is explicitly identified and administrator authentication is provided. Use `--admin-input` and `--vault-input` only with protected files; generated passwords and handoffs for add/rotate go to a protected `--secrets-output` file in unattended operation. `backup` and `restore-check` require an explicit destination and retention count.

`fos upgrade` and `fos uninstall` show a preview by default. Add `--approve` only after reviewing the preview. Uninstall preserves data by default; deleting it requires the separate `--delete-data` and exact confirmation options documented by that CLI version.

## Modes and ownership

- **Native:** `fos` manages NATS and Caddy systemd services and persistent data in its owned paths. NATS listens on loopback.
- **Docker Compose / Podman Compose:** `fos` manages an internal NATS service, Caddy, and persistent data under its installation paths. Compose publishes only Caddy's 80 and 443 ports; it does not publish NATS ports.

All modes use the same NATS authorization and Caddy endpoint behavior. NATS HTTP monitoring (port 8222) is not configured in this change. Firewall and backup options are selected during bootstrap; upgrades and uninstall are separate explicit commands. Review each plan before confirming.

For the manual NATS authorization reference and plugin-side connection requirements, see [NATS setup](nats-setup.md).
