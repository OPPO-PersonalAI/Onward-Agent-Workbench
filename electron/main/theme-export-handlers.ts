/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { writeFile, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { IPC } from '../shared/ipc-channels'
import { getSettingsStorage } from './settings-storage'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { isThemeImportRequestId } from './theme-import-types'

type ExportResult = { success: boolean; canceled?: boolean }
const autotestEnabled = process.env.ONWARD_AUTOTEST === '1'
const jobs = new Map<number, { requestId: string; controller: AbortController; done: Promise<ExportResult> }>()
const nativeChoosers = new Map<number, object>()
const testPaths = new Map<number, string | null>()
const testCleanup = new Map<number, () => void>()
interface ExportAutotestOptions { pauseAt?: 'before-worker' | 'before-commit'; waitUntilPaused?: boolean }
const testPauses = new Map<number, { at: NonNullable<ExportAutotestOptions['pauseAt']>; ready: Promise<boolean>; markReady: (paused: boolean) => void }>()
let registered = false
let closing = false
const trace = (stage: string, data: Record<string, unknown> = {}) => performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_EXPORT, { stage, ...data })

async function snapshot(themeId: string, signal: AbortSignal): Promise<{ filename: string; text: string }> {
  trace('worker-dispatch')
  let worker: Worker
  try {
    worker = new Worker(join(__dirname, 'theme-export-worker-entry.js'), {
      workerData: { settings: getSettingsStorage().getThemeExportSnapshot(themeId), themeId }
    })
  } catch { trace('worker-spawn-failed'); throw new Error('worker-failed') }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(new Error('canceled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      timer = setTimeout(() => { trace('worker-timeout'); reject(new Error('timeout')) }, 15000)
      worker.once('error', () => { trace('worker-error'); reject(new Error('worker-failed')) })
      worker.once('exit', code => { trace('worker-exit', { code }); reject(new Error('worker-exited')) })
      worker.on('message', result => {
        if (result?.type === 'started') {
          performanceTrace.record(PERF_TRACE_EVENT.WORKER_THEME_EXPORT, { stage: 'entered' })
          return
        }
        const ok = result?.success === true && typeof result.filename === 'string' && typeof result.text === 'string'
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_THEME_EXPORT, { stage: 'serialized', ok, durationMs: Number.isFinite(result?.durationMs) ? Math.min(15000, Math.max(0, result.durationMs)) : 0 })
        trace('worker-result', { ok })
        if (ok) resolve(result)
        else reject(new Error('export-failed'))
      })
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    try { await worker.terminate(); trace('worker-cleanup') }
    catch { trace('worker-cleanup-failed'); throw new Error('worker-cleanup-failed') }
  }
}

async function chooseDestination(sender: WebContents, filename: string, signal: AbortSignal): Promise<string | null> {
  trace('chooser-open')
  const owner = BrowserWindow.fromWebContents(sender)
  const options: Electron.SaveDialogOptions = { defaultPath: filename, filters: [{ name: 'JSON', extensions: ['json'] }] }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (path: string | null, failed = false) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (failed) reject(new Error('dialog-failed'))
      else resolve(path)
    }
    const abort = () => finish(null)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      const chooser = {}
      nativeChoosers.set(sender.id, chooser)
      const selection = owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)
      const closed = () => { if (nativeChoosers.get(sender.id) === chooser) nativeChoosers.delete(sender.id) }
      void selection.then(chosen => {
        closed()
        trace('chooser-closed', { canceled: chosen.canceled, aborted: signal.aborted })
        finish(chosen.canceled ? null : chosen.filePath ?? null)
      }, () => { closed(); trace('chooser-failed'); finish(null, true) })
    } catch { nativeChoosers.delete(sender.id); trace('chooser-failed'); finish(null, true) }
  })
}

async function exportForSender(sender: WebContents, themeId: string, controller: AbortController, predecessor?: Promise<ExportResult>): Promise<ExportResult> {
  const started = performance.now()
  const cancel = () => { trace('cancel'); controller.abort() }
  const navigate = (event: Electron.Event & { isMainFrame?: boolean; isSameDocument?: boolean }) => {
    if (event.isMainFrame && !event.isSameDocument) cancel()
  }
  sender.once('destroyed', cancel)
  sender.on('did-start-navigation', navigate)
  let result: ExportResult = { success: false }
  let temporary: string | undefined
  let pause: ReturnType<typeof testPauses.get>
  const pauseForAutotest = async (at: NonNullable<ExportAutotestOptions['pauseAt']>) => {
    if (!pause || pause.at !== at || controller.signal.aborted) return
    await new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
      pause!.markReady(true)
    })
  }
  try {
    if (predecessor) { trace('retry-wait'); await predecessor }
    if (controller.signal.aborted || closing || sender.isDestroyed()) return result = { success: false, canceled: true }
    if (nativeChoosers.has(sender.id)) { trace('chooser-busy'); return result }
    const testPath = autotestEnabled ? testPaths.get(sender.id) : undefined
    pause = autotestEnabled ? testPauses.get(sender.id) : undefined
    testPaths.delete(sender.id)
    await pauseForAutotest('before-worker')
    if (controller.signal.aborted) return result = { success: false, canceled: true }
    const file = await snapshot(themeId, controller.signal)
    if (controller.signal.aborted || closing) return result = { success: false, canceled: true }
    let path = testPath
    if (path === undefined) {
      path = await chooseDestination(sender, file.filename, controller.signal)
    }
    trace('chooser-result', { canceled: !path || controller.signal.aborted })
    if (!path || controller.signal.aborted || closing || sender.isDestroyed()) return result = { success: false, canceled: true }
    trace('write-start')
    temporary = join(dirname(path), `.onward-theme-${randomUUID()}.tmp`)
    await writeFile(temporary, file.text, { encoding: 'utf8', flag: 'wx', signal: controller.signal })
    await pauseForAutotest('before-commit')
    if (controller.signal.aborted || closing) return result = { success: false, canceled: true }
    // Rename is the commit point. Cancellation never truncates a previous export.
    trace('write-commit')
    await rename(temporary, path)
    temporary = undefined
    trace('write-complete', { bytes: Buffer.byteLength(file.text) })
    return result = { success: true }
  } catch {
    result = { success: false, ...(controller.signal.aborted ? { canceled: true } : {}) }
    trace('failed', { canceled: result.canceled === true })
    return result
  } finally {
    if (pause) {
      pause.markReady(false)
      if (testPauses.get(sender.id) === pause) testPauses.delete(sender.id)
    }
    if (temporary) {
      try { await rm(temporary, { force: true }); trace('write-cleanup') }
      catch { trace('write-cleanup-failed') }
    }
    sender.removeListener('destroyed', cancel)
    sender.removeListener('did-start-navigation', navigate)
    trace('complete', { ...result, durationMs: performance.now() - started })
  }
}

export function registerThemeExportHandlers(): void {
  trace('register', { alreadyRegistered: registered })
  if (registered) return
  registered = true
  closing = false
  ipcMain.handle(IPC.THEMES_AUTOTEST_EXPORT_FILE, (event, path: unknown, options?: ExportAutotestOptions) => {
    if (!autotestEnabled) throw new Error('autotest-disabled')
    if (options?.waitUntilPaused) {
      const pause = testPauses.get(event.sender.id)
      if (!pause) throw new Error('autotest-pause-not-configured')
      return pause.ready.then(paused => { if (!paused) throw new Error('autotest-pause-canceled') })
    }
    if (path !== null && (typeof path !== 'string' || !path)) throw new Error('invalid-autotest-path')
    testPauses.get(event.sender.id)?.markReady(false)
    testPauses.delete(event.sender.id)
    if (options?.pauseAt === 'before-worker' || options?.pauseAt === 'before-commit') {
      let markReady!: (paused: boolean) => void
      const ready = new Promise<boolean>(resolve => { markReady = resolve })
      testPauses.set(event.sender.id, { at: options.pauseAt, ready, markReady })
    }
    testPaths.set(event.sender.id, path as string | null)
    if (!testCleanup.has(event.sender.id)) {
      const clear = () => {
        testPaths.delete(event.sender.id)
        testPauses.get(event.sender.id)?.markReady(false)
        testPauses.delete(event.sender.id)
        testCleanup.delete(event.sender.id)
      }
      testCleanup.set(event.sender.id, () => { event.sender.removeListener('destroyed', clear); clear() })
      event.sender.once('destroyed', clear)
    }
  })
  ipcMain.handle(IPC.THEMES_CANCEL_EXPORT, async (event, requestId: unknown) => {
    trace('cancel-received')
    const job = jobs.get(event.sender.id)
    if (!isThemeImportRequestId(requestId) || !job || job.requestId !== requestId) {
      trace('cancel-stale')
      return { canceled: false }
    }
    job.controller.abort()
    trace('cancel-requested')
    const result = await job.done
    const canceled = result.canceled === true
    trace('cancel-complete', { canceled })
    return { canceled }
  })
  ipcMain.handle(IPC.THEMES_EXPORT, (event, requestId: unknown, themeId: unknown) => {
    trace('received')
    const previous = jobs.get(event.sender.id)
    if (closing || !isThemeImportRequestId(requestId) || (previous && (!previous.controller.signal.aborted || previous.requestId === requestId)) || typeof themeId !== 'string' || themeId.length > 128) {
      trace('rejected')
      return { success: false }
    }
    const controller = new AbortController()
    const done = exportForSender(event.sender, themeId, controller, previous?.done).finally(() => {
      if (jobs.get(event.sender.id)?.requestId === requestId) jobs.delete(event.sender.id)
    })
    jobs.set(event.sender.id, { requestId, controller, done })
    return done
  })
}

export async function cleanupThemeExportHandlers(): Promise<void> {
  trace('shutdown', { pending: jobs.size })
  closing = true
  if (registered) {
    ipcMain.removeHandler(IPC.THEMES_EXPORT)
    ipcMain.removeHandler(IPC.THEMES_CANCEL_EXPORT)
    ipcMain.removeHandler(IPC.THEMES_AUTOTEST_EXPORT_FILE)
    registered = false
  }
  for (const job of jobs.values()) job.controller.abort()
  await Promise.allSettled([...jobs.values()].map(job => job.done))
  // Aborted native chooser results cannot write files after shutdown.
  for (const clear of testCleanup.values()) clear()
  nativeChoosers.clear()
  trace('shutdown-complete')
}
