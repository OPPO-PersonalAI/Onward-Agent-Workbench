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
  getFileList: () => Array<{ filename: string; originalFilename?: string; status?: string; changeType?: string }>
  getRepoList: () => Array<{ root: string; label: string; isSubmodule: boolean; depth: number; changeCount: number; loading?: boolean }>
  getSelectedFile: () => { filename: string; originalFilename?: string; status?: string; changeType?: string } | null
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
  isSubmodulesLoading: () => boolean
  getTiming: () => {
    openRequestedAt: number | null
    shellShownAt: number | null
    cwdReadyAt: number | null
    diffLoadedAt: number | null
    openToShellMs: number | null
    openToCwdReadyMs: number | null
    openToDiffLoadedMs: number | null
    cwdReadyToDiffLoadedMs: number | null
  }
  getSplitViewState?: () => {
    ratio: number | null
    originalWidth: number
    modifiedWidth: number
  } | null
  setSplitViewRatio?: (ratio: number) => boolean
  dragSplitViewRatio?: (ratio: number) => Promise<boolean>
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
  getFileActionState?: () => {
    fileActionsVisible: boolean
    lineActionsVisible: boolean
    keepDisabled: boolean
    denyDisabled: boolean
    pending: boolean
  } | null
  triggerFileAction?: (action: 'keep' | 'deny') => Promise<boolean>
  getPdfCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    originalSrc: string | null
    modifiedSrc: string | null
    originalHasEmpty: boolean
    modifiedHasEmpty: boolean
  } | null
  getEpubCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    chapterCount: number
    selectedHref: string | null
    chapterBadges: Array<{ href: string; label: string; kind: 'added' | 'deleted' | 'modified' | 'unchanged' }>
    diffCounts: { add: number; del: number; same: number } | null
  } | null
}

export interface PromptSenderDebugApi {
  getTerminalCards: () => Array<{ id: string; title: string; isSelected: boolean }>
  getSelectedCount: () => number
  getSelectionIndicatorStates: () => Array<{ id: string; isActive: boolean }>
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
  getImagePreviewState?: () => {
    isImage: boolean
    isSvg: boolean
    hasOriginalUrl: boolean
    hasModifiedUrl: boolean
    compareMode: '2up' | 'swipe' | 'onion'
    displayMode: 'original' | 'fit'
    svgViewMode: 'visual' | 'text'
    loading: boolean
  } | null
  setImageCompareMode?: (mode: '2up' | 'swipe' | 'onion') => void
  setImageDisplayMode?: (mode: 'original' | 'fit') => void
  setSvgViewMode?: (mode: 'visual' | 'text') => void
  getPdfCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    originalSrc: string | null
    modifiedSrc: string | null
    originalHasEmpty: boolean
    modifiedHasEmpty: boolean
  } | null
  getEpubCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    chapterCount: number
    selectedHref: string | null
    chapterBadges: Array<{ href: string; label: string; kind: 'added' | 'deleted' | 'modified' | 'unchanged' }>
    diffCounts: { add: number; del: number; same: number } | null
  } | null
  isLoading: () => boolean
  getActiveCwd: () => string | null
  getRepoState: () => {
    selectedRepoRoot: string | null
    cachedParentCwd: string | null
    repoSearch: string
    cachedRepoCount: number
  }
  switchRepo?: (repoRoot: string | null) => void
  injectRepoState: (state: {
    selectedRepoRoot: string | null
    cachedParentCwd: string | null
    repoSearch?: string
    cachedRepos?: Array<{
      root: string
      label: string
      isSubmodule?: boolean
      depth?: number
      changeCount?: number
    }>
  }) => boolean
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
  getPrompts: () => Array<{ id: string; title: string; pinned: boolean; color?: string; lastUsedAt: number; taskNumbers: number[] }>
  getVisiblePromptItems?: () => Array<{ id: string; title: string; color?: string; taskNumbers: number[] }>
  getSelectedPromptId?: () => string | null
  selectPrompt?: (promptId: string) => boolean
  setPromptColor?: (promptId: string, color: 'red' | 'yellow' | 'green' | null) => boolean
  copyPrompt?: (promptId: string) => Promise<boolean>
  getColorFilterState?: () => {
    enabled: boolean
    activeColor: 'red' | 'yellow' | 'green' | null
    counts: { red: number; yellow: number; green: number }
  }
  setColorFilter?: (color: 'red' | 'yellow' | 'green' | null) => boolean
  getTaskFilterState?: () => {
    enabled: boolean
    activeTaskNumber: number | null
    options: Array<{ taskNumber: number; count: number }>
  }
  setTaskFilter?: (taskNumber: number | null) => boolean
  isFilterEnabled?: () => boolean
  setFilterEnabled?: (enabled: boolean) => boolean
  isTargetsEnabled?: () => boolean
  setTargetsEnabled?: (enabled: boolean) => boolean
  getCleanupConfig: () => { autoEnabled: boolean; autoKeepDays: number; autoDeleteColored: boolean; lastAutoCleanupAt: number | null }
  getEditorContent: () => string
  getEditorHeight: () => number | null
  getPersistedEditorHeight: () => number
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
  getSidebarMode?: () => 'files' | 'search'
  setSidebarMode?: (mode: 'files' | 'search') => void
  getEditorContent: () => string
  setEditorContent?: (content: string) => boolean
  getEditorLineCount: () => number
  openFileByPath: (filePath: string) => Promise<void>
  openFileByPathAsUser: (filePath: string, options?: { trackRecent?: boolean }) => Promise<void>
  triggerEditorSaveCommand: () => boolean
  triggerToolbarSave: () => Promise<boolean>
  isSqliteViewerVisible: () => boolean
  isPdfReaderVisible?: () => boolean
  getPdfReaderState?: () => {
    visible: boolean
    src: string | null
    filePath: string
  } | null
  isEpubReaderVisible?: () => boolean
  getEpubReaderState?: () => {
    visible: boolean
    hasContent: boolean
    tocCount: number
    fontSizeLabel: string | null
    filePath: string
    errorMessage: string | null
    contentHtmlLen: number
    currentLocationHref: string | null
  } | null
  getImageFilePreviewState?: () => {
    visible: boolean
    loaded: boolean
    broken: boolean
    src: string
  } | null
  getFileBrowserScrollTop?: () => number
  getFileBrowserScrollHeight?: () => number
  scrollFileBrowserToFraction?: (fraction: number) => boolean
  getFileBrowserActiveRowBounds?: () => {
    found: boolean
    containerTop: number
    containerHeight: number
    rowTop: number
    rowHeight: number
    centerOffsetRatio: number
  } | null
  getFileBrowserExpandedDirs?: () => string[]
  clickLocateFileButton?: () => boolean
  getOutlineActiveItemBounds?: () => {
    found: boolean
    containerTop: number
    containerHeight: number
    itemTop: number
    itemHeight: number
    centerOffsetRatio: number
  } | null
  isMarkdownEditorVisible?: () => boolean
  setMarkdownEditorVisible?: (visible: boolean) => void
  setMarkdownPreviewVisible?: (visible: boolean) => void
  isMarkdownPreviewVisible: () => boolean
  setMarkdownPreviewOpen?: (open: boolean) => void
  isMarkdownCodeWrapEnabled?: () => boolean
  setMarkdownCodeWrapEnabled?: (enabled: boolean) => void
  getMarkdownCodeWrapState?: () => {
    enabled: boolean
    previewClassName: string | null
    blockWhiteSpace: string | null
    blockOverflowWrap: string | null
    inlineWhiteSpace: string | null
    inlineOverflowWrap: string | null
  }
  setPreviewSearchOpen?: (open: boolean) => void
  isPreviewSearchOpen?: () => boolean
  previewSearchSetQuery?: (query: string) => void
  previewSearchGoToNext?: () => void
  previewSearchGoToPrevious?: () => void
  getPreviewSearchMatchCount?: () => number
  getPreviewSearchCurrentIndex?: () => number
  getPreviewSearchMatchPositions?: () => Array<{ top: number; left: number; isActive: boolean }>
  getPreviewSearchActiveCenter?: () => {
    markCenter: number
    containerCenter: number
    containerHeight: number
    offset: number
  } | null
  isMarkdownRenderPending: () => boolean
  getMarkdownRenderedHtml: () => string
  getMarkdownPreviewImageState?: () => {
    count: number
    loadedCount: number
    brokenCount: number
    sources: string[]
  }
  getMermaidPreviewState?: () => {
    total: number
    rendered: number
    error: number
    pending: number
    inFlight: boolean
  }
  getMarkdownSessionCacheState?: () => {
    size: number
    limit: number
    lastRestore: {
      mode: 'hit' | 'miss' | 'stale' | 'disabled'
      key: string | null
      filePath: string | null
      size: number
      limit: number
      openCount?: number
      dwellMs?: number
      renderedHtmlLength?: number
    }
    entries: Array<{
      filePath: string
      renderedHtmlLength: number
      openCount: number
      dwellMs: number
      lastAccessedAt: number
      hitCount: number
      stale: boolean
    }>
  }
  getOutlineTarget?: () => 'editor' | 'preview'
  setOutlineTarget?: (target: 'editor' | 'preview') => void
  getOutlineEffectiveTarget?: () => 'editor' | 'preview'
  isOutlineVisible?: () => boolean
  setOutlineVisible?: (visible: boolean) => void
  getOutlineSymbolCount?: () => number
  getOutlineActiveItemName?: () => string | null
  getOutlineScrollTop?: () => number
  getOutlineScrollHeight?: () => number
  getOutlineScrollMax?: () => number
  scrollOutlineToFraction?: (fraction: number) => boolean
  clickOutlineItemByName?: (name: string) => boolean
  getPreviewActiveSlug?: () => string | null
  scrollPreviewToFraction?: (fraction: number) => boolean
  getPreviewScrollTop?: () => number
  getPreviewScrollHeight?: () => number
  isPreviewTransitioning?: () => boolean
  isPreviewContentVisible?: () => boolean
  getPreviewRestorePhase?: () => 'idle' | 'waiting-html' | 'restoring-layout' | 'revealing'
  debugScanPreviewHeadings?: () => { nearest: string | null }
  runPreviewPositionTest?: (mdFilePath: string, otherFilePath: string) => Promise<boolean>
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
  getVisibleTerminalIds: () => string[]
  getActiveTerminalId: () => string | null
  getSessionState: (terminalId?: string) => {
    terminalId: string
    status: 'idle' | 'initializing' | 'ready' | 'error' | 'disposed'
    open: boolean
    visible: boolean
    pendingDataChunks: number
    pendingDataBytes: number
  } | null
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

export interface SettingsDebugApi {
  isOpen: () => boolean
  getUpdaterState: () => {
    phase: string
    supported: boolean
    statusLabel: string
    actionLabel: string
    actionDisabled: boolean
    detailText: string | null
    actionCounts: {
      checkNow: number
      restartToUpdate: number
    }
    targetVersion: string | null
    lastCheckedAt: number | null
    actionError: string | null
  }
  setMockUpdaterStatus: (
    patch: Partial<import('../types/electron.d.ts').UpdaterStatus> & {
      phase: import('../types/electron.d.ts').UpdatePhase
    }
  ) => boolean
  setMockNextCheckResult: (
    patch: Partial<import('../types/electron.d.ts').UpdaterStatus> & {
      phase: import('../types/electron.d.ts').UpdatePhase
    },
    delayMs?: number
  ) => boolean
  setMockRestartResult: (result: {
    success: boolean
    error?: string
    delayMs?: number
  }) => boolean
  clickUpdateAction: () => Promise<boolean>
  resetMockUpdater: () => boolean
}

export interface ChangeLogDebugApi {
  isOpen: () => boolean
  isLoading: () => boolean
  getCurrentTag: () => string | null
  getRenderedText: () => string
  getUnavailableState: () => {
    visible: boolean
    message: string | null
    detail: string | null
  }
  clickCloseButton: () => boolean
  clickOverlay: () => boolean
  pressEscape: () => boolean
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
    __onwardSettingsDebug?: SettingsDebugApi
    __onwardChangeLogDebug?: ChangeLogDebugApi
    __onwardTerminalFocusDebug?: TerminalFocusDebugApi
    __onwardTerminalDebug?: TerminalDebugApi
  }
}
