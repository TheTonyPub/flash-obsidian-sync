## 1. Source installation and CLI contract

- [x] 1.1 [owner: gpt-5.6-luna medium, tests] Define a failing documentation check for root README prerequisites, reproducible source build, manual desktop plugin installation, existing NATS setup, optional S3 limits, and a connection check.
- [x] 1.2 [owner: gpt-5.6-terra low, implementation] Write root README with those steps; verify a clean source build and manual installation against a test vault before starting server CLI work.

Task 1.2 verification note: the user requested completion despite the manual Obsidian test-vault install not being exercised. README check, typecheck, and clean plugin build passed; live UI installation remains unverified.
- [x] 1.3 [owner: gpt-5.6-terra medium, architecture] Fix supported Debian 13, Ubuntu 24.04/26.04 amd64 releases and per-release NATS/Caddy versions, Compose provider matrix, owned paths, and server-local command contract; keep SSH orchestration out of this change.
- [x] 1.4 [owner: gpt-5.6-luna medium, tests] Write failing tests for unsupported OS, remote-target rejection, missing domain, interactive prompts, redacted preview, confirmation, and missing unattended input.
- [x] 1.5 [owner: gpt-5.6-terra low, implementation] Add server-local CLI package and guided `bootstrap`/`plan` flow plus unattended protected-input support; pass tests from 1.4.
- [x] 1.6 [owner: gpt-5.6-luna medium, tests] Write failing tests for owned-resource inventory, conflict detection, repeat bootstrap, and protected state permissions.
- [x] 1.7 [owner: gpt-5.6-terra low, implementation] Add desired-state reconciliation and status without mutating unrelated installations; pass tests from 1.6.
- [x] 1.8 [owner: gpt-5.6-luna medium, tests] Write failing rename tests for `flash-osidian-sync` manifest/install path, `fos` executable, legacy settings/SecretStorage/IndexedDB outbox and vault binding, dual import URI compatibility, interrupted migration, and rollback preservation.
- [x] 1.9 [owner: gpt-5.6-terra low, implementation] Rename plugin identity, user-facing copy and internal packages as needed; add idempotent legacy-state migration without deleting old data or allowing two simultaneous writers; pass tests from 1.8.
- [x] 1.10 [owner: gpt-5.6-terra low, implementation] Rename CLI executable, banner, managed paths and project/unit names to `fos`/`flash-osidian-sync`; update README, source-install check, operator docs, and CLI tests; preserve existing manual infrastructure and pass focused checks.

## 2. Installation modes

- [x] 2.1 [owner: gpt-5.6-luna medium, tests] Write failing native-mode tests for preflight, non-root service identities, systemd services, private listener, and persistent JetStream state.
- [x] 2.2 [owner: gpt-5.6-terra low, implementation] Implement native Debian/Ubuntu NATS/Caddy service adapter and config validation; pass tests from 2.1.
- [x] 2.3 [owner: gpt-5.6-luna medium, tests] Write failing Docker Compose tests for the Caddy/NATS private-network topology, pinned services, only 80/443 host-published, private WebSocket upstream, no 8222 monitoring listener, restart, persistent JetStream data, and provider preflight.
- [x] 2.4 [owner: gpt-5.6-terra low, implementation] Implement generated Compose resources and Docker adapter; pass tests from 2.3.
- [x] 2.5 [owner: gpt-5.6-luna medium, tests] Write failing Podman Compose compatibility tests covering provider discovery, rootless ports, volumes, and restart.
- [x] 2.6 [owner: gpt-5.6-terra low, implementation] Implement Podman adapter or narrow provider-specific overrides; pass tests from 2.5.
- [x] 2.7 [owner: gpt-5.6-luna medium, tests] Add failing parity tests proving native, Docker, and Podman configurations contain no NATS HTTP monitoring listener or 8222 exposure while keeping client/WebSocket listeners private.
- [x] 2.8 [owner: gpt-6-luna high, implementation] Remove the NATS monitoring listener and Compose exposure from every generated mode; verify the Caddy endpoint continues to proxy only to private NATS WebSocket.

## 3. Verified WSS endpoint

- [x] 3.1 [owner: gpt-5.6-luna medium, tests] Write failing domain-mode tests for DNS/ports, certificate acquisition failures, TLS/WSS verification, private NATS exposure, and generated configuration without a monitoring listener, 8222 port, or `/monitoring` route.
- [x] 3.2 [owner: gpt-5.6-terra low, implementation] Generate and validate domain Caddy/NATS proxy configuration; pass tests from 3.1.

## 4. Vault and credential lifecycle

- [x] 4.1 [owner: gpt-5.6-luna medium, tests] Write failing tests for random administrator and vault password generation, one-time post-success disclosure, protected unattended output, and no plaintext persistence or logging.
- [x] 4.2 [owner: gpt-5.6-terra low, implementation] Generate distinct administrator and vault credentials, store only password hashes in managed NATS config, and deliver secrets through protected output; pass tests from 4.1.
- [x] 4.3 [owner: gpt-5.6-luna medium, tests] Write failing tests for required administrator authentication, vault ID collisions, idempotent bucket creation, data preservation, and file/history/replica properties.
- [x] 4.4 [owner: gpt-5.6-terra low, implementation] Implement administrator-authenticated internal NATS KV create/list/inspect commands; pass tests from 4.3.
- [x] 4.5 [owner: gpt-5.6-luna medium, tests] Write failing tests for scoped NATS user configuration, generated rotation passwords, administrator-gated user actions, config validation/reload, and rollback on failure.
- [x] 4.6 [owner: gpt-5.6-terra low, implementation] Implement add, rotate, and revoke via managed authorization config and service reload; pass tests from 4.5.
- [x] 4.7 [owner: gpt-5.6-luna medium, tests] Write failing two-vault integration tests for own-bucket read/write/watch/status and cross-vault or unauthenticated denial; use the supplied `OBS_VAULT_A_FILES` subject allowlist as a reference fixture and determine minimum grants against pinned versions.
- [x] 4.8 [owner: gpt-5.6-terra low, implementation] Add `vault` verification and error reporting using scoped credentials; pass tests from 4.7.

## 5. Optional operator controls

- [x] 5.1 [owner: gpt-5.6-luna medium, tests] Write failing tests for firewall opt-out, live SSH preservation, dedicated service identity selection, and confirmation boundaries.
- [x] 5.2 [owner: gpt-5.6-terra low, implementation] Add opt-in firewall and service identity handling; pass tests from 5.1.
- [x] 5.3 [owner: gpt-5.6-luna medium, tests] Write failing backup/restore-check tests for destination, retention, access restrictions, and a verified restore.
- [x] 5.4 [owner: gpt-5.6-terra low, implementation] Add opt-in backup schedule and restore-check commands; pass tests from 5.3.
- [x] 5.5 [owner: gpt-5.6-luna medium, tests] Write failing upgrade/uninstall tests for preview, rollback, owned-resource boundaries, data preservation, and separate deletion confirmation.
- [x] 5.6 [owner: gpt-5.6-terra low, implementation] Add opt-in upgrade management and later uninstall command; pass tests from 5.5.

## 6. Packaging and acceptance

- [x] 6.1 [owner: gpt-5.6-luna medium, tests] Write failing plugin tests for empty S3 settings: inline Markdown sync succeeds; changed images remain local, do not publish blob references, and show not-synced status.
- [x] 6.2 [owner: gpt-5.6-luna medium, tests] Write failing recovery tests: adding valid S3 settings resumes pending image upload; files requiring blob storage are never discarded while S3 is absent.
- [x] 6.3 [owner: gpt-5.6-terra low, implementation] Make plugin S3 settings optional and gate blob transfers without blocking inline Markdown; pass tests from 6.1 and 6.2.
- [x] 6.4 [owner: gpt-5.6-terra low, implementation] Expand `.gitignore` for `.DS_Store`, deployment secrets/data, generated artifacts, and logs without hiding checked-in examples or OpenSpec files.
- [x] 6.5 [owner: gpt-5.6-terra low, implementation] Update English NATS setup and operator docs for server-local commands, domain DNS/TLS, protected administrator and vault secret handoff, optional S3 plugin settings, and safe recovery.
- [ ] 6.6 [owner: gpt-5.6-luna medium, tests] Run focused suites, disposable NATS/Caddy tests for both Compose providers, Debian 13 and Ubuntu 24.04/26.04 amd64 smoke checks, negative TLS/access tests, and optional-S3 plugin tests; record which runtime checks actually ran.
- [x] 6.7 [owner: gpt-5.6-terra medium, architecture] Review resulting diff, ownership boundaries, and acceptance evidence; do not claim untested production installation.
- [x] 6.8 [owner: gpt-5.6-luna medium, tests] Add a focused documentation check for separate `fos` source-installation and usage guides, including README and NATS-guide links.
- [x] 6.9 [owner: gpt-5.6-terra low, implementation] Write separate `docs/fos-install.md` and `docs/fos-usage.md`; document building/installing `fos` from repository source (never APT), prerequisites, verification, updates, interactive and unattended use, secrets, supported modes, and administrator-gated commands.
