## MODIFIED Requirements

### Requirement: Blob-backed remote records
When valid external S3 settings are configured, the plugin SHALL store included binary files and Markdown over the configurable inline limit as SHA-256-addressed blobs. It SHALL complete an upload before publishing a remote record that references the blob. Without valid S3 settings, the plugin SHALL retain files requiring blob storage locally, report them as not synced, and SHALL NOT publish a remote record claiming the missing blob exists. Normal inline Markdown synchronization SHALL remain available.

#### Scenario: Large file publication
- **WHEN** an included binary file or oversized Markdown file changes and valid S3 settings are configured
- **THEN** the plugin uploads the blob before remote state contains its metadata and hash, not raw bytes

#### Scenario: S3 settings are empty
- **WHEN** S3 settings are empty and an image or oversized Markdown file changes
- **THEN** the plugin keeps that file locally, reports it as not synced, publishes no blob reference for it, and continues syncing unrelated inline Markdown

#### Scenario: S3 is configured later
- **WHEN** valid S3 settings are added after blob-backed files were held locally
- **THEN** the plugin resumes their pending uploads without discarding the local files or publishing a reference before each upload completes
