## Why

The user has to press **Connect** after each Obsidian startup. The plugin already attempts `connectNow()` when layout becomes ready, so this is a reliability defect rather than a missing connection command; a failed initial attempt may leave no engine for the current `online` handler to reconcile.

## What Changes

- Diagnose startup connection timing, persisted settings/SecretStorage availability, and initial WSS failure with reproducible evidence before selecting a fix.
- Automatically connect a configured vault after startup and retry transient failures when connectivity or app readiness returns, without requiring the manual **Connect** button.
- Report missing settings, authentication rejection, and transient network failure distinctly. Never loop indefinitely on invalid credentials or lose local outbox work.
- Keep **Connect** as a manual retry control and verify desktop and mobile startup/resume behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `realtime-sync-core`: Require reliable automatic startup connection and truthful connection/retry state.
- `local-durable-state`: Ensure pending mutations remain durable and replay only after a successful automatic reconnect.

## Impact

Plugin lifecycle, connection/retry state, status display, and tests. No server deployment or credential storage change. Exit condition: with valid saved settings and a reachable WSS endpoint, a fresh Obsidian start reaches reconciliation and normal sync without pressing **Connect**; an initially unavailable endpoint recovers after connectivity returns.
