## Why

The initial `provision-sync-server` bootstrap runs on the target server. Operators should also be able to start the same installation from their local machine without manually opening an SSH session and running commands there.

## What Changes

- Add a local CLI mode that connects to a Debian/Ubuntu target over SSH and invokes the server bootstrap remotely.
- Define secure SSH authentication, host-key verification, privilege escalation, progress reporting, and recovery behavior before implementation.
- Keep the server-local bootstrap and its domain-only endpoint requirements as the foundation; this change adds remote orchestration, not a second provisioning implementation.

## Capabilities

### New Capabilities

- `remote-ssh-bootstrap`: Operator-initiated provisioning of a target server from a local machine over SSH.

### Modified Capabilities

None.

## Impact

The provisioning CLI, its packaging and documentation, SSH access to the target host, and installation tests. No change to the Obsidian plugin's synchronization protocol.
