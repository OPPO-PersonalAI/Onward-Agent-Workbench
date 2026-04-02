# Interaction Design Difference Report

**Source Project**: `/Users/yingyun/Projects/Project_Onward2`
**Current Project**: `/Users/yingyun/Projects/Onward-Github-worktree_opt2` (`opt2` branch)
**Generated On**: 2026-04-01

---

## Overview

| # | Area | Source Project | Current Project | Impact |
|---|------|----------------|-----------------|--------|
| 1 | Internationalization | Hardcoded mixed-language strings | Full i18n system with locale switching | All user-facing copy |
| 2 | Coding Agent Modal | Claude Code specific modal | Generic coding-agent modal with multiple agent types | Terminal menu to agent launch flow |
| 3 | Global Search | Overlay modal | Sidebar-integrated panel | ProjectEditor search workflow |
| 4 | Terminal Context Menu | Not available | Full copy, paste, select-all, and clear actions | Terminal interaction |
| 5 | Git History Submodules | Not supported | Submodule repository sidebar | Git History page |
| 6 | Diff Unchanged Region Folding | Disabled | `hideUnchangedRegions` enabled | GitDiff readability |
| 7 | ProjectEditor State Persistence | Basic localStorage fields | Full layout and scroll persistence | ProjectEditor restore behavior |
| 8 | Terminal Focus Management | Simple `shouldAutoFocus` callback | `focusCoordinator` plus pointer-aware logic | Focus recovery and keyboard flow |
| 9 | Component Memoization | Limited optimization | Memoized critical components such as `TerminalGrid` and `PromptNotebook` | Render performance |
| 10 | Prompt Import Flow | Two-step prepare and execute flow | Single-step import flow | Prompt import interaction |
| 11 | Git History Summary Panel | Fixed height | Resizable summary panel | Git History layout |
| 12 | Performance Monitoring | Not available | Integrated `perfMonitor` support | Development diagnostics |
| 13 | Settings Locale Selector | Not available | Locale dropdown selector | Settings panel |
| 14 | Shortcut Configuration | Claude Code specific shortcut remains visible | Claude Code specific shortcut removed and naming generalized | Settings panel |

---

## Detailed Notes

### 1. Internationalization

**Source project**

UI strings are hardcoded directly inside components, often with mixed Chinese and English copy.

```typescript
// Sidebar.tsx
<button title="Prompt Notebook">
<button title="Single Layout">
<button title="Quad Layout">

// Settings.tsx
title: 'Global Shortcuts'
description: 'Available in every application'
label: 'Launch Claude Code (Standalone)'

// ClaudeCodeLaunchModal.tsx
if (!trimmed) return 'Unsaved'
```

**Current project**

- Added `src/i18n/` with `core.ts` and `useI18n.ts`
- Components read copy through `const { t, locale } = useI18n()`
- Settings now includes a locale selector

```typescript
// Sidebar.tsx
<button title={t('sidebar.promptNotebook')}>
<button title={t('sidebar.layout.single')}>
<button title={t('sidebar.layout.quad')}>

// Settings.tsx
titleKey: 'settings.group.globalShortcuts'
descriptionKey: 'settings.group.globalShortcuts.description'
labelKey: 'settings.shortcut.viewGitDiff'
```

Affected areas include `Sidebar`, `Settings`, `TerminalGrid`, `PromptNotebook`, `GitHistoryViewer`, and `CodingAgentModal`.

### 2. Coding Agent Modal

**Source project**

- Uses `ClaudeCodeLaunchModal`
- Tailored to a single Claude Code workflow
- Always requires API configuration before launch

**Current project**

- Uses `CodingAgentModal`
- Supports `claude-code` and `codex`
- API configuration is conditional by agent type

```typescript
const needsApiConfig = agentType === 'claude-code'
```

Related state also moved from Claude-specific names to generic coding-agent state in `TerminalGrid`.

### 3. Global Search

**Source project**

- Global search opens as a fixed-position overlay
- Uses dedicated overlay state such as `globalSearchOpen`

**Current project**

- Search lives inside the sidebar area
- Sidebar switches between `files` and `search`
- Adds explicit mode-switch buttons

```css
.project-editor-sidebar-mode-bar {
  display: flex;
}

.pe-mode-btn {
  /* Files / Search mode button styles */
}
```

This changes the interaction from an interrupting overlay to an integrated side-panel workflow.

### 4. Terminal Context Menu

**Source project**

No terminal context menu is available.

**Current project**

Adds a full terminal context menu with copy, paste, select-all, and clear actions.

```typescript
const [termCtxMenu, setTermCtxMenu] = useState<{
  x: number
  y: number
  terminalId: string
  hasSelection: boolean
} | null>(null)
```

The menu is rendered through `createPortal` so it is not clipped by the terminal container.

### 5. Git History Submodule Support

**Source project**

Shows history only for the current repository.

**Current project**

Adds a repository sidebar so submodule repositories can be selected directly.

```typescript
const [selectedRepoRoot, setSelectedRepoRoot] = useState<string | null>(null)
const [repoSearch, setRepoSearch] = useState('')
const [cachedRepos, setCachedRepos] = useState<GitHistoryResult['repos']>(undefined)
```

The main layout changes from a single-column body to a row layout with repository selection on the side.

### 6. Diff Unchanged Region Folding

**Source project**

Monaco DiffEditor shows all unchanged content inline.

**Current project**

Unchanged regions are folded by default:

```typescript
hideUnchangedRegions: {
  enabled: true,
  minimumLineCount: 3,
  contextLineCount: 3,
  revealLineCount: 20
}
```

This reduces scrolling when reading large diffs.

### 7. ProjectEditor UI State Persistence

**Source project**

Only a small set of layout values is persisted, such as basic modal size and file-tree width.

**Current project**

The saved state now includes preview visibility, editor visibility, outline visibility, pane widths, modal size, outline target, and multiple scroll positions.

```typescript
interface ProjectEditorState {
  filePath: string
  cursorPosition: { lineNumber: number; column: number }
  scrollTop: number
  previewOpen: boolean
  editorOpen: boolean
  outlineOpen: boolean
  fileTreeWidth: number
  previewWidth: number
  outlineWidth: number
  modalSize: { w: number; h: number }
  outlineTarget: string
  fileTreeScrollTop: number
  outlineScrollTop: number
  previewAnchor: string
}
```

The result is much stronger recovery after reopening ProjectEditor.

### 8. Terminal Focus Management

**Source project**

Focus control is driven by a simple `shouldAutoFocus` style callback.

**Current project**

Focus behavior is coordinated through a dedicated `focusCoordinator` plus debug helpers. Pointer activity is considered before reclaiming focus, which reduces unwanted focus stealing.

### 9. Component Memoization

**Source project**

Critical components are less aggressively memoized.

**Current project**

Memoization is applied more consistently to components that are expensive to rerender, improving responsiveness during heavy UI activity.

### 10. Prompt Import Flow

**Source project**

Prompt import follows a prepare-then-execute flow.

**Current project**

Prompt import is reduced to a single operation through a unified import callback.

```typescript
onImportAllPrompts: () => Promise<PromptImportResult>
```

This simplifies the interaction and removes an extra confirmation step.

### 11. Git History Summary Panel

**Source project**

The commit summary panel height is fixed.

**Current project**

The summary panel can be resized vertically with a drag handle and persisted across sessions.

### 12. Performance Monitoring

**Source project**

No integrated performance monitor exists.

**Current project**

`perfMonitor` is available for internal diagnostics and regression tracking.

### 13. Settings Locale Selector

**Source project**

No locale selection control exists in Settings.

**Current project**

Settings now exposes an explicit locale selector with support for `en` and `zh-CN`.

### 14. Shortcut Configuration

**Source project**

Shortcut settings still expose Claude Code specific naming.

**Current project**

Shortcut naming has been generalized and Claude-specific entries have been removed from the visible configuration surface where they no longer match the broader agent model.

---

## Direction Summary

| Dimension | Source Project | Current Project Direction |
|-----------|----------------|---------------------------|
| Internationalization | Mixed hardcoded copy | Translation-key-driven multilingual architecture |
| Search UX | Interrupting overlay | Integrated sidebar workflow |
| Agent Support | Single Claude Code path | Multi-agent extensibility |
| Terminal Interaction | Minimal context actions | Standard desktop context menu |
| Git Scope | Single repository | Submodule-aware repository switching |
| State Persistence | Partial persistence | Full layout and scroll restoration |
| Performance | Minimal instrumentation | Memoization plus monitoring |
| Layout Flexibility | Mostly fixed panel sizes | Resizable panels |
| Import Flow | Two-step confirmation | Single-step completion |
| Focus Logic | Simple boolean gating | Pointer-aware focus coordination |
