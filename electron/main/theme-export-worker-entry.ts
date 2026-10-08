/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import { parentPort, workerData } from 'node:worker_threads'
import { createThemeExport } from '../../src/themes/theme-export'

const started = performance.now()
parentPort?.postMessage({ type: 'started' })
try {
  const snapshot = createThemeExport(workerData.settings, workerData.themeId)
  parentPort?.postMessage({ type: 'result', success: true, ...snapshot, durationMs: performance.now() - started })
} catch {
  parentPort?.postMessage({ type: 'result', success: false, durationMs: performance.now() - started })
} finally {
  parentPort?.close()
}
