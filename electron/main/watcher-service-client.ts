/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import type { Worker } from 'worker_threads'
import { WatcherRpcClient, WatcherConnectionError, isWatchReply, isWatchCommand, type WatchCallback, type WatchSubscription, type WatchReply } from './watcher-rpc'
import { performanceTrace, isPerfTraceWorkerEvent, replayPerfTraceWorkerEvent } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

class WatcherServiceClient {
  private child: UtilityProcess | null = null
  private stopping = false
  private frozen = false
  private forceRequested = false
  private starts = 0
  private exitPromise: Promise<void> = Promise.resolve()
  private readonly rpc = new WatcherRpcClient(command => {
    const child = this.ensureProcess()
    this.trace('request-sent', { operation: command.op, requestId: command.id })
    try { child.postMessage(command) }
    catch (error) {
      this.trace('request-send-failed', { requestId: command.id })
      throw error
    }
  })

  private trace(phase: string, data: Record<string, unknown> = {}): void {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_WATCHER_SERVICE_LIFECYCLE, { phase, ...data })
  }

  subscribe(path: string, callback: WatchCallback, options: { ignore?: string[] } = {}): Promise<WatchSubscription> {
    if (this.stopping || this.frozen) {
      this.trace('subscribe-refused')
      return Promise.reject(new Error('Watcher service is stopping'))
    }
    return this.rpc.subscribe(path, callback, options)
  }

  freeze(): void {
    this.frozen = true
    this.trace('admission-closed', this.inspect())
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.exitPromise
    this.stopping = true
    this.frozen = true
    this.rpc.disconnect(new Error('Watcher service is stopping'), true)
    this.trace('shutdown-sent', this.inspect())
    try { this.child?.postMessage({ event: 'watcher-shutdown' }) }
    catch {
      this.trace('shutdown-send-failed')
      if (this.child) this.killOwnedProcess(this.child)
    }
    return this.exitPromise
  }

  forceStop(): void {
    this.stopping = true
    this.frozen = true
    this.rpc.disconnect(new Error('Watcher service terminated'), true)
    const child = this.child
    this.trace('force-stop', { pid: child?.pid ?? null })
    this.forceRequested = true
    if (child) this.killOwnedProcess(child)
  }

  inspect(): { pid: number | null; starts: number; stopping: boolean; subscriptions: number; pending: number } {
    return { pid: this.child?.pid ?? null, starts: this.starts, stopping: this.stopping, ...this.rpc.inspect() }
  }

  testExit(): void {
    if (process.env.ONWARD_AUTOTEST === '1' && this.child) this.killOwnedProcess(this.child)
  }

  testBlock(): Promise<void> {
    const child = this.child
    if (process.env.ONWARD_AUTOTEST !== '1' || !child) return Promise.reject(new Error('Watcher test hook unavailable'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.removeListener('message', receive)
        reject(new Error('Watcher block acknowledgment missing'))
      }, 5000)
      const receive = (message: { event?: string }) => {
        if (message?.event !== 'watcher-test-blocked') return
        clearTimeout(timer)
        child.removeListener('message', receive)
        resolve()
      }
      child.on('message', receive)
      child.postMessage({ event: 'watcher-test-block' })
    })
  }

  private ensureProcess(): UtilityProcess {
    if (this.stopping) throw new Error('Watcher service is stopping')
    if (this.child) return this.child
    if (this.frozen) {
      this.trace('spawn-refused')
      throw new Error('Watcher service admission is closed')
    }
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(join(__dirname, 'watcher-service-entry.js'), [], {
        serviceName: 'Onward Watcher Service', stdio: 'pipe',
        env: { ...process.env, ONWARD_WATCHER_OWNER_PID: String(process.pid) }
      })
    } catch (error) {
      this.trace('spawn-failed')
      throw error
    }
    this.child = child
    this.starts += 1
    this.trace('spawn', { starts: this.starts })
    child.stdout?.on('data', data => console.log('[WatcherService]', String(data).trimEnd()))
    child.stderr?.on('data', data => console.error('[WatcherService]', String(data).trimEnd()))
    this.exitPromise = new Promise(resolve => {
      child.once('exit', code => {
        if (this.child === child) this.child = null
        this.trace('exit', { code, stopping: this.stopping })
        console.log('[WatcherService] exited', { code, stopping: this.stopping })
        this.rpc.disconnect(new WatcherConnectionError('Watcher service exited'), this.stopping)
        resolve()
      })
    })
    child.on('spawn', () => {
      this.trace('spawned', { pid: child.pid })
      console.log('[WatcherService] spawned', { pid: child.pid })
      if (this.forceRequested) this.killOwnedProcess(child)
    })
    child.on('error', () => this.trace('native-error'))
    child.on('message', message => {
      if (this.child !== child) return
      if (isWatchReply(message)) {
        if (message.event === 'watcher-reply') this.trace('reply-received', { requestId: message.id, failed: Boolean(message.error) })
        this.rpc.receive(message)
      } else if (isPerfTraceWorkerEvent(message)) {
        replayPerfTraceWorkerEvent(message, { tid: 5008, threadName: 'native-watcher-service' })
      } else if (message?.event === 'watcher-drained') {
        this.trace('drained', { subscriptions: message.subscriptions, pending: message.pending })
      } else if (message?.event === 'watcher-ready') {
        this.trace('ready', { pid: message.pid })
      }
    })
    return child
  }

  private killOwnedProcess(child: UtilityProcess): void {
    const pid = child.pid
    if (this.child !== child || !pid) {
      this.trace('kill-skipped', { pendingSpawn: this.child === child && !pid })
      return
    }
    try {
      const sent = process.platform === 'win32' ? child.kill() : process.kill(pid, 'SIGKILL')
      // Electron's macOS kill() waits up to two seconds before SIGKILL. Use the
      // live owned PID directly on POSIX so the main input loop never blocks.
      this.trace(sent ? 'kill-sent' : 'kill-failed', { pid, platform: process.platform })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
      this.trace(code === 'ESRCH' ? 'kill-raced-exit' : 'kill-failed', { code })
    }
  }
}

export const watcherService = new WatcherServiceClient()

/** Scope subscription ownership to the exact worker instance, including late replies. */
export function bindWatcherWorker(worker: Worker): void {
  let closed = false
  const subscriptions = new Map<number, Promise<WatchSubscription>>()
  let batches = 0
  let events = 0
  let relayMs = 0
  const flushStats = () => {
    if (!batches) return
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_WATCHER_RELAY_STATS, { batches, events, durationMs: relayMs })
    batches = 0
    events = 0
    relayMs = 0
  }
  const statsTimer = setInterval(flushStats, 1000)
  statsTimer.unref()
  const send = (reply: WatchReply) => {
    if (closed) return
    const started = performance.now()
    worker.postMessage(reply)
    if (reply.event === 'watcher-events') {
      batches++
      events += reply.events.length
      relayMs += performance.now() - started
    }
  }
  worker.on('message', message => {
    if (!isWatchCommand(message) || closed) return
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_WATCHER_SERVICE_LIFECYCLE, { phase: 'worker-request-received', operation: message.op })
    let operation: Promise<unknown>
    if (message.op === 'subscribe') {
      const subscription = watcherService.subscribe(message.path, (error, events) => {
        send({ event: 'watcher-events', subscription: message.subscription, events, error: error?.message })
      }, { ignore: message.ignore })
      subscriptions.set(message.subscription, subscription)
      operation = subscription.then(async value => {
        if (closed) await value.unsubscribe()
      })
    } else {
      const subscription = subscriptions.get(message.subscription)
      subscriptions.delete(message.subscription)
      operation = subscription ? subscription.then(value => value.unsubscribe(), () => {}) : Promise.resolve()
    }
    void operation.then(() => send({ event: 'watcher-reply', id: message.id }), error => {
      subscriptions.delete(message.subscription)
      send({ event: 'watcher-reply', id: message.id, error: String(error?.message ?? error).slice(0, 256) })
    })
  })
  worker.once('exit', () => {
    closed = true
    clearInterval(statsTimer)
    flushStats()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_WATCHER_SERVICE_LIFECYCLE, { phase: 'worker-owner-exited', subscriptions: subscriptions.size })
    for (const subscription of subscriptions.values()) void subscription.then(value => value.unsubscribe()).catch(() => {})
    subscriptions.clear()
  })
}
