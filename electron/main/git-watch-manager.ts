/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename } from 'path'
import {
  getTerminalCwd,
  getGitRepoMeta,
  getGitRepoFingerprint,
  getGitBranchAndStatus,
  type TerminalGitInfo
} from './git-utils'
import { gitRuntimeManager } from './git-runtime-manager'

type TerminalInfoEmitter = (terminalId: string, info: TerminalGitInfo) => void

type WatchEntry = {
  terminalId: string
  cwd: string | null
  repoRoot: string | null
  gitDir: string | null
  pollTimer: NodeJS.Timeout | null
  nextPollAt: number
  inFlight: boolean
  pendingPoll: boolean
  manualRefreshPending: boolean
  disposed: boolean
  lastInfo: TerminalGitInfo | null
  lastFingerprint: string | null
  lastActivityAt: number
  lastPollAt: number
  lastStatusAt: number
}

type RepoBoostState = {
  boostedUntil: number
}

const ENABLE_ADAPTIVE_POLLING = process.env.ONWARD_GIT_POLLING !== '0'
const GIT_WATCH_DEBUG = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'

const ACTIVE_POLL_MS = 800
const IDLE_POLL_MS = 1200
const QUIET_POLL_MS = 3000

const ACTIVE_WINDOW_MS = 5000
const QUIET_WINDOW_MS = 45000

const STATUS_REFRESH_ACTIVE_MS = 1200
const STATUS_REFRESH_IDLE_MS = 3500
const STATUS_REFRESH_QUIET_MS = 7000

const ACTIVITY_TRIGGER_MS = 800
const MANUAL_TRIGGER_MS = 80

export class GitWatchManager {
  private entries = new Map<string, WatchEntry>()
  private repoBoostMap = new Map<string, RepoBoostState>()
  private focusedTerminalId: string | null = null

  // Diagnostic counters (1-second granularity)
  private diagActivityCalls = 0
  private diagPollRuns = 0
  private diagTimer: ReturnType<typeof setInterval> | null = null

  constructor(private emit: TerminalInfoEmitter) {
    if (GIT_WATCH_DEBUG) {
      this.diagTimer = setInterval(() => {
        if (this.diagActivityCalls > 0 || this.diagPollRuns > 0) {
          console.log(`[PerfDiag] GitWatch activityCalls/s=${this.diagActivityCalls} pollRuns/s=${this.diagPollRuns}`)
          this.diagActivityCalls = 0
          this.diagPollRuns = 0
        }
      }, 1000)
    }
  }

  async subscribe(terminalId: string): Promise<void> {
    if (this.entries.has(terminalId)) return

    const now = Date.now()
    const entry: WatchEntry = {
      terminalId,
      cwd: null,
      repoRoot: null,
      gitDir: null,
      pollTimer: null,
      nextPollAt: 0,
      inFlight: false,
      pendingPoll: false,
      manualRefreshPending: true,
      disposed: false,
      lastInfo: null,
      lastFingerprint: null,
      lastActivityAt: now,
      lastPollAt: 0,
      lastStatusAt: 0
    }

    this.entries.set(terminalId, entry)
    await this.runPoll(entry, 'subscribe')
  }

  unsubscribe(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (this.focusedTerminalId === terminalId) {
      this.focusedTerminalId = null
      if (entry.repoRoot) {
        this.repoBoostMap.delete(entry.repoRoot)
      }
    }
    this.disposeEntry(entry)
    this.entries.delete(terminalId)
  }

  dispose(): void {
    if (this.diagTimer) {
      clearInterval(this.diagTimer)
      this.diagTimer = null
    }
    Array.from(this.entries.values()).forEach((entry) => {
      this.disposeEntry(entry)
    })
    this.entries.clear()
    this.repoBoostMap.clear()
    this.focusedTerminalId = null
  }

  notifyTerminalActivity(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return

    if (GIT_WATCH_DEBUG) this.diagActivityCalls += 1
    entry.lastActivityAt = Date.now()
    if (entry.repoRoot && this.focusedTerminalId === terminalId) {
      this.boostRepo(entry.repoRoot)
    }
    if (entry.inFlight) {
      entry.pendingPoll = true
      return
    }

    this.schedulePoll(entry, ACTIVITY_TRIGGER_MS)
  }

  notifyTerminalGitUpdate(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return

    entry.manualRefreshPending = true
    entry.lastActivityAt = Date.now()
    if (entry.inFlight) {
      entry.pendingPoll = true
      return
    }

    this.schedulePoll(entry, MANUAL_TRIGGER_MS)
  }

  notifyTerminalFocus(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return

    const now = Date.now()
    const previousFocusedEntry = this.focusedTerminalId ? this.entries.get(this.focusedTerminalId) : null
    if (previousFocusedEntry?.repoRoot && previousFocusedEntry.repoRoot !== entry.repoRoot) {
      this.repoBoostMap.delete(previousFocusedEntry.repoRoot)
    }

    this.focusedTerminalId = terminalId
    entry.lastActivityAt = now
    entry.manualRefreshPending = true

    if (entry.repoRoot) {
      this.boostRepo(entry.repoRoot, true)
    }

    if (entry.inFlight) {
      entry.pendingPoll = true
      return
    }

    this.schedulePoll(entry, 0)
  }

  private disposeEntry(entry: WatchEntry): void {
    entry.disposed = true
    if (entry.pollTimer) {
      clearTimeout(entry.pollTimer)
      entry.pollTimer = null
    }
    entry.nextPollAt = 0
  }

  private schedulePoll(entry: WatchEntry, delayMs: number): void {
    if (entry.disposed) return

    const safeDelay = Math.max(0, delayMs)
    const dueAt = Date.now() + safeDelay

    if (entry.pollTimer && dueAt >= entry.nextPollAt) {
      return
    }

    if (entry.pollTimer) {
      clearTimeout(entry.pollTimer)
      entry.pollTimer = null
    }

    entry.nextPollAt = dueAt
    entry.pollTimer = setTimeout(() => {
      entry.pollTimer = null
      entry.nextPollAt = 0
      void this.runPoll(entry, 'timer')
    }, safeDelay)
  }

  private async runPoll(entry: WatchEntry, reason: string): Promise<void> {
    if (entry.disposed) return
    if (entry.inFlight) {
      entry.pendingPoll = true
      return
    }

    entry.inFlight = true
    entry.lastPollAt = Date.now()
    if (GIT_WATCH_DEBUG) this.diagPollRuns += 1

    try {
      await this.refreshInfo(entry, reason)
    } catch (error) {
      console.warn('[GitWatch] poll failed:', error)
    } finally {
      entry.inFlight = false
      if (entry.disposed) return

      if (entry.pendingPoll) {
        entry.pendingPoll = false
        this.schedulePoll(entry, ACTIVITY_TRIGGER_MS)
        return
      }

      this.schedulePoll(entry, this.getPollInterval(entry))
    }
  }

  private getPollInterval(entry: WatchEntry): number {
    if (entry.repoRoot && this.isRepoBoosted(entry.repoRoot)) {
      return ACTIVE_POLL_MS
    }

    if (!ENABLE_ADAPTIVE_POLLING) {
      return IDLE_POLL_MS
    }

    const idleFor = Date.now() - entry.lastActivityAt
    if (idleFor <= ACTIVE_WINDOW_MS) {
      return ACTIVE_POLL_MS
    }
    if (idleFor <= QUIET_WINDOW_MS) {
      return IDLE_POLL_MS
    }
    return QUIET_POLL_MS
  }

  private getStatusRefreshInterval(entry: WatchEntry): number {
    if (entry.repoRoot && this.isRepoBoosted(entry.repoRoot)) {
      return STATUS_REFRESH_ACTIVE_MS
    }

    if (!ENABLE_ADAPTIVE_POLLING) {
      return STATUS_REFRESH_IDLE_MS
    }

    const idleFor = Date.now() - entry.lastActivityAt
    if (idleFor <= ACTIVE_WINDOW_MS) {
      return STATUS_REFRESH_ACTIVE_MS
    }
    if (idleFor <= QUIET_WINDOW_MS) {
      return STATUS_REFRESH_IDLE_MS
    }
    return STATUS_REFRESH_QUIET_MS
  }

  private async refreshInfo(entry: WatchEntry, _reason: string): Promise<void> {
    const cwd = await getTerminalCwd(entry.terminalId)
    const cwdChanged = cwd !== entry.cwd
    entry.cwd = cwd

    if (!cwd) {
      entry.repoRoot = null
      entry.gitDir = null
      entry.lastFingerprint = null
      entry.manualRefreshPending = false
      entry.lastStatusAt = 0
      this.emitInfo(entry, {
        cwd: null,
        branch: null,
        repoName: null,
        status: null
      })
      return
    }

    const meta = await getGitRepoMeta(cwd)
    if (!meta.isRepo || !meta.repoRoot) {
      entry.repoRoot = null
      entry.gitDir = null
      entry.lastFingerprint = null
      entry.manualRefreshPending = false
      entry.lastStatusAt = 0
      this.emitInfo(entry, {
        cwd,
        branch: null,
        repoName: null,
        status: null
      })
      return
    }

    const repoChanged = entry.repoRoot !== meta.repoRoot || entry.gitDir !== meta.gitDir
    entry.repoRoot = meta.repoRoot
    entry.gitDir = meta.gitDir
    if (this.focusedTerminalId === entry.terminalId && entry.repoRoot) {
      this.boostRepo(entry.repoRoot, !this.isRepoBoosted(entry.repoRoot))
    }

    const fingerprint = await getGitRepoFingerprint(meta.gitDir, meta.repoRoot)
    const fingerprintChanged = fingerprint !== entry.lastFingerprint
    entry.lastFingerprint = fingerprint

    const now = Date.now()
    const statusStale = now - entry.lastStatusAt >= this.getStatusRefreshInterval(entry)
    const shouldRefresh = cwdChanged || repoChanged || fingerprintChanged || entry.manualRefreshPending || !entry.lastInfo || statusStale
    if (!shouldRefresh) {
      return
    }

    const refreshStartedAt = Date.now()
    const snapshot = await getGitBranchAndStatus(meta.repoRoot)
    const repoName = basename(meta.repoRoot.replace(/[\\/]+$/, '')) || null

    this.emitInfo(entry, {
      cwd,
      branch: snapshot.branch,
      repoName,
      status: snapshot.status
    })
    entry.lastStatusAt = Date.now()
    entry.manualRefreshPending = false

    gitRuntimeManager.recordTitleRefreshLatency(Date.now() - refreshStartedAt)
  }

  private emitInfo(entry: WatchEntry, info: TerminalGitInfo): void {
    if (this.isSameInfo(entry.lastInfo, info)) return
    entry.lastInfo = info
    this.emit(entry.terminalId, info)
  }

  private isRepoBoosted(repoRoot: string): boolean {
    const state = this.repoBoostMap.get(repoRoot)
    if (!state) return false
    if (state.boostedUntil > Date.now()) return true
    this.repoBoostMap.delete(repoRoot)
    return false
  }

  private boostRepo(repoRoot: string, forceImmediate = false): void {
    const boostedUntil = Date.now() + ACTIVE_WINDOW_MS
    this.repoBoostMap.set(repoRoot, { boostedUntil })

    if (!forceImmediate) return

    this.entries.forEach((item) => {
      if (item.disposed) return
      if (item.repoRoot !== repoRoot) return
      item.lastActivityAt = Date.now()
      this.schedulePoll(item, 0)
    })
  }

  private isSameInfo(prev: TerminalGitInfo | null, next: TerminalGitInfo | null): boolean {
    if (!prev && !next) return true
    if (!prev || !next) return false
    return (
      prev.cwd === next.cwd &&
      prev.branch === next.branch &&
      prev.repoName === next.repoName &&
      prev.status === next.status
    )
  }
}
