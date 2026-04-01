# 交互设计差异对比报告

**原工程**: `/Users/yingyun/Projects/Project_Onward2`
**当前工程**: `/Users/yingyun/Projects/Onward-Github-worktree_opt2` (opt2 分支)
**生成日期**: 2026-04-01

---

## 差异总览

| # | 差异项 | 原工程 | 当前工程 | 影响范围 |
|---|--------|--------|----------|----------|
| 1 | 国际化 (i18n) | 硬编码中英文字符串 | 完整 i18n 系统 + 语言切换 | 全局所有 UI 文案 |
| 2 | Coding Agent Modal | Claude Code 专用弹窗 | 通用 Coding Agent 弹窗（多 Agent 类型） | 终端菜单 → Agent 启动 |
| 3 | 全局搜索 | 浮层 Overlay（fixed 定位） | 侧边栏集成面板（sidebar 模式切换） | ProjectEditor 搜索体验 |
| 4 | 终端右键菜单 | 无 | 完整实现（复制/粘贴/全选/清屏） | 终端交互 |
| 5 | Git History 子模块 | 不支持 | 子模块仓库侧边栏（行布局） | Git History 页面 |
| 6 | Diff 未变更区域折叠 | 未启用 | 启用 hideUnchangedRegions | GitDiff 查看体验 |
| 7 | ProjectEditor 状态持久化 | 基础 localStorage | 完整 UI 布局状态（12 个字段 + 滚动位置） | ProjectEditor 恢复体验 |
| 8 | 终端焦点管理 | shouldAutoFocus 回调 | focusCoordinator 系统 + 指针感知 | 终端焦点恢复 |
| 9 | 组件 Memoization | 未优化 | TerminalGrid / PromptNotebook 等关键组件 memo 化 | 渲染性能 |
| 10 | Prompt 导入流程 | 两步式（Prepare + Execute） | 单步式（统一 Import） | Prompt 导入交互 |
| 11 | Git History 摘要面板 | 固定高度 | 可拖拽调整高度（ns-resize） | Git History 布局 |
| 12 | 性能监控 | 无 | perfMonitor 集成 | 开发调试 |
| 13 | Settings 语言选择器 | 无 | 语言下拉选择器 | 设置面板 |
| 14 | 快捷键配置 | 包含 Claude Code 快捷键 | 移除 Claude Code 快捷键，通用化命名 | 设置面板 |

---

## 详细差异说明

### 1. 国际化 (i18n) 系统

**原工程：硬编码字符串**

所有 UI 文案直接写在组件代码中，混用中英文：

```typescript
// Sidebar.tsx
<button title="Prompt 笔记本">
<button title="单窗口">
<button title="四宫格">

// Settings.tsx
title: '全局快捷键'
description: '在任何应用中都有效'
label: '启动 Claude Code（Standalone）'

// GitHistoryViewer.tsx
const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

// ClaudeCodeLaunchModal.tsx
if (!trimmed) return '未保存'
```

**当前工程：完整 i18n 系统**

- 新增 `src/i18n/` 目录，包含 `core.ts`（翻译字典）和 `useI18n.ts`（React Hook）
- 所有组件使用 `const { t, locale } = useI18n()` 获取翻译函数
- Settings 面板新增语言选择器

```typescript
// Sidebar.tsx
<button title={t('sidebar.promptNotebook')}>
<button title={t('sidebar.layout.single')}>
<button title={t('sidebar.layout.quad')}>

// Settings.tsx
titleKey: 'settings.group.globalShortcuts'
descriptionKey: 'settings.group.globalShortcuts.description'
labelKey: 'settings.shortcut.viewGitDiff'

// GitHistoryViewer.tsx
function formatRelativeTime(dateText: string, locale: string) {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const wrappedRelative = locale.startsWith('zh')
    ? `（${relative}）`
    : ` (${relative})`
}

// CodingAgentModal.tsx
if (!trimmed) return t('codingAgent.keyMask')
```

**影响的组件**：Sidebar、Settings、TerminalGrid、PromptNotebook、GitHistoryViewer、CodingAgentModal 等全部 UI 组件。

---

### 2. Coding Agent Modal（Claude Code → 通用 Agent）

**原工程：`ClaudeCodeLaunchModal`**

- 路径：`src/components/ClaudeCodeLaunchModal/`
- 专门为 Claude Code 设计，只支持一种 Agent
- 启动时必须配置 API（URL、Key、Model）

**当前工程：`CodingAgentModal`**

- 路径：`src/components/CodingAgentModal/`
- 支持多种 Agent 类型：`CodingAgentType = 'claude-code' | 'codex'`
- 根据 Agent 类型动态决定是否需要 API 配置

```typescript
// 当前工程
const needsApiConfig = agentType === 'claude-code'
// codex 类型无需 API 配置，直接启动
```

**TerminalGrid 对应变化**：

```typescript
// 原工程
const [claudeModalOpen, setClaudeModalOpen] = useState(false)
const [claudeTargetTerminalId, setClaudeTargetTerminalId] = useState<string | null>(null)

// 当前工程
const [codingAgentModalOpen, setCodingAgentModalOpen] = useState(false)
const [codingAgentTerminalId, setCodingAgentTerminalId] = useState<string | null>(null)
const [codingAgentType, setCodingAgentType] = useState<CodingAgentType>('claude-code')
```

---

### 3. ProjectEditor 全局搜索：Overlay → 侧边栏集成

**原工程：浮层 Overlay 模式**

- 全局搜索以 `position: fixed` 浮层方式打开
- 使用 `globalSearchOpen` 和 `globalSearchInitialType` 状态控制
- CSS 类 `.project-editor-global-search` 定义模态尺寸

**当前工程：侧边栏集成面板**

- 搜索面板嵌入文件树侧边栏区域
- 使用 `sidebarMode: 'files' | 'search'` 模式切换
- 新增模式切换栏（Files / Search 按钮）

```css
/* 新增 CSS - SearchPanel.css */
.project-editor-sidebar-mode-bar {
  display: flex;
  /* 模式切换按钮组 */
}
.pe-mode-btn {
  /* Files / Search 切换按钮样式 */
}
```

**交互差异**：
- 原工程：Cmd+Shift+F 弹出浮层覆盖编辑器，ESC 关闭
- 当前工程：Cmd+Shift+F 切换侧边栏为搜索模式，文件树和搜索共享同一区域

---

### 4. 终端右键菜单（全新功能）

**原工程**：终端区域无右键菜单。

**当前工程**：完整的终端右键菜单实现。

```typescript
// TerminalGrid.tsx
const [termCtxMenu, setTermCtxMenu] = useState<{
  x: number; y: number;
  terminalId: string;
  hasSelection: boolean
} | null>(null)
```

**菜单项**：
- 复制 (Copy) — 仅在有选区时可用
- 粘贴 (Paste)
- 全选 (Select All)
- 清屏 (Clear)

**渲染方式**：使用 `createPortal` 渲染到 document.body，避免被终端容器裁剪。

---

### 5. Git History 子模块支持（全新功能）

**原工程**：不支持子模块，只显示当前仓库的提交历史。

**当前工程**：新增子模块仓库侧边栏。

```typescript
// GitHistoryViewer.tsx - 新增状态
const [selectedRepoRoot, setSelectedRepoRoot] = useState<string | null>(null)
const [repoSearch, setRepoSearch] = useState('')
const [cachedRepos, setCachedRepos] = useState<GitHistoryResult['repos']>(undefined)
```

**布局变化**：
- 原工程 `.git-history-body`：无子模块区域
- 当前工程 `.git-history-body` + `.git-history-main`：使用 `flex-direction: row`，仓库列表和提交历史并排显示

**新增类型**：
```typescript
import type { GitRepoContext } from '../../types/electron'
```

---

### 6. Diff 视图未变更区域折叠

**原工程**：Monaco DiffEditor 不启用 `hideUnchangedRegions`，所有行平铺展示。

**当前工程**：启用折叠功能，未变更的连续区域自动折叠。

```typescript
// GitDiffViewer.tsx - editor options
hideUnchangedRegions: {
  enabled: true,
  minimumLineCount: 3,   // 最少 3 行才折叠
  contextLineCount: 3,   // 折叠边界保留 3 行上下文
  revealLineCount: 20    // 点击展开时显示 20 行
}
```

**交互差异**：
- 原工程：大文件 diff 需要大量滚动才能找到变更位置
- 当前工程：未变更区域自动折叠为一行提示，点击可展开，减少滚动量

---

### 7. ProjectEditor UI 状态持久化

**原工程**：基础 localStorage 持久化（仅模态窗口尺寸、文件树宽度等少量字段）。

**当前工程**：完整的 UI 布局状态持久化，新增 12 个字段。

```typescript
// tab.d.ts - ProjectEditorState 扩展
interface ProjectEditorState {
  // 原有字段
  filePath: string
  cursorPosition: { lineNumber: number; column: number }
  scrollTop: number

  // 新增字段
  previewOpen: boolean        // Markdown 预览面板是否打开
  editorOpen: boolean         // 编辑器是否展开
  outlineOpen: boolean        // 大纲面板是否打开
  fileTreeWidth: number       // 文件树宽度
  previewWidth: number        // 预览面板宽度
  outlineWidth: number        // 大纲面板宽度
  modalSize: { w: number; h: number }  // 模态窗口尺寸
  outlineTarget: string       // 大纲目标（editor/preview）
  fileTreeScrollTop: number   // 文件树滚动位置
  outlineScrollTop: number    // 大纲滚动位置
  previewAnchor: string       // 预览锚点位置
}
```

**交互差异**：
- 原工程：关闭/重开 ProjectEditor 后面板布局重置
- 当前工程：完整恢复上次的面板开关状态、宽度、滚动位置

---

### 8. 终端焦点管理系统

**原工程：`shouldAutoFocus` 回调**

```typescript
// App.tsx
interface TabTerminalGridProps {
  shouldAutoFocus?: () => boolean
}
```

简单的布尔值判断，由上层决定是否自动聚焦。

**当前工程：`focusCoordinator` 系统**

```typescript
// 新文件: src/terminal/focus-coordinator.ts
import { focusCoordinator, type TerminalFocusRestoreReason } from './terminal/focus-coordinator'

// App.tsx
interface TabTerminalGridProps {
  focusRequest?: TerminalFocusRequest | null
}
```

- 新增 `focus-coordinator.ts`：根据鼠标指针活动智能决定焦点恢复策略
- 新增 `focus-debug-api.ts`：调试 API，支持开发阶段排查焦点问题
- 感知用户是否正在与终端交互，避免不必要的焦点抢夺

---

### 9. 组件 Memoization 优化

**原工程**：关键组件未使用 `React.memo`。

```typescript
// 原工程
export function TerminalGrid({ ... }) { }
function TabTerminalGrid({ ... }) { }
function TabPromptNotebook({ ... }) { }
export function PromptNotebook({ ... }) { }
```

**当前工程**：关键组件均使用 `React.memo` 包裹。

```typescript
// 当前工程
export const TerminalGrid = memo(function TerminalGrid({ ... }) { })
const TabTerminalGrid = memo(function TabTerminalGrid({ ... }) { })
const TabPromptNotebook = memo(function TabPromptNotebook({ ... }) { })
export const PromptNotebook = memo(function PromptNotebook({ ... }) { })
```

虽然不直接影响交互设计，但显著影响渲染性能，间接改善交互流畅度。

---

### 10. Prompt 导入流程简化

**原工程：两步式导入**

```typescript
interface PromptNotebookProps {
  onPrepareImport: () => Promise<ImportPrepareResult>  // 第一步：准备
  onExecuteImport: (globals: Prompt[], locals: Prompt[]) => void  // 第二步：执行
}
```

用户需要先预览导入结果，再确认执行。

**当前工程：单步式导入**

```typescript
interface PromptNotebookProps {
  onImportAllPrompts: () => Promise<PromptImportResult>  // 一步完成
}
```

导入流程简化为单次操作，减少用户操作步骤。

---

### 11. Git History 摘要面板高度可调

**原工程**：提交摘要区域高度固定。

**当前工程**：新增垂直拖拽调整功能。

```typescript
// GitHistoryViewer.tsx
const [summaryHeight, setSummaryHeight] = useState(() => {
  const saved = localStorage.getItem(STORAGE_KEY_SUMMARY_HEIGHT)
  return saved ? parseInt(saved, 10) : DEFAULT_SUMMARY_HEIGHT
})

// 拖拽手柄
<div className="summary-resize-handle"
     style={{ cursor: 'ns-resize' }}
     onMouseDown={handleVDragStart} />
```

**交互差异**：
- 原工程：摘要高度固定，长提交信息可能需要内部滚动
- 当前工程：鼠标拖拽分隔线调整摘要与文件列表的高度比例，支持 localStorage 持久化

---

### 12. 性能监控系统（新增）

**原工程**：无性能监控。

**当前工程**：集成 `perfMonitor`。

```typescript
// TerminalGrid.tsx
import { perfMonitor } from '../../utils/perf-monitor'
// ...
perfMonitor.recordReactRender()
```

虽不影响用户交互，但为性能调优提供了基础设施。

---

### 13. Settings 语言选择器（新增）

**原工程**：Settings 面板无语言切换功能。

**当前工程**：新增语言下拉选择器。

```typescript
// Settings.tsx
const { t, locale, locales, updateLanguage } = useI18n()

const handleLanguageChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
  updateLanguage(e.target.value as typeof locale)
}, [updateLanguage])
```

支持 `en` 和 `zh-CN` 两种语言实时切换。

---

### 14. 快捷键配置变化

**原工程**：包含 Claude Code 专用快捷键。

```typescript
// Settings.tsx
{ key: 'terminalClaudeCode', label: '启动 Claude Code（Standalone）' }
```

**当前工程**：移除 Claude Code 快捷键，通用化命名。

```typescript
// Settings.tsx - 快捷键列表中不再包含 terminalClaudeCode
// 标签使用 i18n 翻译 key
{ key: 'terminalGitDiff', labelKey: 'settings.shortcut.viewGitDiff' }
```

---

## 交互设计演进方向总结

| 维度 | 原工程特点 | 当前工程演进方向 |
|------|-----------|----------------|
| **国际化** | 中文硬编码 | 多语言架构，翻译 key 驱动 |
| **搜索体验** | 浮层打断式 | 侧边栏无缝集成 |
| **Agent 支持** | Claude Code 单一 | 多 Agent 类型可扩展 |
| **终端交互** | 无右键菜单 | 标准右键菜单 |
| **Git 能力** | 单仓库 | 子模块仓库切换 |
| **状态持久化** | 部分持久化 | 全面布局状态恢复 |
| **性能优化** | 无特殊优化 | memo 化 + 性能监控 |
| **布局灵活性** | 固定高度面板 | 可拖拽调整面板比例 |
| **导入流程** | 两步确认式 | 单步完成式 |
| **焦点管理** | 简单布尔判断 | 智能指针感知系统 |
