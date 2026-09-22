# NATS setup for flash-osidian-sync

This guide covers two supported paths:

- **Managed setup:** run `fos` on the target Debian 13, Ubuntu 24.04, or Ubuntu 26.04 amd64 server. It owns only the `flash-osidian-sync` paths and creates the service topology.
- **Manual setup:** operate an existing NATS and Caddy deployment yourself. Preserve the subject permissions below; `fos` does not adopt or modify a manual deployment.

Every vault needs one pre-created JetStream KV bucket and a distinct NATS username/password. The plugin derives its bucket as `OBS_<vaultId>_FILES`; for example, vault ID `VAULT_A` uses `OBS_VAULT_A_FILES`. Do not enter the full bucket name as the Vault ID.

## Managed setup with fos

Install `fos` from source using [the installation guide](fos-install.md), then follow [the usage guide](fos-usage.md) to run bootstrap and manage vaults.

First point a domain, such as `sync.example.com`, at the server's public IP address. Ensure TCP ports 80 and 443 can reach the server so Caddy can complete ACME HTTP-01 validation and renew certificates. The plugin endpoint must be a valid domain-based URL such as `wss://sync.example.com`; IP-only TLS endpoints are not supported.

Run `sudo fos plan` to inspect the selected native, Docker Compose, or Podman Compose layout, then run `sudo fos bootstrap` and confirm the rendered plan. `fos` generates separate administrator and first-vault NATS credentials. It displays them only through the protected post-install handoff; record both securely. The administrator credential is required for later bucket and vault-user management. Give plugin users only their vault-specific credentials.

For unattended operation, use a root-owned protected input file, pass `--approve`, and choose a root-only `--secrets-output` destination. Do not pass passwords as command-line flags or save generated secrets in a repository, shell history, or ordinary logs.

`fos` keeps NATS behind Caddy. The public endpoint is HTTPS/WSS only; the NATS WebSocket listener is private to the local host or Compose network. It does not publish NATS TCP port 4222 or a public monitoring route.

## Manual NATS setup

Enable JetStream with persistent file storage. Before connecting a plugin, an administrator creates each bucket with file storage, history 10, and replicas 1:

```sh
nats kv add OBS_VAULT_A_FILES --history 10 --replicas 1 --storage file
nats kv info OBS_VAULT_A_FILES
```

Use a separate administrator account for bucket creation and later management. Do not grant bucket-creation permission to normal vault users. A per-vault NATS user requires the following permissions; repeat the pattern with the second vault's bucket and stream name.

```hcl
jetstream { store_dir: "/path/to/persistent/nats-store" }
websocket {
  listen: "127.0.0.1:9222"
  no_tls: true
}
authorization {
  users: [
    {
      user: "vault-a", password: "<bcrypt-hash>"
      permissions: {
        publish: { allow: [
          "$KV.OBS_VAULT_A_FILES.>",
          "$JS.API.STREAM.INFO.KV_OBS_VAULT_A_FILES",
          "$JS.API.DIRECT.GET.KV_OBS_VAULT_A_FILES",
          "$JS.API.STREAM.MSG.GET.KV_OBS_VAULT_A_FILES",
          "$JS.API.CONSUMER.CREATE.KV_OBS_VAULT_A_FILES.>",
          "$JS.API.CONSUMER.INFO.KV_OBS_VAULT_A_FILES.>",
          "$JS.API.CONSUMER.DELETE.KV_OBS_VAULT_A_FILES.>",
          "$JS.API.CONSUMER.MSG.NEXT.KV_OBS_VAULT_A_FILES.>"
        ] }
        subscribe: { allow: ["_INBOX.>", "$KV.OBS_VAULT_A_FILES.>"] }
      }
    }
  ]
}
```

Use strong unique source passwords, store only their bcrypt hashes in NATS configuration, and provide the source password to the matching vault user through a protected channel. The file-record subject is `$KV.<bucket>.f.<fileId>`; keep the JetStream API and `_INBOX.>` permissions shown above because the KV client needs them for reads, watches, consumer management, and status.

Terminate TLS at Caddy and proxy only to the private NATS WebSocket listener:

```caddyfile
sync.example.com {
  reverse_proxy 127.0.0.1:9222
}
```

Confirm the domain DNS record resolves to the server and that every device accepts Caddy's public certificate. Do not expose the unencrypted upstream listener to the Internet. [NATS WebSocket configuration](https://docs.nats.io/reference/config/websocket/), [NATS authentication](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro), and [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) cover the underlying services.

## Plugin configuration and optional S3

In **Settings → Community plugins → flash-osidian-sync**, enter the provisioned Vault ID, `wss://` endpoint, vault username, and vault password. The plugin opens only `OBS_<vaultId>_FILES`.

S3 is optional. Leave all S3 fields empty to synchronize Markdown and content that fits the inline limit through NATS only. In that mode, images and other larger files are not synchronized. To synchronize large files, provide all S3 settings: HTTPS endpoint, bucket, region, access key ID, and secret key.

## Verification and safe recovery

Test a vault user's `put`, `get`, `watch`, `create`, `update`, and `status` operations only in that vault's bucket. Verify that the same user cannot access another vault's bucket and that invalid credentials are rejected. Check the plugin status after **Connect**; `SYNCED` indicates the initial reconciliation completed.

Before adding another device, back up its vault. Review conflict copies instead of deleting them blindly. For recovery, preserve the JetStream store and Caddy certificate data, stop the affected `fos-*` service or Compose project, and inspect `fos status` plus the protected state manifest. Do not remove volumes or the NATS store as part of a retry. Rotate a compromised vault password with the administrator account, update the plugin secret, and verify the old credential no longer connects.
