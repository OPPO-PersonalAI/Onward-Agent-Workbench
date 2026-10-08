/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads'
import { importThemeFile } from './theme-import-source.ts'
import { importErrorCode, type ThemeImportResult, type ThemeImportWorkerPacket, type ThemeImportTraceSink } from './theme-import-types.ts'
import { emitThemeImportTrace } from './theme-import-trace.ts'

const postPacket = (packet: ThemeImportWorkerPacket) => parentPort?.postMessage(packet)
const trace: ThemeImportTraceSink = data => postPacket({ type: 'trace', data })

async function run(): Promise<void> {
  const startedAt = performance.now()
  emitThemeImportTrace(trace, 'worker-start')
  // Deterministic autotest barrier: the existing worker AbortController terminates this wait.
  if (process.env.ONWARD_AUTOTEST === '1' && workerData?.pauseForAutotest === true) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  let result: ThemeImportResult
  try {
    if (typeof workerData?.path !== 'string') result = { success: false, error: { code: 'file-unreadable' } }
    else result = { success: true, themes: await importThemeFile(workerData.path, {}, trace) }
  } catch (error) {
    result = { success: false, error: { code: importErrorCode(error) } }
  }
  // The main client supplies the registered WORKER_THEME_IMPORT event name.
  // Only aggregate fields cross the tracing boundary, never source metadata.
  emitThemeImportTrace(trace, 'worker-result', {
    durationMs: performance.now() - startedAt,
    ok: result.success,
    canceled: false,
    count: result.themes?.length ?? 0,
    ...(result.error ? { code: result.error.code } : {})
  })
  postPacket({ type: 'result', result })
  parentPort?.close()
}

void run()
