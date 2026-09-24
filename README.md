# obsidian-flash-sync

[![Master unit test coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2FTheTonyPub%2F26e423a64b46c4ca558901a40f9c9e3d%2Fraw%2Fobsidian-flash-sync-master-lcov-coverage.json)](https://gist.github.com/TheTonyPub/26e423a64b46c4ca558901a40f9c9e3d)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/TheTonyPub/obsidian-flash-sync/ci.yml?branch=master&label=master)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/TheTonyPub/obsidian-flash-sync/ci.yml?branch=dev&label=dev)
![GitHub Release](https://img.shields.io/github/v/release/TheTonyPub/obsidian-flash-sync?include_prereleases)
![GitHub License](https://img.shields.io/github/license/TheTonyPub/obsidian-flash-sync)
![GitHub Repo stars](https://img.shields.io/github/stars/TheTonyPub/obsidian-flash-sync)

`flash-osidian-sync` is a self-hosted Obsidian plugin that synchronizes vault content through a pre-provisioned NATS JetStream KV bucket over WSS. It is not yet distributed through the Obsidian community plugin catalogue

## Contents

- [Prerequisites](#prerequisites)
- [Manual installation from a release](#manual-installation-from-a-release)
- [Build from source (optional)](#build-from-source-optional)
- [Configure an existing vault](#configure-an-existing-vault)
- [S3 is optional](#s3-is-optional)
- [Check connection](#check-connection)
- [Server bootstrap CLI](#server-bootstrap-cli)
- [Features](#features)

## Prerequisites

- Obsidian 1.11.4 or newer and an existing local vault.
- Node.js 22 and npm only when building the plugin from source.
- A reachable `wss://` NATS endpoint with JetStream enabled. The endpoint must be served through the server's configured domain and valid TLS certificate.
- An existing vault ID, bucket `OBS_<vaultId>_FILES`, and the matching NATS username and password. The server bootstrap administrator creates and manages these; the plugin does not create NATS users or buckets.

## Manual installation from a release

1. Open the [GitHub releases](https://github.com/TheTonyPub/obsidian-flash-sync/releases) and choose a stable release or alpha/beta prerelease. Development builds are available as CI artifacts from the corresponding GitHub Actions run.
2. Download `main.js` and `manifest.json` from the selected release or CI artifact. Both files must come from the same build. If that build includes `styles.css`, download it too.
3. Create the plugin folder in the target vault. Replace `/path/to/vault` with the local filesystem path of the vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/flash-sync
```

Copy the downloaded files into `/path/to/vault/.obsidian/plugins/flash-sync/`. Keep `main.js`, `manifest.json`, and optional `styles.css` together. GitHub's **Source code (zip)** and **Source code (tar.gz)** are repository snapshots, not ready-to-install plugin packages.

Restart Obsidian. In **Settings → Community plugins**, enable community plugins and then enable **flash-sync**.

## Build from source (optional)

Clone this repository, install dependencies, and build the plugin:

```bash
git clone https://github.com/TheTonyPub/obsidian-flash-sync.git
cd obsidian-flash-sync
npm ci
npm run build:plugin
```

Copy `packages/plugin/dist/main.js` and `packages/plugin/manifest.json` into `.obsidian/plugins/flash-sync/`. Rebuild and copy the files again after source updates. The repository's source archives are also available from each GitHub release, but they still require a local build.

## Configure an existing vault

> [!IMPORTANT]
> Set up the server before configuring the plugin. The server administrator must create the vault's `OBS_<vaultId>_FILES` JetStream KV bucket and issue its vault ID, NATS username, and password. You also need the server's reachable `wss://` URL. Follow the [server bootstrap CLI guide](docs/fos-install.md) to prepare the server and credentials.

Open **Settings → Community plugins → flash-sync** and enter the provisioned values:

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

## Features

Realised:

- [x] MVP: obsidian plugin, sync through NATS server.
- [x] CLI interface for server bootstrap and managment.

Planned:

- [x] Generate an Obsidian import link for vault credentials from the `fos` bootstrap CLI.
- [ ] Add end-to-end encryption for synchronized data.
- [ ] Back up vault content to a remote Git repository.
- [ ] Monitor the NATS server and show usage statistics.
- [ ] `fos` command without unnecessary sudo commands.
