/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Automated test sharing type definition
 */

// ============================================================
// Debug API interface
// ============================================================

export interface GitDiffDebugApi {
  isOpen: () => boolean
  getFileList: () => { filename: string; originalFilename?: string }[]
  getSelectedFile: () => { filename: string; originalFilename?: string } | null
  selectFileByPath: (path: string) => boolean
  selectFileByIndex: (index: number) => boolean
  isSelectedReady: () => boolean
  getRestoreNotice: () => { type: 'missing' | 'changed'; message: string; fileName?: string } | null
  getScrollTop: () => number
  getFirstVisibleLine: () => number
  scrollToFraction: (fraction: number) => boolean
  scrollToLine: (line: number) => boolean
  getDiffFontSize: () => number
  getCwd: () => string | null
  getRepoRoot: () => string | null
  getImagePreviewState?: () => {
    isImage: boolean
    isSvg: boolean
    isBinary: boolean
    hasOriginalUrl: boolean
    hasModifiedUrl: boolean
    compareMode: '2up' | 'swipe' | 'onion'
    displayMode: 'original' | 'fit'
    loading: boolean
  } | null
}

export interface PromptSenderDebugApi {
  getTerminalCards: () => Array<{ id: string; title: string; isSelected: boolean }>
  getSelectedTerminalIds: () => string[]
  getActionButtons: () => Array<{ label: string; disabled: boolean }>
  getGridLayout: () => { columns: number; rows: number; totalCards: number }
  getNotice: () => string | null
  isSubmitting: () => boolean
  clickAction: (action: 'sendAndExecute' | 'execute' | 'send' | 'sendAllAndExecute') => Promise<boolean>
  selectTerminal: (id: string) => boolean
  deselectTerminal: (id: string) => boolean
  deselectAllTerminals: () => void
}

export interface GitHistoryDebugApi {
  isOpen: () => boolean
  getCommitCount: () => number
  getSelectedShas: () => string[]
  getFiles: () => Array<{ filename: string; status: string }>
  getSelectedFile: () => { filename: string } | null
  isLoading: () => boolean
  selectCommitByIndex: (index: number) => boolean
  selectFileByIndex: (index: number) => boolean
  getDiffStyle: () => 'split' | 'unified'
  setDiffStyle: (style: 'split' | 'unified') => void
  getHideWhitespace: () => boolean
  setHideWhitespace: (value: boolean) => void
}

export interface ScheduleDebugInfo {
  promptId: string
  tabId: string
  targetTerminalIds: string[]
  scheduleType: string
  status: string
  nextExecutionAt: number
  executedCount: number
  executionLogCount: number
  lastError: string | null
  missedExecutions: number
  absoluteTime: number | null
  relativeOffsetMs: number | null
  maxExecutions: number | null
  recurrence: { startTime: number; intervalMs: number } | null
  executionLog: Array<{ timestamp: number; success: boolean; targetTerminalIds: string[]; error?: string | null }>
}

export interface PromptNotebookDebugApi {
  getPromptCount: () => number
  getPrompts: () => Array<{ id: string; title: string; pinned: boolean; color?: string; lastUsedAt: number }>
  getCleanupConfig: () => { autoEnabled: boolean; autoKeepDays: number; autoDeleteColored: boolean; lastAutoCleanupAt: number | null }
  getEditorContent: () => string
  setEditorContent: (content: string) => void
  submitEditor: () => void
  // Scheduled task Debug API
  getSchedules: () => ScheduleDebugInfo[]
  getScheduleForPrompt: (promptId: string) => ScheduleDebugInfo | null
  createSchedule: (promptId: string, type: 'relative' | 'absolute' | 'recurring', options?: {
    offsetMs?: number
    time?: number
    recurrence?: { startTime: number; intervalMs: number }
  }) => boolean
  pauseSchedule: (promptId: string) => boolean
  resumeSchedule: (promptId: string) => boolean
  deleteSchedule: (promptId: string) => boolean
}

export interface ProjectEditorDebugApi {
  isOpen: () => boolean
  getRootPath: () => string | null
  getActiveFilePath: () => string | null
  getEditorLineCount: () => number
  openFileByPath: (filePath: string) => Promise<void>
  triggerEditorSaveCommand: () => boolean
  triggerToolbarSave: () => Promise<boolean>
  isSqliteViewerVisible: () => boolean
  isMarkdownEditorVisible?: () => boolean
  setMarkdownEditorVisible?: (visible: boolean) => void
  isMarkdownPreviewVisible: () => boolean
  setPreviewSearchOpen?: (open: boolean) => void
  isPreviewSearchOpen?: () => boolean
  isMarkdownRenderPending: () => boolean
  getMarkdownRenderedHtml: () => string
  getOutlineTarget?: () => 'editor' | 'preview'
  setOutlineTarget?: (target: 'editor' | 'preview') => void
  isOutlineVisible?: () => boolean
  getOutlineSymbolCount?: () => number
  getOutlineActiveItemName?: () => string | null
  getPreviewActiveSlug?: () => string | null
  scrollPreviewToFraction?: (fraction: number) => boolean
  getCursorPosition: () => { lineNumber: number; column: number } | null
  setCursorPosition: (lineNumber: number, column?: number) => boolean
  getScrollTop: () => number
  getFirstVisibleLine: () => number
  scrollToLine: (lineNumber: number) => boolean
  getMissingFileNotice: () => { path: string; message: string } | null
}

export interface TerminalFocusDebugApi {
  blurActiveElement: () => boolean
  prepareTerminalRestore: (terminalId: string) => boolean
  simulatePointerTarget: (target: 'terminal' | 'input' | 'other', terminalId?: string | null) => boolean
  simulateRestore: (reason: 'window-focus' | 'shortcut-activated' | 'shortcut-terminal') => void
  getFocusedTerminalId: () => string | null
  getState: () => {
    windowHasFocus: boolean
    activeTagName: string | null
    activeClassName: string | null
    focusedTerminalId: string | null
    activeTerminalId: string | null
    lastFocusedTerminalId: string | null
    lastFocusOwner: 'terminal' | 'input'
    recentPointer: boolean
    pointerTarget: 'terminal' | 'input' | 'other'
    targetTerminal: {
      exists: boolean
      open: boolean | null
      status: 'idle' | 'initializing' | 'ready' | 'error' | 'disposed' | null
      visible: boolean | null
      hasContainer: boolean
      containerConnected: boolean
      containerWidth: number | null
      containerHeight: number | null
      containerDisplay: string | null
      hasTextarea: boolean
      textareaConnected: boolean
      textareaDisabled: boolean | null
      textareaTabIndex: number | null
      textareaDisplay: string | null
      terminalElementConnected: boolean
      activeElementMatchesTextarea: boolean
    }
  }
}

export interface TerminalDebugApi {
  getTerminalIds: () => string[]
  getActiveTerminalId: () => string | null
  getViewportState: (terminalId?: string) => {
    terminalId: string
    bufferType: 'normal' | 'alternate'
    baseY: number
    viewportY: number
    rows: number
    cols: number
    isNearBottom: boolean
    userWantsBottom: boolean
    pendingRestore: {
      followBottom: boolean
      viewportY: number
      bufferType: 'normal' | 'alternate'
      reason: 'output' | 'fit' | 'attach'
      capturedAt: number
    } | null
  } | null
  getTailText: (terminalId?: string, lastLines?: number) => string | null
  scrollToTop: (terminalId?: string) => boolean
  scrollToBottom: (terminalId?: string) => boolean
  forceFit: (terminalId?: string) => boolean
  remountTerminal: (terminalId?: string) => boolean
}

// ============================================================
// Test run environment
// ============================================================

export interface AutotestContext {
  terminalId: string
  rootPath: string
  log: (message: string, data?: unknown) => void
  sleep: (ms: number) => Promise<void>
  waitFor: (label: string, predicate: () => boolean, timeoutMs?: number, intervalMs?: number) => Promise<boolean>
  assert: (name: string, ok: boolean, detail?: Record<string, unknown>) => void
  startCpuSampler: () => void
  stopCpuSampler: () => CpuSummary
  cancelled: () => boolean
  openFileInEditor: (filePath: string) => Promise<void>
  reopenProjectEditor: (label: string) => Promise<boolean>
  buildFileIndex: () => Promise<string[]>
  isOpenRef: { current: boolean }
  rootRef: { current: string | null }
}

export interface CpuSummary {
  samples: number
  totalAvg: number
  totalMax: number
  rendererAvg: number
  rendererMax: number
  browserAvg: number
  browserMax: number
}

export interface TestResult {
  name: string
  ok: boolean
  detail?: Record<string, unknown>
}

export interface TestSuiteResult {
  suite: string
  results: TestResult[]
  passed: number
  failed: number
  skipped: number
}

// ============================================================
// Window global declaration
// ============================================================

declare global {
  interface Window {
    __onwardGitDiffDebug?: GitDiffDebugApi
    __onwardPromptSenderDebug?: PromptSenderDebugApi
    __onwardGitHistoryDebug?: GitHistoryDebugApi
    __onwardPromptNotebookDebug?: PromptNotebookDebugApi
    __onwardProjectEditorDebug?: ProjectEditorDebugApi
    __onwardTerminalFocusDebug?: TerminalFocusDebugApi
    __onwardTerminalDebug?: TerminalDebugApi
  }
}
