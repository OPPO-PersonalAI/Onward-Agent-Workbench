/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface TerminalOptions {
  cols?: number
  rows?: number
  cwd?: string
}

export type TerminalReadMode = 'full' | 'tail-lines' | 'tail-chars'

export interface TerminalBufferOptions {
  mode?: TerminalReadMode
  lastLines?: number
  lastChars?: number
  trimTrailingEmpty?: boolean
}

export interface TerminalBufferResult {
  success: boolean
  terminalId: string
  content?: string
  totalLines?: number
  returnedLines?: number
  returnedChars?: number
  truncated?: boolean
  capturedAt?: number
  error?: string
}

export type PromptBridgeAction = 'send' | 'execute' | 'send-and-execute'

export interface PromptBridgeSendRequest {
  requestId: string
  terminalId: string
  content: string
  action: PromptBridgeAction
}

export interface PromptBridgeSendResult {
  success: boolean
  successIds: string[]
  failedIds: string[]
  error?: string
}

export interface TerminalAPI {
  create: (id: string, options?: TerminalOptions) => Promise<{ success: boolean; id?: string; error?: string }>
  write: (id: string, data: string) => Promise<boolean>
  writeSplit: (
    id: string,
    content: string,
    suffix: string,
    delayMs?: number
  ) => Promise<{ ok: boolean; phase?: 'content' | 'suffix'; error?: string }>
  resize: (id: string, cols: number, rows: number) => Promise<boolean>
  dispose: (id: string) => Promise<boolean>
  onData: (callback: (id: string, data: string) => void) => () => void
  onExit: (callback: (id: string, exitCode: number, signal?: number) => void) => () => void
  onGetBufferRequest: (callback: (requestId: string, terminalId: string, options?: TerminalBufferOptions) => void) => () => void
  sendBufferResponse: (requestId: string, result: TerminalBufferResult) => void
  onPromptBridgeSend: (callback: (request: PromptBridgeSendRequest) => void) => () => void
  sendPromptBridgeResponse: (requestId: string, result: PromptBridgeSendResult) => void
}

export interface Prompt {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface PromptAPI {
  load: () => Promise<Prompt[]>
  save: (prompt: Prompt) => Promise<boolean>
  delete: (id: string) => Promise<boolean>
}

export interface TerminalWindowConfig {
  version: number
  layoutMode: 1 | 2 | 4 | 6
  activeTerminalId: string | null
  activePanel: 'prompt' | null
  terminals: { id: string; title: string }[]
  promptPanelWidth: number
  updatedAt: number
}

export interface TerminalConfigAPI {
  load: () => Promise<TerminalWindowConfig>
  save: (config: TerminalWindowConfig) => Promise<boolean>
  update: (partial: Partial<TerminalWindowConfig>) => Promise<boolean>
}

export interface DialogAPI {
  openDirectory: () => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
  openTextFile: (payload?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ success: boolean; path?: string; content?: string; canceled?: boolean; error?: string }>
  saveTextFile: (payload: {
    title?: string
    defaultFileName?: string
    content: string
  }) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
}

export interface ShellAPI {
  openPath: (path: string) => Promise<{ success: boolean; error?: string }>
  openExternal: (url: string) => Promise<{
    success: boolean
    canceled?: boolean
    blocked?: boolean
    error?: string
  }>
}

export interface CommandPreset {
  id: string
  command: string
  isBuiltin: boolean
  createdAt: number
}

export interface CommandPresetAPI {
  load: () => Promise<CommandPreset[]>
  save: (preset: CommandPreset) => Promise<boolean>
  delete: (id: string) => Promise<boolean>
}

export interface LocalPrompt {
  id: string
  title: string
  content: string
  pinned: false
  color?: 'red' | 'yellow' | 'green' | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface GlobalPrompt {
  id: string
  title: string
  content: string
  pinned: true
  color?: 'red' | 'yellow' | 'green' | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface PromptCleanupConfig {
  autoEnabled: boolean
  autoKeepDays: number
  autoDeleteColored: boolean
  lastAutoCleanupAt: number | null
}

export interface TabState {
  id: string
  customName: string | null
  createdAt: number
  layoutMode: 1 | 2 | 4 | 6
  activePanel: 'prompt' | null
  promptPanelWidth: number
  activeTerminalId: string | null
  terminals: { id: string; title: string }[]
  localPrompts: LocalPrompt[]
}

export interface AppState {
  activeTabId: string
  tabs: TabState[]
  globalPrompts: GlobalPrompt[]
  promptCleanup: PromptCleanupConfig
  lastFocusedTerminalId: string | null
  updatedAt: number
}

export interface AppStateAPI {
  load: () => Promise<AppState>
  save: (state: AppState) => Promise<boolean>
}

export type GitChangeType = 'unstaged' | 'staged' | 'untracked'
export type GitStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | '?'

export interface GitSubmoduleInfo {
  name: string
  path: string
  repoRoot: string
  depth: number
  parentRoot: string
}

export interface GitRepoContext {
  root: string
  label: string
  isSubmodule: boolean
  depth: number
  changeCount: number
}

// Git file status
export interface GitFileStatus {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
  changeType: GitChangeType
  repoRoot?: string
  repoLabel?: string
}

// Git Diff results
export interface GitDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  files: GitFileStatus[]
  repos?: GitRepoContext[]
  superprojectRoot?: string
  error?: string
}

export interface GitCommitInfo {
  sha: string
  shortSha: string
  parents: string[]
  summary: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: string
  refs?: string
}

export interface GitHistoryResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  commits: GitCommitInfo[]
  totalCount?: number
  repos?: GitRepoContext[]
  superprojectRoot?: string
  error?: string
}

export interface GitHistoryFile {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
}

export interface GitHistoryDiffOptions {
  base: string
  head: string
  filePath?: string
  hideWhitespace?: boolean
  includeFiles?: boolean
}

export interface GitHistoryDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  base: string
  head: string
  patch: string
  files: GitHistoryFile[]
  error?: string
}

export type TerminalGitStatus = 'clean' | 'modified' | 'added' | 'unknown'

export interface TerminalGitInfo {
  cwd: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
}

export interface GitFileContentResult {
  success: boolean
  cwd: string
  filename: string
  originalContent: string
  modifiedContent: string
  isBinary: boolean
  isImage?: boolean
  isSvg?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
  error?: string
}

export interface GitFileSaveResult {
  success: boolean
  filename: string
  error?: string
}

export interface GitFileActionResult {
  success: boolean
  filename: string
  error?: string
}

export type ProjectEntryType = 'file' | 'dir'

export interface ProjectEntry {
  name: string
  path: string
  type: ProjectEntryType
}

export interface ProjectListResult {
  success: boolean
  root: string
  path: string
  entries: ProjectEntry[]
  error?: string
}

export interface ProjectReadResult {
  success: boolean
  root: string
  path: string
  content: string
  isBinary: boolean
  isImage: boolean
  isSqlite: boolean
  previewUrl?: string
  error?: string
}

export interface ProjectSaveResult {
  success: boolean
  root: string
  path: string
  error?: string
}

export interface ProjectActionResult {
  success: boolean
  root: string
  path: string
  error?: string
}

export interface ProjectRenameResult {
  success: boolean
  root: string
  oldPath: string
  newPath: string
  error?: string
}

export type SqliteBlobValue = {
  type: 'blob'
  base64: string
  bytes: number
}

export type SqliteValue = string | number | null | SqliteBlobValue

export interface SqliteColumnInfo {
  name: string
  type: string
  notNull: boolean
  primaryKeyOrder: number
  hasDefault: boolean
}

export interface SqliteTableInfo {
  name: string
  rowCount: number
  columns: SqliteColumnInfo[]
  hasRowid: boolean
  editable: boolean
}

export type SqliteRowKey =
  | { kind: 'rowid'; rowid: number }
  | { kind: 'primary-key'; values: Record<string, SqliteValue> }

export interface SqliteRow {
  key: SqliteRowKey
  values: Record<string, SqliteValue>
}

export interface ProjectSqliteSchemaResult {
  success: boolean
  root: string
  path: string
  tables: SqliteTableInfo[]
  error?: string
}

export interface ProjectSqliteRowsResult {
  success: boolean
  root: string
  path: string
  table: string
  columns: SqliteColumnInfo[]
  rows: SqliteRow[]
  totalRows: number
  limit: number
  offset: number
  hasRowid: boolean
  editable: boolean
  error?: string
}

export interface ProjectSqliteMutationResult {
  success: boolean
  root: string
  path: string
  table: string
  changes: number
  lastInsertRowid?: number | null
  error?: string
}

export interface ProjectSqliteExecuteResult {
  success: boolean
  root: string
  path: string
  mode: 'rows' | 'run' | 'exec'
  columns: string[]
  rows: Array<Record<string, SqliteValue>>
  changes: number
  lastInsertRowid: number | null
  truncated: boolean
  error?: string
}

export interface ProjectSearchOptions {
  rootPath: string
  query: string
  isRegex: boolean
  isCaseSensitive: boolean
  isWholeWord: boolean
  includeGlob?: string
  excludeGlob?: string
  maxResults?: number
}

export interface ProjectSearchMatch {
  file: string
  line: number
  column: number
  matchLength: number
  lineContent: string
}

export interface ProjectSearchStats {
  searchId: string
  matchCount: number
  fileCount: number
  durationMs: number
  cancelled: boolean
}

// Git API
export interface GitAPI {
  resolveRepoRoot: (cwd: string) => Promise<string>
  getDiff: (cwd: string) => Promise<GitDiffResult>
  getHistory: (cwd: string, options?: { limit?: number; skip?: number }) => Promise<GitHistoryResult>
  getHistoryDiff: (cwd: string, options: GitHistoryDiffOptions) => Promise<GitHistoryDiffResult>
  getFileContent: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType'>, repoRoot?: string) => Promise<GitFileContentResult>
  saveFileContent: (cwd: string, filename: string, content: string) => Promise<GitFileSaveResult>
  stageFile: (cwd: string, filename: string, repoRoot?: string) => Promise<GitFileActionResult>
  unstageFile: (cwd: string, filename: string, repoRoot?: string) => Promise<GitFileActionResult>
  discardFile: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status'>, repoRoot?: string) => Promise<GitFileActionResult>
  getSubmodules: (cwd: string) => Promise<GitSubmoduleInfo[]>
  updateIndexContent: (cwd: string, filename: string, content: string) => Promise<GitFileActionResult>
  checkInstalled: () => Promise<boolean>
  getTerminalCwd: (terminalId: string) => Promise<string | null>
  getTerminalInfo: (terminalId: string) => Promise<TerminalGitInfo>
  subscribeTerminalInfo: (terminalId: string) => Promise<{ success: true }>
  unsubscribeTerminalInfo: (terminalId: string) => Promise<{ success: true }>
  notifyTerminalActivity: (terminalId: string) => Promise<{ success: true }>
  notifyTerminalFocus: (terminalId: string) => Promise<{ success: true }>
  notifyTerminalGitUpdate: (terminalId: string) => Promise<{ success: true }>
  onTerminalInfo: (callback: (terminalId: string, info: TerminalGitInfo) => void) => () => void
}

// Project Editor API
export interface ProjectAPI {
  listDirectory: (root: string, path: string) => Promise<ProjectListResult>
  readFile: (root: string, path: string) => Promise<ProjectReadResult>
  saveFile: (root: string, path: string, content: string) => Promise<ProjectSaveResult>
  createFile: (root: string, path: string, content?: string) => Promise<ProjectActionResult>
  createFolder: (root: string, path: string) => Promise<ProjectActionResult>
  renamePath: (root: string, oldPath: string, newPath: string) => Promise<ProjectRenameResult>
  deletePath: (root: string, path: string) => Promise<ProjectActionResult>
  sqliteGetSchema: (root: string, path: string) => Promise<ProjectSqliteSchemaResult>
  sqliteReadTableRows: (root: string, path: string, table: string, limit?: number, offset?: number) => Promise<ProjectSqliteRowsResult>
  sqliteInsertRow: (root: string, path: string, table: string, values: Record<string, unknown>) => Promise<ProjectSqliteMutationResult>
  sqliteUpdateRow: (root: string, path: string, table: string, key: SqliteRowKey, values: Record<string, unknown>) => Promise<ProjectSqliteMutationResult>
  sqliteDeleteRow: (root: string, path: string, table: string, key: SqliteRowKey) => Promise<ProjectSqliteMutationResult>
  sqliteExecute: (root: string, path: string, sql: string) => Promise<ProjectSqliteExecuteResult>
  searchStart: (options: ProjectSearchOptions) => Promise<{ searchId: string }>
  searchCancel: () => Promise<{ success: boolean }>
  onSearchResult: (callback: (searchId: string, matches: ProjectSearchMatch[]) => void) => () => void
  onSearchDone: (callback: (stats: ProjectSearchStats) => void) => () => void
  watchFile: (root: string, path: string) => Promise<{ success: boolean; error?: string }>
  unwatchFile: (root: string, path: string) => Promise<{ success: boolean }>
  onFileChanged: (callback: (fullPath: string, changeType: 'changed' | 'deleted', content?: string) => void) => () => void
}

// Shortcut configuration
export interface ShortcutConfig {
  focusTerminal1: string | null
  focusTerminal2: string | null
  focusTerminal3: string | null
  focusTerminal4: string | null
  focusTerminal5: string | null
  focusTerminal6: string | null
  switchTab1: string | null
  switchTab2: string | null
  switchTab3: string | null
  switchTab4: string | null
  switchTab5: string | null
  switchTab6: string | null
  activateAndFocusPrompt: string | null
  addToHistory: string | null
  focusPromptEditor: string | null
  terminalGitDiff: string | null
  terminalGitHistory: string | null
  terminalChangeWorkDir: string | null
  terminalOpenWorkDir: string | null
  terminalProjectEditor: string | null
  viewGitDiff: string | null
}

// Terminal style configuration
export interface TerminalStyleConfig {
  terminalId: string
  foregroundColor: string | null
  backgroundColor: string | null
  fontFamily: string | null
  fontSize: number | null
  gitDiffFontSize: number | null
}

export interface GlobalTerminalStyle {
  foregroundColor: string | null
  backgroundColor: string | null
  fontFamily: string | null
  fontSize: number | null
  gitDiffFontSize: number | null
}

// Complete settings state
export interface SettingsState {
  version: number
  shortcuts: ShortcutConfig
  terminalStyles: Record<string, TerminalStyleConfig>
  globalTerminalStyle: GlobalTerminalStyle
  gitDiffFontSize: number | null
  settingsPanelWidth: number
  language: 'en' | 'zh-CN'
  updatedAt: number
}

// Shortcut action type
export type ShortcutAction =
  | { type: 'focusTerminal'; index: number }
  | { type: 'switchTab'; index: number }
  | { type: 'activateAndFocusPrompt' }
  | { type: 'addToHistory' }
  | { type: 'focusPromptEditor' }
  | { type: 'terminalGitDiff' }
  | { type: 'terminalGitHistory' }
  | { type: 'terminalChangeWorkDir' }
  | { type: 'terminalOpenWorkDir' }
  | { type: 'terminalProjectEditor' }
  | { type: 'viewGitDiff' }

// Settings API
export interface SettingsAPI {
  load: () => Promise<SettingsState>
  save: (settings: SettingsState) => Promise<boolean>
  update: (partial: Partial<SettingsState>) => Promise<boolean>
  registerShortcuts: () => Promise<boolean>
  checkShortcutAvailable: (accelerator: string) => Promise<boolean>
  checkShortcutConflict: (accelerator: string, excludeKey?: string) => Promise<string | null>
  onShortcutTriggered: (callback: (action: ShortcutAction) => void) => () => void
  onWindowShortcutTriggered: (callback: (action: ShortcutAction) => void) => () => void
  onActivated: (callback: () => void) => () => void
}

export interface AppInfo {
  buildChannel: 'dev' | 'prod'
  branch: string | null
  productName: string
  displayName: string
  isPackaged: boolean
}

export interface AppInfoAPI {
  get: () => Promise<AppInfo>
  readNotice: () => Promise<string | null>
}

export interface GitRuntimeLatencySummary {
  count: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface GitRuntimeMetrics {
  scheduler: {
    inflightCurrent: number
    inflightPeak: number
    queueDepthCurrent: number
    queueDepthPeak: number
    dedupHits: number
    totalScheduled: number
    totalCompleted: number
    totalFailed: number
    maxInflight: number
    maxPerRepoInflight: number
  }
  kinds: {
    git: { scheduled: number; completed: number; failed: number; latency: GitRuntimeLatencySummary }
    cwd: { scheduled: number; completed: number; failed: number; latency: GitRuntimeLatencySummary }
    misc: { scheduled: number; completed: number; failed: number; latency: GitRuntimeLatencySummary }
  }
  latencies: {
    titleRefresh: GitRuntimeLatencySummary
    cwdProbe: GitRuntimeLatencySummary
  }
  updatedAt: number
}

export interface DebugAPI {
  enabled: boolean
  profile: boolean
  profileCwd: string | null
  autotest: boolean
  autotestCwd: string | null
  autotestSuite: string | null
  autotestExit: boolean
  log: (message: string, data?: unknown) => void
  focusWindow: () => Promise<boolean>
  getAppMetrics: () => Promise<Record<string, unknown>[]>
  getGitRuntimeMetrics: () => Promise<GitRuntimeMetrics>
  quit: () => Promise<void>
}

export interface BrowserNavState {
  canGoBack: boolean
  canGoForward: boolean
  url: string
  title: string
  isLoading: boolean
}

export interface BrowserAPI {
  create: (id: string, url?: string) => Promise<{ success: boolean; id: string; error?: string }>
  destroy: (id: string) => Promise<boolean>
  navigate: (id: string, url: string) => Promise<boolean>
  goBack: (id: string) => Promise<boolean>
  goForward: (id: string) => Promise<boolean>
  reload: (id: string) => Promise<boolean>
  stop: (id: string) => Promise<boolean>
  setBounds: (id: string, rect: { x: number; y: number; width: number; height: number }) => Promise<boolean>
  show: (id: string) => Promise<boolean>
  hide: (id: string) => Promise<boolean>
  getNavState: (id: string) => Promise<BrowserNavState | null>
  clearCookies: (maxAge?: number) => Promise<{ removed: number }>
  onUrlChanged: (callback: (id: string, url: string) => void) => () => void
  onTitleChanged: (callback: (id: string, title: string) => void) => () => void
  onLoadingChanged: (callback: (id: string, isLoading: boolean) => void) => () => void
  onNavStateChanged: (callback: (id: string, state: { canGoBack: boolean; canGoForward: boolean }) => void) => () => void
  onFullscreenChanged: (callback: (id: string, isFullscreen: boolean) => void) => () => void
  onEscapePressed: (callback: (id: string) => void) => () => void
}

const terminalAPI: TerminalAPI = {
  create: (id: string, options?: TerminalOptions) => {
    return ipcRenderer.invoke('terminal:create', id, options)
  },

  write: (id: string, data: string) => {
    return ipcRenderer.invoke('terminal:write', id, data)
  },

  writeSplit: (id: string, content: string, suffix: string, delayMs?: number) => {
    return ipcRenderer.invoke('terminal:write-split', id, content, suffix, delayMs)
  },

  resize: (id: string, cols: number, rows: number) => {
    return ipcRenderer.invoke('terminal:resize', id, cols, rows)
  },

  setBufferFastPath: (id: string, enabled: boolean) => {
    ipcRenderer.send('terminal:set-buffer-fast-path', id, enabled)
  },

  dispose: (id: string) => {
    return ipcRenderer.invoke('terminal:dispose', id)
  },

  onData: (callback: (id: string, data: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, data: string) => {
      callback(id, data)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => {
      ipcRenderer.removeListener('terminal:data', listener)
    }
  },

  onExit: (callback: (id: string, exitCode: number, signal?: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, exitCode: number, signal?: number) => {
      callback(id, exitCode, signal)
    }
    ipcRenderer.on('terminal:exit', listener)
    return () => {
      ipcRenderer.removeListener('terminal:exit', listener)
    }
  },

  onGetBufferRequest: (callback: (requestId: string, terminalId: string, options?: TerminalBufferOptions) => void) => {
    const listener = (_: Electron.IpcRendererEvent, requestId: string, terminalId: string, options?: TerminalBufferOptions) => {
      callback(requestId, terminalId, options)
    }
    ipcRenderer.on('terminal:request-buffer', listener)
    return () => {
      ipcRenderer.removeListener('terminal:request-buffer', listener)
    }
  },

  sendBufferResponse: (requestId: string, result: TerminalBufferResult) => {
    ipcRenderer.send('terminal:buffer-response', requestId, result)
  },

  onPromptBridgeSend: (callback: (request: PromptBridgeSendRequest) => void) => {
    const listener = (_: Electron.IpcRendererEvent, request: PromptBridgeSendRequest) => {
      callback(request)
    }
    ipcRenderer.on('prompt:bridge-send', listener)
    return () => {
      ipcRenderer.removeListener('prompt:bridge-send', listener)
    }
  },

  sendPromptBridgeResponse: (requestId: string, result: PromptBridgeSendResult) => {
    ipcRenderer.send('prompt:bridge-response', requestId, result)
  }
}

const promptAPI: PromptAPI = {
  load: () => {
    return ipcRenderer.invoke('prompt:load')
  },

  save: (prompt: Prompt) => {
    return ipcRenderer.invoke('prompt:save', prompt)
  },

  delete: (id: string) => {
    return ipcRenderer.invoke('prompt:delete', id)
  }
}

const terminalConfigAPI: TerminalConfigAPI = {
  load: () => {
    return ipcRenderer.invoke('terminal-config:load')
  },

  save: (config: TerminalWindowConfig) => {
    return ipcRenderer.invoke('terminal-config:save', config)
  },

  update: (partial: Partial<TerminalWindowConfig>) => {
    return ipcRenderer.invoke('terminal-config:update', partial)
  }
}

const dialogAPI: DialogAPI = {
  openDirectory: () => {
    return ipcRenderer.invoke('dialog:openDirectory')
  },
  openTextFile: (payload?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    return ipcRenderer.invoke('dialog:openTextFile', payload)
  },
  saveTextFile: (payload: { title?: string; defaultFileName?: string; content: string }) => {
    return ipcRenderer.invoke('dialog:saveTextFile', payload)
  }
}

const shellAPI: ShellAPI = {
  openPath: (path: string) => {
    return ipcRenderer.invoke('shell:open-path', path)
  },
  openExternal: (url: string) => {
    return ipcRenderer.invoke('shell:open-external', url)
  }
}

const commandPresetAPI: CommandPresetAPI = {
  load: () => {
    return ipcRenderer.invoke('command-preset:load')
  },

  save: (preset: CommandPreset) => {
    return ipcRenderer.invoke('command-preset:save', preset)
  },

  delete: (id: string) => {
    return ipcRenderer.invoke('command-preset:delete', id)
  }
}

const appStateAPI: AppStateAPI = {
  load: () => {
    return ipcRenderer.invoke('app-state:load')
  },

  save: (state: AppState) => {
    return ipcRenderer.invoke('app-state:save', state)
  }
}

const gitAPI: GitAPI = {
  resolveRepoRoot: (cwd: string) => {
    return ipcRenderer.invoke('git:resolve-repo-root', cwd)
  },

  getDiff: (cwd: string) => {
    return ipcRenderer.invoke('git:get-diff', cwd)
  },

  getHistory: (cwd: string, options?: { limit?: number; skip?: number }) => {
    return ipcRenderer.invoke('git:get-history', cwd, options)
  },

  getHistoryDiff: (cwd: string, options: GitHistoryDiffOptions) => {
    return ipcRenderer.invoke('git:get-history-diff', cwd, options)
  },

  getFileContent: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType'>, repoRoot?: string) => {
    return ipcRenderer.invoke('git:get-file-content', cwd, file, repoRoot)
  },

  saveFileContent: (cwd: string, filename: string, content: string) => {
    return ipcRenderer.invoke('git:save-file-content', cwd, filename, content)
  },

  stageFile: (cwd: string, filename: string, repoRoot?: string) => {
    return ipcRenderer.invoke('git:stage-file', cwd, filename, repoRoot)
  },

  unstageFile: (cwd: string, filename: string, repoRoot?: string) => {
    return ipcRenderer.invoke('git:unstage-file', cwd, filename, repoRoot)
  },

  discardFile: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status'>, repoRoot?: string) => {
    return ipcRenderer.invoke('git:discard-file', cwd, file, repoRoot)
  },

  getSubmodules: (cwd: string) => {
    return ipcRenderer.invoke('git:get-submodules', cwd)
  },

  updateIndexContent: (cwd: string, filename: string, content: string) => {
    return ipcRenderer.invoke('git:update-index-content', cwd, filename, content)
  },

  checkInstalled: () => {
    return ipcRenderer.invoke('git:check-installed')
  },

  getTerminalCwd: (terminalId: string) => {
    return ipcRenderer.invoke('git:get-terminal-cwd', terminalId)
  },

  getTerminalInfo: (terminalId: string) => {
    return ipcRenderer.invoke('git:get-terminal-info', terminalId)
  },

  subscribeTerminalInfo: (terminalId: string) => {
    return ipcRenderer.invoke('git:subscribe-terminal-info', terminalId)
  },

  unsubscribeTerminalInfo: (terminalId: string) => {
    return ipcRenderer.invoke('git:unsubscribe-terminal-info', terminalId)
  },

  notifyTerminalActivity: (terminalId: string) => {
    return ipcRenderer.invoke('git:notify-terminal-activity', terminalId)
  },

  notifyTerminalFocus: (terminalId: string) => {
    return ipcRenderer.invoke('git:notify-terminal-focus', terminalId)
  },

  notifyTerminalGitUpdate: (terminalId: string) => {
    return ipcRenderer.invoke('git:notify-terminal-git-update', terminalId)
  },

  onTerminalInfo: (callback: (terminalId: string, info: TerminalGitInfo) => void) => {
    const listener = (_: Electron.IpcRendererEvent, terminalId: string, info: TerminalGitInfo) => {
      callback(terminalId, info)
    }
    ipcRenderer.on('git:terminal-info', listener)
    return () => {
      ipcRenderer.removeListener('git:terminal-info', listener)
    }
  }
}

const projectAPI: ProjectAPI = {
  listDirectory: (root: string, path: string) => {
    return ipcRenderer.invoke('project:list-directory', root, path)
  },

  readFile: (root: string, path: string) => {
    return ipcRenderer.invoke('project:read-file', root, path)
  },

  saveFile: (root: string, path: string, content: string) => {
    return ipcRenderer.invoke('project:save-file', root, path, content)
  },

  createFile: (root: string, path: string, content?: string) => {
    return ipcRenderer.invoke('project:create-file', root, path, content ?? '')
  },

  createFolder: (root: string, path: string) => {
    return ipcRenderer.invoke('project:create-folder', root, path)
  },

  renamePath: (root: string, oldPath: string, newPath: string) => {
    return ipcRenderer.invoke('project:rename-path', root, oldPath, newPath)
  },

  deletePath: (root: string, path: string) => {
    return ipcRenderer.invoke('project:delete-path', root, path)
  },

  sqliteGetSchema: (root: string, path: string) => {
    return ipcRenderer.invoke('project:sqlite-get-schema', root, path)
  },

  sqliteReadTableRows: (root: string, path: string, table: string, limit?: number, offset?: number) => {
    return ipcRenderer.invoke('project:sqlite-read-table-rows', root, path, table, limit, offset)
  },

  sqliteInsertRow: (root: string, path: string, table: string, values: Record<string, unknown>) => {
    return ipcRenderer.invoke('project:sqlite-insert-row', root, path, table, values)
  },

  sqliteUpdateRow: (root: string, path: string, table: string, key: SqliteRowKey, values: Record<string, unknown>) => {
    return ipcRenderer.invoke('project:sqlite-update-row', root, path, table, key, values)
  },

  sqliteDeleteRow: (root: string, path: string, table: string, key: SqliteRowKey) => {
    return ipcRenderer.invoke('project:sqlite-delete-row', root, path, table, key)
  },

  sqliteExecute: (root: string, path: string, sql: string) => {
    return ipcRenderer.invoke('project:sqlite-execute', root, path, sql)
  },

  searchStart: (options: ProjectSearchOptions) => {
    return ipcRenderer.invoke('project:search-start', options)
  },

  searchCancel: () => {
    return ipcRenderer.invoke('project:search-cancel')
  },

  onSearchResult: (callback: (searchId: string, matches: ProjectSearchMatch[]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, searchId: string, matches: ProjectSearchMatch[]) => {
      callback(searchId, matches)
    }
    ipcRenderer.on('project:search-result', listener)
    return () => {
      ipcRenderer.removeListener('project:search-result', listener)
    }
  },

  onSearchDone: (callback: (stats: ProjectSearchStats) => void) => {
    const listener = (_: Electron.IpcRendererEvent, stats: ProjectSearchStats) => {
      callback(stats)
    }
    ipcRenderer.on('project:search-done', listener)
    return () => {
      ipcRenderer.removeListener('project:search-done', listener)
    }
  },

  watchFile: (root: string, path: string) => {
    return ipcRenderer.invoke('project:watch-file', root, path)
  },

  unwatchFile: (root: string, path: string) => {
    return ipcRenderer.invoke('project:unwatch-file', root, path)
  },

  onFileChanged: (callback: (fullPath: string, changeType: 'changed' | 'deleted', content?: string) => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      fullPath: string,
      changeType: 'changed' | 'deleted',
      content?: string
    ) => {
      callback(fullPath, changeType, content)
    }
    ipcRenderer.on('project:file-changed', listener)
    return () => {
      ipcRenderer.removeListener('project:file-changed', listener)
    }
  }
}

const settingsAPI: SettingsAPI = {
  load: () => {
    return ipcRenderer.invoke('settings:load')
  },

  save: (settings: SettingsState) => {
    return ipcRenderer.invoke('settings:save', settings)
  },

  update: (partial: Partial<SettingsState>) => {
    return ipcRenderer.invoke('settings:update', partial)
  },

  registerShortcuts: () => {
    return ipcRenderer.invoke('settings:register-shortcuts')
  },

  checkShortcutAvailable: (accelerator: string) => {
    return ipcRenderer.invoke('settings:check-shortcut-available', accelerator)
  },

  checkShortcutConflict: (accelerator: string, excludeKey?: string) => {
    return ipcRenderer.invoke('settings:check-shortcut-conflict', accelerator, excludeKey)
  },

  onShortcutTriggered: (callback: (action: ShortcutAction) => void) => {
    const listener = (_: Electron.IpcRendererEvent, action: ShortcutAction) => {
      callback(action)
    }
    ipcRenderer.on('shortcut:triggered', listener)
    return () => {
      ipcRenderer.removeListener('shortcut:triggered', listener)
    }
  },

  onWindowShortcutTriggered: (callback: (action: ShortcutAction) => void) => {
    const listener = (_: Electron.IpcRendererEvent, action: ShortcutAction) => {
      callback(action)
    }
    ipcRenderer.on('shortcut:window-triggered', listener)
    return () => {
      ipcRenderer.removeListener('shortcut:window-triggered', listener)
    }
  },

  onActivated: (callback: () => void) => {
    const listener = () => {
      callback()
    }
    ipcRenderer.on('shortcut:activated', listener)
    return () => {
      ipcRenderer.removeListener('shortcut:activated', listener)
    }
  }
}

const appInfoAPI: AppInfoAPI = {
  get: () => {
    return ipcRenderer.invoke('app:get-info')
  },
  readNotice: () => {
    return ipcRenderer.invoke('app:read-notice')
  }
}

const debugEnabled = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
const debugProfileEnabled = process.env.ONWARD_PROFILE === '1'
const debugProfileCwd = process.env.ONWARD_PROFILE_CWD || null
const debugAutotestEnabled = process.env.ONWARD_AUTOTEST === '1'
const debugAutotestCwd = process.env.ONWARD_AUTOTEST_CWD || null
const debugAutotestSuite = process.env.ONWARD_AUTOTEST_SUITE || null
const debugAutotestExit = process.env.ONWARD_AUTOTEST_EXIT === '1'

const debugAPI: DebugAPI = {
  enabled: debugEnabled,
  profile: debugProfileEnabled,
  profileCwd: debugProfileCwd,
  autotest: debugAutotestEnabled,
  autotestCwd: debugAutotestCwd,
  autotestSuite: debugAutotestSuite,
  autotestExit: debugAutotestExit,
  log: (message: string, data?: unknown) => {
    if (!debugEnabled) return
    ipcRenderer.send('debug:log', { message, data })
  },
  focusWindow: () => {
    return ipcRenderer.invoke('debug:focus-window')
  },
  getAppMetrics: () => {
    return ipcRenderer.invoke('debug:get-app-metrics')
  },
  getGitRuntimeMetrics: () => {
    return ipcRenderer.invoke('debug:get-git-runtime-metrics')
  },
  quit: () => {
    return ipcRenderer.invoke('debug:quit')
  }
}

const browserAPI: BrowserAPI = {
  create: (id: string, url?: string) => {
    return ipcRenderer.invoke('browser:create', id, url)
  },
  destroy: (id: string) => {
    return ipcRenderer.invoke('browser:destroy', id)
  },
  navigate: (id: string, url: string) => {
    return ipcRenderer.invoke('browser:navigate', id, url)
  },
  goBack: (id: string) => {
    return ipcRenderer.invoke('browser:go-back', id)
  },
  goForward: (id: string) => {
    return ipcRenderer.invoke('browser:go-forward', id)
  },
  reload: (id: string) => {
    return ipcRenderer.invoke('browser:reload', id)
  },
  stop: (id: string) => {
    return ipcRenderer.invoke('browser:stop', id)
  },
  setBounds: (id: string, rect: { x: number; y: number; width: number; height: number }) => {
    return ipcRenderer.invoke('browser:set-bounds', id, rect)
  },
  show: (id: string) => {
    return ipcRenderer.invoke('browser:show', id)
  },
  hide: (id: string) => {
    return ipcRenderer.invoke('browser:hide', id)
  },
  getNavState: (id: string) => {
    return ipcRenderer.invoke('browser:get-nav-state', id)
  },
  clearCookies: (maxAge?: number) => {
    return ipcRenderer.invoke('browser:clear-cookies', maxAge)
  },
  onUrlChanged: (callback: (id: string, url: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, url: string) => {
      callback(id, url)
    }
    ipcRenderer.on('browser:url-changed', listener)
    return () => {
      ipcRenderer.removeListener('browser:url-changed', listener)
    }
  },
  onTitleChanged: (callback: (id: string, title: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, title: string) => {
      callback(id, title)
    }
    ipcRenderer.on('browser:title-changed', listener)
    return () => {
      ipcRenderer.removeListener('browser:title-changed', listener)
    }
  },
  onLoadingChanged: (callback: (id: string, isLoading: boolean) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, isLoading: boolean) => {
      callback(id, isLoading)
    }
    ipcRenderer.on('browser:loading-changed', listener)
    return () => {
      ipcRenderer.removeListener('browser:loading-changed', listener)
    }
  },
  onNavStateChanged: (callback: (id: string, state: { canGoBack: boolean; canGoForward: boolean }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, state: { canGoBack: boolean; canGoForward: boolean }) => {
      callback(id, state)
    }
    ipcRenderer.on('browser:nav-state-changed', listener)
    return () => {
      ipcRenderer.removeListener('browser:nav-state-changed', listener)
    }
  },
  onFullscreenChanged: (callback: (id: string, isFullscreen: boolean) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, isFullscreen: boolean) => {
      callback(id, isFullscreen)
    }
    ipcRenderer.on('browser:fullscreen-changed', listener)
    return () => {
      ipcRenderer.removeListener('browser:fullscreen-changed', listener)
    }
  },
  onEscapePressed: (callback: (id: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string) => {
      callback(id)
    }
    ipcRenderer.on('browser:escape-pressed', listener)
    return () => {
      ipcRenderer.removeListener('browser:escape-pressed', listener)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  terminal: terminalAPI,
  prompt: promptAPI,
  terminalConfig: terminalConfigAPI,
  dialog: dialogAPI,
  shell: shellAPI,
  commandPreset: commandPresetAPI,
  appState: appStateAPI,
  git: gitAPI,
  project: projectAPI,
  settings: settingsAPI,
  appInfo: appInfoAPI,
  browser: browserAPI,
  debug: debugAPI,
  platform: process.platform as 'darwin' | 'win32' | 'linux'
})
