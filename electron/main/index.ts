/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Suppress EPIPE errors on stdout/stderr when the parent process closes the pipe
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    throw err
  })
}

// On Windows, node-pty 1.1.0 forks `conpty_console_list_agent.js` during
// PTY teardown to enumerate the console process list.  If the shell's
// console session was already destroyed (app is exiting), AttachConsole()
// fails inside the forked process, which crashes it.  Node.js then fires
// an ECONNRESET 'error' event on the ChildProcess object; without a
// handler this becomes an uncaughtException that exits Electron with a
// non-zero code, even though traceStore and the API server were already
// cleanly flushed inside the will-quit handler.
if (process.platform === 'win32') {
  process.on('uncaughtException', (error: Error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ECONNRESET') {
      console.warn('[PTY] node-pty teardown ECONNRESET suppressed:', error.message)
      return
    }
    throw error
  })
}

import { app, BrowserWindow, nativeImage, nativeTheme, Menu, dialog, ipcMain, crashReporter } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { registerIpcHandlers, cleanupIpcHandlers, abortBackgroundWorkForQuit, floodBackgroundQueuesForQuitTest, setupWindowShortcuts } from './ipc-handlers'
import { getTrayManager } from './tray-manager'
import { getAppInfo, initializeAppIdentity } from './app-info'
import { ptyManager } from './pty-manager'
import { isSameAppNavigation, openExternalUrlWithConfirm } from './external-link-guard'
import { startApiServer, stopApiServer, getApiPort } from './api-server'
import { tMain } from './localization'
import { getUpdateService, applyPendingUpdateOnStartup } from './update-service'
import { getAppStateStorage } from './app-state-storage'
import { collectQuitActivitySummary, warmQuitActivityScanner } from './quit-activity-scan'
import { initializeSessionLedger, markSessionLedgerClean } from './session-ledger'
import { getSettingsStorage } from './settings-storage'
import { resolveTheme } from '../../src/themes/theme-engine'
import { getTerminalCwdSync } from './git-utils'
import { gitAutofetchManager } from './git-autofetch-manager'
import { getWindowStateStorage } from './window-state-storage'
import { getTelemetryService } from './telemetry/telemetry-service'
import { TELEMETRY_RESET_CONSENT } from './telemetry/telemetry-constants'
import { startSessionHeartbeat, stopSessionHeartbeat, getSessionDurationMs } from './telemetry/telemetry-session-tracker'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { IPC } from '../shared/ipc-channels'
import { broadcastGpuProcessGone } from './gpu-crash-recovery'
import { startThreadpoolWatchdog, stopThreadpoolWatchdog } from './threadpool-watchdog'
import { QuitCoordinator } from './quit-coordinator'
import { watcherService } from './watcher-service-client'
import { gitStateMirrorRouter } from './git-state-mirror-router'
import { startVisibilityWatchdog, stopVisibilityWatchdog } from './visibility-watchdog'
import { performanceTrace } from './performance-trace'
import { traceStore, runRotationStressForAutotest } from './trace-store'
import { htmlPreviewProtocolManager } from './html-preview-protocol'
import { browserViewManager } from './browser-view-manager'
import { isAllowedOpenBrowserGuestUrl } from '../../src/utils/browser-url'

// ONWARD_SMOKE_LAUNCH=1 makes the main process self-quit once the main window
// renderer finishes loading, after writing a ready marker to the path in
// ONWARD_SMOKE_READY_FILE (if set). CI uses this to assert a clean startup
// without a human observer. See docs/debug-env-variables.md.
const SMOKE_LAUNCH_MODE = process.env.ONWARD_SMOKE_LAUNCH === '1'
const SMOKE_READY_FILE = process.env.ONWARD_SMOKE_READY_FILE || null
const QUIT_STRESS_MODE = process.env.ONWARD_AUTOTEST === '1' && process.env.ONWARD_AUTOTEST_QUIT_STRESS === '1'
const QUIT_STRESS_HOLD_STAGE = QUIT_STRESS_MODE ? process.env.ONWARD_AUTOTEST_QUIT_HOLD_STAGE : undefined
if (SMOKE_LAUNCH_MODE) {
  console.log('[SmokeLaunch] Mode active (ONWARD_SMOKE_LAUNCH=1)')
}

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let installUpdateOnQuit = false
let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null
let lastNormalBounds: { x: number; y: number; width: number; height: number } | null = null
const hardenedBrowserSessions = new WeakSet<Electron.Session>()

// Single-instance lock keys on the resolved userData path; we MUST set
// userData (via initializeAppIdentity) BEFORE requesting the lock so the
// dev / prod / autotest profiles each get their own lock and don't block
// each other. After this point, only ONE Onward process per (build, userData)
// can run; the second-instance event focuses the existing main window.
//
// This also fixes the duplicate-writers race against userData/traces/ and
// userData/app-state.json that surfaced when daily + Intel-mac-release
// builds were left running side-by-side against the same userData.
const earlyAppInfo = initializeAppIdentity()

// Quit-crash test gate, cross-platform layer: local-only minidumps for every
// process (main, renderer, GPU, workers) under the per-runner userData dir.
// macOS keeps writing system .ips too (ignoreSystemCrashHandler stays false),
// which the orchestrator's DiagnosticReports sweep consumes; this layer gives
// Windows/Linux the same "a native crash during a suite fails the suite"
// guarantee via the crashDumps sweep. Autotest-only: production keeps its
// current no-reporter behavior (no strategy change without a user decision).
if (process.env.ONWARD_AUTOTEST === '1') {
  crashReporter.start({ uploadToServer: false, submitURL: '', rateLimit: false, compress: false })
  console.log('[CrashReporter] started (autotest mode), dumps -> ' + app.getPath('crashDumps'))
}

const gotTheSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotTheSingleInstanceLock) {
  console.log('[SingleInstance] another Onward is already running; exiting.')
  app.quit()
}

// Session ledger (clean-shutdown marker): ONLY the lock holder may touch it —
// a second instance racing past here would overwrite the primary's ledger and
// fabricate an abnormal-exit verdict on the next launch.
const previousSessionVerdict = gotTheSingleInstanceLock ? initializeSessionLedger() : null

// One-shot startup notice for the TabBar banner: abnormal end, unreadable
// ledger, or a clean quit that knowingly terminated running tasks.
function buildPreviousSessionNotice(): {
  kind: 'abnormal' | 'corrupt' | 'terminated-jobs'
  terminatedActiveJobs: number
  lastSeenAt: string | null
} | null {
  const v = previousSessionVerdict
  if (!v) return null
  if (v.kind === 'abnormal') {
    return {
      kind: 'abnormal',
      terminatedActiveJobs: 0,
      lastSeenAt: v.previous.lastSeenAt ?? null
    }
  }
  if (v.kind === 'corrupt') {
    return { kind: 'corrupt', terminatedActiveJobs: 0, lastSeenAt: null }
  }
  if (v.kind === 'clean' && (v.previous.terminatedActiveJobs ?? 0) > 0) {
    return {
      kind: 'terminated-jobs',
      terminatedActiveJobs: v.previous.terminatedActiveJobs as number,
      lastSeenAt: v.previous.finishedAt ?? null
    }
  }
  return null
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// GPU helper crash (Electron 39 ANGLE-Metal, deterministic on macOS Space
// switches — see gpu-crash-recovery.ts). App-level listener registered ONCE
// at module scope: broadcast so renderers force-recreate WebGL, because
// Chromium does NOT deliver webglcontextlost on this crash path.
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return
  console.log('[App] gpu-process-gone', details.reason, details.exitCode)
  const { notified, activity } = broadcastGpuProcessGone({
    reason: details.reason,
    exitCode: details.exitCode ?? 0
  })
  console.log('[App] gpu-process-gone broadcast', notified)
  // Fleet-analysis enrichment (2026-07-23): the msSince* antecedents let
  // PostHog classify wake-crash vs throttle-crash vs organic per version —
  // the Electron-upgrade A/B runs on this event. Values are identical to the
  // main:gpu.process-gone trace payload (same snapshot instance).
  getTelemetryService().track('error/gpuProcessCrash', {
    reason: details.reason,
    exitCode: details.exitCode ?? 0,
    msSinceLastWindowShow: activity.msSinceLastWindowShow ?? -1,
    msSinceLastWindowFocus: activity.msSinceLastWindowFocus ?? -1,
    msSinceLastThrottleToggle: activity.msSinceLastThrottleToggle ?? -1,
    msSinceLastNudge: activity.msSinceLastNudge ?? -1
  })
})

// Ask the renderer to flush all pending debounced state saves (prompt height,
// editor drafts, etc.) before the app quits. Without this, changes made within
// the last 300-500ms debounce window would be lost on quit/update-restart.
async function flushRendererState(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const sender = mainWindow.webContents
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcMain.removeListener(IPC.APP_STATE_FLUSH_DONE, onDone)
        reject(new Error('Renderer state flush timed out'))
      }, 2000)
      const onDone = (event: Electron.IpcMainEvent, result?: { success: boolean }) => {
        if (event.sender !== sender) {
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase: 'renderer-ack-ignored' })
          return
        }
        clearTimeout(timeout)
        ipcMain.removeListener(IPC.APP_STATE_FLUSH_DONE, onDone)
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase: 'renderer-ack', success: result?.success === true })
        if (result?.success !== true) reject(new Error('Renderer state flush failed'))
        else resolve()
      }
      ipcMain.on(IPC.APP_STATE_FLUSH_DONE, onDone)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase: 'renderer-flush-sent' })
      sender.send(IPC.APP_STATE_FLUSH_PENDING)
    })
  } catch (error) {
    throw error
  }
}

function persistTerminalCwdSnapshot(): void {
  const appStateStorage = getAppStateStorage()
  const state = appStateStorage.get()
  const terminalIds = state.tabs.flatMap((tab) => tab.terminals.map((terminal) => terminal.id))
  const uniqueTerminalIds = Array.from(new Set(terminalIds))

  if (uniqueTerminalIds.length === 0) {
    return
  }

  const validUpdates: Array<{ terminalId: string; cwd: string }> = []
  for (const terminalId of uniqueTerminalIds) {
    if (!ptyManager.get(terminalId)) {
      continue
    }
    const cwd = getTerminalCwdSync(terminalId, ptyManager.getCwd(terminalId))
    if (cwd) {
      validUpdates.push({ terminalId, cwd })
    }
  }

  if (validUpdates.length > 0) {
    appStateStorage.setTerminalLastCwds(validUpdates, { persist: false })
  }
}

async function flushAppStateStorage(): Promise<void> {
  try {
    if (!await getAppStateStorage().flush()) throw new Error('AppState flush rejected')
  } catch (error) {
    console.warn('[AppState] flush failed during shutdown:', error)
    throw error
  }
}

function persistWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const isMaximized = mainWindow.isMaximized()
  const isFullScreen = mainWindow.isFullScreen()
  // Use live bounds when in normal state; fall back to last tracked normal bounds
  // when maximized/fullscreen (those bounds reflect the expanded display, not user intent)
  const bounds = (!isMaximized && !isFullScreen)
    ? mainWindow.getBounds()
    : (lastNormalBounds ?? mainWindow.getBounds())

  getWindowStateStorage().save(bounds, isMaximized, isFullScreen)
}

if (process.env.ONWARD_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

// Count of active-job terminals the user knowingly terminated at the last
// confirmed quit — recorded into the session ledger for next-launch context.
let confirmedQuitTerminatedActiveJobs = 0
export function getConfirmedQuitTerminatedActiveJobs(): number {
  return confirmedQuitTerminatedActiveJobs
}

// Exit confirmation dialog (exported for use by tray-manager). When any
// terminal still has running jobs (descendant-process enumeration, see
// quit-activity.ts), the dialog states what would be terminated instead of
// the generic copy — the generic dialog is how a running codex task got
// silently killed on 2026-07-24. Detection is fail-open: on scan error or
// over-budget the plain dialog shows.
export async function confirmQuit(): Promise<boolean> {
  const { displayName } = getAppInfo()
  const activity = await collectQuitActivitySummary(ptyManager)
  if (activity && activity.activeCount > 0) {
    const jobs = activity.jobNames.join(', ')
    const terminals = activity.activeTerminalLabels.join(', ')
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [tMain('common.cancel'), tMain('dialog.quit.quitAnyway')],
      defaultId: 0,
      cancelId: 0,
      title: tMain('dialog.quit.title', { displayName }),
      message: tMain('dialog.quit.activeMessage', {
        activeCount: String(activity.activeCount),
        terminalCount: String(activity.terminalCount)
      }),
      detail: tMain('dialog.quit.activeDetail', { jobs, terminals })
    })
    if (response === 1) confirmedQuitTerminatedActiveJobs = activity.activeCount
    return response === 1
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [tMain('common.cancel'), tMain('menu.quitApp', { displayName })],
    defaultId: 0,
    cancelId: 0,
    title: tMain('dialog.quit.title', { displayName }),
    message: tMain('dialog.quit.message', { displayName }),
    detail: tMain('dialog.quit.detail')
  })
  return response === 1
}

// Flush telemetry before any quit path
async function shutdownTelemetry(): Promise<void> {
  stopSessionHeartbeat()
  getTelemetryService().track('session/end', { durationMs: getSessionDurationMs() })
  await getTelemetryService().shutdown()
}

function flushPerformanceTrace(reason: string): void {
  if (!performanceTrace.enabled) return
  try {
    performanceTrace.flush(reason)
  } catch (error) {
    console.warn('[PerfTrace] Failed to flush trace:', String(error))
  }
}

// Synchronous, crash-survivable quit-phase breadcrumb. Unlike perfTrace (buffered
// and FLUSHED only at the end of teardown — so it is lost when an earlier teardown
// step crashes), a console.log is captured line-by-line in the autotest runner log
// and survives a subsequent segfault, so the last "[QuitPhase] …" line in a
// crash log pinpoints exactly which teardown step was reached. Gated to autotest /
// debug so production quit stays quiet.
function logQuitPhase(phase: string): void {
  if (process.env.ONWARD_AUTOTEST === '1' || process.env.ONWARD_DEBUG === '1') {
    console.log(`[QuitPhase] ${phase}`)
  }
}

// Destroy all renderer windows during quit. Ordering vs cleanupIpcHandlers() is
// CRITICAL — it was the source of two OPPOSITE teardown bugs:
//   1. Calling app.quit() WITHOUT first destroying the window leaves the renderer's
//      1 s perf/persist setInterval loops invoking IPC after the handlers are gone;
//      on an EDR-taxed Windows host the live renderer message loop + never-closed
//      window WEDGE app.quit() (~193 s post-test hang when the Project Editor was
//      left active at exit). So the window MUST be destroyed before app.quit().
//   2. But HARD-destroying the window (w.destroy() frees the webContents native
//      object) BEFORE disposing the native subsystems that hold a webContents
//      reference (the GitStateMirror worker, parcel-watchers, worker clients — all
//      torn down in cleanupIpcHandlers) lets a callback fire in that gap and touch
//      freed native memory → a teardown SEGFAULT (observed ~1-in-3 on
//      prompt-input-latency: the crash landed after "[AutoTest] done", DURING
//      cleanup, before the perf-trace flush — i.e. exactly this window).
// Correct invariant: dispose native subsystems FIRST (await cleanupIpcHandlers),
// THEN destroy the windows, THEN app.quit(). Each quit path therefore calls
// cleanupIpcHandlers() BEFORE destroyAllWindowsForQuit(). Must still run AFTER any
// renderer-dependent flush (flushRendererState / flushAppStateStorage).
function destroyAllWindowsForQuit(reason: string): void {
  const windows = BrowserWindow.getAllWindows()
  if (performanceTrace.enabled) {
    try {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_QUIT_WINDOWS_DESTROYED, {
        reason,
        windowCount: windows.length
      })
    } catch {
      /* best-effort diagnostic breadcrumb */
    }
  }
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try {
        w.destroy()
      } catch (error) {
        console.warn('[Quit] window.destroy() failed:', String(error))
      }
    }
  }
  // Clearing the module-global reference prevents a post-quit stale-reference reuse
  // (e.g. a macOS `activate` recreating the window mid-teardown). Safe: this now
  // runs AFTER cleanupIpcHandlers() has disposed every native subsystem that held a
  // webContents reference, and every quit-reachable access in this module is
  // null-guarded (`if (mainWindow && !mainWindow.isDestroyed())` / `mainWindow?.`).
  mainWindow = null
}

const quitCoordinator = new QuitCoordinator({
  now: Date.now,
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  trace: (phase, data) => {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase, ...data })
    logQuitPhase(`${phase} ${JSON.stringify(data)}`)
  },
  begin: reason => {
    isQuitting = true
    installUpdateOnQuit = reason === 'restart-to-update'
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(false)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase: 'input-disabled', reason })
    if (reason === 'relaunch-for-recovery') app.relaunch()
    stopThreadpoolWatchdog()
    stopVisibilityWatchdog()
    gitAutofetchManager.dispose()
    gitStateMirrorRouter.beginShutdown()
    watcherService.freeze()
    const aborted = abortBackgroundWorkForQuit()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, {
      phase: 'background-work-aborted',
      reason,
      ...aborted
    })
    logQuitPhase(`background-work-aborted ${JSON.stringify({ reason, ...aborted })}`)
    // Upload is best-effort; it cannot hold user state or terminal shutdown hostage.
    void shutdownTelemetry().catch(error => console.warn('[Quit] telemetry shutdown failed:', error))
  },
  stages: () => [
    { name: 'renderer-state', required: true, run: flushRendererState },
    { name: 'window-state', required: true, run: persistWindowState },
    { name: 'terminal-cwd', required: true, run: persistTerminalCwdSnapshot },
    { name: 'app-state', required: true, run: () => QUIT_STRESS_HOLD_STAGE === 'app-state'
      ? new Promise<void>(() => {}) : flushAppStateStorage() },
    { name: 'terminals', required: true, run: async () => {
      const result = await ptyManager.shutdownAll()
      if (result.timedOut) throw new Error('Terminal shutdown incomplete')
    } },
    { name: 'services', run: async () => {
      await Promise.all([cleanupIpcHandlers(), watcherService.shutdown()])
    } }
  ],
  finish: (reason, clean) => {
    willQuitCleanupDone = true
    destroyAllWindowsForQuit(reason)
    if (clean) markSessionLedgerClean(reason, getConfirmedQuitTerminatedActiveJobs())
    flushPerformanceTrace(reason)
    app.quit()
  },
  force: (reason, clean) => {
    try {
      watcherService.forceStop()
      ptyManager.disposeAll()
      if (clean) markSessionLedgerClean(reason, getConfirmedQuitTerminatedActiveJobs())
      if (installUpdateOnQuit) getUpdateService().installDownloadedUpdateOnQuit()
    } catch {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase: 'forced-cleanup-failed', reason })
    } finally {
      try {
        flushPerformanceTrace(`${reason}:deadline`)
        traceStore.close()
      } finally {
        app.exit(clean ? 0 : 1)
      }
    }
  }
})
app.once('quit', () => quitCoordinator.exited())

export async function requestQuit(): Promise<void> {
  await quitCoordinator.request('quit', confirmQuit)
}

export async function requestRestartToApplyUpdate(): Promise<{ success: boolean; error?: string }> {
  if (quitCoordinator.stopping) return { success: false, error: 'Application is already quitting.' }
  const result = getUpdateService().requestRestartToUpdate()
  if (!result.success) return result
  await quitCoordinator.request('restart-to-update')
  return { success: true }
}

export async function requestRelaunchForRecovery(): Promise<{ success: boolean; error?: string }> {
  if (quitCoordinator.stopping) return { success: false, error: 'Application is already quitting.' }
  await quitCoordinator.request('relaunch-for-recovery')
  return { success: true }
}

export async function requestQuitForDebug(): Promise<{ success: boolean; error?: string }> {
  await quitCoordinator.request('debug-quit')
  return { success: true }
}

if (QUIT_STRESS_MODE) {
  console.log('[QuitStress] isolated lifecycle hooks enabled')
  Object.assign(globalThis, { __onwardQuitAutotest: {
    inspect: () => watcherService.inspect(),
    faultWatcher: () => watcherService.testExit(),
    blockWatcher: () => watcherService.testBlock(),
    hangTelemetry: () => { getTelemetryService().shutdown = () => new Promise<void>(() => {}) },
    floodQueues: (schedulerCount?: number, gitCount?: number) => floodBackgroundQueuesForQuitTest(schedulerCount, gitCount),
    recovery: requestRelaunchForRecovery,
    update: () => {
      const service = getUpdateService()
      service.requestRestartToUpdate = () => ({ success: true })
      service.installDownloadedUpdateOnQuit = () => { console.log('[QuitStress] update-install-requested') }
      return requestRestartToApplyUpdate()
    }
  } })
}

// Build menu template
function buildMenuTemplate(displayName: string): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    // macOS: Custom appMenu (for custom exit behavior)
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: tMain('menu.quitApp', { displayName }),
          accelerator: 'CommandOrControl+Q',
          click: async () => {
            await requestQuit()
          }
        }
      ]
    })
  }

  // All platforms: Added Edit menu (uses system role, enables standard editing shortcuts)
  template.push({ role: 'editMenu' })

  return template
}

// Get application icon path
function getIconPath(): string {
  // In development mode, __dirname is out/main, so you need to go up two levels to the project root directory
  const resourcesPath = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(__dirname, '../../resources')

  if (process.platform === 'win32') {
    return join(resourcesPath, 'icon.ico')
  }
  // macOS and Linux both use PNG
  return join(resourcesPath, 'icon.png')
}

function createWindow(displayName: string): void {
  const iconPath = getIconPath()
  const shouldLog = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
  const log = (...args: unknown[]) => {
    if (shouldLog) {
      console.log(...args)
    }
  }

  // Restore saved window state
  const savedWindowState = getWindowStateStorage().get()
  const initialThemeSettings = getSettingsStorage().get().theme
  if (initialThemeSettings.mode === 'system') nativeTheme.themeSource = 'system'
  const initialTheme = resolveTheme(initialThemeSettings, nativeTheme.shouldUseDarkColors)
  if (initialThemeSettings.mode !== 'system') nativeTheme.themeSource = initialTheme.kind
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: savedWindowState.width,
    height: savedWindowState.height,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: initialTheme.colors['--bg-0'],
    icon: iconPath,
    title: displayName,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Required for node-pty
      webviewTag: true
    }
  }
  if (savedWindowState.x !== undefined && savedWindowState.y !== undefined) {
    windowOptions.x = savedWindowState.x
    windowOptions.y = savedWindowState.y
  }

  mainWindow = new BrowserWindow(windowOptions)
  const themedWindow = mainWindow
  const applyNativeWindowTheme = () => {
    if (themedWindow.isDestroyed()) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_NATIVE_APPLY, { reason: 'window-destroyed' })
      return
    }
    const settings = getSettingsStorage().get().theme
    if (settings.mode === 'system' && nativeTheme.themeSource !== 'system') nativeTheme.themeSource = 'system'
    const theme = resolveTheme(settings, nativeTheme.shouldUseDarkColors)
    const source = settings.mode === 'system' ? 'system' : theme.kind
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source
    themedWindow.setBackgroundColor(theme.colors['--bg-0'])
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_NATIVE_APPLY, { themeId: theme.id, mode: settings.mode, kind: theme.kind })
  }
  nativeTheme.on('updated', applyNativeWindowTheme)
  themedWindow.once('closed', () => {
    nativeTheme.removeListener('updated', applyNativeWindowTheme)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_NATIVE_APPLY, { reason: 'listener-disposed' })
  })
  applyNativeWindowTheme()

  if (process.env.ONWARD_AUTOTEST === '1') {
    // Keep the window unoccluded for the whole autotest run. Electron 43
    // dropped MacWebContentsOcclusion from its default --disable-features,
    // so a test window covered by the orchestrator's terminal genuinely goes
    // document-hidden and rAF freezes — starving every paint-dependent
    // assertion (double-rAF trace events, content-visible waits). Pinning
    // the window on top removes occlusion from the test environment without
    // touching production visibility semantics.
    mainWindow.setAlwaysOnTop(true)
  }

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = params.src || 'about:blank'
    if (process.env.ONWARD_AUTOTEST === '1') console.log('[BrowserWebview] will-attach', src)
    if (!isAllowedOpenBrowserGuestUrl(src)) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    params.partition = 'persist:browser'
    delete params.allowpopups
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    browserViewManager.registerDomWebview(guestContents.id)
    guestContents.once('destroyed', () => browserViewManager.unregisterDomWebview(guestContents.id))
    if (process.env.ONWARD_AUTOTEST === '1') console.log('[BrowserWebview] did-attach', guestContents.id, guestContents.getURL())
    if (process.env.ONWARD_AUTOTEST === '1') {
      guestContents.on('did-start-loading', () => console.log('[BrowserWebview] did-start-loading', guestContents.id, guestContents.getURL()))
      guestContents.on('did-finish-load', () => console.log('[BrowserWebview] did-finish-load', guestContents.id, guestContents.getURL()))
      guestContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        console.warn('[BrowserWebview] did-fail-load', { id: guestContents.id, errorCode, errorDescription, validatedURL, isMainFrame })
      })
      setTimeout(() => {
        if (!guestContents.isDestroyed()) {
          console.log('[BrowserWebview] delayed-state', guestContents.id, guestContents.getURL(), guestContents.isLoading())
        }
      }, 1000)
    }
    const guestSession = guestContents.session
    if (!hardenedBrowserSessions.has(guestSession)) {
      hardenedBrowserSessions.add(guestSession)
      guestSession.setPermissionCheckHandler(() => false)
      guestSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      guestSession.on('will-download', (event) => event.preventDefault())
    }

    guestContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedOpenBrowserGuestUrl(url)) void guestContents.loadURL(url)
      return { action: 'deny' }
    })
    guestContents.on('will-navigate', (event, url) => {
      if (!isAllowedOpenBrowserGuestUrl(url)) event.preventDefault()
    })
    guestContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const modifier = input.meta || input.control
      let action: 'escape' | 'reload' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | null = null
      if (key === 'escape' && !input.alt && !modifier) {
        action = 'escape'
      } else if (modifier && !input.alt && key === 'r') {
        action = 'reload'
      } else if (modifier && !input.alt && (key === '+' || key === '=')) {
        action = 'zoom-in'
      } else if (modifier && !input.alt && (key === '-' || key === '_')) {
        action = 'zoom-out'
      } else if (modifier && !input.alt && key === '0') {
        action = 'zoom-reset'
      }
      if (!action) return
      event.preventDefault()
      mainWindow?.webContents.send(IPC.BROWSER_WEBVIEW_INPUT, guestContents.id, action)
    })
  })

  // Track normal (non-maximized, non-fullscreen) bounds for accurate restoration
  lastNormalBounds = mainWindow.getBounds()

  const debouncedSaveBounds = () => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
    windowStateSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
        lastNormalBounds = mainWindow.getBounds()
      }
    }, 500)
  }

  mainWindow.on('resize', debouncedSaveBounds)
  mainWindow.on('move', debouncedSaveBounds)

  mainWindow.on('ready-to-show', () => {
    log('[Window] ready-to-show')
    if (savedWindowState.isMaximized) {
      mainWindow?.maximize()
    }
    if (savedWindowState.isFullScreen) {
      mainWindow?.setFullScreen(true)
    }
    mainWindow?.show()
  })

  if (mainWindow.webContents) {
    const windowForEvents = mainWindow
    windowForEvents.webContents.on('did-finish-load', async () => {
      log('[Window] did-finish-load', windowForEvents.webContents.getURL())
      if (shouldLog && !windowForEvents.isDestroyed()) {
        const logDomInfo = async (label: string) => {
          try {
            const info = await windowForEvents.webContents.executeJavaScript(`(() => {
              const root = document.getElementById('root')
              const rootRect = root ? root.getBoundingClientRect() : null
              const bodyStyle = window.getComputedStyle(document.body)
              const rootStyle = root ? window.getComputedStyle(root) : null
              return {
                title: document.title,
                hasElectronAPI: typeof window.electronAPI !== 'undefined',
                rootChildCount: root ? root.childElementCount : -1,
                rootText: root?.innerText?.slice(0, 200) ?? '',
                rootRect: rootRect ? {
                  width: Math.round(rootRect.width),
                  height: Math.round(rootRect.height)
                } : null,
                styleSheetsCount: document.styleSheets.length,
                bodyBg: bodyStyle.backgroundColor,
                bodyColor: bodyStyle.color,
                rootColor: rootStyle?.color ?? null,
                bodyOpacity: bodyStyle.opacity,
                rootOpacity: rootStyle?.opacity ?? null,
                rootVisibility: rootStyle?.visibility ?? null
              }
            })()`, true)
            log(`[Window] dom-info ${label}`, info)
          } catch (error) {
            log(`[Window] dom-info ${label} error`, error)
          }
        }

        await logDomInfo('t=0')
        setTimeout(() => void logDomInfo('t=1000'), 1000)
        setTimeout(() => void logDomInfo('t=3000'), 3000)
      }

      if (process.env.ONWARD_DEBUG_CAPTURE === '1' && !windowForEvents.isDestroyed()) {
        const capture = (label: string, delay: number) => {
          setTimeout(async () => {
            try {
              const image = await windowForEvents.webContents.capturePage()
              const outputPath = join(app.getPath('temp'), `onward-debug-${label}.png`)
              writeFileSync(outputPath, image.toPNG())
              log('[Window] capturePage saved', outputPath)
            } catch (error) {
              log('[Window] capturePage error', error)
            }
          }, delay)
        }

        capture('t1', 1500)
        capture('t2', 5000)
      }
    })
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log('[Window] did-fail-load', { errorCode, errorDescription, validatedURL })
    })
    if (SMOKE_LAUNCH_MODE) {
      mainWindow.webContents.once('did-finish-load', () => {
        // Give React a moment to mount before declaring ready.
        setTimeout(() => {
          if (SMOKE_READY_FILE) {
            try {
              writeFileSync(SMOKE_READY_FILE, JSON.stringify({
                ready: true,
                ts: Date.now(),
                pid: process.pid,
                url: mainWindow?.webContents.getURL() ?? null
              }))
            } catch (error) {
              console.error('[SmokeLaunch] failed to write ready file', error)
            }
          }
          console.log('[SmokeLaunch] READY')
          setTimeout(() => {
            void requestQuitForDebug().catch((error) => {
              console.error('[SmokeLaunch] graceful quit failed', error)
              app.exit(1)
            })
          }, 500)
        }, 1500)
      })
    }
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      log('[Window] render-process-gone', details)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_RENDERER_PROCESS_GONE, {
        reason: details.reason,
        exitCode: details.exitCode
      })
      getTelemetryService().track('error/rendererCrash', {
        reason: details.reason,
        exitCode: details.exitCode
      })
    })
    mainWindow.webContents.on('unresponsive', () => {
      log('[Window] renderer unresponsive')
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_RENDERER_UNRESPONSIVE)
      // Stability telemetry: gray-degradation exposure (live lane dedupes
      // to one discrete event per kind per day; aggregate counts them all)
      getTelemetryService().track('error/recovered', { kind: 'unresponsive' })
    })
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      log('[Renderer]', { level, message, line, sourceId })
    })
  }

  // macOS: Intercept close event, hide window instead of closing
  mainWindow.on('close', (e) => {
    if (isQuitting) {
      if (!willQuitCleanupDone) {
        e.preventDefault()
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase: 'window-close-deferred' })
      }
      return
    }

    if (process.platform === 'darwin') {
      e.preventDefault()
      mainWindow?.hide()
      app.dock?.hide()
      return
    }

    // Windows / Linux: Confirm to exit before closing the window
    e.preventDefault()
    void requestQuit()
  })

  mainWindow.webContents.on('will-navigate', (event, nextUrl) => {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''
    if (isSameAppNavigation(currentUrl, nextUrl)) {
      return
    }
    event.preventDefault()
    void openExternalUrlWithConfirm(mainWindow, nextUrl)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrlWithConfirm(mainWindow, details.url)
    return { action: 'deny' }
  })

  // Register IPC handlers
  ipcMain.removeAllListeners(IPC.THEMES_BOOTSTRAP)
  ipcMain.on(IPC.THEMES_BOOTSTRAP, event => {
    const settings = getSettingsStorage().get()
    event.returnValue = { settings, resolvedTheme: resolveTheme(settings.theme, nativeTheme.shouldUseDarkColors) }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'bootstrap', mode: settings.theme.mode })
  })
  registerIpcHandlers(mainWindow, {
    isQuitting: () => isQuitting,
    onSettingsChanged: () => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(displayName)))
      applyNativeWindowTheme()
    },
    onRestartToApplyUpdate: requestRestartToApplyUpdate,
    onGracefulQuitForDebug: requestQuitForDebug,
    onRelaunchForRecovery: requestRelaunchForRecovery,
    getPreviousSessionNotice: buildPreviousSessionNotice,
    getApiPort
  })

  // Set up window shortcuts (before-input-event)
  setupWindowShortcuts(mainWindow)

  // Load the app
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Reuse the userData / displayName work we already did at top level so
  // the single-instance lock and appInfo agree on identity. Module-scope
  // call already invoked initializeAppIdentity(); no need to repeat.
  const appInfo = earlyAppInfo
  htmlPreviewProtocolManager.register()
  performanceTrace.start()
  performanceTrace.startEventLoopMonitor()
  performanceTrace.initialize()
  // Post-ready on purpose — see registerSignalQuitHandlers' header: a
  // pre-ready registration loses the sigaction slot to Chromium.
  registerSignalQuitHandlers()

  // Trace-rotation autotest hook: when ONWARD_TRACE_ROTATION_STRESS_MB is
  // set, write that many MB of synthetic events through the store and quit
  // cleanly. Used by run-perf-trace-rotation-autotest.sh; absent in
  // production runs. Must happen AFTER the loggers initialize so the store
  // has its directory + first chunk open. See trace-store.ts.
  const stressMb = parseInt(process.env.ONWARD_TRACE_ROTATION_STRESS_MB || '', 10)
  if (Number.isFinite(stressMb) && stressMb > 0) {
    const written = runRotationStressForAutotest(stressMb)
    console.log(`[TraceStore] autotest stress: ${written} events written for ${stressMb} MB target`)
    // Force a final-chunk close so Perfetto-side validators see a clean
    // file with no in-flight bytes; will-quit also calls traceStore.close()
    // but we want the test to be deterministic regardless of platform
    // shutdown ordering.
    setTimeout(() => app.quit(), 50)
    return
  }

  // Windows: PowerShell is a hard runtime requirement. The terminal /
  // shell-integration / cwd-detection pipeline assumes either pwsh.exe
  // (PowerShell 7+) or powershell.exe (5.1) is on PATH. Without it the
  // OSC 633 / 7 emitter cannot install and cwd updates would silently fall
  // back to a much slower lsof-style polling path that we removed in this
  // refactor. Fail loud at startup with an install link rather than ship a
  // half-functional UI.
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process')
    const probeShell = (cmd: string): boolean => {
      try {
        const result = spawnSync('where.exe', [cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
        return result.status === 0 && result.stdout && result.stdout.toString().trim().length > 0
      } catch {
        return false
      }
    }
    const hasPwsh = probeShell('pwsh.exe')
    const hasPs5 = probeShell('powershell.exe')
    if (!hasPwsh && !hasPs5) {
      const { dialog, shell } = await import('electron')
      const choice = await dialog.showMessageBox({
        type: 'error',
        title: 'PowerShell required',
        message: 'Onward requires PowerShell on Windows.',
        detail: 'Install PowerShell 7+ from https://aka.ms/powershell, then relaunch Onward. Windows PowerShell 5.1 (preinstalled on Windows 10/11) also works.',
        buttons: ['Open install guide', 'Quit'],
        defaultId: 0,
        cancelId: 1
      })
      if (choice.response === 0) {
        try { await shell.openExternal('https://aka.ms/powershell') } catch { /* ignore */ }
      }
      app.exit(1)
      return
    }
  }

  // Windows: check for a pending update that wasn't applied during the
  // previous quit (e.g. the helper script was killed by Job Object cleanup).
  // If found, launch the update script and exit immediately so the script
  // can replace the app files and relaunch.
  if (applyPendingUpdateOnStartup()) {
    console.log('[UpdateService] Startup recovery: update script launched, exiting.')
    app.exit(0)
    return
  }

  // Autotest: skip the first-run consent dialog. Logs on startup per the
  // debug-env-variable convention; no persisted state is touched.
  if (process.env.ONWARD_AUTOTEST_SKIP_CONSENT === '1') {
    console.log('[Telemetry] Consent dialog suppressed (ONWARD_AUTOTEST_SKIP_CONSENT=1); effective consent = declined')
  } else if (process.env.ONWARD_AUTOTEST === '1') {
    console.log('[Telemetry] Consent dialog suppressed in autotest mode (ONWARD_AUTOTEST=1); effective consent = declined. Set ONWARD_TELEMETRY_RESET_CONSENT=1 to override with a real consent = true.')
  }

  // Debug: reset telemetry consent
  if (TELEMETRY_RESET_CONSENT) {
    const isAutotest = process.env.ONWARD_AUTOTEST === '1'
    if (isAutotest) {
      // Autotest mode: enable telemetry with a fresh instanceId so events flow immediately
      const { randomUUID } = require('crypto')
      getSettingsStorage().setTelemetryConsent(true, randomUUID())
      if (process.env.ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX === '1') {
        // Outbox-remediation autotests seed telemetry-events.jsonl BEFORE
        // launch; wiping it here would delete pending records without an
        // upload acknowledgement — the exact anti-pattern the outbox
        // semantics forbid — and blind the remediation assertions.
        console.log('[Telemetry] Keeping seeded outbox (ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX=1)')
      } else {
        // Clear the local log file for a clean test run
        const logPath = join(app.getPath('userData'), 'telemetry-events.jsonl')
        try { require('fs').writeFileSync(logPath, '', 'utf-8') } catch {}
      }
      console.log('[Telemetry] Consent set to true for autotest (ONWARD_TELEMETRY_RESET_CONSENT=1)')
    } else {
      // Manual debug mode: reset to null so the consent dialog appears
      getSettingsStorage().setTelemetryConsent(null, null)
      console.log('[Telemetry] Consent reset to null for debugging (ONWARD_TELEMETRY_RESET_CONSENT=1)')
    }
  }

  // Debug: surface the Prompt virtual-cursor kill switch so it's obvious
  // when a user/CI is running without click-anywhere-to-type.
  if (process.env.ONWARD_DISABLE_VIRTUAL_CURSOR === '1') {
    console.log('[PromptEditor] Virtual cursor disabled (ONWARD_DISABLE_VIRTUAL_CURSOR=1); falling back to plain line-by-line input.')
  }

  // Initialize telemetry (reads consent from settings; no-op if not consented)
  getTelemetryService().initialize()
  getTelemetryService().track('session/start')

  // Prime the quit-activity process-table path off the startup critical path
  // (Windows PowerShell/CIM cold-start would otherwise eat the scan budget
  // on the first quit and degrade the dialog to the generic copy).
  setTimeout(() => warmQuitActivityScanner(), 5000)

  // Fleet visibility for the no-crash-report death class: the session ledger
  // found the previous instance ended without a clean-shutdown mark
  // (SIGKILL / power loss / freeze force-quit — none of which leave an .ips).
  if (previousSessionVerdict && (previousSessionVerdict.kind === 'abnormal' || previousSessionVerdict.kind === 'corrupt')) {
    const previous = previousSessionVerdict.kind === 'abnormal' ? previousSessionVerdict.previous : null
    getTelemetryService().track('error/abnormalExit', {
      kind: previousSessionVerdict.kind,
      lastAppVersion: previous?.appVersion ?? 'unknown',
      uptimeMs: previous ? String(Math.max(0, Date.parse(previous.lastSeenAt) - Date.parse(previous.startedAt) || 0)) : '-1',
      terminatedActiveJobs: String(previous?.terminatedActiveJobs ?? 0)
    })
  }

  // Set up the application menu (contains the Edit menu to enable standard editing shortcuts)
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(appInfo.displayName)))

  // Set macOS Dock icon
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getIconPath()
    console.log('[Dock] Icon path:', iconPath)

    const fs = require('fs')
    console.log('[Dock] File exists:', fs.existsSync(iconPath))

    const icon = nativeImage.createFromPath(iconPath)
    console.log('[Dock] Icon size:', icon.getSize())

    if (!icon.isEmpty()) {
      app.dock.setIcon(icon)
      console.log('[Dock] Icon set!')
    } else {
      console.log('[Dock] Icon is empty, not setting')
    }
  }

  createWindow(appInfo.displayName)

  // Start telemetry heartbeat with focus tracking (requires mainWindow)
  if (mainWindow) {
    startSessionHeartbeat(mainWindow)
  }

  // Infrastructure watchdogs (2026-07-20 incident class): the libuv
  // threadpool can lose its condvar wakeup at a display-sleep boundary
  // (async fs/dns/zlib/crypto dead until restart) and the renderer's
  // visibilityState can strand at 'hidden' while the window is frontmost.
  // Neither failure is observable by the existing event-loop monitor.
  startThreadpoolWatchdog()
  startVisibilityWatchdog(() => mainWindow)

  // Initialize system tray
  if (mainWindow) {
    getTrayManager().init(mainWindow, appInfo.displayName)
  }

  // Start HTTP API Server (for use by onward-bridge CLI)
  if (mainWindow) {
    startApiServer(mainWindow, {
      onRestartToApplyUpdate: requestRestartToApplyUpdate,
      onGracefulQuitForDebug: requestQuitForDebug
    }).catch((error) => {
      console.error('[API Server] Failed to start:', error)
    })
    getUpdateService().start(mainWindow)
  }

  // Background git auto-fetch: keep the Task badge's behind count fresh. Gate
  // fetching on window visibility (hidden/minimized pauses it — the confirmed
  // hidden-pause strategy) so we do not fetch while the user is away.
  if (mainWindow) {
    const win = mainWindow
    const syncAutofetchVisibility = () => {
      gitAutofetchManager.setAppVisible(win.isVisible() && !win.isMinimized())
    }
    win.on('show', syncAutofetchVisibility)
    win.on('hide', syncAutofetchVisibility)
    win.on('minimize', syncAutofetchVisibility)
    win.on('restore', syncAutofetchVisibility)
    syncAutofetchVisibility()
    gitAutofetchManager.start()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(appInfo.displayName)
    } else if (mainWindow) {
      // macOS: Show window when clicking Dock icon
      getTrayManager().showWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void quitCoordinator.request('window-all-closed')
  }
})

// A termination signal is a DECIDED quit (OS shutdown/logout, pkill, test
// harness) — it must never park on the interactive confirm dialog. Chromium's
// default converts SIGTERM into the quit flow, which lands in before-quit →
// confirmQuit() → -[NSAlert runModal] blocking forever with nobody to click
// (2026-07-31 SIGTERM investigation: 3/3 SURVIVED_SIGTERM, stack sampled in
// runModal). Route signals through the same bounded no-confirm teardown the
// debug quit uses; its hard-exit floor keeps termination bounded even when a
// teardown step wedges.
//
// MUST be called from app.whenReady(): Chromium installs its own native
// sigaction during browser startup, replacing any libuv handler registered at
// module-import time (a pre-ready `process.on` silently loses the slot — the
// dialog still appeared with the handler in the bundle). Post-ready
// registration wins the slot back, exactly like performance-trace's
// flush-only handlers do; when both are installed they share libuv's
// dispatch and both fire (flush first is harmless, this one decides exit).
function registerSignalQuitHandlers(): void {
  for (const terminationSignal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(terminationSignal, () => {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_SIGNAL_QUIT, {
        signal: terminationSignal,
        isQuitting,
        ready: app.isReady()
      })
      if (isQuitting) return
      if (!app.isReady()) {
        isQuitting = true
        app.exit(0)
        return
      }
      void quitCoordinator.request('signal').catch((error) => {
        console.warn('[Lifecycle] signal quit failed:', error)
        app.exit(1)
      })
    })
  }
}

app.on('before-quit', async (e) => {
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_BEFORE_QUIT, {
    isQuitting,
    installUpdateOnQuit
  })
  // Repeated native quit requests must not close the renderer during its save.
  if (willQuitCleanupDone) return
  if (isQuitting) {
    e.preventDefault()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_COORDINATOR, { phase: 'native-quit-joined' })
    return
  }
  if (!app.isReady()) {
    isQuitting = true
    return
  }

  // Reaching here un-armed means the quit was EXTERNALLY initiated: Chromium's
  // SIGTERM conversion (when its sigaction beat libuv's — the process.on
  // handlers above are registered post-ready yet the slot ownership races per
  // profile), a macOS logout/shutdown AppleEvent, or a stray app.quit(). The
  // decision is already made and nobody is present to answer a dialog — the
  // pre-fix confirmQuit() here parked -[NSAlert runModal] forever and made the
  // app unkillable by SIGTERM. Run the bounded no-confirm teardown instead.
  // Interactive quits never arrive un-armed: menu Cmd+Q, tray quit, and the
  // window-close path all call requestQuit() (confirm dialog included)
  // themselves and set isQuitting before any app.quit().
  e.preventDefault()

  try {
    await quitCoordinator.request('quit')
  } catch (error) {
    console.warn('[Lifecycle] external quit teardown failed:', error)
    app.exit(1)
  }
})

// Every external quit joins the same coordinator; this hook owns no second timer.
let willQuitCleanupDone = false
app.on('will-quit', (event) => {
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_WILL_QUIT, {
    installUpdateOnQuit
  })
  if (!willQuitCleanupDone) {
    event.preventDefault()
    void quitCoordinator.request('will-quit')
    return
  }
  if (installUpdateOnQuit) {
    getUpdateService().installDownloadedUpdateOnQuit()
  }
  getUpdateService().stop()
  stopApiServer()
  performanceTrace.stop()
  // Close the shared trace store last so any final performanceTrace.stop()
  // events are written before we fsync + unlink the active chunk's stream.
  traceStore.close()
  getTrayManager().destroy()
})
