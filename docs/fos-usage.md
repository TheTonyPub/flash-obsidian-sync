# Use fos

`fos` configures synchronization infrastructure on the server where it runs. It does not connect to a remote server over SSH. An operator may SSH into the host first, then run the commands there.

## First installation

Point a DNS record at the server and allow inbound TCP 80 and 443 for Caddy certificate issuance and renewal. Use a domain endpoint; this change does not support IP-only TLS endpoints. NATS client and WebSocket listeners remain private. Caddy is the only public service and terminates TLS.

Start by reviewing the selected plan, then run the guided installer:

```sh
sudo fos plan
sudo fos bootstrap
```

The interactive flow asks for native, Docker Compose, or Podman Compose mode, the domain, the first vault ID, and optional operations such as firewall and backup management. It displays a redacted plan and asks before making host changes. First bootstrap creates a random NATS administrator credential and a separate first-vault credential. Save both from the protected handoff; the administrator credential is required for future bucket and user management, while only the vault credential belongs in Obsidian.

For automation, place inputs in a root-readable protected file and direct generated secrets to a root-only file:

```sh
sudo fos bootstrap --non-interactive \
  --input /root/fos-input.json \
  --secrets-output /root/fos-secrets.json \
  --approve
sudo chmod 600 /root/fos-secrets.json
```

Do not put passwords in command arguments, shell history, repositories, or normal logs. Protect and remove secret files according to your server's credential-handling policy after securely recording the values.

## Day-to-day commands

```sh
sudo fos status
sudo fos vault list --mode docker
sudo fos vault inspect --mode docker --vault-id VAULT_ID
sudo fos vault create --mode docker --vault-id VAULT_ID
sudo fos vault verify --mode docker --vault-id VAULT_ID
sudo fos backup --destination /srv/flash-osidian-sync-backups --retention 7
sudo fos restore-check --destination /srv/flash-osidian-sync-backups --retention 7
```

Vault creation, inspection, rotation, revocation, listing, and other KV management require administrator authentication through an interactive prompt or protected input. `vault verify` requires the vault password and checks that vault's own scoped access; cross-vault isolation is only tested when an existing peer is explicitly identified and administrator authentication is provided. Use `--admin-input` and `--vault-input` only with protected files; generated passwords for add/rotate go to a protected `--secrets-output` file in unattended operation. `backup` and `restore-check` require an explicit destination and retention count.

`fos upgrade` and `fos uninstall` show a preview by default. Add `--approve` only after reviewing the preview. Uninstall preserves data by default; deleting it requires the separate `--delete-data` and exact confirmation options documented by that CLI version.

## Modes and ownership

- **Native:** `fos` manages NATS and Caddy systemd services and persistent data in its owned paths. NATS listens on loopback.
- **Docker Compose / Podman Compose:** `fos` manages an internal NATS service, Caddy, and persistent data under its installation paths. Compose publishes only Caddy's 80 and 443 ports; it does not publish NATS ports.

All modes use the same NATS authorization and Caddy endpoint behavior. NATS HTTP monitoring (port 8222) is not configured in this change. Firewall and backup options are selected during bootstrap; upgrades and uninstall are separate explicit commands. Review each plan before confirming.

For the manual NATS authorization reference and plugin-side connection requirements, see [NATS setup](nats-setup.md).
