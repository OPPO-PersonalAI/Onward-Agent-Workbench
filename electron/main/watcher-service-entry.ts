/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import * as parcelWatcher from '@parcel/watcher'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { WatcherServiceRegistry } from './watcher-service-registry'
import { isWatchCommand, type WatchReply } from './watcher-rpc'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

const port = process.parentPort
if (!port) throw new Error('Watcher service requires an Electron utility parent')
// Chromium's IO thread handles parent death on POSIX. Windows needs an
// independent watchdog because a blocked native callback can stop this loop.
if (process.platform === 'win32') {
  const watchdog = new Worker(join(__dirname, 'watcher-owner-watchdog-entry.js'), {
    workerData: { ownerPid: Number(process.env.ONWARD_WATCHER_OWNER_PID) }
  })
  watchdog.on('message', message => port.postMessage(message))
  watchdog.on('error', () => {
    port.postMessage({ event: 'trace', name: PERF_TRACE_EVENT.UTILITY_WATCHER_LIFECYCLE, data: { phase: 'owner-watchdog-failed' } })
    process.kill(process.pid, 'SIGKILL')
  })
  watchdog.unref()
}
const autotest = process.env.ONWARD_AUTOTEST === '1'
const hangShutdown = autotest && process.env.ONWARD_AUTOTEST_WATCHER_HANG_SHUTDOWN === '1'
const hangSubscribe = autotest && process.env.ONWARD_AUTOTEST_WATCHER_HANG_SUBSCRIBE === '1'
const hangUnsubscribe = autotest && process.env.ONWARD_AUTOTEST_WATCHER_HANG_UNSUBSCRIBE === '1'
const registry = new WatcherServiceRegistry({ subscribe: async (path, callback, options) => {
  const subscription = await parcelWatcher.subscribe(path, callback, options)
  if (hangSubscribe) await new Promise<void>(() => {})
  return { unsubscribe: async () => {
    if (hangUnsubscribe) await new Promise<void>(() => {})
    await subscription.unsubscribe()
  } }
} })
const trace = (phase: string, data: Record<string, unknown> = {}) => port.postMessage({
  event: 'trace', name: PERF_TRACE_EVENT.UTILITY_WATCHER_LIFECYCLE, data: { phase, ...data }
})
let batchCount = 0
let eventCount = 0
let transportMs = 0
function flushBatchStats(): void {
  if (!batchCount) return
  port.postMessage({ event: 'trace', name: PERF_TRACE_EVENT.UTILITY_WATCHER_BATCH_STATS,
    data: { batchCount, eventCount, durationMs: transportMs } })
  batchCount = 0
  eventCount = 0
  transportMs = 0
}
const statsTimer = setInterval(flushBatchStats, 1000)
statsTimer.unref()

port.on('message', ({ data }) => {
  if (autotest && data?.event === 'watcher-test-block') {
    port.postMessage({ event: 'watcher-test-blocked' })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    return
  }
  if (data?.event === 'watcher-shutdown') {
    trace('shutdown-received', registry.inspect())
    flushBatchStats()
    if (hangShutdown) { trace('autotest-shutdown-held'); return }
    void registry.shutdown().then(() => {
      trace('drained', registry.inspect())
    }, () => {
      trace('shutdown-failed', registry.inspect())
    }).finally(() => {
      port.postMessage({ event: 'watcher-drained', ...registry.inspect() })
      // Leave the native completion callback before entering Node teardown.
      setImmediate(() => process.exit(0))
    })
    return
  }
  if (!isWatchCommand(data)) return
  trace('request-received', { operation: data.op, requestId: data.id })
  const started = performance.now()
  const operation = data.op === 'subscribe'
    ? registry.subscribe(data.subscription, data.path, (error, events) => {
      const start = performance.now()
      port.postMessage({ event: 'watcher-events', subscription: data.subscription, events, error: error?.message } satisfies WatchReply)
      batchCount++
      eventCount += events.length
      transportMs += performance.now() - start
    }, data.ignore)
    : registry.unsubscribe(data.subscription)
  void operation.then(() => {
    trace('request-complete', { operation: data.op, requestId: data.id, durationMs: performance.now() - started })
    port.postMessage({ event: 'watcher-reply', id: data.id } satisfies WatchReply)
  }, (error) => {
    trace('request-failed', { operation: data.op, requestId: data.id, durationMs: performance.now() - started })
    port.postMessage({ event: 'watcher-reply', id: data.id, error: String(error?.message ?? error).slice(0, 256) } satisfies WatchReply)
  })
})
trace('ready', { pid: process.pid, hangShutdown, hangSubscribe, hangUnsubscribe })
port.postMessage({ event: 'watcher-ready', pid: process.pid })
