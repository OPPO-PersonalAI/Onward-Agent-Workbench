# Porting Diff Analysis: Onward-Github vs Project_Onward2

> Generated: 2026-03-31
>
> Ported project: `/Users/yingyun/Projects/Onward-Github-worktree_bug3`
> Original project: `/Users/yingyun/Projects/Project_Onward2`

---

## Overview

| Scope | Diff Lines | Files Changed | Ported Only | Original Only |
|-------|-----------|---------------|-------------|---------------|
| `src/` | **9,604** | 85 | Terminal, TerminalTabs, i18n/, perf-monitor.ts | ClaudeCodeLaunchModal |
| `electron/` | **3,098** | 22 | localization.ts | claude-code-config-storage.ts, claude-code-runtime.ts |
| **Total** | **~12,700** | **107** | 8 new files | 5 removed files |

---

## 1. New Files (Ported Only)

### `src/components/Terminal/Terminal.tsx` + `.css` (310 + 115 lines)
- **Category**: Extracted component
- **Content**: xterm.js terminal component extracted from TerminalGrid, with WebGL acceleration, context menu, copy/paste
- **Risk**: Medium — core UI component, WebGL failure has canvas fallback

### `src/components/TerminalTabs/TerminalTabs.tsx` + `.css` (105 + 142 lines)
- **Category**: Extracted component
- **Content**: Terminal tab management, supports create/select/close tabs
- **Risk**: Low-medium — state fully managed by React

### `src/i18n/core.ts` (1538 lines) + `src/i18n/useI18n.ts` (32 lines)
- **Category**: Infrastructure
- **Content**: Complete i18n system with EN + ZH-CN translation dictionary, type-safe translation keys, locale management
- **Risk**: Low — infrastructure, but translation keys must stay in sync with all UI strings

### `src/utils/perf-monitor.ts` (253 lines)
- **Category**: Debug infrastructure
- **Content**: Performance monitoring tool tracking FPS, xterm writes, IPC throughput, WebGL context count, React renders
- **Risk**: Very low — only activates when `ONWARD_DEBUG=1`

### `electron/main/localization.ts` (20 lines)
- **Category**: Infrastructure
- **Content**: Main process i18n bridge, provides `tMain()` function
- **Risk**: Low

---

## 2. Removed Files (Original Only)

### `src/components/ClaudeCodeLaunchModal/` (404 + 370 + 1 lines)
- **Category**: Removed feature
- **Content**: Claude Code launch config modal (Provider selection, API URL/Key/Model config, history)
- **Risk**: Intentional removal — open-source version excludes Claude Code integration

### `electron/main/claude-code-config-storage.ts` (212 lines)
- **Category**: Removed feature
- **Content**: Claude Code config persistence (JSON file storage)
- **Risk**: Intentional removal

### `electron/main/claude-code-runtime.ts` (124 lines)
- **Category**: Removed feature
- **Content**: Claude Code installation detection and version info
- **Risk**: Intentional removal

---

## 3. File-by-File Diff Analysis

### Legend
- **SAFE** — Pure SPDX/i18n/comment translation, no logic changes
- **MODERATE** — Has logic changes but impact is contained
- **HIGH** — Substantive logic changes that may introduce bugs

---

### `src/` Root Files

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `App.tsx` | 412 | **HIGH** | SPDX + i18n + **Prompt import flow changed from two-step confirmation to single-step direct execution (confirmation dialog removed)** + memo wrapping + `resolveProjectEditorDebugCwd()` added |
| `App.css` | 5 | SAFE | SPDX + CSS comment translation |
| `main.tsx` | 5 | SAFE | SPDX |
| `monaco-env.ts` | 5 | SAFE | SPDX |

---

### `src/components/BrowserPanel/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `BrowserPanel.tsx` | 295 | MODERATE | SPDX + i18n + **Added `hasVisibleView` state and `useSubpageEscape` hook** + bounds sync split into two useEffects + race condition fix |
| `BrowserPanel.css` | 72 | SAFE | SPDX + comment translation + CSS tweaks (inset shorthand, color adjustments, opacity tweaks) |

---

### `src/components/CommandSelectModal/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `CommandSelectModal.tsx` | 41 | SAFE | SPDX + i18n (12 strings converted) |
| `CommandSelectModal.css` | 7 | SAFE | SPDX + comment translation |
| `index.ts` | 5 | SAFE | SPDX |

---

### `src/components/GitDiffViewer/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `GitDiffViewer.tsx` | 1196 | MODERATE | SPDX + i18n (70+ strings) + Added `RestoredAnchor`/`LineSelectionInfo` types + **`loadDiffFromRoot` removed async token concurrency protection** + Added `detachDiffEditor()` cleanup function + file key path fallback priority change |
| `GitDiffViewer.css` | 113 | SAFE | SPDX + comment translation + CSS tweaks |
| `index.ts` | ~5 | SAFE | SPDX |

---

### `src/components/GitHistoryViewer/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `GitHistoryViewer.tsx` | 405 | MODERATE | SPDX + i18n + comment translation + **Partial logic refactoring** |
| `GitHistoryViewer.css` | 82 | SAFE | SPDX + comment translation |
| `index.ts` | ~5 | SAFE | SPDX |

---

### `src/components/ProjectEditor/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `ProjectEditor.tsx` | 1302 | **HIGH** | SPDX + i18n (100+) + **Search architecture changed from sidebar toggle to overlay modal** + **File tree/outline scroll position memory removed** + **Ref replaced State for preview button logic** + `BasicProjectEditorDebugApi` type removed + `countSymbols()` replaced `.length` + `openFile()` signature changed |
| `ProjectEditor.css` | ~50 | SAFE | SPDX + comment translation |
| `projectEditorRestoreUtils.ts` | ~30 | SAFE | SPDX + comment translation |
| `SqliteViewer.tsx` | 145 | MODERATE | SPDX + i18n + comment translation |
| `index.ts` | ~5 | SAFE | SPDX |

**ProjectEditor Sub-directories:**

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `GlobalSearch/SearchPanel.tsx` | 352 | MODERATE | SPDX + i18n + **Search architecture matching ProjectEditor changes** |
| `GlobalSearch/SearchPanel.css` | 62 | SAFE | SPDX + comment translation |
| `GlobalSearch/useGlobalSearch.ts` | 132 | MODERATE | SPDX + i18n + search logic adjustments |
| `Outline/OutlinePanel.tsx` | 161 | MODERATE | SPDX + i18n + outline logic adjustments |
| `Outline/OutlinePanel.css` | 73 | SAFE | SPDX + comment translation |
| `Outline/outlineParser.ts` | ~20 | SAFE | SPDX + Added `countSymbols()` function |
| `Outline/types.ts` | ~10 | SAFE | SPDX + type tweaks |
| `Outline/useOutlineSymbols.ts` | ~20 | SAFE | SPDX + comment translation |
| `PreviewSearch/PreviewSearchBar.tsx` | 64 | MODERATE | SPDX + i18n |
| `PreviewSearch/PreviewSearchBar.css` | ~10 | SAFE | SPDX |
| `PreviewSearch/usePreviewSearch.ts` | 126 | MODERATE | SPDX + i18n + search logic adjustments |

---

### `src/components/PromptNotebook/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `PromptNotebook.tsx` | 436 | **HIGH** | SPDX + i18n + **Import flow changed from two-step confirmation to single-step execution** (same as App.tsx) + `ImportConfirmState` removed + memo wrapping + Ref cache optimization |
| `PromptNotebook.css` | ~5 | SAFE | SPDX + comment translation |
| `PromptEditor.tsx` | ~7 | SAFE | SPDX + i18n (4 strings) |
| `PromptList.tsx` | 116 | SAFE | SPDX + i18n (16 strings) + `onImportPrompts` -> `onImportAllPrompts` rename |
| `PromptSearch.tsx` | ~21 | SAFE | SPDX + i18n + memo wrapping |
| `PromptSender.tsx` | 68 | MODERATE | SPDX + i18n + **action parameter type changed from Chinese literals to i18n keys** |
| `ScheduleConfigModal.tsx` | 91 | SAFE | SPDX + i18n (12 validation messages) |
| `ScheduleConfigModal.css` | ~6 | SAFE | SPDX + comment translation |
| `ScheduleNotification.tsx` | ~7 | SAFE | SPDX + i18n |

---

### `src/components/Settings/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `Settings.tsx` | 234 | MODERATE | SPDX + i18n + **Added language selection feature** + shortcut structure changed from `label` to `labelKey`/`labelParams` + Removed "Claude Code Standalone" shortcut |
| `Settings.css` | 93 | SAFE | SPDX + comment translation + Added version/copyright styling + flex layout improvements |
| `ColorPicker.tsx` | ~10 | SAFE | SPDX + i18n (1 string) |
| `ColorPickerAdvanced.tsx` | ~10 | SAFE | SPDX + i18n (1 string) |
| `FontSelector.tsx` | 66 | SAFE | SPDX + i18n + font data structure changed to `labelKey`/`fallbackLabel` |
| `NumberInput.tsx` | ~10 | SAFE | SPDX + i18n (2 aria-labels) |
| `NumberInput.css` | ~5 | SAFE | SPDX + comment translation |
| `ShortcutInput.tsx` | 110 | MODERATE | SPDX + i18n + `getShortcutLabel()` signature changed (added `t` parameter) + Removed Claude Code shortcut |
| `ThemeSelector.tsx` | ~30 | SAFE | SPDX + i18n + theme defaults extracted to constants |
| `ThemeSelector.css` | ~5 | SAFE | SPDX + comment translation |
| `index.ts` | ~5 | SAFE | SPDX |

---

### `src/components/Sidebar/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `Sidebar.tsx` | ~30 | SAFE | SPDX + i18n (5 title attributes) |
| `Sidebar.css` | ~5 | SAFE | SPDX + comment translation |

---

### `src/components/TabBar/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `TabBar.tsx` | 43 | SAFE | SPDX + i18n (6 strings) |
| `TabBar.css` | ~5 | SAFE | SPDX + comment translation |
| `TabItem.tsx` | ~10 | SAFE | SPDX + i18n (2 strings) |
| `index.ts` | ~5 | SAFE | SPDX |

---

### `src/components/TerminalDropdown/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `TerminalDropdown.tsx` | 44 | MODERATE | SPDX + i18n + **Removed `onOpenClaudeCode` prop and menu item** |
| `TerminalDropdown.css` | ~12 | SAFE | SPDX + Removed `.is-active` style |
| `index.ts` | ~5 | SAFE | SPDX |

---

### `src/components/TerminalGrid/`

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `TerminalGrid.tsx` | 593 | **HIGH** | SPDX + i18n + **Claude Code Modal completely removed** + **Added terminal context menu** + **Terminal visibility management** (`setVisibility`) + memo wrapping + perfMonitor + browser state cleanup + Debug API removed |
| `TerminalGrid.css` | 146 | SAFE | SPDX + comment translation + style adjustments |

---

### `src/` Utilities / Types / Other

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `contexts/AppStateContext.tsx` | 191 | SAFE | SPDX + comment translation + extracted `createDefaultGlobalTerminalStyle()` and `applyTerminalStylePatch()` helpers |
| `contexts/PromptActionsContext.tsx` | ~10 | SAFE | SPDX + comment translation |
| `contexts/SettingsContext.tsx` | 192 | MODERATE | SPDX + i18n + **Version 2->4** + **Added `updateLanguage()` method and `language` field** + Removed `terminalClaudeCode` shortcut |
| `hooks/useAppState.ts` | ~5 | SAFE | SPDX |
| `hooks/useScheduleEngine.ts` | 78 | MODERATE | SPDX + i18n + **Execution strategy added two tiers: session manager `pasteAndExecute()` first, fallback to `writeSplit()`** |
| `hooks/useSubpageEscape.ts` | ~5 | SAFE | SPDX + comment translation |
| `constants/gitDiff.ts` | ~5 | SAFE | SPDX |
| `constants/terminal.ts` | ~5 | SAFE | SPDX |
| `constants/themes.ts` | 41 | SAFE | SPDX + theme names changed from Chinese to English |
| `types/electron.d.ts` | 147 | MODERATE | SPDX + **Claude Code related types removed (9 types/interfaces)** + `writeSplit` return type refined + Added `openTextFile` |
| `types/prompt.d.ts` | ~5 | SAFE | SPDX |
| `types/settings.d.ts` | 42 | MODERATE | SPDX + **Added `language: AppLocale` field** + Removed `terminalClaudeCode` shortcut |
| `types/tab.d.ts` | 149 | MODERATE | SPDX + **ProjectEditorState added many UI layout persistence fields** |
| `types/theme.d.ts` | ~5 | SAFE | SPDX |
| `utils/externalLink.ts` | ~5 | SAFE | SPDX |
| `utils/keyboard.ts` | ~5 | SAFE | SPDX |
| `utils/prompt-io.ts` | 250 | MODERATE | SPDX + comment translation + **import validation logic enhanced** + refactored into multiple helper functions (`normalizeColor`, `normalizeTimestamp`, `buildImportPlan`) |
| `utils/schedule.ts` | 46 | SAFE | SPDX + i18n (`formatShortTime`/`formatScheduleDescription` added `locale` parameter) |
| `utils/theme-applier.ts` | ~5 | SAFE | SPDX |
| `utils/theme-generator.ts` | ~5 | SAFE | SPDX |
| `themes/terminal-themes.ts` | ~5 | SAFE | SPDX |
| `workers/markdownPreviewWorker.ts` | 60 | SAFE | SPDX + comment translation |
| `terminal/terminal-session-manager.ts` | 661 | **HIGH** | SPDX + **IPC listener changed from per-terminal to single global dispatch** + **Added visible write throttling system** (`VISIBLE_WRITE_THROTTLE_MS=50ms`) + **Added `pendingData` buffering** + `paste()`/`pasteAndExecute()` new methods + WebGL lifecycle management + debug logging removed |

---

### `electron/` Files

| File | Diff Lines | Risk | Change Summary |
|------|-----------|------|----------------|
| `main/index.ts` | 70 | SAFE | SPDX + i18n (`tMain`) + EPIPE error suppression + `registerIpcHandlers` added `onSettingsChanged` callback |
| `main/ipc-handlers.ts` | 555 | **HIGH** | SPDX + **Added `TerminalDataBuffer` class (100ms flush interval, 64KB forced flush)** + Claude Code handlers removed + Added `app:read-notice` / `dialog:openTextFile` handlers + Git activity notification changed to 500ms throttle |
| `main/api-server.ts` | 61 | SAFE | SPDX + comment translation + body size limit check (security enhancement) |
| `main/app-info.ts` | 5 | SAFE | SPDX |
| `main/app-state-storage.ts` | 123 | MODERATE | SPDX + comment translation + **Added PromptSchedule type validation** + execution log truncation to 50 entries |
| `main/browser-view-manager.ts` | 295 | **HIGH** | SPDX + comment translation + **Session partition changed from `onward-browser-panel` to `persist:browser` (affects cookie persistence)** + Removed `attached` field + show/hide logic simplified + permission handler enhanced |
| `main/command-preset-storage.ts` | 29 | SAFE | SPDX + comment translation |
| `main/external-link-guard.ts` | 16 | SAFE | SPDX + i18n (`tMain`) |
| `main/file-watch-manager.ts` | 195 | SAFE | SPDX + comment translation + enhanced debug logging + `mainWindow.isDestroyed()` defensive checks |
| `main/git-runtime-manager.ts` | 12 | MODERATE | SPDX + **Concurrency limits adjusted: `MAX_INFLIGHT` 4->6, `MAX_PER_REPO` 1->3** |
| `main/git-utils.ts` | 485 | MODERATE | SPDX + i18n + comment translation + type improvements + **Windows CWD detection code removed** (moved to pty-manager) + Added `GitSubmoduleInfo`/`GitRepoContext` types |
| `main/git-watch-manager.ts` | 33 | MODERATE | **Polling intervals adjusted: `ACTIVE_POLL_MS` 800->400ms, `ACTIVITY_TRIGGER_MS` 800->120ms** + diagnostic counters removed |
| `main/prompt-storage.ts` | 29 | SAFE | SPDX + comment translation |
| `main/pty-manager.ts` | 244 | **HIGH** | SPDX + comment translation + **Added `writeChunked()` method (1KB chunks, 5ms delays)** + **Windows CWD detection (OSC 9;9 shell integration)** + `cwdMap`/`detectCwd()`/`getCwd()` + `disposed` safety flag |
| `main/reserved-shortcuts.ts` | 5 | SAFE | SPDX |
| `main/ripgrep-search.ts` | 207 | MODERATE | SPDX + comment translation + function/variable renames + **`parseRipgrepLine` signature changed** + error handling flow split |
| `main/settings-storage.ts` | 166 | MODERATE | SPDX + i18n + **Version 2->4** + **Added `language` field and validation** + Removed `terminalClaudeCode` field |
| `main/shortcut-manager.ts` | 81 | SAFE | SPDX + comment translation |
| `main/terminal-config-storage.ts` | 45 | SAFE | SPDX + comment translation |
| `main/tray-manager.ts` | 50 | MODERATE | SPDX + i18n (`tMain`) — menu label internationalization |
| `preload/index.ts` | 315 | MODERATE | SPDX + **Claude Code related types/APIs all removed (9 types)** + Added `openTextFile` API + `writeSplit` type refined |

---

## 4. Risk Summary

### HIGH Risk Files (8) — Substantive Logic Changes

| File | Core Change | Potential Impact |
|------|------------|-----------------|
| `terminal-session-manager.ts` | 3-layer buffering: global listener + pendingData buffer + 50ms write throttle | **Terminal output delayed 50-150ms** |
| `ipc-handlers.ts` | TerminalDataBuffer 100ms flush + Git activity 500ms throttle | **Terminal output delay + Git status updates slower** |
| `pty-manager.ts` | writeChunked 1KB/5ms + Windows CWD detection rewrite | **Large text paste slower, Windows CWD may be inaccurate** |
| `TerminalGrid.tsx` | Claude Code removal + visibility management + Debug API removal | **Feature removal + terminal rendering logic changed** |
| `ProjectEditor.tsx` | Search architecture change + scroll memory removed + Ref replaced State | **Search UX changed + scroll position lost + potential stale closure bugs** |
| `App.tsx` | Prompt import changed from two-step confirmation to single-step execution | **User loses import confirmation opportunity** |
| `PromptNotebook.tsx` | Same import flow change + ImportConfirmState removed | **Same as above** |
| `browser-view-manager.ts` | Session partition change + show/hide logic simplified | **Cookie persistence behavior changed** |

### MODERATE Risk Files (19) — Logic Changes with Contained Impact

| File | Core Change |
|------|------------|
| `GitDiffViewer.tsx` | loadDiffFromRoot removed async token protection + file key path priority change |
| `BrowserPanel.tsx` | Added hasVisibleView state + useSubpageEscape hook |
| `PromptSender.tsx` | action parameter type changed from Chinese literals to i18n keys |
| `Settings.tsx` | Added language selection + shortcut structure refactored |
| `ShortcutInput.tsx` | getShortcutLabel signature changed |
| `TerminalDropdown.tsx` | Removed onOpenClaudeCode |
| `SettingsContext.tsx` | Version 2->4 + language field |
| `useScheduleEngine.ts` | Execution strategy added pasteAndExecute tier |
| `electron.d.ts` | Claude Code types removed |
| `settings.d.ts` | language field added |
| `tab.d.ts` | ProjectEditorState layout persistence fields expanded |
| `prompt-io.ts` | import validation enhanced + refactored |
| `app-state-storage.ts` | PromptSchedule validation |
| `git-runtime-manager.ts` | Concurrency limits 4->6 / 1->3 |
| `git-utils.ts` | Windows CWD removed + type improvements |
| `git-watch-manager.ts` | Polling 800->400ms / trigger 800->120ms |
| `ripgrep-search.ts` | Function signature changes + error handling refactored |
| `settings-storage.ts` | Version 2->4 + language field |
| `preload/index.ts` | Claude Code API removed |

### SAFE Files (~55) — Pure SPDX / i18n / Comments

Most files (~55) changes are limited to:
- SPDX Apache-2.0 license header addition
- Hardcoded Chinese strings -> `t()` i18n calls
- Chinese code comments -> English
- CSS comment translation
- Minor style tweaks

---

## 5. Change Category Breakdown

| Category | Percentage | Description |
|----------|-----------|-------------|
| SPDX license headers | ~3% | 4 lines per file |
| i18n internationalization | ~25% | All user-visible strings -> t() |
| Comment translation CN->EN | ~10% | Full code comment translation |
| Claude Code removal | ~10% | 3 files deleted + reference cleanup |
| **Terminal performance system** | **~15%** | **3-layer buffering + throttling + WebGL management** |
| Search/editor architecture | ~5% | Sidebar->modal + scroll memory removed |
| Prompt import flow | ~3% | Two-step confirmation->single-step execution |
| Component extraction/memo | ~5% | Terminal/TerminalTabs extraction |
| Dependency version upgrades | ~2% | Electron 33->35, Vite 5->6 |
| CWD detection/Git tuning | ~3% | PTY CWD + polling interval adjustments |
| Browser management | ~2% | Partition change |
| Type/utility refactoring | ~5% | prompt-io, ripgrep-search, etc. |
| Other | ~12% | perf-monitor, debug tools, etc. |

---

## 6. Change Reasonableness Assessment

### Reasonable — Should Keep

1. **SPDX headers** — Open-source license compliance, must keep
2. **i18n system** — Multi-language support is the right direction, should keep
3. **English comments** — Standard practice for open-source projects, should keep
4. **Claude Code removal** — Intentional feature trimming, reasonable
5. **memo wrapping** — Performance optimization, harmless
6. **perf-monitor** — Debug infrastructure, harmless
7. **Terminal/TerminalTabs extraction** — Reasonable component separation

### Potentially Excessive — Evaluate Whether to Revert

| # | Change | Risk | Details |
|---|--------|------|---------|
| 1 | Terminal 3-layer buffering system | HIGH | Original direct send path is simpler and more reliable; buffering introduces 50-150ms latency |
| 2 | ProjectEditor search architecture change | HIGH | Sidebar mode was the original design; modal mode may or may not be better |
| 3 | Scroll position memory removed | HIGH | Clear UX regression |
| 4 | Prompt import confirmation removed | HIGH | Removing user confirmation step may cause accidental operations |
| 5 | Ref replaced State | MODERATE | Increases stale closure bug risk |
| 6 | Browser session partition change | HIGH | Changes cookie persistence behavior |
| 7 | Git polling interval acceleration (800->400ms) | MODERATE | May increase CPU usage |
| 8 | Git concurrency limits relaxed (1->3 per repo) | MODERATE | May increase resource contention |
| 9 | loadDiffFromRoot concurrency protection removed | MODERATE | May cause race conditions |

### Dependency Version Upgrade Impact

| Package | Original | Ported | Impact |
|---------|----------|--------|--------|
| Electron | 33.4.11 | 35.7.5 | Major version jump, possible API changes |
| Vite | 5.0.0 | 6.4.1 | Major version jump, build behavior may change |
| electron-vite | 2.3.0 | 5.0.0 | Major version jump |
| electron-builder | 26.4.0 | 26.8.0 | Minor upgrade, low risk |
| @electron/rebuild | 3.6.0 | 4.0.3 | Major version jump |
| @vscode/ripgrep | 1.17.1 | **1.15.11 (downgraded!)** | Reverse downgrade, may lack fixes |

---

## 7. Terminal Latency Deep Dive

The most impactful change is the terminal data flow rewrite, which introduces a **3-layer buffering system** that adds **50-150ms latency** to every keystroke echo.

### Original Data Path (0-2ms total)
```
PTY onData -> immediate IPC send -> per-terminal listener -> terminal.write()
```

### Ported Data Path (+50-150ms added latency)
```
PTY onData
  | (0-100ms) Main process: TerminalDataBuffer
  | (0-100ms) IPC: merged batch send
  | (0ms)     Renderer: global listener
  | (0-50ms)  Renderer: scheduleVisibleFlush (VISIBLE_WRITE_THROTTLE_MS)
  | (0-16ms)  Renderer: requestAnimationFrame alignment
  v           terminal.write() with 256KB chunk limit
```

### The 3 Latency Sources

| Layer | Location | Constant | Value | Original |
|-------|----------|----------|-------|----------|
| Layer 1 | `ipc-handlers.ts:80` TerminalDataBuffer | `FLUSH_INTERVAL_MS` | **100ms** | 0ms (immediate) |
| Layer 2 | `terminal-session-manager.ts:97` | `VISIBLE_WRITE_THROTTLE_MS` | **50ms** | 0ms (immediate) |
| Layer 3 | `terminal-session-manager.ts:189` | rAF alignment | **0-16ms** | N/A |

**Worst case: 100ms + 50ms + 16ms = 166ms per keystroke echo.** This exceeds the ~100ms threshold where humans perceive delay.
