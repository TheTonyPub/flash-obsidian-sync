## 1. Plugin identity

- [x] 1.1 Add failing tests for `flash-sync` manifest identity, installation path, and fresh installation.
- [x] 1.2 Implement the smallest identity change on `dev`; keep `master`, server operational names, and `fos` intact.
- [x] 1.3 Run focused identity tests, plugin build, and typecheck.

## 2. Versioned distribution and tag workflow

- [x] 2.1 Add failing tests or local fixtures for valid and invalid tag forms, branch reachability, exact manifest/tag version match, and the required installation files.
- [x] 2.2 Implement distribution manifest generation from the validated tag, with a stable source-template base version check and no edits to the tagged checkout.
- [x] 2.3 Add one GitHub Actions tag workflow with ordered validate, build, test, and release stages; keep `dev` outputs as CI artifacts and publish alpha/beta and stable GitHub Releases with `main.js` and `manifest.json`, adding `styles.css` only if custom CSS is used.
- [x] 2.4 Verify version cases locally, installation files, typecheck, lint, unit tests, and workflow syntax; preserve existing broader push/PR CI. Mark stable GitHub publication unverified; do not trigger a stable tag or release.
- [ ] 2.5 Run only a prerelease tag on `dev` for live GitHub workflow acceptance. Verify its two uploaded installation files and GitHub's two generated source archives, without uploading duplicate archives.

## 3. Installation and repository identity

- [ ] 3.1 Rewrite README manual installation for matching release files, development CI artifacts, `.obsidian/plugins/flash-sync`, optional source build, stable-only Community Directory candidacy, GitHub-generated source archives, and a basic connection check.
- [ ] 3.2 Update repository-facing package metadata and stale clone/release URLs in user documentation for the existing `obsidian-flash-sync` repository, retaining `fos` and server-owned operational paths.
- [ ] 3.3 Review the full diff and strict OpenSpec validation; record prerelease GitHub evidence and the unverified stable GitHub path.
