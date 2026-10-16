/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort } from 'worker_threads'
import { WatcherRpcClient, isWatchReply } from './watcher-rpc'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

// Only messages cross this worker boundary; watcher.node lives in a utility process.
const client = new WatcherRpcClient(command => {
  if (!parentPort) throw new Error('Missing watcher worker transport')
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_WATCHER_RPC, { phase: 'send', operation: command.op, requestId: command.id })
  parentPort.postMessage(command)
})
parentPort?.on('message', message => {
  if (isWatchReply(message)) {
    if (message.event === 'watcher-reply') {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_WATCHER_RPC, { phase: 'reply', requestId: message.id, failed: Boolean(message.error) })
    }
    client.receive(message)
  }
})
export const subscribe = client.subscribe.bind(client)
