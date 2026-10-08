/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  THEME_IMPORT_TRACE_STAGES, isThemeImportErrorCode,
  type ThemeImportTraceData, type ThemeImportTraceSink, type ThemeImportTraceStage
} from './theme-import-types.ts'

const stages = new Set<string>(THEME_IMPORT_TRACE_STAGES)
const causes = new Set(['user', 'escape', 'unmount', 'navigation', 'destroy', 'shutdown', 'abort', 'pre-abort'])
const COUNTERS = [
  'reads', 'includeReads', 'readFailures', 'bytes', 'depth', 'filesOpened', 'filesClosed',
  'cleanupFailures', 'entries', 'archiveBytes', 'streamsOpened', 'streamsClosed', 'streamsDestroyed', 'pending'
] as const
const MAX_TRACE_NUMBER = 1_000_000_000

/** A fixed-key, fixed-enum envelope; arbitrary strings never cross the worker trace boundary. */
export function normalizeThemeImportTraceData(value: unknown): ThemeImportTraceData | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (typeof data.stage !== 'string' || !stages.has(data.stage)) return null
  if (typeof data.durationMs !== 'number' || !Number.isFinite(data.durationMs) || data.durationMs < 0) return null
  const result: ThemeImportTraceData = {
    stage: data.stage as ThemeImportTraceStage,
    durationMs: Math.min(data.durationMs, MAX_TRACE_NUMBER),
    ok: data.ok === true,
    canceled: data.canceled === true,
    count: typeof data.count === 'number' && Number.isSafeInteger(data.count) && data.count >= 0
      ? Math.min(data.count, MAX_TRACE_NUMBER) : 0
  }
  if (isThemeImportErrorCode(data.code)) result.code = data.code
  if (typeof data.cause === 'string' && causes.has(data.cause)) result.cause = data.cause as ThemeImportTraceData['cause']
  if (data.format === 'file' || data.format === 'vsix') result.format = data.format
  if (data.cleanup === 'pending' || data.cleanup === 'complete' || data.cleanup === 'failed') result.cleanup = data.cleanup
  for (const key of COUNTERS) {
    const value = data[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = Math.min(value, MAX_TRACE_NUMBER)
  }
  return result
}

export function emitThemeImportTrace(
  sink: ThemeImportTraceSink | undefined,
  stage: ThemeImportTraceStage,
  data: Partial<Omit<ThemeImportTraceData, 'stage'>> = {}
): void {
  if (!sink) return
  const normalized = normalizeThemeImportTraceData({ durationMs: 0, ok: true, canceled: false, count: 0, ...data, stage })
  if (!normalized) return
  try { sink(normalized) } catch { /* Diagnostics must not change import or cleanup behavior. */ }
}

export interface ThemeImportIoTrace {
  stats: Record<Exclude<typeof COUNTERS[number], 'pending'>, number> & { archiveOpened: boolean; archiveClosed: boolean }
  begin(stage: ThemeImportTraceStage, data?: Partial<Omit<ThemeImportTraceData, 'stage'>>): void
  emit(stage: ThemeImportTraceStage, data?: Partial<Omit<ThemeImportTraceData, 'stage'>>): void
}

/** One bounded set of stage boundaries and aggregate counters for an entire import. */
export function createThemeImportIoTrace(sink?: ThemeImportTraceSink, format?: 'file' | 'vsix'): ThemeImportIoTrace {
  const seen = new Set<ThemeImportTraceStage>()
  const stats: ThemeImportIoTrace['stats'] = {
    reads: 0, includeReads: 0, readFailures: 0, bytes: 0, depth: 0,
    filesOpened: 0, filesClosed: 0, cleanupFailures: 0, entries: 0, archiveBytes: 0,
    streamsOpened: 0, streamsClosed: 0, streamsDestroyed: 0, archiveOpened: false, archiveClosed: false
  }
  const emit: ThemeImportIoTrace['emit'] = (stage, data) => {
    if (!sink) return
    const { archiveOpened, archiveClosed, ...counters } = stats
    const pending = Math.max(0, stats.filesOpened - stats.filesClosed) + Math.max(0, stats.streamsOpened - stats.streamsClosed)
      + (archiveOpened && !archiveClosed ? 1 : 0)
    emitThemeImportTrace(sink, stage, {
      ...counters, pending, format,
      cleanup: stats.cleanupFailures > 0 ? 'failed' : pending > 0 ? 'pending' : 'complete',
      ...data
    })
  }
  return {
    stats, emit,
    begin(stage, data) {
      if (seen.has(stage)) return
      seen.add(stage)
      emit(stage, data)
    }
  }
}
