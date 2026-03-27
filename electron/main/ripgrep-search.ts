/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'child_process'
import { BrowserWindow, app } from 'electron'

export interface RipgrepSearchOptions {
  rootPath: string
  query: string
  isRegex: boolean
  isCaseSensitive: boolean
  isWholeWord: boolean
  includeGlob?: string
  excludeGlob?: string
  maxResults?: number
}

export interface RipgrepMatch {
  file: string
  line: number
  column: number
  matchLength: number
  lineContent: string
}

export interface RipgrepSearchStats {
  searchId: string
  matchCount: number
  fileCount: number
  durationMs: number
  cancelled: boolean
}

function resolveRipgrepPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rgPath } = require('@vscode/ripgrep')
    return app.isPackaged ? rgPath.replace('app.asar', 'app.asar.unpacked') : rgPath
  } catch {
    return 'rg'
  }
}

function buildRipgrepArgs(options: RipgrepSearchOptions): string[] {
  const args = [
    '--json',
    '--no-heading',
    '--color', 'never',
    '--max-columns', '500',
    '--max-columns-preview'
  ]

  if (!options.isCaseSensitive) args.push('-i')
  if (options.isWholeWord) args.push('-w')

  if (options.isRegex) {
    args.push('-e', options.query)
  } else {
    args.push('-F', '-e', options.query)
  }

  if (options.includeGlob) {
    for (const glob of options.includeGlob.split(',')) {
      const trimmed = glob.trim()
      if (trimmed) args.push('--glob', trimmed)
    }
  }

  if (options.excludeGlob) {
    for (const glob of options.excludeGlob.split(',')) {
      const trimmed = glob.trim()
      if (trimmed) args.push('--glob', `!${trimmed}`)
    }
  }

  args.push('--max-count', '200')
  args.push('.')
  return args
}

function parseRipgrepLine(line: string): RipgrepMatch | null {
  try {
    const payload = JSON.parse(line) as {
      type?: string
      data?: {
        path?: { text?: string }
        line_number?: number
        lines?: { text?: string }
        submatches?: Array<{ start: number; end: number }>
      }
    }
    if (payload.type !== 'match' || !payload.data?.path?.text) return null

    let file = payload.data.path.text
    if (file.startsWith('./')) {
      file = file.slice(2)
    }

    const submatch = payload.data.submatches?.[0]
    return {
      file,
      line: payload.data.line_number ?? 1,
      column: submatch ? submatch.start + 1 : 1,
      matchLength: submatch ? submatch.end - submatch.start : 0,
      lineContent: (payload.data.lines?.text ?? '').replace(/\n$/, '')
    }
  } catch {
    return null
  }
}

let searchCounter = 0

export class RipgrepSearchManager {
  private activeProcess: ChildProcess | null = null
  private activeSearchId: string | null = null
  private rgPath: string | null = null

  private getRipgrepPath(): string {
    if (!this.rgPath) {
      this.rgPath = resolveRipgrepPath()
    }
    return this.rgPath
  }

  start(mainWindow: BrowserWindow, options: RipgrepSearchOptions): string {
    this.cancel()

    const searchId = `search-${++searchCounter}-${Date.now()}`
    this.activeSearchId = searchId
    const startTime = Date.now()
    const maxResults = options.maxResults ?? 5000

    let process: ChildProcess
    try {
      process = spawn(this.getRipgrepPath(), buildRipgrepArgs(options), {
        cwd: options.rootPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch {
      mainWindow.webContents.send('project:search-done', {
        searchId,
        matchCount: 0,
        fileCount: 0,
        durationMs: 0,
        cancelled: false
      } satisfies RipgrepSearchStats)
      return searchId
    }

    this.activeProcess = process

    let matchCount = 0
    let lineBuffer = ''
    let limitReached = false
    const files = new Set<string>()
    let batch: RipgrepMatch[] = []
    let batchTimer: ReturnType<typeof setTimeout> | null = null

    const flushBatch = () => {
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      if (batch.length > 0 && this.activeSearchId === searchId) {
        mainWindow.webContents.send('project:search-result', searchId, batch)
        batch = []
      }
    }

    const scheduleBatch = () => {
      if (!batchTimer) {
        batchTimer = setTimeout(flushBatch, 50)
      }
    }

    process.stdout?.on('data', (chunk: Buffer) => {
      if (limitReached) return
      lineBuffer += chunk.toString('utf-8')
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        const match = parseRipgrepLine(line)
        if (!match) continue

        matchCount += 1
        files.add(match.file)
        batch.push(match)

        if (matchCount >= maxResults) {
          limitReached = true
          process.kill('SIGTERM')
          break
        }

        if (batch.length >= 30) {
          flushBatch()
        } else {
          scheduleBatch()
        }
      }
    })

    process.stderr?.on('data', () => {
      // Ignore ripgrep warnings.
    })

    const finish = () => {
      if (lineBuffer.trim() && !limitReached) {
        const match = parseRipgrepLine(lineBuffer)
        if (match) {
          matchCount += 1
          files.add(match.file)
          batch.push(match)
        }
      }
      flushBatch()
      if (this.activeSearchId !== searchId) return
      mainWindow.webContents.send('project:search-done', {
        searchId,
        matchCount,
        fileCount: files.size,
        durationMs: Date.now() - startTime,
        cancelled: limitReached
      } satisfies RipgrepSearchStats)
      if (this.activeProcess === process) {
        this.activeProcess = null
      }
    }

    process.on('close', finish)
    process.on('error', finish)
    return searchId
  }

  cancel(): void {
    if (this.activeProcess) {
      try {
        this.activeProcess.kill('SIGTERM')
      } catch {
        // Ignore.
      }
      this.activeProcess = null
    }
    this.activeSearchId = null
  }

  dispose(): void {
    this.cancel()
  }
}
