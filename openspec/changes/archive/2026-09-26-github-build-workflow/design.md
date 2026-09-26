## Context

See proposal.md. The current CI workflow runs on pushes and pull requests, while `build:plugin` emits only `packages/plugin/dist/main.js`. `packages/plugin/manifest.json` is a checked-in stable version. Existing server-owned paths and Compose identity also contain the old name. The plugin currently has no `styles.css` or custom CSS use. The checkout is `dev`; local `dev`, local `master`, and remote-tracking `origin/dev` and `origin/master` all resolve to `30e77dafce9a2ec48f63ee8c6f2d0b60bf609445`. The origin URL already points to `TheTonyPub/obsidian-flash-sync`.

## Goals / Non-Goals

**Goals:**

- One small tag workflow implements the four ordered stages for both branches.
- Every downloadable pair uses the tag's exact version and is built from the tag's commit.
- The built plugin and manual installation path use one `flash-sync` identity.

**Non-Goals:**

- Publish the plugin to the Obsidian Community Directory as part of this change.
- Release or package the `fos` CLI in the plugin GitHub Release.
- Rename existing server state directories, systemd units, Compose project, or backup roots. That would require a separate server migration.
- Change NATS/S3 topology, deploy a user server, or mutate an existing vault during CI.
- Change `master` or run a stable tagged GitHub Release as part of this change.

## Decisions

### One tag workflow with channel validation

Trigger on pushed tags, then validate the entire tag against one of `x.y.z`, `x.y.z-alpha.N`, `x.y.z-beta.N`, or `x.y.z-dev.N`. Use strict SemVer numeric components and positive build sequence `N`. Fetch branch history and require the tagged commit to be reachable from `origin/master` for stable or `origin/dev` for prerelease/development. Tag spelling determines channel even if a merged commit is reachable from both branches. A branch name supplied by the tag pusher is not reliable evidence of tag origin.

Use four named, ordered stages in one workflow: **validate**, **build**, **test**, **release**. A single job avoids repeating checkout, Node setup, and artifact transfers. Validation also checks release manifest identity; build runs `npm ci`, `build:plugin`, and creates a temporary distribution directory; test runs typecheck, lint, unit tests, and checks that the installation files are present and self-consistent. Keep existing push/PR CI for its broader integration and simulation coverage. Alternative: four jobs with artifact handoffs. That adds setup and transfer complexity without changing the release contract.

### Version only the distribution manifest

Keep `packages/plugin/manifest.json` as the source template with a stable `x.y.z` version. At build time, write a distribution copy whose `version` is exactly the tag text. Never edit the tagged checkout during release or require a per-tag manifest commit. Installers use the generated manifest beside the generated `main.js`, including `-dev.N`, `-alpha.N`, or `-beta.N`. Check the base `x.y.z` in the source template against the tag base to prevent publishing a tag for a different version. The tag is the source of truth for channel/version; GitHub run number is not substituted for `N`.

Alternative: commit a unique manifest version for every tag. That requires extra version-only commits, especially for development builds, and can cause tag/manifest drift.

### Publish only installation files according to channel

For stable tags, create a GitHub Release. For alpha and beta tags, create a GitHub Release marked prerelease. Upload generated `main.js` and `manifest.json` as explicit installation assets. The current plugin has no custom CSS, so do not upload `styles.css`; include it only if a future build actually uses it. GitHub automatically presents Source code (zip) and Source code (tar.gz) for each release. Never upload duplicate archives. A current release therefore shows four visible assets: two uploaded installation files and two generated source archives. If custom CSS becomes necessary, it shows five. For development tags, upload the installation files as a CI artifact in the release stage, without creating a GitHub Release. Give the workflow only the token permissions needed to create releases; do not use a personal access token. Ensure failed earlier stages cannot publish.

Alternative: publish development tags as GitHub prereleases. This would mix short-lived development output with deliberately published alpha/beta releases.

### Set one plugin identity

Use `flash-sync` consistently in manifest, UI, plugin data path, local store name, and newly generated import URI. Keep server ownership names unchanged.

Alternative: retain the previous manifest ID. That would not deliver the requested plugin identity.

### Use the existing repository identity

The GitHub repository and origin URL already use `obsidian-flash-sync`. Update stale clone/release links and root package metadata on `dev`, without renaming GitHub or changing the remote. Keep executable `fos`. Keep existing server operational names and paths for deployed-state compatibility. Internal workspace package names may remain unchanged because they are private implementation identifiers; changing them is unnecessary to satisfy the public naming contract.

## Risks / Trade-offs

- **Invalid or misplaced tag:** validate full syntax and branch reachability before building or publishing.
- **Version mismatch between files:** generate distribution manifest from the tag and test the pair before publication.
- **Stale repository links:** update references to the existing `obsidian-flash-sync` URL.
- **Stable path not live-tested:** inspect and test stable classification locally, but mark GitHub stable publication unverified until a later authorized `master` tag run.

## Release Plan

1. Make feature changes on `dev` only. Change plugin identity to `flash-sync` and verify a fresh install uses that identity. Keep server-owned names unchanged.
2. Add tag workflow and local distribution verification. Test channel classification locally. Exercise only a prerelease tag on `dev` in GitHub; verify two uploaded installation files and two generated source archives. Do not create or run a stable tag for this change.
3. Update manual installation guide and stale `fos` clone URL to the already renamed repository. Verify those links without changing GitHub repository settings or the Git remote.
