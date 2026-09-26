# plugin-release-distribution Specification

## Purpose
Defines how tagged plugin builds become versioned installation files for stable, prerelease, and development channels without requiring users to build the plugin locally.

## Requirements

### Requirement: Tag channels and source branches
The repository SHALL recognize `x.y.z` as stable, `x.y.z-alpha.N` and `x.y.z-beta.N` as prerelease, and `x.y.z-dev.N` as development, where all numeric components are nonnegative SemVer integers without leading zeroes and `N` is a positive integer. Stable tags SHALL point to commits reachable from `master`; prerelease and development tags SHALL point to commits reachable from `dev`. Invalid or mismatched tags SHALL fail before publication.

#### Scenario: Stable tag
- **WHEN** a valid `1.2.3` tag points to a commit on `master`
- **THEN** the workflow accepts it as a stable release candidate

#### Scenario: Prerelease tag
- **WHEN** a valid `1.3.0-alpha.2` or `1.3.0-beta.2` tag points to a commit on `dev`
- **THEN** the workflow accepts it as a prerelease candidate

#### Scenario: Development tag
- **WHEN** a valid `1.3.0-dev.7` tag points to a commit on `dev`
- **THEN** the workflow accepts it as a development build candidate

#### Scenario: Wrong branch or malformed tag
- **WHEN** a tag has an unsupported version form or its commit is not reachable from the required branch
- **THEN** validation fails and no installation files are published

### Requirement: Manifest version matches build
Each tagged build SHALL contain a plugin manifest whose version equals the tag text exactly, including prerelease or development suffix. The plugin ID and display name SHALL be `flash-sync`. The release SHALL use the JavaScript built from the same tagged commit.

#### Scenario: Versioned prerelease build
- **WHEN** tag `1.3.0-beta.11` is built
- **THEN** its installable `manifest.json` has version `1.3.0-beta.11`, ID and name `flash-sync`, and accompanies that commit's `main.js`

### Requirement: Minimal installable outputs
Stable and prerelease GitHub Releases SHALL attach `main.js` and `manifest.json` as explicit installation assets. They SHALL attach `styles.css` only if the plugin uses custom CSS. They SHALL NOT upload source archives as extra assets: GitHub automatically provides Source code (zip) and Source code (tar.gz) for each release. Stable releases SHALL not be marked prerelease; alpha and beta releases SHALL be marked prerelease. Development tags SHALL create downloadable CI artifacts containing the same required installation files but SHALL not create a GitHub Release. Every channel SHALL pass validation, build, and tests before its output is published.

#### Scenario: Stable publication
- **WHEN** a stable tagged build passes validation, build, and tests
- **THEN** a stable GitHub Release for that tag provides two uploaded installation assets, `main.js` and `manifest.json`, plus the two GitHub-generated source archives

#### Scenario: Prerelease publication
- **WHEN** an alpha or beta tagged build passes validation, build, and tests
- **THEN** a GitHub prerelease for that tag provides the same two uploaded installation assets and two GitHub-generated source archives

#### Scenario: Custom stylesheet is added later
- **WHEN** the plugin actually uses custom CSS at a tagged build
- **THEN** that build also provides `styles.css` as an installation asset, for three uploaded files and five visible release assets including GitHub-generated source archives

#### Scenario: Development artifact
- **WHEN** a development tagged build passes validation, build, and tests
- **THEN** a CI artifact provides `main.js` and `manifest.json`, with `styles.css` only when used, and no GitHub Release for that tag

#### Scenario: Failed verification
- **WHEN** any validation, build, or test stage fails
- **THEN** no GitHub Release or development installation artifact is published for that run

The stable publication scenarios define required workflow behavior. This change's live GitHub acceptance SHALL exercise only a prerelease tag on `dev`; a stable tag or release SHALL NOT be created or run for acceptance of this change.
