# flash-osidian-sync

`flash-osidian-sync` is a self-hosted Obsidian plugin that synchronizes vault content through a pre-provisioned NATS JetStream KV bucket over WSS. It is not yet distributed through the Obsidian community plugin catalogue.

## Prerequisites

- Obsidian desktop 1.11.4 or newer and an existing local vault.
- Node.js 22 and npm to build the plugin from this repository.
- A reachable `wss://` NATS endpoint with JetStream enabled. The endpoint must be served through the server's configured domain and valid TLS certificate.
- An existing vault ID, bucket `OBS_<vaultId>_FILES`, and the matching NATS username and password. The server bootstrap administrator creates and manages these; the plugin does not create NATS users or buckets.

## Manual installation from source

From a clone of this repository, install dependencies and build the plugin:

```bash
npm ci
npm run build:plugin
```

Copy the build output and manifest into the target vault's plugin directory. Replace `/path/to/vault` with the local filesystem path of the vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/flash-osidian-sync
cp packages/plugin/dist/main.js packages/plugin/manifest.json /path/to/vault/.obsidian/plugins/flash-osidian-sync/
```

Restart Obsidian, then enable **flash-osidian-sync** in **Settings → Community plugins**. Rebuild and recopy `main.js` after each source update.

## Configure an existing vault

Open **Settings → Community plugins → flash-osidian-sync** and enter the provisioned values:

- **Vault ID**: the existing vault ID, such as `my_vault`.
- **NATS WSS URL**: the server URL, for example `wss://sync.example.com`.
- **NATS username** and **NATS password**: the credentials assigned to this vault. Obsidian stores the password through its secret storage.

The plugin connects only to the bucket derived from the vault ID: `OBS_<vaultId>_FILES`. Use the exact ID supplied by the server administrator when joining an existing vault. Once the plugin has connected, its vault binding cannot be changed from settings.

## S3 is optional

S3 is optional. Leave every S3 field empty when object storage is not configured; Markdown and other content that fits the inline limit continue to synchronize through NATS. In this mode, images and other files larger than the inline limit are not synchronized.

To enable large-file synchronization, configure all S3 fields: an HTTPS endpoint, bucket, region, access key ID, and secret key. The plugin reports incomplete or failed S3 configuration in its status and does not treat it as a successful large-file connection.

## Check connection

After entering the NATS values, select **Connect**. A successful initial reconciliation changes **Status** to `SYNCED`; ongoing work may briefly show `RECONCILING` or `PENDING`. If it reports `AUTH_ERROR`, verify the vault ID and per-vault credentials. If it reports `OFFLINE`, verify the `wss://` URL, DNS, TLS certificate, and server availability. Enable **Debug logging** to inspect connection and reconciliation events in Obsidian's developer console.

For a safe first sync, back up the vault before connecting another device. Conflicting local content is retained as a separate conflict copy for review.

## Server bootstrap CLI

On the target server, install Node.js 22 and npm, clone this repository, then build and install the CLI:

```bash
npm ci
npm run build:server-cli
sudo npm install -g ./packages/server-cli
```

Install the server CLI from repository source by following [the `fos` installation guide](docs/fos-install.md), then use [the `fos` usage guide](docs/fos-usage.md) for bootstrap, vault management, and safe credential handling. `fos` runs on supported Debian/Ubuntu amd64 servers in native, Docker Compose, or Podman Compose mode. The [NATS setup guide](docs/nats-setup.md) covers the managed topology and manual configuration reference.
