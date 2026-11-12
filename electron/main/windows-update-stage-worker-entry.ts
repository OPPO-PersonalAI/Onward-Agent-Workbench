/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads'
import { extractWindowsUpdateZip, type ExtractWindowsZipOptions } from './windows-zip-extract.ts'

interface WorkerPayload extends ExtractWindowsZipOptions {}

void (async () => {
  const started = performance.now()
  try {
    const payload = workerData as WorkerPayload
    const result = await extractWindowsUpdateZip(payload)
    parentPort?.postMessage({
      type: 'result',
      success: true,
      extractedFiles: result.extractedFiles,
      durationMs: Math.round(performance.now() - started)
    })
  } catch (error) {
    parentPort?.postMessage({
      type: 'result',
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - started)
    })
  } finally {
    parentPort?.close()
  }
})()
