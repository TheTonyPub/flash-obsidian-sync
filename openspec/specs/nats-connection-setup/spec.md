# nats-connection-setup Specification

## Purpose

Provides the minimum user-run NATS configuration contract needed for a plugin to access one self-hosted vault safely.

## Requirements

### Requirement: User setup guide
The repository SHALL include a concise setup guide that states how to enable JetStream, create one KV bucket and one dedicated NATS username/password per vault, name the backing subjects, expose the required WSS endpoint, configure bucket-scoped permissions for KV and JetStream API operations, and enter matching plugin settings. Plugin credentials SHALL not require bucket-administration rights.

#### Scenario: User prepares an endpoint
- **WHEN** a user follows the setup guide for a fresh NATS deployment
- **THEN** the guide identifies every NATS value and plugin setting needed to perform a KV connection check

#### Scenario: Two vaults remain separate
- **WHEN** a user follows the guide to configure two vaults on one NATS server
- **THEN** it gives distinct bucket names and user credentials, and checks each vault's `put/get/watch` access while denying cross-vault access

#### Scenario: Unauthenticated access is denied
- **WHEN** a client connects without credentials or with an incorrect password
- **THEN** NATS rejects the connection and no vault data becomes available

### Requirement: Deployment remains user-owned
The repository SHALL not require deployment automation, server provisioning, or incident troubleshooting to use the plugin setup guide.

#### Scenario: CI remains deployment-independent
- **WHEN** GitHub Actions runs project checks
- **THEN** it validates plugin artifacts and test environments without deploying a user-hosted NATS service
