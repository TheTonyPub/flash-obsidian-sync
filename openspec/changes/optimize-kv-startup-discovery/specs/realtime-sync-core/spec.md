## MODIFIED Requirements

### Requirement: Converged status is truthful
The plugin SHALL report `SYNCED` only when connected, complete startup or reconnect reconciliation has established a current remote snapshot and live delivery, no applicable outbox work remains, no unresolved conflict exists, and required blob transfers are complete. If primary discovery uses a recoverable fallback, `SYNCED` SHALL remain withheld until that fallback completes.

#### Scenario: Connected does not mean synchronized
- **WHEN** the WSS connection is open but reconciliation is still running
- **THEN** the status is not reported as `SYNCED`

#### Scenario: Discovery fallback is in progress
- **WHEN** primary remote discovery cannot establish completion and its complete-discovery fallback is running
- **THEN** the status is not reported as `SYNCED` until the fallback has completed and all other convergence conditions hold
