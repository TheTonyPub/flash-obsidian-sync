# Install fos from source

`fos` is built from this repository and installed from the locally built package. It is not an APT package. Native mode uses the CLI's version-pinned stock APT packages for NATS and Caddy; Docker and Podman modes use pinned container images.

## Requirements

- A fresh or operator-reviewed Debian 13, Ubuntu 24.04, or Ubuntu 26.04 server on amd64.
- Node.js 22 and npm, plus Git.
- Root access for installation and server changes (`sudo`).
- A domain pointing to the server and public inbound TCP 80 and 443 for Caddy certificates.
- For container mode, Docker Engine with Compose v2/v5, or Podman 5 with an explicitly configured `podman-compose` provider.

The CLI rejects OS/package combinations outside the compatibility lock shipped with that CLI version. Check the release's compatibility list before using a newer operating system.

## Build and install

On the target server, clone the repository and build its server CLI bundle:

```sh
git clone https://github.com/TheTonyPub/flash-obsidian-sync.git
cd flash-obsidian-sync
npm ci
npm run build:server-cli
```

Install the locally built package and verify the executable and bundled admin worker:

```sh
sudo npm install --global ./packages/server-cli
test -x "$(command -v fos)"
test -f "$(npm root --global)/@flash-osidian-sync/server-cli/dist/admin-worker.js"
npm pack --dry-run --workspace @flash-osidian-sync/server-cli
```

The workspace package includes the built `fos` entry point and its admin worker. Run server operations as root, for example with `sudo fos plan`. Do not install a similarly named CLI from APT or another package source.

## Update from a later source revision

Keep the clone as the source checkout. To update the global executable:

```sh
cd flash-obsidian-sync
git pull --ff-only
npm ci
npm run build:server-cli
sudo npm install --global ./packages/server-cli
command -v fos
```

Before updating, review the release notes and compatibility lock. Updating the CLI package does not itself upgrade managed NATS or Caddy; those are separate, explicit `fos` operations.

Continue with [the usage guide](fos-usage.md) to plan and run bootstrap.
