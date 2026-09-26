## Why

Manual plugin installation currently requires a source checkout and local build. The release process needs reproducible, downloadable plugin files and a consistent identity and version scheme across stable, prerelease, and development builds.

## What Changes

- Add one tag-driven GitHub Actions workflow with validate, build, test, and release stages for `dev` and `master`.
- Publish stable `x.y.z` releases from `master` and `x.y.z-alpha.N` or `x.y.z-beta.N` prereleases from `dev`, each with `main.js` and `manifest.json` as explicit installation assets. Include `styles.css` only if the plugin uses custom CSS. GitHub supplies Source code (zip) and Source code (tar.gz) archives automatically. Produce CI artifacts, without a GitHub Release, for `x.y.z-dev.N` tags from `dev`.
- Make each built manifest version exactly match its tag and document SemVer prerelease ordering. Treat stable releases as the Community Directory candidate; keep prerelease and development builds for manual installation.
- **BREAKING:** Change plugin ID and display name to `flash-sync`.
- Update repository URLs and manual installation instructions for the existing `obsidian-flash-sync` repository. Keep the server CLI command `fos`.

## Capabilities

### New Capabilities

- `plugin-release-distribution`: Tag validation, versioned plugin build, verification, downloadable assets, and release channel behavior.

### Modified Capabilities

- `server-provisioning`: Update plugin identity and manual installation requirements for `flash-sync` and release downloads.

## Impact

GitHub Actions, the plugin manifest/build, identity constants and related tests, package metadata, and installation documentation change on `dev`. The repository and origin URL already use `obsidian-flash-sync`; `master` remains untouched during this change. Existing server-owned paths, Compose project identity, and `fos` executable remain compatible. Server operations remain user-owned. Live workflow acceptance uses only a prerelease tag on `dev`; stable publication behavior stays specified but unverified on GitHub in this change.
