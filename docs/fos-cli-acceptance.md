# fos CLI acceptance evidence

Recorded 2026-09-24 on the authorized test host `83.217.194.115` (Podman
5.7.0). This page records real-host vault CLI checks and isolated-container
lifecycle checks. It does not claim a fresh host installation or production
acceptance.

## Filesystem and preview checks

The lifecycle harness streams the built CLI bundle and test driver into a
disposable Node 22 container using the cached image
`docker.io/library/node:22-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34`.
The container has no network, host mounts, published ports, or Linux
capabilities. It is removed after the run; fixtures exist only in its
temporary root filesystem.

| Check | Command or operation | Result |
| --- | --- | --- |
| Lifecycle E2E | `rtk env FOS_LIFECYCLE_CONTAINER_E2E=1 bash tests/integration/fos-lifecycle-container-e2e.sh` | Passed on Node `v22.22.0`. |
| Status | Run `fos status` before and after writing a protected fixture manifest | Reported `NOT_INSTALLED`, then `MANAGED — podman`. |
| Backup | `fos backup --destination /tmp/fos-lifecycle-e2e-backups --retention 2` | Created a root-owned private snapshot containing the expected fixture markers. |
| Restore check | `fos restore-check --destination /tmp/fos-lifecycle-e2e-backups --retention 2` | Reported verification success; the restored Caddy and NATS fixture markers matched their sources. |
| Upgrade preview | `fos upgrade` | Returned the pinned Podman upgrade preview. No backup, pull, or service command ran. |
| Uninstall preview | `fos uninstall` | Returned the data-preserving preview. Managed state remained present afterward. |
| Upgrade apply orchestration | `fos upgrade --approve` in a disposable container with a Compose command shim | Attempted, then failed at DNS readiness (`queryA ETIMEOUT lifecycle.test`). This did not exercise real image or service changes. |
| Upgrade apply on a live service | Not run | DNS/TLS/WSS readiness could not be satisfied with container networking disabled. |
| Uninstall apply | Not run | No service shutdown or managed-resource removal was performed on the host. |
| Lifecycle orchestration units | `npx vitest run tests/unit/server-cli-lifecycle.test.ts tests/unit/server-cli-upgrade.test.ts` | Passed: 14 tests. Adapter orchestration uses test doubles and is not service E2E. |

The harness is opt-in and rejects execution unless
`FOS_LIFECYCLE_CONTAINER_E2E=1` is set. Its source is
`tests/integration/fos-lifecycle-container-e2e.sh` and its in-container
assertions are in `tests/integration/fos-lifecycle-container.mjs`.

## Apply-path limits

Upgrade and uninstall apply were not validated against real services.
Nested Podman, even with the VFS storage driver, could not start a harmless
child workload in the restricted container:

| Probe | Result |
| --- | --- |
| Nested Podman with no added capabilities | `newuidmap` failed with `operation not permitted`. |
| Nested Podman sharing the outer user namespace | Runtime hit read-only `/proc/sys/net/ipv4/ping_group_range`. |
| Inner workload sharing the outer network namespace | Outer container remained network-isolated, but crun failed setting mount propagation for `/`. |
| One-capability retry (`SYS_ADMIN`) | Did not resolve mount propagation. A later chroot-mode attempt closed SSH; a fresh connection succeeded and showed only the already accepted Caddy/NATS containers. No probe container remained. |
| Loopback DNS override | Podman rejected `--dns=127.0.0.1` with `--network=none` before creating a container. |

The successful harness validates local filesystem mutations and the
non-mutating lifecycle previews only. Unit tests cover lifecycle control flow
through adapter doubles; they do not validate real image pull/start/health
checks/rollback, service shutdown, or data deletion. The accepted host
installation was left running.

## Vault CLI acceptance and final verification

The final bundle passed the real Podman vault lifecycle on the authorized host:
`vault list` without options, `create`, `inspect`, `add`, `verify`, cross-vault
denial, `rotate`, `import`, and `revoke`. Both the old rotated password and the
revoked password were rejected with `VAULT_AUTH_REQUIRED`. The harness was
`FOS_VAULT_E2E=1 bash /root/fos-vault-e2e.sh`, sourced from
`tests/integration/fos-vault-e2e.sh`.

A live pre-fix probe confirmed the authorization failure: after an atomic host
configuration write, the host file had inode `530448` while the running NATS
file mount retained inode `525329`; their SHA-256 checksums differed. Sending
SIGHUP reloaded the stale mounted file. The fix recreates only the NATS service
with `up -d --no-deps --force-recreate nats`; native mode retains reload. This
causes a brief client reconnect. Regression tests cover both container modes
and restoring the original configuration.

After the full lifecycle, the original `test` vault authenticated and returned
bucket status through `wss://test.sync.wholedata.ru`. Caddy remained running.
Five exact disposable E2E buckets were removed through the administrator API
after verifying that their keys were empty or contained only `fos-verify`
probe values. The original `test` bucket was preserved.

Final local verification: 324 unit, simulation, and bundle tests passed;
TypeScript and ESLint passed. A broader `npm test` attempt additionally reached
three NATS integration tests that failed at their prerequisite checks because
`NATS_SERVER_BIN` / `NATS_TEST_DOCKER` was unset; the optional MinIO test was
skipped. These are not reported as successful local integration coverage.
Real Podman vault E2E above passed against the installed NATS service.

Vault acceptance baseline bundle SHA-256 values:

- `main.js`: `d7865a01a7b35f21c868b3c61cbb7af33fdb195b4b9c8bc9f0511b46200e98b3`
- `admin-worker.js`: `14a629f59abcfe159948aa2987667389fd25cd7ad93144bd8b6623b4c1e2830a`

Temporary diagnostic workers, logs, and test handoffs were removed. Only the
running NATS and Caddy containers remain; the three retained images are the
pinned NATS, Caddy, and Node admin-worker images required by the installation.
The original protected handoff and CLI rollback backups were preserved.

## Compact QR and import link follow-up

The terminal import link is highlighted without changing or truncating the URI.
Compact QR rendering retains error correction level M; a synthetic example
measured 35 by 18 terminal cells instead of 70 by 35. No physical scan was performed.

The final installed `main.js` SHA-256 is
`0bbc4c1a52cb41f5d69583df775615f02ed29ef0e616c0a5088be2be04b4028b`;
the administrator worker hash is unchanged from the baseline above.
Real host PTY verification of `fos import --secrets-output` passed: the file was
root-owned with mode 0600, contained a valid URI and compact QR without ANSI
escapes, and no URI was disclosed to the terminal. Status and bare vault list
still passed. Services and configuration were not changed or restarted.
Temporary verification files were removed; the original handoff was preserved.

## Presentation follow-up acceptance

The subsequent compact QR and import-link presentation bundle was installed
without restarting services or changing server configuration. A real host PTY
ran `fos import --vault-id test --secrets-output <unique-private-path>`.
Assertions confirmed that the URI was valid, no URI appeared in terminal
output, and the destination was root-owned with mode `0600` and no ANSI
sequences. The temporary handoff and diagnostic files were then removed.
The original protected handoff was preserved.

For the same synthetic payload and unchanged error correction level M, the
terminal QR changed from 70 columns by 35 rows to 35 columns by 18 rows.
These are renderer dimensions, not a claim of physical scanning acceptance.

Latest installed bundle SHA-256 values:

- `main.js`: `0bbc4c1a52cb41f5d69583df775615f02ed29ef0e616c0a5088be2be04b4028b`
- `admin-worker.js`: `14a629f59abcfe159948aa2987667389fd25cd7ad93144bd8b6623b4c1e2830a`
