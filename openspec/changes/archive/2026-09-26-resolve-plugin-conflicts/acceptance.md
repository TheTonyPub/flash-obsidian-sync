# Automated acceptance evidence

Executed on 2026-09-25 from the repository root after the section 2 and status-bar changes were integrated.

| Acceptance area | Evidence |
| --- | --- |
| Durable merge, bootstrap, and path-collision records; anchors; metadata-only comparisons; stale local/remote guards; recovery backups; history retention and redaction | `npx vitest run tests/unit/conflict-lifecycle-contract.test.ts` — 13 passed |
| Keep remote, Keep local copy, manual edit/delete, exact outbox confirmation, changed-copy guard, and raced-resolution return to review | `npx vitest run tests/unit/conflict-lifecycle-contract.test.ts` — 13 passed |
| Restart recovery, idempotent records, and CAS retry behavior | `npx vitest run tests/simulation/conflict-restart-cas-contract.test.ts` — 3 passed |
| Type safety | `npm run typecheck` — passed |
| Lint | `npm run lint` — passed |
| Plugin bundle | `npm run build:plugin` — passed; esbuild reported a 1.2 MB bundle warning only |
| OpenSpec artifacts | `openspec validate resolve-plugin-conflicts --strict` — valid |
| Patch whitespace | `git diff --check` — passed |

Automated evidence does not cover the manual Obsidian accessibility review in task 4.5.

## Manual acceptance correction, 2026-09-25

User-provided Obsidian screenshots showed nine eager inline comparisons overflowing the Settings pane, including long paths and hashes behind action buttons. Two inspected vault files (`copilot/skills/copilot-web-fetch/SKILL.md` and its preserved conflict copy) were byte-identical at inspection time: both 2,017 bytes with SHA-256 `28f08b5625de2d0b384d84d1a7fc791aa184fa546a0b3a80960fc922731817e2`. The historical remote bytes at conflict detection were unavailable, so this observation does not prove they matched then. Code inspection identified two reproducible mechanisms: stale-revision blob handling created a conflict before equal-hash comparison, and generated conflict copies were queued as ordinary files, producing nested conflict-copy paths.

The correction uses collapsed conflict items in Settings and creates an on-demand local Markdown review snapshot under `Flash Sync Conflict Reviews/`. It keeps generated copies and review notes out of synchronization and preserves existing conflict records and files for deliberate review. No existing conflict copy was deleted or automatically marked resolved.

| Check | Executed result |
| --- | --- |
| Complete unit suite after correction | `npm exec vitest run tests/unit` — 51 files, 367 tests passed |
| Conflict/restart simulations | `npm exec vitest run tests/simulation/conflict-restart-cas-contract.test.ts tests/simulation/conflicts.test.ts` — 2 files, 7 tests passed |
| Type safety and lint | `npm run typecheck` and `npm run lint` — passed |
| Plugin bundle | `npm run build:plugin` — passed; esbuild reported a 1.2 MB bundle warning only |
| OpenSpec and patch | `openspec validate resolve-plugin-conflicts --strict` and `git diff --check` — passed |

The redesigned Settings and review note still need manual visual and accessibility inspection in Obsidian. Task 4.5 remains open.

## User-provided Settings screenshots, 2026-09-25 13:25

The supplied Obsidian screenshots show Overview, Connection, Attachments, Device transfer, and Advanced sections rendering. Overview reports Connected, zero pending Markdown changes, zero attachment transfers, and zero unresolved conflicts. These images support the user's report that the current settings flow works. The Advanced screenshot exposes a misplaced status-bar mode control; a focused layout correction follows this review. Because the images show zero conflicts and omit the status bar itself, they do not verify an expanded conflict, a review note, state-specific status labels/tooltips, keyboard activation, or contrast. Task 4.5 remains open until those checks are observed.

The Advanced control now uses one native Settings row for its label, description, and dropdown. `npm exec vitest run tests/unit/settings-ui.test.ts tests/unit/plugin-identity.test.ts` passed (14 tests), as did typecheck, lint, plugin build, strict OpenSpec validation, and `git diff --check`. The rebuilt plugin files were copied to the active `VAULT_A` test vault and matched the build byte-for-byte. A plugin reload is required for Obsidian to display the correction.

## Immediate Advanced controls and Overview indicator, 2026-09-25

The user requested an immediate-save Advanced page, a visible Minimal/Extended choice, Debug logging in a footer, and an Overview status dot. Advanced now commits each changed field against the latest serialized configuration; a valid completed inline-limit edit reconnects once. Validation and persistence failures leave the saved configuration intact, and persistence failure restores the visible controls. Connection and Attachments retain staged Save/Discard behavior. Overview derives its colored dot and text from the same aggregate precedence as the status bar, so conflict and pending states cannot appear green.

Executed evidence: `npm exec vitest run tests/unit` — 51 files, 373 tests passed; `npm run typecheck`, `npm run lint`, `npm run build:plugin`, `openspec validate resolve-plugin-conflicts --strict`, and `git diff --check` all passed. The bundle produced only the existing 1.2 MB esbuild warning. Manual Obsidian visual and accessibility review remains task 4.5.
