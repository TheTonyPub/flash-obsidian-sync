# MVP acceptance evidence — 2026-09-22

## Scope and state

This record covers the local workspace and the user's reported Desktop/iPhone acceptance of easy-sync 0.1.3. The workspace has no Git `HEAD`; all project files are untracked. There is no published commit, CI run, or release-review result to cite. Task 8.3 was cancelled by the owner.

## Executed checks

| Check | Result | What it proves |
| --- | --- | --- |
| `npx vitest run tests/unit tests/simulation` | 79/79 passed, 16 files | Protocol, local state, conflicts, lifecycle, blob handling, QR transfer, and deterministic multi-replica simulations. |
| `tests/simulation/faults.test.ts` | 7/7 passed | Three delayed/duplicate watch orders, restart after a committed KV write but before local acknowledgement, offline replay after simulated server restart with persisted KV, and two path-collision insertion orders. |
| `NATS_TEST_DOCKER=1 npx vitest run tests/integration/recovery-nats.test.ts` | 1/1 passed | Disposable NATS 2.15.0 with JetStream: bootstrap, offline edit, server restart, catch-up, and stable rapid edits. Test removed its container and volume. |
| `S3_TEST_DOCKER=1 npx vitest run tests/integration/blob-minio.test.ts` | 1/1 passed | Disposable MinIO: blob upload before KV publication, verified download, corruption rejection, and S3 outage behavior. Test removed its container. |
| `npm run typecheck` | passed | TypeScript checks on current source. |
| `npm run lint` | passed | ESLint checks on current source. |
| `npm run build:plugin` | passed | Browser bundle builds. |
| `openspec validate obsidian-sync-mvp --strict` | passed | OpenSpec change validates. |

The fault simulation initially had an intermittent failure because a Vault event timer added a second capture while the test also forced acknowledgement failure. The crash-point test now sets the Vault bytes directly and calls capture explicitly, isolating the intended failure point; the full 79-test run then passed. This does not claim every combination of timer and crash scheduling was explored.

## Manual acceptance

The user reported that the plugin works inside Obsidian, then on iPhone, and that the current end-to-end flow appears to work. On 2026-09-22 the user explicitly accepted task 8.2 as complete. These reports establish owner acceptance for Desktop/Mobile use; they are not a timestamped per-scenario execution log from this workspace.

No separate manual evidence was supplied here for each offline/resume, conflict-copy, rename, deletion, and S3 blob case on both physical devices. Automated checks above cover those behaviors at the engine/integration level. Mobile background execution is not promised by the design.

## Remaining verification limits

- The NATS integration uses direct local TCP and does not exercise the user's Caddy/WSS production route.
- The MinIO integration uses a local MinIO container and in-memory NATS KV, not the user's production S3 credentials or storage.
- The new fault tests use deterministic injected failures; they do not prove all schedules or long-running two-device operation.
- No Git commit or GitHub Actions run exists yet for this workspace, and release review was cancelled.
