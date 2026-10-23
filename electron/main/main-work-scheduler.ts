/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type MainWorkLane =
  | 'realtime-input'
  | 'focused-interactive'
  | 'visible-ui'
  | 'background-index'
  | 'maintenance'

export interface MainWorkOptions {
  lane?: MainWorkLane
  key?: string
  ownerId?: string
  label?: string
  timeoutMs?: number
  concurrencyKey?: string
  concurrencyLimit?: number
}

interface LatencyBucket {
  count: number
  totalMs: number
  maxMs: number
  samples: number[]
}

interface LaneMetrics {
  scheduled: number
  completed: number
  failed: number
  cancelled: number
  timedOut: number
  wait: LatencyBucket
  run: LatencyBucket
}

export interface MainWorkLatencySummary {
  count: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

export interface MainWorkSchedulerMetrics {
  scheduler: {
    inflightCurrent: number
    inflightPeak: number
    queueDepthCurrent: number
    queueDepthPeak: number
    dedupeHits: number
    totalScheduled: number
    totalCompleted: number
    totalFailed: number
    totalCancelled: number
    totalTimedOut: number
    maxInflight: number
  }
  lanes: Record<MainWorkLane, {
    scheduled: number
    completed: number
    failed: number
    cancelled: number
    timedOut: number
    wait: MainWorkLatencySummary
    run: MainWorkLatencySummary
  }>
  updatedAt: number
}

type QueueTask<T> = {
  id: number
  options: Required<Pick<MainWorkOptions, 'lane'>> & Omit<MainWorkOptions, 'lane'>
  createdAt: number
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error?: unknown) => void
  promise: Promise<T>
  timeout: ReturnType<typeof setTimeout> | null
  started: boolean
}

const DEFAULT_MAX_INFLIGHT = clampPositive(Number(process.env.ONWARD_MAIN_WORK_MAX_CONCURRENCY || '8'), 8)
const MAX_SAMPLE_SIZE = 1024

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function createLatencyBucket(): LatencyBucket {
  return {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    samples: []
  }
}

function recordLatency(bucket: LatencyBucket, valueMs: number): void {
  const value = Number.isFinite(valueMs) && valueMs >= 0 ? valueMs : 0
  bucket.count += 1
  bucket.totalMs += value
  bucket.maxMs = Math.max(bucket.maxMs, value)
  bucket.samples.push(value)
  if (bucket.samples.length > MAX_SAMPLE_SIZE) {
    bucket.samples.shift()
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)))
  return sorted[index]
}

function summarize(bucket: LatencyBucket): MainWorkLatencySummary {
  if (bucket.count === 0) {
    return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }
  }
  const sorted = [...bucket.samples].sort((a, b) => a - b)
  return {
    count: bucket.count,
    avgMs: bucket.totalMs / bucket.count,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: bucket.maxMs
  }
}

function createLaneMetrics(): LaneMetrics {
  return {
    scheduled: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    wait: createLatencyBucket(),
    run: createLatencyBucket()
  }
}

function normalizeLane(lane: MainWorkLane | undefined): MainWorkLane {
  if (
    lane === 'realtime-input' ||
    lane === 'focused-interactive' ||
    lane === 'visible-ui' ||
    lane === 'background-index' ||
    lane === 'maintenance'
  ) {
    return lane
  }
  return 'visible-ui'
}

function laneRank(lane: MainWorkLane): number {
  switch (lane) {
    case 'realtime-input':
      return 5
    case 'focused-interactive':
      return 4
    case 'visible-ui':
      return 3
    case 'background-index':
      return 2
    case 'maintenance':
      return 1
    default:
      return 3
  }
}

export class MainWorkScheduler {
  private nextTaskId = 1
  private inflight = 0
  private inflightPeak = 0
  private queueDepthPeak = 0
  private dedupeHits = 0
  private totalScheduled = 0
  private totalCompleted = 0
  private totalFailed = 0
  private totalCancelled = 0
  private totalTimedOut = 0
  private draining = false
  private queue: QueueTask<unknown>[] = []
  private dedupeMap = new Map<string, Promise<unknown>>()
  private inflightByConcurrencyKey = new Map<string, number>()
  private preservedOwners: ReadonlySet<string> | null = null
  private readonly metrics: Record<MainWorkLane, LaneMetrics> = {
    'realtime-input': createLaneMetrics(),
    'focused-interactive': createLaneMetrics(),
    'visible-ui': createLaneMetrics(),
    'background-index': createLaneMetrics(),
    maintenance: createLaneMetrics()
  }
  private updatedAt = Date.now()

  enqueue<T>(options: MainWorkOptions, run: () => Promise<T>): Promise<T> {
    const normalizedOptions: QueueTask<T>['options'] = {
      lane: normalizeLane(options.lane),
      key: options.key,
      ownerId: options.ownerId,
      label: options.label,
      timeoutMs: options.timeoutMs,
      concurrencyKey: options.concurrencyKey,
      concurrencyLimit: options.concurrencyLimit
    }

    if (normalizedOptions.key) {
      const existing = this.dedupeMap.get(normalizedOptions.key)
      if (existing) {
        this.dedupeHits += 1
        this.updatedAt = Date.now()
        return existing as Promise<T>
      }
    }

    let resolveTask: (value: T) => void = () => {}
    let rejectTask: (error?: unknown) => void = () => {}
    const promise = new Promise<T>((resolve, reject) => {
      resolveTask = resolve
      rejectTask = reject
    })

    const task: QueueTask<T> = {
      id: this.nextTaskId++,
      options: normalizedOptions,
      createdAt: Date.now(),
      run,
      resolve: resolveTask,
      reject: rejectTask,
      promise,
      timeout: null,
      started: false
    }

    this.queue.push(task as QueueTask<unknown>)
    this.totalScheduled += 1
    this.metrics[normalizedOptions.lane].scheduled += 1
    this.queueDepthPeak = Math.max(this.queueDepthPeak, this.queue.length)
    this.updatedAt = Date.now()

    if (normalizedOptions.key) {
      this.dedupeMap.set(normalizedOptions.key, promise as Promise<unknown>)
    }

    this.scheduleDrain()
    return promise
  }

  cancelOwner(ownerId: string, reason = 'owner cancelled'): number {
    let cancelled = 0
    const kept: QueueTask<unknown>[] = []
    for (const task of this.queue) {
      if (task.options.ownerId !== ownerId) {
        kept.push(task)
        continue
      }
      this.finishQueuedCancellation(task, new Error(reason))
      cancelled += 1
    }
    this.queue = kept
    if (cancelled > 0) {
      this.updatedAt = Date.now()
    }
    return cancelled
  }

  cancelAllExcept(preservedOwners: ReadonlySet<string>, reason = 'application shutting down'): number {
    this.preservedOwners = new Set(preservedOwners)
    let cancelled = 0
    const kept: QueueTask<unknown>[] = []
    for (const task of this.queue) {
      if (task.options.ownerId && this.preservedOwners.has(task.options.ownerId)) {
        kept.push(task)
        continue
      }
      this.finishQueuedCancellation(task, new Error(reason))
      cancelled += 1
    }
    this.queue = kept
    this.drainPreservedTasks()
    if (cancelled > 0) {
      this.updatedAt = Date.now()
    }
    return cancelled
  }

  getMetrics(): MainWorkSchedulerMetrics {
    return {
      scheduler: {
        inflightCurrent: this.inflight,
        inflightPeak: this.inflightPeak,
        queueDepthCurrent: this.queue.length,
        queueDepthPeak: this.queueDepthPeak,
        dedupeHits: this.dedupeHits,
        totalScheduled: this.totalScheduled,
        totalCompleted: this.totalCompleted,
        totalFailed: this.totalFailed,
        totalCancelled: this.totalCancelled,
        totalTimedOut: this.totalTimedOut,
        maxInflight: DEFAULT_MAX_INFLIGHT
      },
      lanes: {
        'realtime-input': this.summarizeLane('realtime-input'),
        'focused-interactive': this.summarizeLane('focused-interactive'),
        'visible-ui': this.summarizeLane('visible-ui'),
        'background-index': this.summarizeLane('background-index'),
        maintenance: this.summarizeLane('maintenance')
      },
      updatedAt: this.updatedAt
    }
  }

  private summarizeLane(lane: MainWorkLane): MainWorkSchedulerMetrics['lanes'][MainWorkLane] {
    const metric = this.metrics[lane]
    return {
      scheduled: metric.scheduled,
      completed: metric.completed,
      failed: metric.failed,
      cancelled: metric.cancelled,
      timedOut: metric.timedOut,
      wait: summarize(metric.wait),
      run: summarize(metric.run)
    }
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    setImmediate(() => {
      this.draining = false
      this.drainQueue()
    })
  }

  /**
   * After cancelAllExcept, preserved owners (the final app-state save) must
   * not wait behind in-flight background work that cannot be cancelled. Only
   * concurrency-keyed tasks may bypass the global cap, so the bypass stays
   * bounded by their own single-flight limit and can never fan out unbounded.
   */
  private drainPreservedTasks(): void {
    if (!this.preservedOwners || this.preservedOwners.size === 0) return
    let index = 0
    while (index < this.queue.length) {
      const task = this.queue[index]
      if (
        task &&
        task.options.ownerId &&
        task.options.concurrencyKey &&
        this.preservedOwners.has(task.options.ownerId) &&
        this.canRunTask(task)
      ) {
        this.queue.splice(index, 1)
        this.startTask(task)
        continue
      }
      index += 1
    }
  }

  private drainQueue(): void {
    this.drainPreservedTasks()
    while (this.inflight < DEFAULT_MAX_INFLIGHT) {
      const nextIndex = this.pickNextRunnableTaskIndex()
      if (nextIndex < 0) break
      const [task] = this.queue.splice(nextIndex, 1)
      if (!task) break
      this.startTask(task)
    }
    this.updatedAt = Date.now()
  }

  private pickNextRunnableTaskIndex(): number {
    let bestIndex = -1
    let bestRank = -1
    let bestId = Number.MAX_SAFE_INTEGER

    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.queue[index]
      if (!this.canRunTask(task)) continue
      const rank = laneRank(task.options.lane)
      if (rank > bestRank || (rank === bestRank && task.id < bestId)) {
        bestIndex = index
        bestRank = rank
        bestId = task.id
      }
    }

    return bestIndex
  }

  private canRunTask(task: QueueTask<unknown>): boolean {
    if (!task.options.concurrencyKey) return true
    const limit = clampPositive(task.options.concurrencyLimit ?? 1, 1)
    const current = this.inflightByConcurrencyKey.get(task.options.concurrencyKey) || 0
    return current < limit
  }

  private startTask(task: QueueTask<unknown>): void {
    task.started = true
    this.inflight += 1
    this.inflightPeak = Math.max(this.inflightPeak, this.inflight)
    if (task.options.concurrencyKey) {
      this.inflightByConcurrencyKey.set(
        task.options.concurrencyKey,
        (this.inflightByConcurrencyKey.get(task.options.concurrencyKey) || 0) + 1
      )
    }

    const startedAt = Date.now()
    recordLatency(this.metrics[task.options.lane].wait, startedAt - task.createdAt)

    if (task.options.timeoutMs && task.options.timeoutMs > 0) {
      task.timeout = setTimeout(() => {
        task.timeout = null
        this.totalTimedOut += 1
        this.metrics[task.options.lane].timedOut += 1
        task.reject(new Error(`Main work timed out: ${task.options.label || task.id}`))
      }, task.options.timeoutMs)
    }

    Promise.resolve()
      .then(() => task.run())
      .then((value) => {
        this.totalCompleted += 1
        this.metrics[task.options.lane].completed += 1
        recordLatency(this.metrics[task.options.lane].run, Date.now() - startedAt)
        task.resolve(value)
      })
      .catch((error) => {
        this.totalFailed += 1
        this.metrics[task.options.lane].failed += 1
        recordLatency(this.metrics[task.options.lane].run, Date.now() - startedAt)
        task.reject(error)
      })
      .finally(() => {
        if (task.timeout) {
          clearTimeout(task.timeout)
          task.timeout = null
        }
        this.completeTask(task)
      })
  }

  private completeTask(task: QueueTask<unknown>): void {
    this.inflight = Math.max(0, this.inflight - 1)
    if (task.options.concurrencyKey) {
      const current = (this.inflightByConcurrencyKey.get(task.options.concurrencyKey) || 0) - 1
      if (current <= 0) {
        this.inflightByConcurrencyKey.delete(task.options.concurrencyKey)
      } else {
        this.inflightByConcurrencyKey.set(task.options.concurrencyKey, current)
      }
    }
    if (task.options.key) {
      const existing = this.dedupeMap.get(task.options.key)
      if (existing === task.promise) {
        this.dedupeMap.delete(task.options.key)
      }
    }
    this.updatedAt = Date.now()
    this.scheduleDrain()
  }

  private finishQueuedCancellation(task: QueueTask<unknown>, error: Error): void {
    this.totalCancelled += 1
    this.metrics[task.options.lane].cancelled += 1
    if (task.options.key) {
      const existing = this.dedupeMap.get(task.options.key)
      if (existing === task.promise) {
        this.dedupeMap.delete(task.options.key)
      }
    }
    task.reject(error)
  }
}

export const mainWorkScheduler = new MainWorkScheduler()
