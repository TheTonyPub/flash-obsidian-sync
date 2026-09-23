## MODIFIED Requirements

### Requirement: Source installation guide
The repository SHALL provide a root README with prerequisites for using `flash-sync`: a supported Obsidian version, reachable NATS WSS endpoint, pre-created vault bucket and credentials, and optional S3-dependent features. It SHALL explain how to download the matching `main.js` and `manifest.json` from a stable or prerelease GitHub Release, or from a development CI artifact, and manually install both under `.obsidian/plugins/flash-sync` in a desktop Obsidian vault. It SHALL direct users to install `styles.css` only when the selected build uses custom CSS, and distinguish these installation files from GitHub-generated Source code (zip) and Source code (tar.gz) archives. It SHALL give a basic connection check, describe source-build installation as an optional path, and distinguish manual installation from Community Plugins directory publication. It SHALL identify stable releases as the only Community Directory candidates.

#### Scenario: Manual installation from release
- **WHEN** a user downloads both assets from one stable or prerelease version and follows the README
- **THEN** the user can place them under `.obsidian/plugins/flash-sync`, enable the plugin, and identify the settings needed to connect to an existing server

#### Scenario: Manual installation from development artifact
- **WHEN** a user chooses a development CI artifact and follows the README
- **THEN** the user can install its two matching files manually and identify that it is a development build

#### Scenario: Manual installation from source
- **WHEN** a user follows the optional source-build path on a supported development machine
- **THEN** the user can build the plugin, place its required artifacts in the vault's plugin directory, enable it in Obsidian, and identify the settings needed to connect to an existing server

#### Scenario: Server is not yet available
- **WHEN** the user has no WSS endpoint or vault bucket
- **THEN** the README identifies those missing prerequisites and links to the manual server setup path without claiming the plugin can sync before server setup

#### Scenario: S3 is not available
- **WHEN** the user installs the plugin without external S3 configuration
- **THEN** the README explains that inline Markdown remains the intended NATS-only path and images are not synchronized until S3 is configured

## ADDED Requirements

### Requirement: Flash Sync plugin identity
The plugin SHALL use manifest ID and display name `flash-sync`.

#### Scenario: Fresh installation
- **WHEN** a user installs the plugin under `.obsidian/plugins/flash-sync`
- **THEN** Obsidian recognizes and displays it as `flash-sync`

## REMOVED Requirements

### Requirement: Preserve plugin state across identity rename
**Reason**: The new plugin identity supersedes this requirement.
**Migration**: Existing-vault migration is user-owned and outside this change.
