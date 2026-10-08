/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { IPC } from '../shared/ipc-channels'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { performanceTrace } from './performance-trace'
import { runThemeImportWorker } from './theme-import-worker-client'
import { isThemeImportRequestId, type ThemeImportAutotestOptions, type ThemeImportCancelCause, type ThemeImportResult, type ThemeImportTraceSink } from './theme-import-types'
import { emitThemeImportTrace } from './theme-import-trace'

const autotestEnabled = process.env.ONWARD_AUTOTEST === '1'
// Strings persist; null is consumed by exactly one import as dialog cancellation.
const selectedTestPaths = new Map<number, string | null>()
const testPathCleanup = new Map<number, { sender: WebContents; dispose: () => void }>()
const testPauses = new Map<number, { at: 'before-worker' | 'worker'; taken: boolean; ready: Promise<boolean>; markReady: (paused: boolean) => void }>()
interface ImportDiagnostics { cause?: ThemeImportCancelCause }
interface ImportJob { requestId: string; controller: AbortController; done: Promise<ThemeImportResult>; diagnostics: ImportDiagnostics }
const active = new Map<number, ImportJob>()
// Aborting our wait cannot close a native chooser. Retain its ownership until the OS returns it.
const nativeChoosers = new Map<number, object>()
let registered = false
let closing = false
const traceMain: ThemeImportTraceSink = data => performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_IMPORT, { ...data })

function cancelImport(controller: AbortController, diagnostics: ImportDiagnostics, cause: ThemeImportCancelCause): void {
  if (!controller.signal.aborted) {
    diagnostics.cause = cause
    emitThemeImportTrace(traceMain, 'cancel-requested', { canceled: true, cause, pending: active.size })
  }
  controller.abort()
}

function clearTestPath(id: number): void {
  selectedTestPaths.delete(id)
  testPauses.get(id)?.markReady(false)
  testPauses.delete(id)
  const cleanup = testPathCleanup.get(id)
  if (cleanup) cleanup.sender.removeListener('destroyed', cleanup.dispose)
  testPathCleanup.delete(id)
}

async function selectFile(sender: WebContents, signal: AbortSignal, diagnostics: ImportDiagnostics): Promise<string | null> {
  const testPath = autotestEnabled ? selectedTestPaths.get(sender.id) : undefined
  if (testPath === null) {
    clearTestPath(sender.id)
    return null
  }
  if (testPath !== undefined) return testPath
  if (signal.aborted || sender.isDestroyed()) return null
  const owner = BrowserWindow.fromWebContents(sender)
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'JSON / JSONC / VSIX', extensions: ['json', 'jsonc', 'vsix'] }]
  }
  const startedAt = performance.now()
  emitThemeImportTrace(traceMain, 'chooser-open')
  return new Promise((resolvePath, reject) => {
    let settled = false
    const finish = (path: string | null, failed = false) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (!path && !failed) diagnostics.cause ??= 'user'
      emitThemeImportTrace(traceMain, 'chooser-result', {
        durationMs: performance.now() - startedAt, ok: !failed, canceled: !path && !failed,
        cause: diagnostics.cause, ...(failed ? { code: 'dialog-failed' } : {})
      })
      if (failed) reject(new Error('dialog-failed'))
      else resolvePath(path)
    }
    const abort = () => finish(null)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    let selection: Promise<Electron.OpenDialogReturnValue>
    const chooser = {}
    nativeChoosers.set(sender.id, chooser)
    try {
      selection = owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
    } catch {
      nativeChoosers.delete(sender.id)
      finish(null, true)
      return
    }
    const closed = () => {
      if (nativeChoosers.get(sender.id) === chooser) nativeChoosers.delete(sender.id)
      emitThemeImportTrace(traceMain, 'chooser-closed', { canceled: signal.aborted, cause: diagnostics.cause })
    }
    void selection.then(result => { closed(); finish(result.canceled ? null : result.filePaths[0] ?? null) }, () => { closed(); finish(null, true) })
  })
}

async function importForSender(sender: WebContents, controller: AbortController, diagnostics: ImportDiagnostics, predecessor?: Promise<ThemeImportResult>): Promise<ThemeImportResult> {
  const cancel = () => cancelImport(controller, diagnostics, 'destroy')
  const navigate = (details: Electron.Event & { isMainFrame?: boolean; isSameDocument?: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) cancelImport(controller, diagnostics, 'navigation')
  }
  sender.once('destroyed', cancel)
  sender.on('did-start-navigation', navigate)
  try {
    if (predecessor) {
      emitThemeImportTrace(traceMain, 'retry-wait', { cleanup: 'pending' })
      await predecessor
    }
    if (controller.signal.aborted || closing || sender.isDestroyed()) return { success: false, canceled: true }
    if (nativeChoosers.has(sender.id)) {
      emitThemeImportTrace(traceMain, 'chooser-busy', { ok: false, code: 'busy' })
      return { success: false, error: { code: 'busy' } }
    }
    const pause = autotestEnabled ? testPauses.get(sender.id) : undefined
    const pauseAt = pause && !pause.taken ? pause.at : undefined
    if (pause) pause.taken = true
    const path = await selectFile(sender, controller.signal, diagnostics)
    if (path && pauseAt === 'before-worker' && !controller.signal.aborted) {
      await new Promise<void>(resolve => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
        pause!.markReady(true)
      })
    }
    if (!path || controller.signal.aborted || closing || sender.isDestroyed()) {
      diagnostics.cause ??= closing ? 'shutdown' : sender.isDestroyed() ? 'destroy' : controller.signal.aborted ? 'abort' : 'user'
      return { success: false, canceled: true }
    }
    emitThemeImportTrace(traceMain, 'worker-dispatch')
    return await runThemeImportWorker(() => new Worker(join(__dirname, 'theme-import-worker-entry.js'), {
      workerData: { path, ...(pauseAt === 'worker' ? { pauseForAutotest: true } : {}) }
    }), {
      signal: controller.signal,
      cancelCause: () => diagnostics.cause,
      onTrace: data => {
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_THEME_IMPORT, { ...data })
        if (pauseAt === 'worker' && data.stage === 'worker-start') pause!.markReady(true)
      }
    })
  } catch {
    return { success: false, error: { code: 'dialog-failed' } }
  } finally {
    sender.removeListener('destroyed', cancel)
    sender.removeListener('did-start-navigation', navigate)
    emitThemeImportTrace(traceMain, 'sender-cleanup', { cleanup: 'complete', canceled: controller.signal.aborted, cause: diagnostics.cause })
  }
}

/** Register once from the primary IPC setup; snapshots are returned, never persisted here. */
export function registerThemeImportHandlers(): void {
  if (registered) {
    emitThemeImportTrace(traceMain, 'register-skipped')
    return
  }
  registered = true
  closing = false
  if (autotestEnabled) console.info('[ThemeImport] ONWARD_AUTOTEST file selection enabled')
  emitThemeImportTrace(traceMain, 'registered')

  ipcMain.handle(IPC.THEMES_AUTOTEST_SELECT_FILE, (event, path: unknown, options?: ThemeImportAutotestOptions) => {
    if (!autotestEnabled) throw new Error('autotest-disabled')
    if (options?.waitUntilPaused === true) {
      const pause = testPauses.get(event.sender.id)
      if (!pause) throw new Error('autotest-pause-not-configured')
      return pause.ready.then(paused => { if (!paused) throw new Error('autotest-pause-canceled') })
    }
    if (path !== null && (typeof path !== 'string' || path.length === 0)) throw new Error('invalid-autotest-path')
    clearTestPath(event.sender.id)
    selectedTestPaths.set(event.sender.id, path as string | null)
    if (options?.pauseAt === 'before-worker' || options?.pauseAt === 'worker') {
      let markReady!: (paused: boolean) => void
      const ready = new Promise<boolean>(resolve => { markReady = resolve })
      testPauses.set(event.sender.id, { at: options.pauseAt, taken: false, ready, markReady })
    }
    const dispose = () => clearTestPath(event.sender.id)
    testPathCleanup.set(event.sender.id, { sender: event.sender, dispose })
    event.sender.once('destroyed', dispose)
  })

  ipcMain.handle(IPC.THEMES_CANCEL_IMPORT, async (event, requestId: unknown, cause: unknown) => {
    const startedAt = performance.now()
    const valid = isThemeImportRequestId(requestId) && (cause === 'escape' || cause === 'unmount')
    emitThemeImportTrace(traceMain, 'cancel-handler-received', { cause: valid ? cause : undefined })
    let canceled = false
    try {
      const job = active.get(event.sender.id)
      if (!valid || !job || job.requestId !== requestId) {
        emitThemeImportTrace(traceMain, valid ? 'cancel-stale' : 'cancel-invalid', { ok: valid })
        return { canceled }
      }
      cancelImport(job.controller, job.diagnostics, cause)
      await job.done
      canceled = true
      return { canceled }
    } finally {
      emitThemeImportTrace(traceMain, 'cancel-handler-result', {
        durationMs: performance.now() - startedAt, canceled, cause: valid ? cause : undefined, cleanup: 'complete'
      })
    }
  })

  ipcMain.handle(IPC.THEMES_IMPORT, async (event, requestId: unknown) => {
    const startedAt = performance.now()
    let result: ThemeImportResult = { success: false, canceled: true }
    const diagnostics: ImportDiagnostics = {}
    emitThemeImportTrace(traceMain, 'handler-received', { pending: active.size })
    try {
      if (!isThemeImportRequestId(requestId)) {
        emitThemeImportTrace(traceMain, 'handler-invalid', { ok: false, code: 'worker-failed' })
        result = { success: false, error: { code: 'worker-failed' } }
        return result
      }
      if (closing || event.sender.isDestroyed()) {
        diagnostics.cause = closing ? 'shutdown' : 'destroy'
        return result
      }
      const previous = active.get(event.sender.id)
      if (previous && (!previous.controller.signal.aborted || previous.requestId === requestId)) {
        result = { success: false, error: { code: 'busy' } }
        return result
      }
      const controller = new AbortController()
      const job: ImportJob = { requestId, controller, diagnostics, done: Promise.resolve(result) }
      // Reserve the successor synchronously. It shares the canceled job's bounded settlement,
      // and can itself be canceled while waiting without spawning a second worker.
      active.set(event.sender.id, job)
      job.done = importForSender(event.sender, controller, diagnostics, previous?.done).finally(() => {
        if (active.get(event.sender.id) === job) active.delete(event.sender.id)
      })
      result = await job.done
      return result
    } finally {
      emitThemeImportTrace(traceMain, 'handler-result', {
        durationMs: performance.now() - startedAt,
        ok: result.success,
        canceled: result.canceled === true,
        count: result.themes?.length ?? 0,
        cause: diagnostics.cause,
        ...(result.error ? { code: result.error.code } : {})
      })
    }
  })
}

/** Abort pending dialog waits and terminate/join every worker before shutdown completes. */
export async function cleanupThemeImportHandlers(): Promise<void> {
  const startedAt = performance.now()
  emitThemeImportTrace(traceMain, 'shutdown-start', { pending: active.size, cleanup: 'pending' })
  closing = true
  if (registered) {
    ipcMain.removeHandler(IPC.THEMES_IMPORT)
    ipcMain.removeHandler(IPC.THEMES_CANCEL_IMPORT)
    ipcMain.removeHandler(IPC.THEMES_AUTOTEST_SELECT_FILE)
    registered = false
  }
  for (const id of selectedTestPaths.keys()) clearTestPath(id)
  const jobs = [...active.values()]
  for (const job of jobs) cancelImport(job.controller, job.diagnostics, 'shutdown')
  await Promise.allSettled(jobs.map(job => job.done))
  active.clear()
  nativeChoosers.clear()
  emitThemeImportTrace(traceMain, 'shutdown-complete', { durationMs: performance.now() - startedAt, pending: 0, cleanup: 'complete' })
}
