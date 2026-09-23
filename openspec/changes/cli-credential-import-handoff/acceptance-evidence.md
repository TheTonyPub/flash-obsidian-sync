# Acceptance Evidence: CLI Credential Import Handoff

## Scope reviewed

Reviewed the implementation against the `credential-import-handoff` and `vault-provisioning` delta specs, [proposal.md](proposal.md), and [design.md](design.md).

- Bootstrap, vault add, and rotation produce a vault-only Obsidian URI and terminal QR after verified credential provisioning.
- The endpoint resolver validates `wss://` values, prefers an explicit override, then the retained bootstrap endpoint, prompts only interactively, and does not discover a domain from an IP.
- Bootstrap retains the administrator record separately; vault plaintext is retained only with `--keep`. Vault records use the managed root-owned `0600` atomic store and cannot resolve an administrator record.
- `fos import --vault-id` reads only a retained vault record, has no server adapter or mutation path, supports a validated endpoint override, and reports rotation guidance for unavailable credentials.
- Empty phrases generate plaintext version 2; a nonempty phrase of at least eight characters keeps encrypted version 1. Plugin import recognizes both and writes NATS/S3 secrets only to SecretStorage.
- Rotation replaces or removes stale retained vault credentials after verification; revocation removes only the successfully revoked vault record.
- No server deployment automation, DNS/reverse-DNS endpoint discovery, or server-side password recovery was added.

## Executed checks

| Check | Result |
| --- | --- |
| `npm run test:unit -- --reporter=dot` | Passed: 45 files, 296 tests |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run build:plugin` | Passed |
| `npm run build:server-cli` | Passed |
| `git diff --check` | Passed |
| `openspec validate cli-credential-import-handoff --strict` | Passed |

Focused lifecycle tests cover protected recovery when state commit, administrator-record persistence, or QR rendering fails after server apply. They verify one protected credential disclosure, redacted failures, and normal administrator persistence before the ordinary handoff.

## Unverified runtime gates

- A separate `npm test` attempt reported three NATS integration prerequisite failures because neither `NATS_SERVER_BIN` nor `NATS_TEST_DOCKER=1` was configured. Those cases did not reach live NATS execution; they provide no product-runtime result.
- No live server deployment, endpoint, QR-device scan, NATS mutation, rotation, or revocation was performed during this review. Those operations remain user-owned runtime acceptance.

## Rollback and recovery

Version-1 encrypted transfer payloads remain supported. Version-2 generation can be stopped while retaining version-1 import support. If post-apply state persistence, credential-record persistence, or QR rendering fails, the CLI attempts a single protected credential disclosure and returns a redacted failure so an operator can recover rather than relying on password-hash recovery. Existing installations without a retained vault plaintext credential require rotation with `--keep` before `fos import` can regenerate a link.
