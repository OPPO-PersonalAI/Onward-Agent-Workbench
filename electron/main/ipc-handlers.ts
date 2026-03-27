/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { ptyManager, PtyOptions } from './pty-manager'
import { GitWatchManager } from './git-watch-manager'
import { getPromptStorage, Prompt } from './prompt-storage'
import { getTerminalConfigStorage, TerminalWindowConfig } from './terminal-config-storage'
import { getCommandPresetStorage, CommandPreset } from './command-preset-storage'
import { getAppStateStorage, AppState } from './app-state-storage'
import {
  checkGitInstalled,
  getGitDiff,
  getGitHistory,
  getGitHistoryDiff,
  getGitFileContent,
  getGitRepoMeta,
  getTerminalCwd,
  getTerminalGitInfo,
  resolveRepoRoot,
  saveGitFileContent,
  stageGitFile,
  unstageGitFile,
  discardGitFile,
  detectSubmodulesRecursive,
  updateGitIndexContent,
  GitFileStatus,
  GitHistoryDiffOptions
} from './git-utils'
import {
  listDirectory,
  readProjectFile,
  saveProjectFile,
  createProjectFile,
  createProjectFolder,
  renameProjectPath,
  deleteProjectPath,
  getProjectSqliteSchema,
  readProjectSqliteTableRows,
  insertProjectSqliteRow,
  updateProjectSqliteRow,
  deleteProjectSqliteRow,
  executeProjectSqlite
} from './project-editor-utils'
import { getSettingsStorage, SettingsState, ShortcutConfig } from './settings-storage'
import { getShortcutManager } from './shortcut-manager'
import { getAppInfo } from './app-info'
import { gitRuntimeManager } from './git-runtime-manager'
import { openExternalUrlWithConfirm } from './external-link-guard'
import { RipgrepSearchManager } from './ripgrep-search'

let gitWatchManager: GitWatchManager | null = null
let ripgrepSearchManager: RipgrepSearchManager | null = null

/**
 * Batches PTY output data into periodic flushes to reduce IPC message rate.
 * Instead of sending one IPC message per onData callback (which can be
 * 400-1000/s across 4 terminals), data is buffered and flushed at ~60fps.
 */
class TerminalDataBuffer {
  private chunks: string[] = []
  private totalBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  // IPC flush interval.  The previous value of 16 ms (~60 fps) sent up to
  // 360 IPC messages/s across 6 terminals, saturating the renderer's main
  // thread with callback processing alone.  100 ms (~10 fps per terminal)
  // reduces IPC traffic to ~60 msgs/s while the renderer-side throttle
  // (50 ms rAF) still provides smooth visual updates by coalescing writes.
  // Terminal text remains highly responsive — 100 ms of buffering is
  // imperceptible for human reading of scrolling output.
  private static readonly FLUSH_INTERVAL_MS = 100
  // Force flush when buffer exceeds 64KB (keeps large bursts responsive)
  private static readonly FORCE_FLUSH_BYTES = 64 * 1024

  constructor(
    private readonly terminalId: string,
    private readonly send: (id: string, data: string) => void
  ) {}

  push(data: string): void {
    if (this.disposed) return
    this.chunks.push(data)
    this.totalBytes += data.length

    if (this.totalBytes >= TerminalDataBuffer.FORCE_FLUSH_BYTES) {
      this.flush()
      return
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, TerminalDataBuffer.FLUSH_INTERVAL_MS)
    }
  }

  flush(): void {
    if (this.chunks.length === 0) return
    const merged = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('')
    this.chunks = []
    this.totalBytes = 0
    this.send(this.terminalId, merged)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Flush remaining data before disposal
    this.flush()
  }
}

// Active data buffers keyed by terminal ID
const terminalDataBuffers = new Map<string, TerminalDataBuffer>()

// Buffer request waiting queue
interface TerminalBufferResult {
  success: boolean
  terminalId: string
  content?: string
  totalLines?: number
  returnedLines?: number
  returnedChars?: number
  truncated?: boolean
  capturedAt?: number
  bufferType?: 'normal' | 'alternate'
  error?: string
}

const bufferRequestCallbacks = new Map<string, {
  resolve: (result: TerminalBufferResult) => void
  timer: ReturnType<typeof setTimeout>
}>()

let bufferRequestCounter = 0

// Prompt Bridge request waiting queue
const promptBridgeCallbacks = new Map<string, {
  resolve: (result: PromptBridgeSendResult) => void
  timer: ReturnType<typeof setTimeout>
}>()

let promptBridgeCounter = 0

interface RegisterIpcHandlersOptions {
  onSettingsChanged?: (settings: SettingsState) => void
}

/**
 * Get terminal buffer contents from the renderer process.
 * Requests xterm.js buffer data through IPC.
 */
export function getTerminalBuffer(
  mainWindow: BrowserWindow,
  terminalId: string,
  options?: { mode?: string; lastLines?: number; lastChars?: number; trimTrailingEmpty?: boolean; buffer?: string }
): Promise<TerminalBufferResult> {
  return new Promise((resolve) => {
    if (mainWindow.isDestroyed()) {
      resolve({ success: false, terminalId, error: 'Window was destroyed' })
      return
    }

    const requestId = `buf-${++bufferRequestCounter}-${Date.now()}`

    const timer = setTimeout(() => {
      bufferRequestCallbacks.delete(requestId)
      resolve({ success: false, terminalId, error: 'Request timed out (5 seconds)' })
    }, 5000)

    bufferRequestCallbacks.set(requestId, { resolve, timer })

    mainWindow.webContents.send('terminal:request-buffer', requestId, terminalId, options)
  })
}

export type PromptBridgeAction = 'send' | 'execute' | 'send-and-execute'

export interface PromptBridgeSendResult {
  success: boolean
  successIds: string[]
  failedIds: string[]
  error?: string
}

/**
 * Send commands to the rendering process via Prompt Bridge
 * The rendering process calls the existing Prompt sending logic (including split-write and history records)
 */
export function sendPromptViaBridge(
  mainWindow: BrowserWindow,
  terminalId: string,
  content: string,
  action: PromptBridgeAction
): Promise<PromptBridgeSendResult> {
  return new Promise((resolve) => {
    if (mainWindow.isDestroyed()) {
      resolve({ success: false, successIds: [], failedIds: [terminalId], error: 'Window was destroyed' })
      return
    }

    const requestId = `prompt-bridge-${++promptBridgeCounter}-${Date.now()}`

    // 10 second timeout (send-and-execute includes 50ms delay)
    const timer = setTimeout(() => {
      promptBridgeCallbacks.delete(requestId)
      resolve({ success: false, successIds: [], failedIds: [terminalId], error: 'Request timed out (10 seconds)' })
    }, 10000)

    promptBridgeCallbacks.set(requestId, { resolve, timer })

    mainWindow.webContents.send('prompt:bridge-send', {
      requestId,
      terminalId,
      content,
      action
    })
  })
}

export function registerIpcHandlers(mainWindow: BrowserWindow, options: RegisterIpcHandlersOptions = {}): void {
  const shouldLog = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
  const log = (...args: unknown[]) => {
    if (shouldLog) {
      console.log(...args)
    }
  }

  // --- Diagnostic counters (ONWARD_DEBUG=1) ---
  const ipcDataCounters = new Map<string, { messages: number; bytes: number }>()
  let diagTimer: ReturnType<typeof setInterval> | null = null
  if (shouldLog) {
    diagTimer = setInterval(() => {
      for (const [tid, c] of ipcDataCounters) {
        if (c.messages > 0) {
          console.log(`[PerfDiag] terminal:data tid=${tid} ipc/s=${c.messages} bytes/s=${c.bytes}`)
          c.messages = 0
          c.bytes = 0
        }
      }
    }, 1000)
  }

  gitWatchManager = new GitWatchManager((terminalId, info) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('git:terminal-info', terminalId, info)
  })

  ipcMain.on('debug:log', (_event, payload: { message?: string; data?: unknown }) => {
    log('[RendererDebug]', payload?.message ?? '', payload?.data ?? '')
  })

  // Listen to buffer responses returned by the renderer process
  ipcMain.on('terminal:buffer-response', (_event, requestId: string, result: TerminalBufferResult) => {
    const pending = bufferRequestCallbacks.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      bufferRequestCallbacks.delete(requestId)
      pending.resolve(result)
    }
  })

  // Listen to Prompt Bridge responses returned by the renderer process
  ipcMain.on('prompt:bridge-response', (_event, requestId: string, result: PromptBridgeSendResult) => {
    const pending = promptBridgeCallbacks.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      promptBridgeCallbacks.delete(requestId)
      pending.resolve(result)
    }
  })
  ipcMain.handle('debug:get-app-metrics', () => {
    return app.getAppMetrics()
  })
  ipcMain.handle('debug:focus-window', () => {
    if (mainWindow.isDestroyed()) return false

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()

    if (process.platform === 'darwin') {
      app.dock?.show()
      app.focus({ steal: true })
    }

    return mainWindow.isFocused()
  })
  ipcMain.handle('debug:get-git-runtime-metrics', () => {
    return gitRuntimeManager.getMetrics()
  })
  ipcMain.handle('debug:quit', () => {
    app.exit(0)
  })

  const createTerminalProcess = (id: string, options?: PtyOptions) => {
    try {
      const ptyProcess = ptyManager.create(id, options)

      // IPC data buffer: merge high-frequency PTY output into batched sends
      const dataBuffer = new TerminalDataBuffer(id, (tid, mergedData) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:data', tid, mergedData)
        }
        // Diagnostic counter
        if (shouldLog) {
          let c = ipcDataCounters.get(tid)
          if (!c) { c = { messages: 0, bytes: 0 }; ipcDataCounters.set(tid, c) }
          c.messages += 1
          c.bytes += mergedData.length
        }
      })
      terminalDataBuffers.set(id, dataBuffer)

      // Throttle git activity notifications from PTY output (500ms)
      let lastGitActivityAt = 0
      const GIT_ACTIVITY_THROTTLE_MS = 500

      const dataDisposable = ptyProcess.onData((data) => {
        // Parse OSC 9;9 CWD reports from shell integration (Windows)
        ptyManager.detectCwd(id, data)
        dataBuffer.push(data)

        // Notify git watch on PTY output (throttled) instead of on every keystroke
        const now = Date.now()
        if (now - lastGitActivityAt >= GIT_ACTIVITY_THROTTLE_MS) {
          lastGitActivityAt = now
          gitWatchManager?.notifyTerminalActivity(id)
        }
      })

      const exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:exit', id, exitCode, signal)
        }
      })

      ptyManager.registerListeners(id, [dataDisposable, exitDisposable])

      return { success: true, id }
    } catch (error) {
      console.error('Failed to create terminal:', error)
      return { success: false, error: String(error) }
    }
  }
  // App info
  ipcMain.handle('app:get-info', () => {
    return getAppInfo()
  })

  // Read NOTICE / ThirdPartyNotices file for open-source license display
  ipcMain.handle('app:read-notice', () => {
    const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath()
    // Prefer auto-generated ThirdPartyNotices.txt, fall back to NOTICE.txt
    for (const filename of ['ThirdPartyNotices.txt', 'NOTICE.txt']) {
      try {
        return readFileSync(join(basePath, filename), 'utf-8')
      } catch {
        // Try next candidate
      }
    }
    return null
  })

  // Create a new terminal
  ipcMain.handle('terminal:create', (_, id: string, options?: PtyOptions) => {
    return createTerminalProcess(id, options)
  })

  // Write data to terminal
  ipcMain.handle('terminal:write', (_, id: string, data: string) => {
    // Git activity notification moved to ptyProcess.onData with 500ms throttle
    // (user keystrokes don't change git state; PTY output means command execution)
    return ptyManager.write(id, data)
  })

  // Resize terminal
  ipcMain.handle('terminal:resize', (_, id: string, cols: number, rows: number) => {
    return ptyManager.resize(id, cols, rows)
  })

  // Dispose terminal
  ipcMain.handle('terminal:dispose', (_, id: string) => {
    // Flush and dispose the data buffer
    const buf = terminalDataBuffers.get(id)
    if (buf) {
      buf.dispose()
      terminalDataBuffers.delete(id)
    }
    ipcDataCounters.delete(id)
    gitWatchManager?.unsubscribe(id)
    return ptyManager.dispose(id)
  })

  // Prompt storage handlers
  const promptStorage = getPromptStorage()

  // Load all prompts
  ipcMain.handle('prompt:load', () => {
    return promptStorage.getAll()
  })

  // Save a prompt
  ipcMain.handle('prompt:save', (_, prompt: Prompt) => {
    return promptStorage.save(prompt)
  })

  // Delete a prompt
  ipcMain.handle('prompt:delete', (_, id: string) => {
    return promptStorage.delete(id)
  })

  // Terminal config storage handlers
  const terminalConfigStorage = getTerminalConfigStorage()

  // Load terminal config
  ipcMain.handle('terminal-config:load', () => {
    return terminalConfigStorage.get()
  })

  // Save terminal config
  ipcMain.handle('terminal-config:save', (_, config: TerminalWindowConfig) => {
    return terminalConfigStorage.save(config)
  })

  // Update terminal config (partial)
  ipcMain.handle('terminal-config:update', (_, partial: Partial<TerminalWindowConfig>) => {
    return terminalConfigStorage.update(partial)
  })

  // Dialog handlers
  ipcMain.handle('dialog:openDirectory', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      return { success: true, path: result.filePaths[0] }
    } catch (error) {
      console.error('Failed to open directory dialog:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('dialog:openTextFile', async (_, payload?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: payload?.title || 'Open file',
        properties: ['openFile'],
        filters: payload?.filters?.length
          ? payload.filters
          : [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt', 'md'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const path = result.filePaths[0]
      const content = readFileSync(path, 'utf-8')
      return { success: true, path, content }
    } catch (error) {
      console.error('Failed to open text file:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('dialog:saveTextFile', async (_, payload: { title?: string; defaultFileName?: string; content: string }) => {
    try {
      if (!payload || typeof payload.content !== 'string') {
        return { success: false, error: 'Invalid export content' }
      }

      const result = await dialog.showSaveDialog(mainWindow, {
        title: payload.title || 'Export file',
        defaultPath: payload.defaultFileName || 'onward-export.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true }
      }

      writeFileSync(result.filePath, payload.content, 'utf-8')
      return { success: true, path: result.filePath }
    } catch (error) {
      console.error('Failed to save text file:', error)
      return { success: false, error: String(error) }
    }
  })

  // Shell handlers
  ipcMain.handle('shell:open-path', async (_, targetPath: string) => {
    try {
      const result = await shell.openPath(targetPath)
      if (result) {
        return { success: false, error: result }
      }
      return { success: true }
    } catch (error) {
      console.error('Failed to open path:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('shell:open-external', async (_, url: string) => {
    const result = await openExternalUrlWithConfirm(mainWindow, url)
    if (!result.success && result.error && !result.canceled && !result.blocked) {
      console.error('Failed to open external url:', result.error)
    }
    return result
  })

  // Command preset storage handlers
  const commandPresetStorage = getCommandPresetStorage()

  // Load all command presets
  ipcMain.handle('command-preset:load', () => {
    return commandPresetStorage.getAll()
  })

  // Save a command preset
  ipcMain.handle('command-preset:save', (_, preset: CommandPreset) => {
    return commandPresetStorage.save(preset)
  })

  // Delete a command preset
  ipcMain.handle('command-preset:delete', (_, id: string) => {
    return commandPresetStorage.delete(id)
  })

  // App state storage handlers
  const appStateStorage = getAppStateStorage()

  // Load app state
  ipcMain.handle('app-state:load', () => {
    log('[IPC] app-state:load')
    return appStateStorage.get()
  })

  // Save app state
  ipcMain.handle('app-state:save', (_, state: AppState) => {
    return appStateStorage.save(state)
  })

  // Git handlers
  // Check if Git is installed
  ipcMain.handle('git:check-installed', async () => {
    return await checkGitInstalled()
  })

  // Resolve git repo root for a given path
  ipcMain.handle('git:resolve-repo-root', async (_, cwd: string) => {
    return await resolveRepoRoot(cwd)
  })

  // Get Git diff for a directory
  ipcMain.handle('git:get-diff', async (_, cwd: string) => {
    return await getGitDiff(cwd)
  })

  // Get Git history list
  ipcMain.handle('git:get-history', async (_, cwd: string, options?: { limit?: number; skip?: number }) => {
    return await getGitHistory(cwd, options?.limit, options?.skip)
  })

  // Get Git history diff (range + file)
  ipcMain.handle('git:get-history-diff', async (_, cwd: string, options: GitHistoryDiffOptions) => {
    return await getGitHistoryDiff(cwd, options)
  })

  // Get Git file content for diff view
  ipcMain.handle('git:get-file-content', async (_, cwd: string, file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType'>, repoRoot?: string) => {
    return await getGitFileContent(cwd, file, repoRoot)
  })

  // Save file content to workspace
  ipcMain.handle('git:save-file-content', async (_, cwd: string, filename: string, content: string) => {
    return await saveGitFileContent(cwd, filename, content)
  })

  ipcMain.handle('git:stage-file', async (_, cwd: string, filename: string, repoRoot?: string) => {
    return await stageGitFile(cwd, filename, repoRoot)
  })

  ipcMain.handle('git:unstage-file', async (_, cwd: string, filename: string, repoRoot?: string) => {
    return await unstageGitFile(cwd, filename, repoRoot)
  })

  ipcMain.handle('git:discard-file', async (_, cwd: string, file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status'>, repoRoot?: string) => {
    return await discardGitFile(cwd, file, repoRoot)
  })

  ipcMain.handle('git:get-submodules', async (_, cwd: string) => {
    const meta = await getGitRepoMeta(cwd)
    if (!meta.isRepo || !meta.repoRoot || !meta.gitExecutable) return []
    return await detectSubmodulesRecursive(meta.repoRoot, meta.gitExecutable)
  })

  ipcMain.handle('git:update-index-content', async (_, cwd: string, filename: string, content: string) => {
    return await updateGitIndexContent(cwd, filename, content)
  })

  // Get terminal's current working directory
  ipcMain.handle('git:get-terminal-cwd', async (_, terminalId: string) => {
    return await getTerminalCwd(terminalId)
  })

  // Get terminal's cwd + git branch
  ipcMain.handle('git:get-terminal-info', async (_, terminalId: string) => {
    return await getTerminalGitInfo(terminalId)
  })
  ipcMain.handle('git:subscribe-terminal-info', async (_event, terminalId: string) => {
    await gitWatchManager?.subscribe(terminalId)
    return { success: true }
  })
  ipcMain.handle('git:unsubscribe-terminal-info', async (_event, terminalId: string) => {
    gitWatchManager?.unsubscribe(terminalId)
    return { success: true }
  })
  ipcMain.handle('git:notify-terminal-activity', async (_event, terminalId: string) => {
    gitWatchManager?.notifyTerminalActivity(terminalId)
    return { success: true }
  })
  ipcMain.handle('git:notify-terminal-focus', async (_event, terminalId: string) => {
    gitWatchManager?.notifyTerminalFocus(terminalId)
    return { success: true }
  })
  ipcMain.handle('git:notify-terminal-git-update', async (_event, terminalId: string) => {
    gitWatchManager?.notifyTerminalGitUpdate(terminalId)
    return { success: true }
  })

  // Project editor handlers
  ipcMain.handle('project:list-directory', async (_, root: string, path: string) => {
    return await listDirectory(root, path)
  })

  ipcMain.handle('project:read-file', async (_, root: string, path: string) => {
    return await readProjectFile(root, path)
  })

  ipcMain.handle('project:save-file', async (_, root: string, path: string, content: string) => {
    return await saveProjectFile(root, path, content)
  })

  ipcMain.handle('project:create-file', async (_, root: string, path: string, content: string) => {
    return await createProjectFile(root, path, content)
  })

  ipcMain.handle('project:create-folder', async (_, root: string, path: string) => {
    return await createProjectFolder(root, path)
  })

  ipcMain.handle('project:rename-path', async (_, root: string, oldPath: string, newPath: string) => {
    return await renameProjectPath(root, oldPath, newPath)
  })

  ipcMain.handle('project:delete-path', async (_, root: string, path: string) => {
    return await deleteProjectPath(root, path)
  })

  ipcMain.handle('project:sqlite-get-schema', async (_, root: string, path: string) => {
    return await getProjectSqliteSchema(root, path)
  })

  ipcMain.handle(
    'project:sqlite-read-table-rows',
    async (_, root: string, path: string, table: string, limit?: number, offset?: number) => {
      return await readProjectSqliteTableRows(root, path, table, limit, offset)
    }
  )

  ipcMain.handle(
    'project:sqlite-insert-row',
    async (_, root: string, path: string, table: string, values: Record<string, unknown>) => {
      return await insertProjectSqliteRow(root, path, table, values)
    }
  )

  ipcMain.handle(
    'project:sqlite-update-row',
    async (_, root: string, path: string, table: string, key: unknown, values: Record<string, unknown>) => {
      return await updateProjectSqliteRow(root, path, table, key, values)
    }
  )

  ipcMain.handle('project:sqlite-delete-row', async (_, root: string, path: string, table: string, key: unknown) => {
    return await deleteProjectSqliteRow(root, path, table, key)
  })

  ipcMain.handle('project:sqlite-execute', async (_, root: string, path: string, sql: string) => {
    return await executeProjectSqlite(root, path, sql)
  })

  ripgrepSearchManager = new RipgrepSearchManager()

  ipcMain.handle('project:search-start', async (_, options: {
    rootPath: string
    query: string
    isRegex: boolean
    isCaseSensitive: boolean
    isWholeWord: boolean
    includeGlob?: string
    excludeGlob?: string
    maxResults?: number
  }) => {
    const searchId = ripgrepSearchManager!.start(mainWindow, options)
    return { searchId }
  })

  ipcMain.handle('project:search-cancel', async () => {
    ripgrepSearchManager?.cancel()
    return { success: true }
  })

  // Settings storage handlers
  const settingsStorage = getSettingsStorage()
  const shortcutManager = getShortcutManager()

  // Set main window for shortcut manager
  shortcutManager.setMainWindow(mainWindow)

  // Load settings
  ipcMain.handle('settings:load', () => {
    return settingsStorage.get()
  })

  // Save settings
  ipcMain.handle('settings:save', (_, settings: SettingsState) => {
    const success = settingsStorage.save(settings)
    if (success) {
      // Re-register shortcuts when settings change
      shortcutManager.registerFromSettings()
      options.onSettingsChanged?.(settingsStorage.get())
    }
    return success
  })

  // Update settings (partial)
  ipcMain.handle('settings:update', (_, partial: Partial<SettingsState>) => {
    const success = settingsStorage.update(partial)
    if (success) {
      // Re-register shortcuts when settings change
      shortcutManager.registerFromSettings()
      options.onSettingsChanged?.(settingsStorage.get())
    }
    return success
  })

  // Register shortcuts from current settings
  ipcMain.handle('settings:register-shortcuts', () => {
    return shortcutManager.registerFromSettings()
  })

  // Check if a shortcut is available
  ipcMain.handle('settings:check-shortcut-available', (_, accelerator: string) => {
    return shortcutManager.isShortcutAvailable(accelerator)
  })

  // Check if a shortcut conflicts with existing settings
  ipcMain.handle('settings:check-shortcut-conflict', (_, accelerator: string, excludeKey?: string) => {
    return shortcutManager.checkConflict(accelerator, excludeKey as keyof ShortcutConfig)
  })

  // Initialize shortcuts on app start
  shortcutManager.registerFromSettings()
}

/**
 * Set window-level shortcut handling
 * Use before-input-event to intercept keyboard events before Chromium handles them
 */
export function setupWindowShortcuts(mainWindow: BrowserWindow): void {
  const settingsStorage = getSettingsStorage()

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const settings = settingsStorage.get()
    const shortcuts = settings.shortcuts

    // Build accelerator format
    const parts: string[] = []
    if (input.meta) parts.push('CommandOrControl')
    if (input.control && !input.meta) parts.push('Control')
    if (input.alt) parts.push('Alt')
    if (input.shift) parts.push('Shift')

    let key = input.key
    if (key.length === 1) key = key.toUpperCase()
    parts.push(key)

    const accelerator = parts.join('+')

    // focusTerminal 1-6
    for (let i = 1; i <= 6; i++) {
      const shortcutKey = `focusTerminal${i}` as keyof typeof shortcuts
      if (shortcuts[shortcutKey] === accelerator) {
        event.preventDefault()
        mainWindow.webContents.send('shortcut:window-triggered', { type: 'focusTerminal', index: i })
        return
      }
    }

    // switchTab 1-6
    for (let i = 1; i <= 6; i++) {
      const shortcutKey = `switchTab${i}` as keyof typeof shortcuts
      if (shortcuts[shortcutKey] === accelerator) {
        event.preventDefault()
        mainWindow.webContents.send('shortcut:window-triggered', { type: 'switchTab', index: i })
        return
      }
    }

    // focusPromptEditor
    if (shortcuts.focusPromptEditor === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'focusPromptEditor' })
      return
    }

    // addToHistory
    if (shortcuts.addToHistory === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'addToHistory' })
      return
    }

    // terminalGitDiff
    if (shortcuts.terminalGitDiff === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'terminalGitDiff' })
      return
    }

    // terminalGitHistory
    if (shortcuts.terminalGitHistory === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'terminalGitHistory' })
      return
    }

    // terminalChangeWorkDir
    if (shortcuts.terminalChangeWorkDir === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'terminalChangeWorkDir' })
      return
    }

    // terminalOpenWorkDir
    if (shortcuts.terminalOpenWorkDir === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'terminalOpenWorkDir' })
      return
    }

    // terminalProjectEditor
    if (shortcuts.terminalProjectEditor === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'terminalProjectEditor' })
      return
    }

    // viewGitDiff
    if (shortcuts.viewGitDiff === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send('shortcut:window-triggered', { type: 'viewGitDiff' })
    }
  })
}

export function cleanupIpcHandlers(): void {
  // Dispose all terminal data buffers
  for (const [, buf] of terminalDataBuffers) {
    buf.dispose()
  }
  terminalDataBuffers.clear()

  gitWatchManager?.dispose()
  gitWatchManager = null
  ripgrepSearchManager?.dispose()
  ripgrepSearchManager = null
  ipcMain.removeHandler('app:get-info')
  ipcMain.removeHandler('app:read-notice')
  ipcMain.removeHandler('terminal:create')
  ipcMain.removeHandler('terminal:write')
  ipcMain.removeHandler('terminal:resize')
  ipcMain.removeHandler('terminal:dispose')
  ipcMain.removeHandler('prompt:load')
  ipcMain.removeHandler('prompt:save')
  ipcMain.removeHandler('prompt:delete')
  ipcMain.removeHandler('terminal-config:load')
  ipcMain.removeHandler('terminal-config:save')
  ipcMain.removeHandler('terminal-config:update')
  ipcMain.removeHandler('dialog:openDirectory')
  ipcMain.removeHandler('dialog:openTextFile')
  ipcMain.removeHandler('dialog:saveTextFile')
  ipcMain.removeHandler('shell:open-path')
  ipcMain.removeHandler('shell:open-external')
  ipcMain.removeHandler('command-preset:load')
  ipcMain.removeHandler('command-preset:save')
  ipcMain.removeHandler('command-preset:delete')
  ipcMain.removeHandler('app-state:load')
  ipcMain.removeHandler('app-state:save')
  ipcMain.removeHandler('git:check-installed')
  ipcMain.removeHandler('git:resolve-repo-root')
  ipcMain.removeHandler('git:get-diff')
  ipcMain.removeHandler('git:get-history')
  ipcMain.removeHandler('git:get-history-diff')
  ipcMain.removeHandler('git:get-file-content')
  ipcMain.removeHandler('git:save-file-content')
  ipcMain.removeHandler('git:stage-file')
  ipcMain.removeHandler('git:unstage-file')
  ipcMain.removeHandler('git:discard-file')
  ipcMain.removeHandler('git:update-index-content')
  ipcMain.removeHandler('git:get-terminal-cwd')
  ipcMain.removeHandler('git:get-terminal-info')
  ipcMain.removeHandler('git:subscribe-terminal-info')
  ipcMain.removeHandler('git:unsubscribe-terminal-info')
  ipcMain.removeHandler('git:notify-terminal-activity')
  ipcMain.removeHandler('git:notify-terminal-focus')
  ipcMain.removeHandler('git:notify-terminal-git-update')
  ipcMain.removeHandler('project:list-directory')
  ipcMain.removeHandler('project:read-file')
  ipcMain.removeHandler('project:save-file')
  ipcMain.removeHandler('project:create-file')
  ipcMain.removeHandler('project:create-folder')
  ipcMain.removeHandler('project:rename-path')
  ipcMain.removeHandler('project:delete-path')
  ipcMain.removeHandler('project:search-start')
  ipcMain.removeHandler('project:search-cancel')
  ipcMain.removeHandler('settings:load')
  ipcMain.removeHandler('settings:save')
  ipcMain.removeHandler('settings:update')
  ipcMain.removeHandler('settings:register-shortcuts')
  ipcMain.removeHandler('settings:check-shortcut-available')
  ipcMain.removeHandler('settings:check-shortcut-conflict')
  ipcMain.removeHandler('debug:get-app-metrics')
  ipcMain.removeHandler('debug:focus-window')
  ipcMain.removeHandler('debug:get-git-runtime-metrics')
  ipcMain.removeHandler('debug:quit')
  ipcMain.removeAllListeners('debug:log')
  ipcMain.removeAllListeners('terminal:buffer-response')
  ipcMain.removeAllListeners('prompt:bridge-response')
  // Clear all pending buffer requests
  for (const [, pending] of bufferRequestCallbacks) {
    clearTimeout(pending.timer)
  }
  bufferRequestCallbacks.clear()
  // Clean up all pending Prompt Bridge requests
  for (const [, pending] of promptBridgeCallbacks) {
    clearTimeout(pending.timer)
  }
  promptBridgeCallbacks.clear()
  ptyManager.disposeAll()
  // Unregister all shortcuts
  getShortcutManager().unregisterAll()
}
