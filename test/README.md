<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test and Validation Guide

This directory contains reusable automation notes and validation procedures for the desktop application. When similar regressions appear in the future, contributors should reuse the same suites and command patterns instead of inventing one-off verification steps.

## Coverage Areas

- PromptSender UI behavior
- Prompt List filtering, Task badges, and copy behavior
- Prompt send / execute flow and failure handling
- Auto-update behavior, including "download only until explicit restart" and GitHub release publishing
- Settings update controls, including manual check and restart-to-update actions
- Per-agent font settings for Git Diff and Project Editor
- Git History browsing and diff rendering
- Image rendering across Git Diff, Git History, and Project Editor
- Prompt cleanup and retention behavior
- Feedback modal browser handoff and GitHub status refresh
- Terminal working-directory and Prompt editor height persistence
- Markdown preview rendering
- External file change watching and automatic refresh
- Preview position restore without top flash
- Project Editor per-file memory persistence, including recent tracking and Markdown preview restore
- Git state inspection and Git Diff behavior
- Multi-submodule Git Diff staged loading
- Terminal autofollow and viewport preservation
- CPU and performance regression checks
- Terminal focus restore and activation behavior
- Stability when switching between Project Editor, Git Diff, and Git History
- Change Log draft generation, manifest publishing, and in-app rendering

Reference document for Markdown + LaTeX syntax:

- `test/markdown-latex-supported-syntax.md`

## Build Preparation

### Development package build

- macOS / Linux

```bash
rm -rf out release && pnpm dist:dev
```

- Windows (PowerShell)

```powershell
if (Test-Path out) { Remove-Item -Recurse -Force out }
if (Test-Path release) { Remove-Item -Recurse -Force release }
pnpm dist:dev
```

## Automation Layout

```text
src/autotest/
├── autotest-runner.ts
├── types.ts
├── test-prompt-integrity.ts
├── test-prompt-list.ts
├── test-project-editor-restore-unit.ts
├── test-project-editor-restore.ts
├── test-project-editor-file-memory.ts
├── test-project-editor-open-position.ts
├── test-project-editor-multi-terminal-scope.ts
├── test-markdown-latex-preview.ts
├── test-settings-update.ts
├── test-change-log.ts
├── test-file-watch.ts
├── test-feedback.ts
├── test-feedback-ui.ts
├── test-feedback-persistence.ts
├── test-preview-position-restore.ts
├── test-project-editor-sqlite.ts
├── test-prompt-sender.ts
├── test-terminal-state-persistence.ts
├── test-per-agent-font.ts
├── test-git-history.ts
├── test-git-history-multi-terminal-scope.ts
├── test-git-cross-platform.ts
├── test-git-diff-submodules.ts
├── test-git-diff-recursive-submodules.ts
├── test-terminal-autofollow.ts
├── test-prompt-cleanup.ts
├── test-regression.ts
└── test-stress.ts
```

Additional suite: `src/autotest/test-terminal-focus-activation.ts`

## Debug APIs

Automation uses debug-only APIs exposed by renderer components when `ONWARD_AUTOTEST=1`.

| API | Component | Purpose |
|-----|-----------|---------|
| `window.__onwardGitDiffDebug` | `GitDiffViewer.tsx` | Diff state, scroll state, font size, and open/load timing |
| `window.__onwardPromptSenderDebug` | `PromptSender.tsx` | Terminal cards, selection state, action buttons |
| `window.__onwardGitHistoryDebug` | `GitHistoryViewer.tsx` | Commit list, file list, diff style, repo-scope state |
| `window.__onwardPromptNotebookDebug` | `PromptNotebook.tsx` | Prompt list, cleanup config, editor content |
| `window.__onwardSettingsDebug` | `Settings.tsx` | Update action state, mock updater status injection, and action triggering |
| `window.__onwardChangeLogDebug` | `ChangeLogModal.tsx` | Modal open state, rendered markdown content, and close interactions |
| `window.__onwardTerminalFocusDebug` | `App.tsx` | Focus restore state, pointer suppression, and synthetic focus simulation |
| `window.__onwardProjectEditorDebug` | `ProjectEditor.tsx` | File content, preview restore state, and external file refresh hooks |
| `window.__onwardTerminalDebug` | `TerminalGrid.tsx` | Terminal viewport state, tail text, fit / remount helpers |

## Environment Variables

| Variable | Purpose |
|---------|---------|
| `ONWARD_AUTOTEST=1` | Enable automation mode |
| `ONWARD_AUTOTEST_CWD=/path/to/repo` | Set the target Git repository |
| `ONWARD_AUTOTEST_EXIT=1` | Exit automatically after the suite finishes |
| `ONWARD_DEBUG=1` | Enable debug logging |
| `ONWARD_DEBUG_CAPTURE=1` | Capture screenshots during debugging |
| `ONWARD_USER_DATA_DIR=/tmp/onward-user-data` | Override the app user-data directory for isolated local updater tests |
| `ONWARD_UPDATE_BASE_URL=http://127.0.0.1:8765/updates` | Override the updater manifest base URL |
| `ONWARD_UPDATE_CHECK_INTERVAL_MS=1000` | Override the periodic updater polling interval (minimum 1000 ms) |

## Automation Launch Commands

### macOS

```bash
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_CWD="/path/to/git/repo" \
ONWARD_DEBUG=1 \
open "release/mac-arm64/Onward 2-<branch>.app"
```

### Linux

```bash
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_CWD="/path/to/git/repo" \
ONWARD_DEBUG=1 \
"/path/to/release/linux-unpacked/Onward 2-<branch>"
```

### Windows (PowerShell)

```powershell
$env:ONWARD_AUTOTEST="1"
$env:ONWARD_AUTOTEST_EXIT="1"
$env:ONWARD_AUTOTEST_CWD="C:\\path\\to\\git\\repo"
$env:ONWARD_DEBUG="1"
& "C:\\path\\to\\release\\win-unpacked\\Onward 2-<branch>.exe"
```

## Current Suite Inventory

### Auto-Update Suites

- `test/test-auto-update-local-e2e.mjs`
  - Builds three macOS production fixtures
  - Verifies periodic updater polling picks up a newer manifest automatically
  - Verifies exact-PID process termination does not install a downloaded update
  - Verifies only explicit restart triggers helper installation and relaunch
  - Verifies stale downloaded archives are cleaned up
- `test/test-auto-update-windows-e2e.mjs`
  - Builds three Windows production fixtures
  - Verifies malformed `pending-update.json` markers are removed without blocking startup
  - Verifies manifest superseding, SHA-256 validation, and cross-session download recovery
  - Verifies exact-PID process termination does not install a downloaded update
  - Verifies explicit restart triggers the Windows installer helper, relaunches the updated app, and clears pending installers
- `test/test-auto-update-github-e2e.mjs`
  - Pushes a temporary tag to GitHub
  - Waits for the `Daily Build` workflow to finish
  - Verifies the GitHub Release assets
  - Verifies the `gh-pages` updater manifests match the pushed tag
  - Verifies Windows `gh-pages` manifests point to the NSIS `.exe` installer, not the `.zip` inspection artifact
- `test/test-auto-update-public-github-e2e.mjs`
  - Builds a local old production fixture
  - Uses the default public GitHub updater source without any local manifest override
  - Verifies anonymous client download from public `gh-pages` + GitHub Release assets
  - Verifies exact-PID process termination still does not install
  - Verifies explicit restart installs the public GitHub update
- `test/test-auto-update-public-github-windows-installer.mjs`
  - Installs a local Windows production installer into the real NSIS install directory
  - Uses the default public GitHub updater source without a local manifest override
  - Verifies the Windows updater downloads a GitHub Release `.exe` installer
  - Verifies explicit restart runs the installer helper and relaunches the updated app

Run the local auto-update suite:

```bash
node test/test-auto-update-local-e2e.mjs
```

Run the Windows local auto-update suite on Windows:

```bash
bash test/run-auto-update-windows-e2e.sh
```

```powershell
node test/test-auto-update-windows-e2e.mjs
```

Run the GitHub release + manifest validation suite:

```bash
node test/test-auto-update-github-e2e.mjs --tag v2.1.0-daily.20260402.200 --create-tag
```

Optional: push the current HEAD to a temporary branch before pushing the tag.

```bash
node test/test-auto-update-github-e2e.mjs \
  --tag v2.1.0-daily.20260402.200 \
  --push-branch codex/auto-update-e2e-20260402 \
  --create-tag
```

Run the public GitHub client E2E suite after the repository is public and a newer Daily release exists:

```bash
node test/test-auto-update-public-github-e2e.mjs \
  --old-tag v2.1.0-daily.20260402.1602 \
  --target-version 2.1.0-daily.20260402.1701
```

Run the public GitHub Windows installer E2E suite after building the local old production installer:

```powershell
node test/test-auto-update-public-github-windows-installer.mjs `
  --local-tag v2.1.0-daily.20260414.1 `
  --target-version 2.1.0-daily.20260415.1
```

### Settings Update Suite

- `src/autotest/test-settings-update.ts`
  - Verifies unsupported environments keep the action disabled
  - Verifies the smart action enters `checking` and blocks repeated clicks
  - Verifies `up-to-date`, `error`, `downloading`, and `downloaded` detail rendering
  - Verifies the restart action locks while pending and surfaces restart errors
  - Verifies the language, font, and task selectors use the shared dropdown shell and inset arrow spacing

Run the Settings update suite:

```bash
bash test/run-settings-update-autotest.sh
```

```powershell
pwsh test/run-settings-update-autotest.ps1
```

### Change Log Suite

- `test/test-changelog-generation.mjs`
  - Verifies daily changelog drafts stay English-only
  - Verifies the nearest lower daily tag is selected as the previous tag
  - Verifies changelog-only commits are filtered out of the generated draft
  - Verifies the draft flow also emits precompiled HTML assets for the packaged app
- `test/test-changelog-manifest.mjs`
  - Verifies updater manifests embed the approved English changelog into `releaseNotes`
  - Verifies publishing fails fast when the changelog file is missing
- `src/autotest/test-change-log.ts`
  - Verifies the sidebar button opens the Change Log modal
  - Verifies the current tagged build loads the precompiled HTML payload, including `zh-CN` fallback to the English asset
  - Verifies close button, overlay click, and `Esc` all close the modal

Run the Change Log suite:

```bash
bash test/run-change-log-autotest.sh
```

```powershell
pwsh test/run-change-log-autotest.ps1
```

### Feedback Suite

- `src/autotest/test-feedback.ts`
  - Verifies GitHub draft URL generation, feedback body markers, and status mapping helpers
- `src/autotest/test-feedback-ui.ts`
  - Drives the real sidebar button and feedback modal UI
  - Validates hidden prerender, optional rating submission, system-browser draft handoff, history scrolling, local removal, and status refresh transitions
  - Verifies the feedback type selector uses the shared dropdown shell and inset arrow spacing
  - Uses an isolated `ONWARD_USER_DATA_DIR` plus autotest-only mock GitHub issue state so the run is deterministic and does not open a real browser
- `src/autotest/test-feedback-persistence.ts`
  - Seeds a feedback record, relaunches the app with the same `ONWARD_USER_DATA_DIR`, and verifies consent + history persistence across restart
  - Cleans up the persisted test record at the end of the verification pass

Run the Feedback suite:

```bash
bash test/run-feedback-autotest.sh
```

```powershell
pwsh test/run-feedback-autotest.ps1
```

Run the Feedback persistence suite:

```bash
bash test/run-feedback-persistence-autotest.sh
```

```powershell
pwsh test/run-feedback-persistence-autotest.ps1
```

### Prompt List Suite

- `src/autotest/test-prompt-list.ts`
  - Verifies Prompt history Task badges appear after sending
  - Verifies color and Task filters can be toggled through the Prompt Notebook debug API
  - Verifies copying a Prompt writes the Prompt content to the clipboard

Run the Prompt List suite:

```bash
bash test/run-prompt-list-autotest.sh
```

```powershell
pwsh test/run-prompt-list-autotest.ps1
```

### Phase 1: PromptSender UI

Source set: PromptSender UI validation suite

- `PS-01`: terminal cards render correctly
- `PS-02`: two-column grid layout is preserved
- `PS-03`: selecting a terminal updates selection state
- `PS-04`: deselecting a terminal removes it from the selected set
- `PS-05`: selection summary shows the current selected Task count
- `PS-06`: the four action buttons are present
- `PS-07`: primary actions are disabled when no terminal is selected
- `PS-08`: repeated rapid selection toggling does not crash
- `PS-09`: rendered card count matches layout metadata
- `PS-10`: single-line Send and execute still runs end to end

### Phase 1.1: Prompt Integrity

Source set: multiline prompt transport integrity suite

- `PI-01`: multi-line `Send` preserves mixed prompt content when bracketed paste is enabled
- `PI-02`: multi-line `Send and execute` preserves content and appends one execute Enter when bracketed paste is enabled
- `PI-03`: large 50-line prompt survives `Send` without truncation
- `PI-04`: multi-line `Send` is blocked cleanly when bracketed paste is unavailable
- `PI-05`: multi-line `Send and execute` is blocked cleanly when bracketed paste is unavailable

Run the prompt integrity suite:

```bash
bash test/run-prompt-integrity-autotest.sh
```

Run the PromptSender suite:

```bash
bash test/run-prompt-sender-autotest.sh
```

### Phase 1.1: Terminal State Persistence

Source set: terminal cwd + Prompt height persistence validation suite

- `TSP-01` to `TSP-09`: prompt panel availability, multi-terminal cwd persistence, editor height persistence, and empty-draft height retention

### Project Editor File Memory Suite

- `src/autotest/test-project-editor-file-memory.ts`
  - Verifies reopening the current file through the user path adds it to `recentFiles`
  - Verifies closing the Markdown preview does not discard the last preview anchor before switching files
  - Verifies opened files keep per-file memory after they fall out of the Recent list
  - Verifies cold-start restore uses persisted `fileStates` for preview position and Markdown view mode
  - Verifies File Browser scroll position persists and restores after reopening the Project Editor
  - Verifies Outline scroll position restores on file switch and after reopening the Project Editor
  - Verifies main-process `app-state` save/load round-trips `fileStates` without dropping fields

Run the Project Editor file-memory suite:

```bash
bash test/run-project-editor-file-memory-autotest.sh
```

```powershell
pwsh test/run-project-editor-file-memory-autotest.ps1
```

### Phase 2: Per-Agent Font Size

Legacy source branch: `git_diff_ui_miss_match`

- `PF-01`: default font fallback is valid
- `PF-02`: font size remains inside the allowed range
- `PF-03`: font size is an integer

### Phase 3: Git History

Source set: Git History validation suite

- `GH-01`: open Git History through the event path
- `GH-02`: commit list loads
- `GH-03`: selecting a commit loads changed files
- `GH-04`: selecting a file loads a diff
- `GH-05`: diff style switching works
- `GH-06`: whitespace hiding works
- `GH-07`: ESC closes Git History
- `GH-08`: Git History can be entered from Git Diff
- `GH-09`: repeated open / close cycles do not leak state
- `GH-10`: rapid commit switching leaves the final selection consistent

### Phase 3.5: Git History Multi-Terminal Scope

Source set: Git History terminal-switch isolation regression suite

- `GHMS-01` to `GHMS-11`: dual-terminal layout setup, stale repo-state injection, terminal switch reload, and stale state cleanup

### Phase 3.75: Git Diff Multi-Submodule

Source set: staged-loading validation for repositories with multiple submodules

- `DSM-01`: root-only diff returns repo outline with submodules marked as loading
- `DSM-02`: Git Diff shell becomes visible quickly
- `DSM-03`: repo outline is visible before full submodule aggregation finishes
- `DSM-04`: full submodule load completes and clears loading markers
- `DSM-05`: Git Diff still closes cleanly

### Phase 3.8: Git Diff Recursive Submodule

Source set: staged-loading validation for nested submodule trees created from a temporary fixture

- `RSM-01`: root-only diff discovers nested submodules and marks them as loading
- `RSM-02`: Git Diff shell becomes visible quickly
- `RSM-03`: nested repo outline is visible before full aggregation finishes
- `RSM-04`: full load completes and nested repo changes are attached
- `RSM-05`: Git Diff still closes cleanly

### Image Rendering Suite

Source set: image rendering validation suite

- `ID-01` to `ID-12`: Git Diff raster and SVG image preview behavior
- `ID-13` to `ID-18`: Git History image commit preview behavior
- `ID-19`: Project Editor direct image file preview behavior
- `ID-20` to `ID-21`: suite cleanup and closeout

### Phase 4: Prompt Cleanup

Source set: Prompt cleanup validation suite

- `PC-01`: `lastUsedAt` updates after prompt execution
- `PC-02`: cleanup configuration is readable
- `PC-03`: `pinned` state is readable
- `PC-04`: color markers are readable
- `PC-05`: editor content read / write works
- `PC-06`: cleanup configuration keeps the expected shape

### Phase 0.4: ProjectEditor Restore Unit Tests

Source set: ProjectEditor restore validation suite

- `PEU-01` to `PEU-10`: restore selection logic, fallback rules, cursor normalization, cursor clamping, and missing-file notice behavior

### Phase 0.5: ProjectEditor Restore Interaction

Source set: ProjectEditor restore validation suite

- `PE-01` to `PE-31`: file restore, cursor restore, persistence, delete handling, and post-insert reopen behavior

### Phase 0.6: ProjectEditor Open Position

Source set: ProjectEditor restore validation suite

- `POP-01` to `POP-17`: file open position persistence, switching behavior, and reopen restoration

### Phase 0.58: Subpage Navigation

Source set: Diff / Editor / History navigation validation suite

- `SN-01` to `SN-14`: unified top switcher visibility, active-state disabling, target-page state restore, selected-file handoff into Project Editor, and missing-file empty-state fallback

### Phase 0.7: ProjectEditor Multi-Terminal Scope

Source set: ProjectEditor multi-terminal isolation validation suite

- `PEMS-01` to `PEMS-20`: dual-terminal layout switching, same-directory isolation, and composite state key persistence

### Phase 0.8: Markdown + LaTeX Preview

Source set: Markdown LaTeX preview validation suite

- `MLP-00` to `MLP-18`: fixture existence, preview rendering, KaTeX output, CJK strong delimiter handling, and temporary file preview behavior

### Phase 0.81: Image Diff

Source set: Git Diff image validation suite

- `ID-01` to `ID-21`: PNG keep / deny state transitions are validated end-to-end, while SVG preview loading and image-only action visibility are verified in the same Git Diff flow

### Phase 0.88: File Watch

Source set: ProjectEditor external file refresh validation suite

- `FW-00` to `FW-05`: setup, automatic refresh, self-save suppression, debounced rapid writes, cursor preservation, and watcher switching

### Phase 0.89: Preview Position Restore

Source set: Markdown preview restore validation suite

- `PPR-00` to `PPR-06`: file discovery, transition visibility, top-flash prevention, and scroll restoration accuracy

### Phase 0.9: ProjectEditor SQLite

Source set: ProjectEditor SQLite validation suite

- `PSQL-01` to `PSQL-28`: table loading, row operations, value normalization, and context-menu visibility

### Phase 5.4: Git Cross-Platform

Source set: Cross-platform Git operations validation suite

Designed to catch platform-specific issues when porting to new platforms. Run this suite on every new platform before release.

- `XP-01`: terminal CWD is available
- `XP-02`: resolveRepoRoot returns forward-slash path on all platforms
- `XP-03`: CWD is under repo root (path containment check)
- `XP-04`: Git History opens and loads commits (no infinite loop)
- `XP-05`: Git History loading completes within timeout (infinite loop detector)
- `XP-06`: commit selection loads files correctly
- `XP-07`: ESC closes Git History
- `XP-08`: Git Diff opens and loads file list
- `XP-09`: Git Diff CWD uses normalized path (no backslashes)
- `XP-10`: Git Diff closes correctly
- `XP-11`: getHistory IPC returns valid result with correct path format
- `XP-12`: getDiff IPC returns valid result
- `XP-13`: getHistory completes within platform-specific latency threshold
- `XP-14`: getDiff completes within platform-specific latency threshold

### Phase 0.1: Terminal Autofollow

Source set: terminal viewport preservation validation suite

- `TA-00` to `TA-10`: bottom-follow persistence, manual-scroll preservation, fit handling, remount handling, and repeated fit/remount stress coverage
- `XP-15`: rapid open/close cycle (5 iterations) — no stale state
- `XP-16`: Git Diff ↔ Git History mutual exclusion

Launch:

```bash
# macOS / Linux
test/run-git-cross-platform-autotest.sh

# Windows (PowerShell)
test/run-git-cross-platform-autotest.ps1
```

### Phase 5.7: Terminal Focus Activation

Source set: terminal focus activation regression suite

- `TFA-01`: debug API is available in autotest mode
- `TFA-02`: terminal restore state can be prepared deterministically
- `TFA-03`: shortcut-triggered restore focuses the terminal
- `TFA-04`: explicit blur clears terminal focus state
- `TFA-05`: recent terminal pointer activity suppresses window-focus restore
- `TFA-06`: shortcut activation still restores terminal focus after suppression
- `TFA-07`: non-terminal mouse activation also suppresses implicit terminal restore
- `TFA-08`: stale pointer state allows normal window-focus restore again

Launch:

```bash
# macOS / Linux
test/run-terminal-focus-activation-autotest.sh

# Windows (PowerShell)
test/run-terminal-focus-activation-autotest.ps1
```

### Phase 5: Regression

- `RG-*`: broader regression coverage for high-risk flows already fixed in the repository

### Phase 6: Stress

- `ST-*`: repeated actions and pressure scenarios intended to surface lifecycle or scheduling leaks

## Validation Principles

When extending automation for performance or stability work:

- Cover common paths
- Cover high-frequency interaction paths
- Cover pressure scenarios strong enough to trigger peak behavior
- Sample first, then add logs to confirm causality
- Watch counters that can be observed at one-second resolution
- Prefer eliminating overlap, re-entry, and stale background work

## Maintainer Notes

- New reusable test scripts should stay under `test/`
- Repository documentation should be updated when new suites are added
- Development builds are the default validation target unless a production artifact is explicitly required
