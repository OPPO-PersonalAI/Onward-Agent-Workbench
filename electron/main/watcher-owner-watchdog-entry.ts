/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { workerData, parentPort } from 'worker_threads'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

// Windows Node utility processes have no guaranteed kill-on-parent-death job.
// A separate JS isolate keeps this check responsive even if watcher JS blocks.
const ownerPid = Number(workerData.ownerPid)
if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('Invalid watcher owner PID')
parentPort?.postMessage({ event: 'trace', name: PERF_TRACE_EVENT.UTILITY_WATCHER_LIFECYCLE, data: { phase: 'owner-watchdog-armed' } })
setInterval(() => {
  try { process.kill(ownerPid, 0) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      // The browser is already gone; this breadcrumb is best-effort only.
      parentPort?.postMessage({ event: 'trace', name: PERF_TRACE_EVENT.UTILITY_WATCHER_LIFECYCLE, data: { phase: 'owner-gone' } })
      process.kill(process.pid, 'SIGKILL')
    }
  }
}, 1000)
