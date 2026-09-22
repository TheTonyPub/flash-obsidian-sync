## Purpose

Defines an externally reachable, verifiable WSS endpoint for a domain-based installation without weakening the plugin's TLS checks.

## ADDED Requirements

### Requirement: Verified domain endpoint
The installer SHALL require a domain and configure Caddy to expose the NATS WebSocket endpoint over `wss://` using a certificate trusted by client devices. It SHALL keep upstream NATS access private and test a real TLS handshake and WebSocket connection before reporting success.

#### Scenario: Reachable domain
- **WHEN** a domain resolves to the host and certificate issuance succeeds
- **THEN** the installer reports the verified WSS URL and NATS remains inaccessible on a public plaintext listener

#### Scenario: Certificate issuance fails
- **WHEN** the domain certificate cannot be obtained or validated
- **THEN** bootstrap reports why and does not present an unusable endpoint as ready

### Requirement: Network exposure checks
The CLI SHALL verify that only Caddy TCP 80/443 are publicly exposed across native, Docker Compose, and Podman Compose installations. NATS client and internal WebSocket traffic SHALL not be publicly reachable. This change SHALL not enable the NATS HTTP monitoring listener or port 8222 in any mode; monitoring belongs to a separate change.

#### Scenario: Public NATS listener detected
- **WHEN** an installation exposes a managed NATS listener publicly
- **THEN** the CLI reports an actionable failure instead of marking installation healthy

#### Scenario: Monitoring is absent in every mode
- **WHEN** the operator renders native, Docker Compose, or Podman Compose configuration
- **THEN** no NATS HTTP monitoring listener, Compose exposure for 8222, or public Caddy monitoring route is present
