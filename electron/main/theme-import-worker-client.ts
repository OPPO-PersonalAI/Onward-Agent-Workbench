/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EventEmitter } from 'node:events'
import { isThemeImportErrorCode, type ThemeImportCancelCause, type ThemeImportResult, type ThemeImportTraceData, type ThemeImportTraceStage } from './theme-import-types.ts'
import { emitThemeImportTrace, normalizeThemeImportTraceData } from './theme-import-trace.ts'

export interface ThemeImportWorker extends EventEmitter {
  terminate(): Promise<number>
}

export interface ThemeImportWorkerOptions {
  signal?: AbortSignal
  onTrace?: (data: ThemeImportTraceData) => void
  timeoutMs?: number
  cancelCause?: () => ThemeImportCancelCause | undefined
}

function validResult(value: unknown): value is ThemeImportResult {
  if (!value || typeof value !== 'object') return false
  const result = value as ThemeImportResult
  if (result.success === true) return Array.isArray(result.themes) && result.themes.every(theme =>
    theme && typeof theme.id === 'string' && theme.id.startsWith('import-') && typeof theme.name === 'string' &&
    (theme.kind === 'light' || theme.kind === 'dark') && theme.colors && typeof theme.colors === 'object')
  return result.success === false && (result.canceled === true || isThemeImportErrorCode(result.error?.code))
}

/** One worker per user import; settlement always terminates and joins that worker. */
export async function runThemeImportWorker(createWorker: () => ThemeImportWorker, options: ThemeImportWorkerOptions = {}): Promise<ThemeImportResult> {
  const startedAt = performance.now()
  const traceResult = (stage: ThemeImportTraceStage, result: ThemeImportResult, cleanup?: ThemeImportTraceData['cleanup']) => {
    emitThemeImportTrace(options.onTrace, stage, {
      durationMs: performance.now() - startedAt,
      ok: result.success,
      canceled: result.canceled === true,
      count: result.themes?.length ?? 0,
      ...(result.error ? { code: result.error.code } : {}),
      ...(result.canceled ? { cause: options.cancelCause?.() ?? (stage === 'worker-pre-abort' ? 'pre-abort' : 'abort') } : {}),
      cleanup
    })
  }
  emitThemeImportTrace(options.onTrace, 'worker-request')
  if (options.signal?.aborted) {
    const result = { success: false, canceled: true }
    traceResult('worker-pre-abort', result, 'complete')
    return result
  }
  return new Promise(resolveResult => {
    let worker: ThemeImportWorker
    emitThemeImportTrace(options.onTrace, 'worker-spawn')
    try { worker = createWorker() } catch {
      const result: ThemeImportResult = { success: false, error: { code: 'worker-failed' } }
      traceResult('worker-spawn-failed', result, 'complete')
      resolveResult(result)
      return
    }
    let settled = false
    const finish = (result: ThemeImportResult, stage: ThemeImportTraceStage) => {
      if (settled) return
      settled = true
      traceResult(stage, result, 'pending')
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      worker.removeListener('message', onMessage)
      worker.removeListener('exit', onExit)
      // The error listener stays until terminate resolves so a queued worker
      // error cannot become an uncaught EventEmitter error during teardown.
      const terminationStart = performance.now()
      let terminationFailed = false
      emitThemeImportTrace(options.onTrace, 'worker-terminate', { cleanup: 'pending' })
      void worker.terminate().catch(() => {
        terminationFailed = true
        emitThemeImportTrace(options.onTrace, 'worker-terminate-failed', {
          durationMs: performance.now() - terminationStart, ok: false, code: 'worker-failed', cleanup: 'failed'
        })
      }).finally(() => {
        worker.removeListener('error', onError)
        traceResult('worker-settled', result, terminationFailed ? 'failed' : 'complete')
        resolveResult(result)
      })
    }
    const onAbort = () => finish({ success: false, canceled: true }, 'worker-aborted')
    const onError = () => finish({ success: false, error: { code: 'worker-failed' } }, 'worker-error')
    const onExit = () => finish({ success: false, error: { code: 'worker-failed' } }, 'worker-exit')
    const invalidResult = () => finish({ success: false, error: { code: 'worker-failed' } }, 'worker-invalid-result')
    const onMessage = (packet: unknown) => {
      if (!packet || typeof packet !== 'object') { invalidResult(); return }
      const message = packet as { type?: unknown; data?: unknown; result?: unknown }
      if (message.type === 'trace') {
        const data = normalizeThemeImportTraceData(message.data)
        if (data) emitThemeImportTrace(options.onTrace, data.stage, data)
        else emitThemeImportTrace(options.onTrace, 'worker-invalid-trace', { ok: false, code: 'worker-failed' })
        return
      }
      if (message.type === 'result' && validResult(message.result)) finish(message.result, 'worker-received')
      else invalidResult()
    }
    const timer = setTimeout(() => finish({ success: false, error: { code: 'timeout' } }, 'worker-timeout'), options.timeoutMs ?? 30_000)
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.once('exit', onExit)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}
