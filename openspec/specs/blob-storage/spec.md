# blob-storage Specification

## Purpose

Synchronizes binary and oversized content through immutable, integrity-checked S3-compatible objects while keeping normal Markdown on the KV path.

## Requirements

### Requirement: Blob-backed remote records
The plugin SHALL store binary files and Markdown over the configurable inline limit as SHA-256-addressed blobs. It SHALL complete an upload before publishing the remote record that references it.

#### Scenario: Large file publication
- **WHEN** an included binary file or oversized Markdown file changes
- **THEN** remote state contains blob metadata and hash, not raw bytes

### Requirement: Downloaded blobs are verified
The plugin SHALL verify downloaded blob bytes against the advertised SHA-256 hash before applying them locally.

#### Scenario: Corrupt blob is rejected
- **WHEN** a blob download hash differs from its remote metadata
- **THEN** the plugin does not apply the bytes and reports a sync error while retaining pending local state
