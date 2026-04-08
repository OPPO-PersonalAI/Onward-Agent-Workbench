/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { TELEMETRY_FORCE_UPLOAD } from './telemetry-constants'

/**
 * Daily telemetry aggregator.
 *
 * Accumulates usage statistics in memory and persists to disk periodically.
 * Once per day, the aggregated summary is uploaded to Azure and counters are reset.
 */

export interface DailyStats {
  /** Date string YYYY-MM-DD for which this data applies */
  date: string
  /** Timestamp of last upload (0 = never uploaded) */
  lastUploadedAt: number

  // --- Session ---
  /** Number of app sessions started today */
  sessionCount: number
  /** Array of individual session active durations (ms) for min/max/avg/p50/p95 */
  sessionDurations: number[]

  // --- Heartbeat snapshots (for tab/terminal/layout analysis) ---
  /** Sampled tabCount values from heartbeats */
  tabCounts: number[]
  /** Sampled terminalCount values from heartbeats */
  terminalCounts: number[]
  /** Sampled layoutMode values from heartbeats */
  layoutModes: number[]

  // --- Feature usage counts ---
  /** prompt/use action counts */
  promptSend: number
  promptExecute: number
  promptSendAndExecute: number

  /** dropdown feature click counts (menu + shortcut) */
  dropdownWorkspaceOpenDir: number
  dropdownWorkspaceChangeDir: number
  dropdownDevelopmentEditor: number
  dropdownDevelopmentGitDiff: number
  dropdownDevelopmentGitHistory: number
  dropdownToolsClaudeCode: number
  dropdownToolsCodex: number
  dropdownToolsBrowser: number

  // --- Errors ---
  rendererCrashCount: number
}

function createEmptyStats(date: string): DailyStats {
  return {
    date,
    lastUploadedAt: 0,
    sessionCount: 0,
    sessionDurations: [],
    tabCounts: [],
    terminalCounts: [],
    layoutModes: [],
    promptSend: 0,
    promptExecute: 0,
    promptSendAndExecute: 0,
    dropdownWorkspaceOpenDir: 0,
    dropdownWorkspaceChangeDir: 0,
    dropdownDevelopmentEditor: 0,
    dropdownDevelopmentGitDiff: 0,
    dropdownDevelopmentGitHistory: 0,
    dropdownToolsClaudeCode: 0,
    dropdownToolsCodex: 0,
    dropdownToolsBrowser: 0,
    rendererCrashCount: 0
  }
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

/**
 * Build an aggregated summary from daily stats for upload.
 */
export function buildDailySummary(stats: DailyStats): Record<string, string | number> {
  const durations = [...stats.sessionDurations].sort((a, b) => a - b)
  const totalActiveMs = durations.reduce((sum, d) => sum + d, 0)

  const tabSorted = [...stats.tabCounts].sort((a, b) => a - b)
  const termSorted = [...stats.terminalCounts].sort((a, b) => a - b)
  const layoutSorted = [...stats.layoutModes].sort((a, b) => a - b)

  return {
    date: stats.date,

    // Session statistics
    sessionCount: stats.sessionCount,
    totalActiveMs,
    sessionDurationMin: durations[0] ?? 0,
    sessionDurationMax: durations[durations.length - 1] ?? 0,
    sessionDurationAvg: durations.length > 0 ? Math.round(totalActiveMs / durations.length) : 0,
    sessionDurationP50: computePercentile(durations, 50),
    sessionDurationP95: computePercentile(durations, 95),

    // Workspace scale (from heartbeat snapshots)
    tabCountMax: tabSorted[tabSorted.length - 1] ?? 0,
    tabCountAvg: tabSorted.length > 0 ? Math.round(tabSorted.reduce((s, v) => s + v, 0) / tabSorted.length) : 0,
    terminalCountMax: termSorted[termSorted.length - 1] ?? 0,
    terminalCountAvg: termSorted.length > 0 ? Math.round(termSorted.reduce((s, v) => s + v, 0) / termSorted.length) : 0,
    layoutModeMax: layoutSorted[layoutSorted.length - 1] ?? 0,

    // Feature usage counts
    promptSend: stats.promptSend,
    promptExecute: stats.promptExecute,
    promptSendAndExecute: stats.promptSendAndExecute,
    dropdownWorkspaceOpenDir: stats.dropdownWorkspaceOpenDir,
    dropdownWorkspaceChangeDir: stats.dropdownWorkspaceChangeDir,
    dropdownDevelopmentEditor: stats.dropdownDevelopmentEditor,
    dropdownDevelopmentGitDiff: stats.dropdownDevelopmentGitDiff,
    dropdownDevelopmentGitHistory: stats.dropdownDevelopmentGitHistory,
    dropdownToolsClaudeCode: stats.dropdownToolsClaudeCode,
    dropdownToolsCodex: stats.dropdownToolsCodex,
    dropdownToolsBrowser: stats.dropdownToolsBrowser,

    // Errors
    rendererCrashCount: stats.rendererCrashCount
  }
}

class DailyAggregator {
  private stats: DailyStats
  private storagePath: string

  constructor() {
    this.storagePath = join(app.getPath('userData'), 'telemetry-daily.json')
    this.stats = this.load()
    // If the date rolled over, the old stats should have been uploaded.
    // If they weren't (e.g. app wasn't running), we reset for today.
    if (this.stats.date !== getTodayDate()) {
      this.stats = createEmptyStats(getTodayDate())
    }
  }

  // --- Recording methods ---

  recordSessionStart(): void {
    this.stats.sessionCount++
    this.persist()
  }

  recordSessionEnd(activeMs: number): void {
    this.stats.sessionDurations.push(activeMs)
    this.persist()
  }

  recordHeartbeat(tabCount: number, terminalCount: number, layoutMode: number): void {
    this.stats.tabCounts.push(tabCount)
    this.stats.terminalCounts.push(terminalCount)
    this.stats.layoutModes.push(layoutMode)
    this.persist()
  }

  recordPrompt(action: string): void {
    switch (action) {
      case 'send': this.stats.promptSend++; break
      case 'execute': this.stats.promptExecute++; break
      case 'sendAndExecute': this.stats.promptSendAndExecute++; break
    }
    this.persist()
  }

  recordDropdown(event: string, action: string): void {
    const key = `${event}/${action}`
    switch (key) {
      case 'dropdown/workspace/openDir': this.stats.dropdownWorkspaceOpenDir++; break
      case 'dropdown/workspace/changeDir': this.stats.dropdownWorkspaceChangeDir++; break
      case 'dropdown/development/editor': this.stats.dropdownDevelopmentEditor++; break
      case 'dropdown/development/gitDiff': this.stats.dropdownDevelopmentGitDiff++; break
      case 'dropdown/development/gitHistory': this.stats.dropdownDevelopmentGitHistory++; break
      case 'dropdown/tools/claudeCode': this.stats.dropdownToolsClaudeCode++; break
      case 'dropdown/tools/codex': this.stats.dropdownToolsCodex++; break
      case 'dropdown/tools/browser': this.stats.dropdownToolsBrowser++; break
    }
    this.persist()
  }

  recordRendererCrash(): void {
    this.stats.rendererCrashCount++
    this.persist()
  }

  // --- Upload check ---

  /**
   * Check if a daily upload is due. Returns the aggregated summary if yes, null if no.
   * After a successful upload, call `markUploaded()`.
   */
  getUploadPayloadIfDue(): Record<string, string | number> | null {
    // Debug: force upload on every check when ONWARD_TELEMETRY_FORCE_UPLOAD=1
    if (TELEMETRY_FORCE_UPLOAD && this.stats.sessionCount > 0 && this.stats.lastUploadedAt === 0) {
      return buildDailySummary(this.stats)
    }

    const today = getTodayDate()

    // If the date rolled over and we have yesterday's data that wasn't uploaded
    if (this.stats.date !== today && this.stats.lastUploadedAt === 0 && this.stats.sessionCount > 0) {
      return buildDailySummary(this.stats)
    }

    return null
  }

  /**
   * Force get the current stats for upload (used at app quit to not lose data).
   */
  getCurrentSummary(): Record<string, string | number> | null {
    if (this.stats.sessionCount === 0) return null
    return buildDailySummary(this.stats)
  }

  /**
   * Mark the current day's data as uploaded and reset for the next period.
   */
  markUploaded(): void {
    this.stats.lastUploadedAt = Date.now()
    this.persist()
    // Reset to a fresh day
    this.stats = createEmptyStats(getTodayDate())
    this.persist()
  }

  /** Get raw stats for local inspection. */
  getStats(): DailyStats {
    return { ...this.stats }
  }

  // --- Persistence ---

  private load(): DailyStats {
    try {
      if (existsSync(this.storagePath)) {
        const raw = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(raw) as DailyStats
        if (parsed.date && typeof parsed.sessionCount === 'number') {
          return parsed
        }
      }
    } catch {}
    return createEmptyStats(getTodayDate())
  }

  private persist(): void {
    try {
      writeFileSync(this.storagePath, JSON.stringify(this.stats), 'utf-8')
    } catch {}
  }
}

// Singleton
let instance: DailyAggregator | null = null

export function getDailyAggregator(): DailyAggregator {
  if (!instance) {
    instance = new DailyAggregator()
  }
  return instance
}
