/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { net } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as NodeReadableStream } from 'stream/web'

export type DownloadErrorCode =
  | 'offline'
  | 'connection-failed'
  | 'timeout'
  | 'stalled'
  | 'http-error'
  | 'checksum-mismatch'
  | 'disk-error'
  | 'aborted'

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
  percent: number
  bytesPerSecond: number
}

export interface DownloadRetryInfo {
  attempt: number
  maxAttempts: number
  delayMs: number
  error: DownloadError
}

export interface DownloadFileOptions {
  onProgress?: (progress: DownloadProgress) => void
  onRetry?: (info: DownloadRetryInfo) => void
  maxRetries?: number
  retryDelaysMs?: number[]
  connectTimeoutMs?: number
  stallTimeoutMs?: number
  totalTimeoutMs?: number
  progressThrottleMs?: number
  log?: (message: string) => void
}

export interface FetchUpdateResourceOptions {
  headers?: Record<string, string>
  timeoutMs?: number
}

interface DownloadErrorDetails {
  status?: number
  retryable?: boolean
}

interface DownloadTimeoutState {
  connectTimedOut: boolean
  totalTimedOut: boolean
}

interface OpenDownloadResponse {
  response: Response
  abort: () => void
  clearTimers: () => void
  timeoutState: DownloadTimeoutState
}

interface ParsedContentRange {
  start: number
  end: number
  totalBytes: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000
const DEFAULT_STALL_TIMEOUT_MS = 30_000
const DEFAULT_TOTAL_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 10000]
const DEFAULT_PROGRESS_THROTTLE_MS = 500

export class DownloadError extends Error {
  readonly code: DownloadErrorCode
  readonly status?: number
  readonly retryable: boolean

  constructor(code: DownloadErrorCode, message: string, details: DownloadErrorDetails = {}) {
    super(message)
    this.name = 'DownloadError'
    this.code = code
    this.status = details.status
    this.retryable = details.retryable ?? false
  }
}

export function getPartialDownloadPath(destinationPath: string): string {
  return `${destinationPath}.partial`
}

export function formatDownloadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export async function fetchUpdateResource(
  url: string,
  options: FetchUpdateResourceOptions = {}
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)

  try {
    return await net.fetch(url, {
      headers: options.headers,
      signal: controller.signal
    })
  } catch (error) {
    throw classifyDownloadError(error, { connectTimedOut: timedOut, totalTimedOut: false })
  } finally {
    clearTimeout(timeoutHandle)
  }
}

class DownloadProgressTransform extends Transform {
  bytesThrough = 0
  private stallTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly stallTimeoutMs: number,
    private readonly onChunk: (bytesThrough: number) => void,
    private readonly onStall: (error: DownloadError) => void
  ) {
    super()
    this.resetStallTimer()
  }

  private resetStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
    }
    this.stallTimer = setTimeout(() => {
      const error = new DownloadError(
        'stalled',
        `Download stalled: no data received for ${Math.round(this.stallTimeoutMs / 1000)} seconds.`,
        { retryable: true }
      )
      this.onStall(error)
      this.destroy(error)
    }, this.stallTimeoutMs)
  }

  _transform(chunk: Buffer, _encoding: string, callback: (error: Error | null, data?: Buffer) => void): void {
    this.bytesThrough += chunk.length
    this.resetStallTimer()
    this.onChunk(this.bytesThrough)
    callback(null, chunk)
  }

  _final(callback: (error: Error | null) => void): void {
    this.clearStallTimer()
    callback(null)
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.clearStallTimer()
    callback(error)
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }
}

function classifyDownloadError(error: unknown, timeoutState?: DownloadTimeoutState): DownloadError {
  if (error instanceof DownloadError) return error

  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (timeoutState?.connectTimedOut) {
    return new DownloadError('timeout', 'Connection timed out while contacting the update server.', { retryable: true })
  }
  if (timeoutState?.totalTimedOut) {
    return new DownloadError('timeout', 'Download timed out before the file completed.', { retryable: true })
  }
  if (isDiskError(error, lower)) {
    return new DownloadError('disk-error', message)
  }
  if (lower.includes('timed out') || lower.includes('etimedout')) {
    return new DownloadError('timeout', message, { retryable: true })
  }
  if (lower.includes('abort')) {
    return new DownloadError('aborted', message)
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('dns') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('epipe') ||
    lower.includes('network') ||
    lower.includes('socket')
  ) {
    return new DownloadError('connection-failed', message, { retryable: true })
  }
  return new DownloadError('connection-failed', message, { retryable: true })
}

function isDiskError(error: unknown, lowerMessage: string): boolean {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code || '').toUpperCase()
    : ''
  return (
    code === 'ENOSPC' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EIO' ||
    code === 'EMFILE' ||
    code === 'ENFILE' ||
    code === 'EROFS' ||
    lowerMessage.includes('no space') ||
    lowerMessage.includes('permission denied')
  )
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function isRetryableError(error: unknown): boolean {
  return error instanceof DownloadError && error.retryable
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  if (!value) return null
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim())
  if (!match) return null

  const start = Number.parseInt(match[1], 10)
  const end = Number.parseInt(match[2], 10)
  const totalBytes = match[3] === '*' ? 0 : Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null
  if (totalBytes !== 0 && (!Number.isSafeInteger(totalBytes) || totalBytes < end + 1)) return null
  return { start, end, totalBytes }
}

function buildProgress(
  resumeFromByte: number,
  newBytesReceived: number,
  totalBytes: number,
  startTime: number
): DownloadProgress {
  const downloadedBytes = resumeFromByte + newBytesReceived
  const elapsedSeconds = (Date.now() - startTime) / 1000
  const bytesPerSecond = elapsedSeconds > 0 ? Math.round(newBytesReceived / elapsedSeconds) : 0
  const percent = totalBytes > 0 ? Math.min(Math.round((downloadedBytes / totalBytes) * 100), 100) : -1
  return {
    downloadedBytes,
    totalBytes,
    percent,
    bytesPerSecond
  }
}

async function openDownloadResponse(
  url: string,
  headers: Record<string, string>,
  connectTimeoutMs: number,
  totalTimeoutMs: number
): Promise<OpenDownloadResponse> {
  const controller = new AbortController()
  const timeoutState: DownloadTimeoutState = {
    connectTimedOut: false,
    totalTimedOut: false
  }
  const connectTimer = setTimeout(() => {
    timeoutState.connectTimedOut = true
    controller.abort()
  }, connectTimeoutMs)
  const totalTimer = setTimeout(() => {
    timeoutState.totalTimedOut = true
    controller.abort()
  }, totalTimeoutMs)

  try {
    const response = await net.fetch(url, {
      headers,
      signal: controller.signal
    })
    clearTimeout(connectTimer)
    return {
      response,
      abort: () => controller.abort(),
      clearTimers: () => {
        clearTimeout(connectTimer)
        clearTimeout(totalTimer)
      },
      timeoutState
    }
  } catch (error) {
    clearTimeout(connectTimer)
    clearTimeout(totalTimer)
    throw classifyDownloadError(error, timeoutState)
  }
}

async function downloadFileCore(
  url: string,
  destinationPath: string,
  options: Required<Pick<DownloadFileOptions, 'connectTimeoutMs' | 'stallTimeoutMs' | 'totalTimeoutMs' | 'progressThrottleMs'>> &
    Pick<DownloadFileOptions, 'onProgress' | 'log'>
): Promise<void> {
  if (!net.isOnline()) {
    throw new DownloadError('offline', 'No network connection available.')
  }

  const partialPath = getPartialDownloadPath(destinationPath)
  let resumeFromByte = 0

  if (existsSync(partialPath)) {
    try {
      resumeFromByte = statSync(partialPath).size
      if (resumeFromByte > 0) {
        options.log?.(`Found partial download (${formatDownloadBytes(resumeFromByte)}), attempting resume`)
      }
    } catch {
      resumeFromByte = 0
    }
  }

  const openResponse = async (rangeStart: number): Promise<OpenDownloadResponse> => {
    const headers: Record<string, string> = {}
    if (rangeStart > 0) {
      headers.Range = `bytes=${rangeStart}-`
    }
    return await openDownloadResponse(url, headers, options.connectTimeoutMs, options.totalTimeoutMs)
  }

  let download = await openResponse(resumeFromByte)

  if (resumeFromByte > 0 && download.response.status === 416) {
    options.log?.('Server rejected Range request (416), restarting download')
    download.clearTimers()
    rmSync(partialPath, { force: true })
    resumeFromByte = 0
    download = await openResponse(0)
  }

  if (!download.response.ok && download.response.status !== 206) {
    const status = download.response.status
    const statusText = download.response.statusText
    download.clearTimers()
    throw new DownloadError('http-error', `Download failed: ${status} ${statusText}`, {
      status,
      retryable: isRetryableHttpStatus(status)
    })
  }

  if (!download.response.body) {
    download.clearTimers()
    throw new DownloadError('http-error', 'Server returned an empty response body.')
  }

  let isResumed = download.response.status === 206
  let contentRange = isResumed ? parseContentRange(download.response.headers.get('content-range')) : null

  if (isResumed && (!contentRange || contentRange.start !== resumeFromByte)) {
    options.log?.('Server returned an invalid Content-Range response, restarting download')
    download.clearTimers()
    rmSync(partialPath, { force: true })
    resumeFromByte = 0
    download = await openResponse(0)
    if (!download.response.ok || !download.response.body) {
      const status = download.response.status
      download.clearTimers()
      throw new DownloadError('http-error', `Download failed after Range restart: ${status} ${download.response.statusText}`, {
        status,
        retryable: isRetryableHttpStatus(status)
      })
    }
    isResumed = false
    contentRange = null
  }

  if (!isResumed && resumeFromByte > 0) {
    options.log?.(`Server returned ${download.response.status} and ignored the Range header, restarting from byte 0`)
    resumeFromByte = 0
  }

  const contentLengthHeader = download.response.headers.get('content-length')
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : 0
  const totalBytes = contentRange?.totalBytes && contentRange.totalBytes > 0
    ? contentRange.totalBytes
    : contentLength > 0
      ? (isResumed ? resumeFromByte + contentLength : contentLength)
      : 0

  options.log?.(
    isResumed
      ? `Resuming from byte ${resumeFromByte}, remaining: ${formatDownloadBytes(Math.max(contentLength, 0))}`
      : `Starting download, size: ${totalBytes > 0 ? formatDownloadBytes(totalBytes) : 'unknown'}`
  )

  mkdirSync(dirname(destinationPath), { recursive: true })

  const downloadStartTime = Date.now()
  let lastProgressEmitTime = 0
  const emitProgress = (newBytesReceived: number, force = false): void => {
    if (!options.onProgress) return
    const now = Date.now()
    if (!force && now - lastProgressEmitTime < options.progressThrottleMs) return
    lastProgressEmitTime = now
    options.onProgress(buildProgress(resumeFromByte, newBytesReceived, totalBytes, downloadStartTime))
  }

  emitProgress(0, true)

  const progressTransform = new DownloadProgressTransform(
    options.stallTimeoutMs,
    (newBytesReceived) => emitProgress(newBytesReceived),
    () => download.abort()
  )

  try {
    await pipeline(
      Readable.fromWeb(download.response.body as unknown as NodeReadableStream),
      progressTransform,
      createWriteStream(partialPath, { flags: isResumed ? 'a' : 'w' })
    )
  } catch (error) {
    throw classifyDownloadError(error, download.timeoutState)
  } finally {
    download.clearTimers()
  }

  const finalBytes = resumeFromByte + progressTransform.bytesThrough
  if (options.onProgress) {
    const progressTotal = totalBytes > 0 ? totalBytes : finalBytes
    options.onProgress({
      ...buildProgress(resumeFromByte, progressTransform.bytesThrough, progressTotal, downloadStartTime),
      percent: 100
    })
  }

  try {
    renameSync(partialPath, destinationPath)
  } catch (error) {
    throw classifyDownloadError(error)
  }

  const totalElapsed = ((Date.now() - downloadStartTime) / 1000).toFixed(1)
  options.log?.(`Download complete: ${formatDownloadBytes(finalBytes)} in ${totalElapsed}s`)
}

export async function downloadFileWithRetry(
  url: string,
  destinationPath: string,
  options: DownloadFileOptions = {}
): Promise<void> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const maxAttempts = maxRetries + 1
  const coreOptions = {
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    progressThrottleMs: options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS,
    onProgress: options.onProgress,
    log: options.log
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await downloadFileCore(url, destinationPath, coreOptions)
      return
    } catch (error) {
      const downloadError = classifyDownloadError(error)
      const isLastAttempt = attempt === maxAttempts

      if (isLastAttempt || !isRetryableError(downloadError)) {
        throw downloadError
      }

      const delayMs = retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0
      options.log?.(`Download attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms: ${downloadError.message}`)
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error: downloadError
      })

      await new Promise(resolve => setTimeout(resolve, delayMs))

      if (!net.isOnline()) {
        throw new DownloadError('offline', 'No network connection available.')
      }
    }
  }
}
