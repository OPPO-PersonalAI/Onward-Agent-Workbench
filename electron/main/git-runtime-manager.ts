/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type GitTaskPriority = 'high' | 'normal' | 'low'
export type GitTaskKind = 'git' | 'cwd' | 'misc'

export interface GitTaskOptions {
  key?: string
  repoKey?: string
  priority?: GitTaskPriority
  kind?: GitTaskKind
  label?: string
}

type LatencyBucket = {
  count: number
  totalMs: number
  maxMs: number
  samples: number[]
}

type KindMetrics = {
  scheduled: number
  completed: number
  failed: number
  latencies: LatencyBucket
}

export interface GitLatencySummary {
  count: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface GitRuntimeMetrics {
  scheduler: {
    inflightCurrent: number
    inflightPeak: number
    queueDepthCurrent: number
    queueDepthPeak: number
    dedupHits: number
    totalScheduled: number
    totalCompleted: number
    totalFailed: number
    maxInflight: number
    maxPerRepoInflight: number
  }
  kinds: Record<GitTaskKind, {
    scheduled: number
    completed: number
    failed: number
    latency: GitLatencySummary
  }>
  latencies: {
    titleRefresh: GitLatencySummary
    cwdProbe: GitLatencySummary
  }
  updatedAt: number
}

type QueueTask<T> = {
  id: number
  options: Required<Pick<GitTaskOptions, 'priority' | 'kind'>> & Omit<GitTaskOptions, 'priority' | 'kind'>
  createdAt: number
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error?: unknown) => void
  promise: Promise<T>
}

const DEFAULT_MAX_INFLIGHT = Number(process.env.ONWARD_GIT_MAX_CONCURRENCY || '6')
const DEFAULT_MAX_PER_REPO = Number(process.env.ONWARD_GIT_MAX_PER_REPO || '3')
const MAX_SAMPLE_SIZE = 512

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

function recordLatency(bucket: LatencyBucket, latencyMs: number): void {
  const value = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0
  bucket.count += 1
  bucket.totalMs += value
  if (value > bucket.maxMs) {
    bucket.maxMs = value
  }
  bucket.samples.push(value)
  if (bucket.samples.length > MAX_SAMPLE_SIZE) {
    bucket.samples.shift()
  }
}

function percentileFromSorted(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0
  const position = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile)))
  return sorted[position]
}

function summarizeLatency(bucket: LatencyBucket): GitLatencySummary {
  if (bucket.count === 0) {
    return {
      count: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0
    }
  }

  const sorted = [...bucket.samples].sort((a, b) => a - b)
  const avgMs = bucket.totalMs / bucket.count
  return {
    count: bucket.count,
    avgMs,
    p50Ms: percentileFromSorted(sorted, 0.5),
    p95Ms: percentileFromSorted(sorted, 0.95),
    maxMs: bucket.maxMs
  }
}

function normalizePriority(priority: GitTaskPriority | undefined): GitTaskPriority {
  if (priority === 'high' || priority === 'normal' || priority === 'low') return priority
  return 'normal'
}

function normalizeKind(kind: GitTaskKind | undefined): GitTaskKind {
  if (kind === 'git' || kind === 'cwd' || kind === 'misc') return kind
  return 'git'
}

function priorityRank(priority: GitTaskPriority): number {
  switch (priority) {
    case 'high':
      return 3
    case 'normal':
      return 2
    case 'low':
      return 1
    default:
      return 2
  }
}

export class GitRuntimeManager {
  private readonly maxInflight = clampPositive(DEFAULT_MAX_INFLIGHT, 4)
  private readonly maxPerRepoInflight = clampPositive(DEFAULT_MAX_PER_REPO, 1)

  private nextTaskId = 1
  private inflight = 0
  private inflightPeak = 0
  private queueDepthPeak = 0
  private dedupHits = 0
  private totalScheduled = 0
  private totalCompleted = 0
  private totalFailed = 0

  private queue: QueueTask<unknown>[] = []
  private dedupeMap = new Map<string, Promise<unknown>>()
  private inflightByRepo = new Map<string, number>()
  private draining = false

  private readonly kindMetrics: Record<GitTaskKind, KindMetrics> = {
    git: { scheduled: 0, completed: 0, failed: 0, latencies: createLatencyBucket() },
    cwd: { scheduled: 0, completed: 0, failed: 0, latencies: createLatencyBucket() },
    misc: { scheduled: 0, completed: 0, failed: 0, latencies: createLatencyBucket() }
  }

  private readonly titleRefreshLatency = createLatencyBucket()
  private readonly cwdProbeLatency = createLatencyBucket()
  private updatedAt = Date.now()

  enqueueTask<T>(options: GitTaskOptions, run: () => Promise<T>): Promise<T> {
    const normalizedOptions: QueueTask<T>['options'] = {
      key: options.key,
      repoKey: options.repoKey,
      priority: normalizePriority(options.priority),
      kind: normalizeKind(options.kind),
      label: options.label
    }

    if (normalizedOptions.key) {
      const existing = this.dedupeMap.get(normalizedOptions.key)
      if (existing) {
        this.dedupHits += 1
        this.updatedAt = Date.now()
        return existing as Promise<T>
      }
    }

    let resolvePromise: (value: T) => void = () => {}
    let rejectPromise: (error?: unknown) => void = () => {}
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    const task: QueueTask<T> = {
      id: this.nextTaskId++,
      options: normalizedOptions,
      createdAt: Date.now(),
      run,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise
    }

    this.queue.push(task as QueueTask<unknown>)
    this.totalScheduled += 1
    this.kindMetrics[task.options.kind].scheduled += 1
    this.queueDepthPeak = Math.max(this.queueDepthPeak, this.queue.length)
    this.updatedAt = Date.now()

    if (normalizedOptions.key) {
      this.dedupeMap.set(normalizedOptions.key, promise as Promise<unknown>)
    }

    this.scheduleDrain()
    return promise
  }

  recordTitleRefreshLatency(latencyMs: number): void {
    recordLatency(this.titleRefreshLatency, latencyMs)
    this.updatedAt = Date.now()
  }

  recordCwdProbeLatency(latencyMs: number): void {
    recordLatency(this.cwdProbeLatency, latencyMs)
    this.updatedAt = Date.now()
  }

  getMetrics(): GitRuntimeMetrics {
    return {
      scheduler: {
        inflightCurrent: this.inflight,
        inflightPeak: this.inflightPeak,
        queueDepthCurrent: this.queue.length,
        queueDepthPeak: this.queueDepthPeak,
        dedupHits: this.dedupHits,
        totalScheduled: this.totalScheduled,
        totalCompleted: this.totalCompleted,
        totalFailed: this.totalFailed,
        maxInflight: this.maxInflight,
        maxPerRepoInflight: this.maxPerRepoInflight
      },
      kinds: {
        git: {
          scheduled: this.kindMetrics.git.scheduled,
          completed: this.kindMetrics.git.completed,
          failed: this.kindMetrics.git.failed,
          latency: summarizeLatency(this.kindMetrics.git.latencies)
        },
        cwd: {
          scheduled: this.kindMetrics.cwd.scheduled,
          completed: this.kindMetrics.cwd.completed,
          failed: this.kindMetrics.cwd.failed,
          latency: summarizeLatency(this.kindMetrics.cwd.latencies)
        },
        misc: {
          scheduled: this.kindMetrics.misc.scheduled,
          completed: this.kindMetrics.misc.completed,
          failed: this.kindMetrics.misc.failed,
          latency: summarizeLatency(this.kindMetrics.misc.latencies)
        }
      },
      latencies: {
        titleRefresh: summarizeLatency(this.titleRefreshLatency),
        cwdProbe: summarizeLatency(this.cwdProbeLatency)
      },
      updatedAt: this.updatedAt
    }
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    queueMicrotask(() => {
      this.draining = false
      this.drainQueue()
    })
  }

  private drainQueue(): void {
    while (this.inflight < this.maxInflight) {
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
    let bestTaskId = Number.MAX_SAFE_INTEGER

    for (let i = 0; i < this.queue.length; i += 1) {
      const task = this.queue[i]
      if (!this.canRunTask(task)) continue

      const rank = priorityRank(task.options.priority)
      if (rank > bestRank || (rank === bestRank && task.id < bestTaskId)) {
        bestIndex = i
        bestRank = rank
        bestTaskId = task.id
      }
    }

    return bestIndex
  }

  private canRunTask(task: QueueTask<unknown>): boolean {
    if (!task.options.repoKey) return true
    const current = this.inflightByRepo.get(task.options.repoKey) || 0
    return current < this.maxPerRepoInflight
  }

  private startTask(task: QueueTask<unknown>): void {
    this.inflight += 1
    this.inflightPeak = Math.max(this.inflightPeak, this.inflight)
    if (task.options.repoKey) {
      this.inflightByRepo.set(task.options.repoKey, (this.inflightByRepo.get(task.options.repoKey) || 0) + 1)
    }


    const startedAt = Date.now()

    Promise.resolve()
      .then(() => task.run())
      .then((value) => {
        this.totalCompleted += 1
        this.kindMetrics[task.options.kind].completed += 1
        recordLatency(this.kindMetrics[task.options.kind].latencies, Date.now() - startedAt)

        task.resolve(value)
      })
      .catch((error) => {
        this.totalFailed += 1
        this.kindMetrics[task.options.kind].failed += 1
        recordLatency(this.kindMetrics[task.options.kind].latencies, Date.now() - startedAt)

        task.reject(error)
      })
      .finally(() => {
        this.inflight = Math.max(0, this.inflight - 1)

        if (task.options.repoKey) {
          const current = (this.inflightByRepo.get(task.options.repoKey) || 0) - 1
          if (current <= 0) {
            this.inflightByRepo.delete(task.options.repoKey)
          } else {
            this.inflightByRepo.set(task.options.repoKey, current)
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
      })
  }
}

export const gitRuntimeManager = new GitRuntimeManager()
