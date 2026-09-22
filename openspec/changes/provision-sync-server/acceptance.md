# Acceptance evidence — provision-sync-server

**Recorded:** 2026-09-22–23 (local workstation and authorized test hosts)

This document records executed evidence only. The original test host was
`201.24.61.112` (Ubuntu 26.04 amd64); the operator deleted it after the
failed ACME attempts. The replacement authorized test host is
`201.34.146.81` (Ubuntu 26.04 amd64) with
`test.obsidian-sync.wholedata.ru`. Neither host is production. Task 6.6
remains incomplete. The original host had no successful credential handoff;
the replacement host has a root-owned `0600` handoff at
`/root/fos-cli-smoke/docker-credentials.json`. Its secret values were not
printed in test output or this record.

Some runtime evidence below predates removal of NATS monitoring port 8222 and
is labeled accordingly. The replacement Docker deployment was updated and
rechecked afterward, as recorded below. Task 6.6 remains incomplete for the
other runtime modes and independent network-vantage checks.

## Executed checks

| Gate | Exact command | Result |
| --- | --- | --- |
| Unit suite | `npm run test:unit` | Passed: 36 files, 192 tests. |
| Simulation suite | `npm run test:simulation` | Passed: 2 files, 11 tests. |
| Combined local suite | `npx vitest run tests/unit tests/simulation` | Passed: 38 files, 203 tests (exit 0). |
| Latest combined local suite | `npx vitest run tests/unit tests/simulation tests/integration/server-cli-bundle.test.ts` | Passed after the no-monitoring and guide changes: 42 files, 235 tests (exit 0) on 2026-09-23. |
| Type check | `npm run typecheck` | Passed. |
| Lint | `npm run lint` | Passed after removing an unused import. |
| Plugin build | `npm run build:plugin` | Passed; generated `packages/plugin/dist/main.js`. |
| Server CLI build | `npm run build:server-cli` then `node packages/server-cli/dist/main.js status` | Passed; CLI reported `NOT_INSTALLED` on the local workstation. |
| Server admin worker build | `npm run build:server-admin-worker` | Passed; generated `packages/server-cli/dist/admin-worker.js`. |
| Server CLI package contents | `npm_config_cache=/private/tmp/fos-npm-cache npm pack --dry-run --workspace @flash-osidian-sync/server-cli --json` | Passed; package includes `dist/main.js` and `dist/admin-worker.js`. |
| Isolated server CLI bundle | `npm run test:server-cli-bundle` | Passed after fixing a live-host missing-`bcryptjs` bundle failure; both artifacts load without host `node_modules`. |
| Ubuntu 26.04 compatibility | `npx vitest run tests/unit/server-cli-native.test.ts tests/unit/server-cli-preflight.test.ts tests/unit/server-cli-podman.test.ts` | Passed: 36 tests; `fos 0.1.0` now pins stock Ubuntu 26.04 NATS `2.10.27-1build1` and Caddy `2.6.2-14`. |
| TLS readiness retry | `npx vitest run tests/unit/server-cli-tls.test.ts tests/unit/server-cli-native.test.ts tests/unit/server-cli-wiring.test.ts` | Passed: 29 tests; 120-second bounded certificate/WSS wait retains TLS validation. |
| Pinned Caddy syntax | Disposable `docker run --rm --network none` with `caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d` and the generated domain proxy shape | Passed: `Valid configuration`; no network ports published. |
| Disposable NATS integration | `NATS_SERVER_BIN=/private/tmp/nats-server-v2.15.0-darwin-arm64/nats-server npx vitest run tests/integration/nats-permissions.test.ts tests/integration/markdown-nats.test.ts tests/integration/recovery-nats.test.ts` | Passed: 3/3 tests; permissions 270 ms, Markdown 188 ms, recovery 603 ms. |
| Debian 13 amd64 stock APT package check | Disposable no-port `debian:13@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c` container: `apt-get update`, exact-version install of `nats-server=2.10.27-1+b2` and `caddy=2.6.2-12+deb13u1`, then binary version checks | Passed; NATS reported `v2.10.27`, Caddy `2.6.2`. This is not a systemd/domain native bootstrap. |
| Ubuntu 24.04 amd64 stock APT package check | Disposable no-port `ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3` container: `apt-get update`, exact-version install of `nats-server=2.10.7-1ubuntu0.3` and `caddy=2.6.2-6ubuntu0.24.04.3`, then binary version checks | Passed; NATS reported `v2.10.7`, Caddy `2.6.2`. This is not a systemd/domain native bootstrap. |

The NATS integration command used the pinned NATS 2.15.0 Darwin ARM64
binary in an approved disposable loopback-only harness. They created no user
server resources. An initial sandbox attempt could not bind the required local
socket and timed out; the passing runs required the approved disposable
execution path.

## Runtime availability observations

Local checks found Docker Engine `29.7.2` and Docker Compose `v5.4.0`.
The pinned NATS and Caddy images were used for local checks. The local
workstation has no Podman. On the authorized test host, stock Ubuntu packages
installed Podman `5.7.0`, `podman-compose 1.5.0`, and Node.js `22.22.1`.
Direct Docker Hub pulls timed out; a temporary, root-only Podman registries
configuration routed the same digest-pinned Docker Hub references through the
reachable Timeweb mirror without changing system-wide registry settings.

## Original test-host runtime evidence

| Gate | Evidence | Result |
| --- | --- | --- |
| DNS and preflight | Public resolver returned `201.24.61.112`; Ubuntu 26.04 amd64, managed paths and 80/443 initially clear; `fos plan` for Podman and native modes | Both redacted plans passed, without mutation. |
| Podman runtime/provider | Rootful `podman run` with a disposable Alpine image; `podman-compose config`, `up -d`, bind-volume marker check, `ps`, then `down` for a no-port probe | Passed; no probe container remained. |
| Podman managed bootstrap | Noninteractive `fos bootstrap --non-interactive --input /root/fos-cli-smoke/input.json --secrets-output /root/fos-cli-smoke/credentials.json --approve` | NATS/Caddy started with only 80/443 host-published; stopped at `TLS_CERTIFICATE_UNVERIFIED`. Caddy container could not reach ACME through Podman bridge, while host-network container and host could. No state or secret handoff. |
| Native APT lock | `apt-cache show` for both exact Ubuntu 26.04 versions, followed by native bootstrap and `dpkg-query -W nats-server caddy` | Installed exact stock APT versions: `nats-server 2.10.27-1build1`, `caddy 2.6.2-14`. `fos-nats.service` failed because its generated unit used `/usr/bin/nats-server`; the package provides `/usr/sbin/nats-server`. The unit-template regression is fixed locally but not yet rerun on the host. |
| Native ACME | Caddy on host 80/443 attempted Let's Encrypt `tls-alpn-01` and `http-01` | Several primary validators reached Caddy, but Let's Encrypt reported `Timeout during connect` from secondary validation. No trusted certificate or verified WSS endpoint; bootstrap failed closed without state or secret handoff. Host UFW inactive; both ports reachable from the local workstation. Cause of validator-specific reachability is unresolved. |
| Failed-install containment | `podman-compose down`; native test units disabled/stopped; test-created config, data, logs, and units moved to root-only `/root/fos-cli-smoke/` | No managed service or 80/443/4222/8222/9222 listener remains. Files are preserved for inspection; no test data was deleted. |

The original host also received stock Docker Engine `29.1.3` and Docker
Compose `2.40.3`; the digest-pinned Caddy/NATS/Node images were pulled through
the Timeweb Docker Hub mirror. A real Docker bootstrap started the two
containers and Docker bridge ACME egress returned HTTP 200, but both ACME
challenge types failed because Let's Encrypt timed out connecting to
`201.24.61.112`. Retrying with the requested global Caddy block still failed
with `TLS_CERTIFICATE_UNVERIFIED`. Each partial Docker stack was stopped;
its configuration and data were moved to separate root-only archives before
the operator deleted the host. No state or credential output was issued.

## Replacement test-host Docker acceptance (2026-09-23)

| Gate | Evidence | Result |
| --- | --- | --- |
| DNS and host preflight | Authoritative Timeweb nameservers and `1.1.1.1` returned `201.34.146.81`; Ubuntu 26.04 amd64, managed paths and 80/443 free | Passed. |
| Stock dependencies and pinned images | Installed Ubuntu `docker.io 29.1.3-0ubuntu4.1`, `docker-compose-v2 2.40.3+ds1-0ubuntu1`, Node.js `22.22.1`; pulled pinned Caddy 2.11.4, NATS 2.15.0, and Node 22.22.0 Alpine images directly | Passed without a registry mirror. |
| Real CLI bootstrap | `fos plan` then `fos bootstrap --non-interactive --input /root/fos-cli-smoke/fos-docker-smoke-input.json --secrets-output /root/fos-cli-smoke/docker-credentials.json --approve` | Exit 0; `fos status: MANAGED — docker`; only 80/443 published by Compose. State and credential handoff are root-owned `0600`. |
| Caddy and public WSS | Generated Caddyfile has explicit Let's Encrypt ACME directory and `mail@hello.com`; Caddy logged `certificate obtained successfully`; external `curl --resolve ...` with normal verification returned WebSocket HTTP `101`, `ssl_verify_result=0`; `openssl s_client` showed Let's Encrypt `YE1` | Passed on the test domain. |
| First KV bucket | `fos vault list` and `inspect` using protected administrator input; internal-only NATS `/jsz?streams=true` | `OBS_smoke-docker_FILES` exists, file storage, history 10, replicas 1. Monitoring returned HTTP 200 only from the private Docker network in this pre-removal deployment. |
| Scoped vault and negative authentication | `fos vault verify` with protected vault input after a verifier fix; separate unauthenticated worker request | Own-bucket status/watch/write/read and cross-bucket denial passed (`{"verified":true}`); unauthenticated request exited 1 with authentication rejection. A test-only `OBS___fos_cross_probe_FILES` bucket remains as the real cross-bucket target. |
| Internal port exposure | Docker NATS `PortBindings` was `{}`; host `ss` showed listeners only on 80/443. External `nc` reported TCP success on 4222/8222/9222, but a simultaneous host `tcpdump -ni eth0` captured zero inbound packets for all three; HTTP to 8222 returned an empty response. | NATS has no host listener or published binding. The apparent TCP success did not reach this host from the test vantage, so a separate independent internet vantage is still needed for conclusive public-network isolation. |
| No-monitoring update | Backed up the two managed files, removed the exact `http_port: 8222` and Compose `expose` entries, validated Compose and NATS configuration, then recreated only NATS. The managed files have no `8222` reference; Docker NATS `PortBindings` is `{}` and host `ss` lists only 80/443. `fos status` reports `MANAGED — docker`. | Passed on the replacement host; the prior live monitoring probe is historical only. |
| TLS/WSS after no-monitoring update | External HTTPS check reported `ssl_verify_result=0`; HTTP/1.1 WebSocket Upgrade through Caddy returned `101` after the NATS restart. | Passed on `test.obsidian-sync.wholedata.ru`. |

The first `fos vault verify` incorrectly returned `VAULT_AUTH_REQUIRED` after
successful own-bucket operations: its worker treated opening a KV handle as
proof of cross-bucket access. A real second bucket did not change that result.
The verifier now performs `status()` against the probe bucket, accepts only
an explicit permission violation as denial, and preserves other failures.
The updated bundle passed the live verification. Fresh single-vault installs
still need a real second bucket for this negative check; this is a remaining
operator/CLI verification limitation, not a passed single-vault gate.

## Required gates not executed

- A conclusive independent external-network denial check for NATS ports;
  Docker/host binding checks passed but external TCP probes were ambiguous.
- Full Podman NATS+Caddy/TLS acceptance: the provider/volume cycle and managed
  startup ran, but bridge-container ACME egress failed; restart and endpoint
  readiness remain unverified.
- Native Debian 13 amd64 systemd/domain smoke check; exact stock APT package
  installation and binary execution passed only inside a disposable container.
- Native Ubuntu 24.04 amd64 systemd/domain smoke check; exact stock APT package
  installation and binary execution passed only inside a disposable container.
- Complete native Ubuntu 26.04 smoke after the corrected NATS unit is
  redeployed, including state/secret handoff and vault verification.
- A self-contained single-vault cross-bucket verification path that does not
  require manually creating the reserved probe bucket.
- Live backup/restore-check, upgrade, firewall-opt-in, and uninstall checks.

## Acceptance status

Task **6.6 remains unchecked**. Docker Compose on the replacement host has
passed real bootstrap, trusted TLS/WSS, first-bucket provisioning, scoped
vault operations, and unauthenticated/cross-bucket negatives. Other OS/mode
runtime gates, the single-vault probe limitation, and conclusive independent
public-port isolation are still open. No production installation is claimed.
