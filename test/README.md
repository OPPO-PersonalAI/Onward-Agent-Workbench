<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test and Validation Guide

This directory contains reusable automation notes and validation procedures for the desktop application. When similar regressions appear in the future, contributors should reuse the same suites and command patterns instead of inventing one-off verification steps.

## Coverage Areas

- PromptSender UI behavior
- Prompt send / execute flow and failure handling
- Per-agent font settings for Git Diff and Project Editor
- Git History browsing and diff rendering
- Prompt cleanup and retention behavior
- Markdown preview rendering
- Git state inspection and Git Diff behavior
- Terminal autofollow and viewport preservation
- CPU and performance regression checks
- Terminal focus restore and activation behavior
- Stability when switching between Project Editor, Git Diff, and Git History

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
├── test-project-editor-restore-unit.ts
├── test-project-editor-restore.ts
├── test-project-editor-open-position.ts
├── test-project-editor-multi-terminal-scope.ts
├── test-markdown-latex-preview.ts
├── test-project-editor-sqlite.ts
├── test-prompt-sender.ts
├── test-per-agent-font.ts
├── test-git-history.ts
├── test-git-history-multi-terminal-scope.ts
├── test-git-cross-platform.ts
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
| `window.__onwardGitDiffDebug` | `GitDiffViewer.tsx` | Diff state, scroll state, font size |
| `window.__onwardPromptSenderDebug` | `PromptSender.tsx` | Terminal cards, selection state, action buttons |
| `window.__onwardGitHistoryDebug` | `GitHistoryViewer.tsx` | Commit list, file list, diff style, repo-scope state |
| `window.__onwardPromptNotebookDebug` | `PromptNotebook.tsx` | Prompt list, cleanup config, editor content |
| `window.__onwardTerminalFocusDebug` | `App.tsx` | Focus restore state, pointer suppression, and synthetic focus simulation |
| `window.__onwardTerminalDebug` | `TerminalGrid.tsx` | Terminal viewport state, tail text, fit / remount helpers |

## Environment Variables

| Variable | Purpose |
|---------|---------|
| `ONWARD_AUTOTEST=1` | Enable automation mode |
| `ONWARD_AUTOTEST_CWD=/path/to/repo` | Set the target Git repository |
| `ONWARD_AUTOTEST_EXIT=1` | Exit automatically after the suite finishes |
| `ONWARD_DEBUG=1` | Enable debug logging |
| `ONWARD_DEBUG_CAPTURE=1` | Capture screenshots during debugging |

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

### Phase 1: PromptSender UI

Source set: PromptSender UI validation suite

- `PS-01`: terminal cards render correctly
- `PS-02`: two-column grid layout is preserved
- `PS-03`: selecting a terminal updates selection state
- `PS-04`: deselecting a terminal removes it from the selected set
- `PS-05`: the four action buttons are present
- `PS-06`: primary actions are disabled when no terminal is selected
- `PS-07`: repeated rapid selection toggling does not crash
- `PS-08`: rendered card count matches layout metadata

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

### Phase 0.7: ProjectEditor Multi-Terminal Scope

Source set: ProjectEditor multi-terminal isolation validation suite

- `PEMS-01` to `PEMS-20`: dual-terminal layout switching, same-directory isolation, and composite state key persistence

### Phase 0.8: Markdown + LaTeX Preview

Source set: Markdown LaTeX preview validation suite

- `MLP-00` to `MLP-15`: fixture existence, preview rendering, KaTeX output, and temporary file preview behavior

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
