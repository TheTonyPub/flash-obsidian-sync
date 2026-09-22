## Why

The plugin needs an existing, correctly isolated NATS JetStream KV deployment, but setting up NATS, WSS/TLS, and each vault manually is error-prone. Provide a user-run installer and day-two CLI without making server operations part of plugin startup.

## What Changes

- Rename the plugin's displayed name and manifest ID to exactly `flash-osidian-sync`; update the source-install directory and preserve existing `easy-sync` user data through a verified migration path.
- Add a root `README.md` first, covering prerequisites, building from source, manual installation in Obsidian, initial plugin setup, and a basic verification path before community-directory publication.
- Add an interactive, guided `fos` CLI built and installed from this repository's source on the target Debian 13, Ubuntu 24.04, or Ubuntu 26.04 amd64 server. It configures NATS and Caddy in native, Docker Compose, or Podman Compose mode. Native NATS/Caddy dependencies may come from the pinned stock APT packages, but `fos` itself is not installed from APT. Support repeatable noninteractive invocation on that server; local-to-server SSH orchestration is a separate future change.
- Require a domain and configure its verified HTTPS `wss://` endpoint through Caddy. Across all three modes, publish only Caddy's 80/443 ports; keep NATS client and WebSocket listeners private and do not configure NATS monitoring port 8222 in this change.
- Generate separate strong random NATS administrator and per-vault passwords, disclose them once through protected output after successful installation, and require administrator credentials for later KV management. Plugin credentials remain bucket-scoped and cannot administer buckets.
- Offer explicit installation choices for firewall, dedicated system users, backup setup, upgrades, and uninstall; make destructive operations confirmation-gated and data-preserving by default.
- Treat S3-compatible object storage as external and optional. Allow empty S3 settings in the plugin; keep inline Markdown syncing through NATS, but do not sync images without S3. Keep unsynced images local for later upload when S3 is configured.
- Expand `.gitignore` for local secrets, generated files, and platform artifacts; provide separate `fos` source-installation and usage guides alongside the NATS configuration reference. Keep implementation on `feature/provision-sync-server` based on `dev`.

## Capabilities

### New Capabilities

- `server-provisioning`: `flash-osidian-sync` source-install onboarding and prerequisites, followed by server-local Debian/Ubuntu installation through `fos` across native, Docker Compose, and Podman Compose modes.
- `server-endpoint-tls`: Domain-only verified WSS endpoint, certificate prerequisites, secure Caddy-to-NATS routing, and connectivity checks.
- `vault-provisioning`: Generated administrator and per-vault credentials, administrator-authenticated KV management, and least-privilege vault isolation.

### Modified Capabilities

- `blob-storage`: Make S3 settings optional in the plugin and define safe behavior for images while S3 is absent.

## Impact

Plugin manifest/identity migration, root README and manual plugin-install instructions precede the source-built `fos` server CLI/package, templates, guided prompts, integration checks, and separate CLI installation/usage guides. NATS and Caddy run on user-owned hosts; Docker/Podman modes use Compose files and persistent volumes. NATS monitoring is deferred to a later change. Plugin settings and blob-sync behavior also change. Existing plugin transport stays direct WSS; S3 remains a separately configured service.
