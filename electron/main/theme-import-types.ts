/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThemeDefinition } from '../../src/types/theme'

export const THEME_IMPORT_ERROR_CODES = [
  'unsupported-format', 'file-not-found', 'file-unreadable', 'invalid-json',
  'invalid-theme', 'invalid-package', 'invalid-archive', 'path-outside-root',
  'include-cycle', 'include-depth-limit', 'size-limit', 'theme-count-limit',
  'duplicate-entry', 'worker-failed', 'timeout', 'busy', 'dialog-failed'
] as const

export type ThemeImportErrorCode = typeof THEME_IMPORT_ERROR_CODES[number]

export class ThemeImportError extends Error {
  readonly code: ThemeImportErrorCode

  constructor(code: ThemeImportErrorCode) {
    super(code)
    this.name = 'ThemeImportError'
    this.code = code
  }
}

export interface ThemeImportResult {
  success: boolean
  canceled?: boolean
  themes?: ThemeDefinition[]
  error?: { code: ThemeImportErrorCode }
}

/** Renderer-generated UUIDs survive Settings remounts without sharing ownership across senders. */
export function isThemeImportRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export interface ThemeImportAutotestOptions {
  pauseAt?: 'before-worker' | 'worker'
  waitUntilPaused?: boolean
}

export interface ThemeImportLimits {
  maxDepth: number
  maxFileBytes: number
  maxTotalBytes: number
  maxArchiveBytes: number
  maxArchiveEntries: number
  maxThemes: number
}

export const THEME_IMPORT_LIMITS: Readonly<ThemeImportLimits> = Object.freeze({
  maxDepth: 16,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxArchiveBytes: 32 * 1024 * 1024,
  maxArchiveEntries: 4096,
  maxThemes: 64
})

export function importErrorCode(error: unknown, fallback: ThemeImportErrorCode = 'file-unreadable'): ThemeImportErrorCode {
  if (error instanceof ThemeImportError) return error.code
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'file-not-found'
  return fallback
}

export function isThemeImportErrorCode(value: unknown): value is ThemeImportErrorCode {
  return typeof value === 'string' && (THEME_IMPORT_ERROR_CODES as readonly string[]).includes(value)
}

export const THEME_IMPORT_TRACE_STAGES = [
  'registered', 'register-skipped', 'handler-received', 'chooser-open', 'chooser-result',
  'cancel-requested', 'worker-dispatch', 'sender-cleanup', 'handler-result', 'shutdown-start', 'shutdown-complete',
  'cancel-handler-received', 'cancel-handler-result', 'cancel-stale', 'cancel-invalid', 'handler-invalid', 'retry-wait', 'chooser-busy', 'chooser-closed',
  'worker-request', 'worker-pre-abort', 'worker-spawn', 'worker-spawn-failed', 'worker-start', 'worker-result', 'worker-received',
  'worker-aborted', 'worker-error', 'worker-exit', 'worker-invalid-result', 'worker-invalid-trace', 'worker-timeout',
  'worker-terminate', 'worker-terminate-failed', 'worker-settled',
  'source-start', 'source-complete', 'file-read', 'file-cleanup', 'file-cleanup-failed',
  'archive-open', 'archive-index', 'archive-indexed', 'archive-error', 'stream-read',
  'archive-cleanup', 'archive-cleanup-failed', 'archive-closed',
  'parse-start', 'parse-complete', 'document-read', 'manifest-read', 'include-read'
] as const

export type ThemeImportTraceStage = typeof THEME_IMPORT_TRACE_STAGES[number]
export type ThemeImportCancelCause = 'user' | 'escape' | 'unmount' | 'navigation' | 'destroy' | 'shutdown' | 'abort' | 'pre-abort'

export interface ThemeImportTraceData {
  stage: ThemeImportTraceStage
  durationMs: number
  ok: boolean
  canceled: boolean
  count: number
  code?: ThemeImportErrorCode
  cause?: ThemeImportCancelCause
  format?: 'file' | 'vsix'
  cleanup?: 'pending' | 'complete' | 'failed'
  reads?: number
  includeReads?: number
  readFailures?: number
  bytes?: number
  depth?: number
  filesOpened?: number
  filesClosed?: number
  cleanupFailures?: number
  entries?: number
  archiveBytes?: number
  streamsOpened?: number
  streamsClosed?: number
  streamsDestroyed?: number
  pending?: number
}

export type ThemeImportTraceSink = (data: ThemeImportTraceData) => void

export type ThemeImportWorkerPacket =
  | { type: 'trace'; data: ThemeImportTraceData }
  | { type: 'result'; result: ThemeImportResult }
