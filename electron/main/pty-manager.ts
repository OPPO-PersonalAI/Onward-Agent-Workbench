/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pty from 'node-pty'
import { platform } from 'os'
import { execFileSync } from 'child_process'
import { app } from 'electron'
import { getApiPort } from './api-server'

export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  command?: string
  args?: string[]
}

type PtyExitEvent = { exitCode: number; signal?: number }

interface PtyRecord {
  pty: pty.IPty
  externalDisposables: pty.IDisposable[]
  exitDisposable: pty.IDisposable
  exitPromise: Promise<PtyExitEvent>
  exited: boolean
  writeQueue: Promise<void>
  disposed: boolean
}

// Chunked write constants for Windows ConPTY pipe buffer safety
const CHUNK_SIZE = 1024
const CHUNK_DELAY_MS = 5
const SMALL_WRITE_THRESHOLD = 1024

export class PtyManager {
  private instances: Map<string, PtyRecord> = new Map()
  private cachedShell: string | null = null
  private cwdMap: Map<string, string> = new Map()

  // OSC 9;9 (ConEmu-style CWD report): \x1b]9;9;PATH\x07 or \x1b]9;9;PATH\x1b\\
  private static readonly OSC_CWD_RE = /\x1b\]9;9;(.+?)(?:\x07|\x1b\\)/

  private getDefaultShell(): string {
    if (this.cachedShell) return this.cachedShell
    if (platform() === 'win32') {
      this.cachedShell = this.resolveWindowsShell()
    } else {
      this.cachedShell = process.env.SHELL || '/bin/bash'
    }
    return this.cachedShell
  }

  // Prefer PowerShell on Windows, fall back to cmd.exe
  private resolveWindowsShell(): string {
    // Try pwsh.exe (PowerShell 7+) first, then powershell.exe (Windows PowerShell 5.x)
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      try {
        const resolved = execFileSync('where', [candidate], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000
        })
          .toString()
          .trim()
          .split(/\r?\n/)[0]
        if (resolved) return resolved
      } catch {
        continue
      }
    }
    return process.env.COMSPEC || 'cmd.exe'
  }

  create(id: string, options: PtyOptions = {}): pty.IPty {
    const shell = this.getDefaultShell()
    const { cols = 80, rows = 24, cwd, env, command, args } = options
    const execCommand = command || shell
    let execArgs = command ? (args || []) : []

    // On Windows, inject shell integration for CWD tracking via OSC 9;9
    if (platform() === 'win32' && !command) {
      execArgs = this.getWindowsShellArgs(shell)
    }

    // Inject Onward Bridge API environment variables
    const apiPort = getApiPort()
    const bridgeEnv: Record<string, string> = {}
    if (apiPort > 0) {
      bridgeEnv.ONWARD_API_PORT = String(apiPort)
    }
    try {
      bridgeEnv.ONWARD_USER_DATA = app.getPath('userData')
    } catch {
      // app may not be ready yet, ignore
    }

    // For cmd.exe on Windows, set PROMPT to emit OSC 9;9 CWD report
    const shellIntegrationEnv: Record<string, string> = {}
    if (platform() === 'win32' && !command && this.isCmdShell(shell)) {
      // $e = ESC, $P = current path, $e\ = ST (string terminator), $G = >
      shellIntegrationEnv.PROMPT = '$e]9;9;$P$e\\$P$G'
    }

    const initialCwd = cwd || process.env.HOME || process.env.USERPROFILE || process.cwd()

    const ptyProcess = pty.spawn(execCommand, execArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: initialCwd,
      env: {
        ...(env || process.env),
        // Ensure correct UTF-8 locale (if not set on the system)
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || '',
        LC_CTYPE: process.env.LC_CTYPE || 'en_US.UTF-8',
        // Git 2.32+ supports overriding configuration through environment variables
        // Disable quotepath to correctly display non-ASCII characters such as Chinese
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.quotepath',
        GIT_CONFIG_VALUE_0: 'false',
        // Shell integration for CWD tracking (cmd.exe)
        ...shellIntegrationEnv,
        // Onward Bridge API environment variables
        ...bridgeEnv
      } as { [key: string]: string }
    })

    // Store initial CWD for Windows shell-integration tracking
    this.cwdMap.set(id, initialCwd)

    let resolveExit: (event: PtyExitEvent) => void
    const exitPromise = new Promise<PtyExitEvent>((resolve) => {
      resolveExit = resolve
    })

    const record: PtyRecord = {
      pty: ptyProcess,
      externalDisposables: [],
      exitDisposable: { dispose: () => {} },
      exitPromise,
      exited: false,
      writeQueue: Promise.resolve(),
      disposed: false
    }

    record.exitDisposable = ptyProcess.onExit((event) => {
      record.exited = true
      resolveExit(event)
    })

    this.instances.set(id, record)
    return ptyProcess
  }

  write(id: string, data: string): boolean | Promise<boolean> {
    const record = this.instances.get(id)
    if (!record || record.disposed) return false

    if (data.length <= SMALL_WRITE_THRESHOLD) {
      // Short input (keystrokes, short commands): pass through directly
      record.pty.write(data)
      return true
    }

    // Large data: enqueue chunked write and return Promise.
    // ipcMain.handle() awaits the Promise, so the renderer's
    // `await terminal.write()` won't resolve until all chunks are written.
    // This prevents the follow-up '\r' from arriving mid-content.
    record.writeQueue = record.writeQueue.then(() =>
      this.writeChunked(record, data)
    )
    return record.writeQueue.then(() => true)
  }

  private async writeChunked(record: PtyRecord, data: string): Promise<void> {
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      if (record.disposed) return
      const chunk = data.slice(offset, offset + CHUNK_SIZE)
      record.pty.write(chunk)
      if (offset + CHUNK_SIZE < data.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_DELAY_MS))
      }
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const record = this.instances.get(id)
    if (record) {
      record.pty.resize(cols, rows)
      return true
    }
    return false
  }

  // Parse OSC 9;9 CWD reports from PTY data stream
  detectCwd(id: string, data: string): void {
    const match = PtyManager.OSC_CWD_RE.exec(data)
    if (match) {
      this.cwdMap.set(id, match[1])
    }
  }

  // Get tracked CWD for a terminal (set by shell integration or initial spawn)
  getCwd(id: string): string | null {
    return this.cwdMap.get(id) ?? null
  }

  dispose(id: string): boolean {
    const record = this.instances.get(id)
    if (record) {
      record.disposed = true
      this.disposeExternalListeners(record)
      this.killRecord(record)
      record.exitDisposable.dispose()
      this.instances.delete(id)
      this.cwdMap.delete(id)
      return true
    }
    return false
  }

  get(id: string): pty.IPty | undefined {
    return this.instances.get(id)?.pty
  }

  registerListeners(id: string, disposables: pty.IDisposable[]): boolean {
    const record = this.instances.get(id)
    if (!record) {
      return false
    }
    record.externalDisposables.push(...disposables)
    return true
  }

  // Build PowerShell args that set up a CWD-reporting prompt via OSC 9;9.
  // Uses -EncodedCommand (Base64-encoded UTF-16LE) to avoid all command-line
  // quoting issues with node-pty's argsToCommandLine escaping.
  private getWindowsShellArgs(shell: string): string[] {
    const lower = shell.toLowerCase()
    if (lower.includes('pwsh') || lower.includes('powershell')) {
      // Wrap the user's existing prompt (from $PROFILE) to prepend an
      // invisible OSC 9;9 escape with the CWD.
      const script = [
        'if (Test-Path $PROFILE) { . $PROFILE }',
        '$__onwardOrigPrompt = $function:prompt',
        'if (-not $__onwardOrigPrompt) {',
        '  $__onwardOrigPrompt = { "PS $($executionContext.SessionState.Path.CurrentLocation)$(' + "'>'" + ' * ($nestedPromptLevel + 1)) " }',
        '}',
        'function prompt {',
        '  $p = $executionContext.SessionState.Path.CurrentLocation.Path',
        '  "$([char]27)]9;9;$p$([char]7)" + (& $__onwardOrigPrompt)',
        '}'
      ].join('\n')
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      return ['-NoLogo', '-NoExit', '-EncodedCommand', encoded]
    }
    // cmd.exe uses the PROMPT env var (set in create())
    return []
  }

  private isCmdShell(shell: string): boolean {
    const lower = shell.toLowerCase()
    return lower.includes('cmd') && !lower.includes('powershell') && !lower.includes('pwsh')
  }

  disposeAll(): void {
    for (const id of Array.from(this.instances.keys())) {
      this.dispose(id)
    }
    this.cwdMap.clear()
  }

  async shutdownAll(timeoutMs: number = 1500): Promise<{ total: number; closed: number; timedOut: number }> {
    const records = Array.from(this.instances.entries())
    if (records.length === 0) {
      return { total: 0, closed: 0, timedOut: 0 }
    }

    for (const [, record] of records) {
      this.disposeExternalListeners(record)
    }

    for (const [, record] of records) {
      this.killRecord(record)
    }

    const results = await Promise.all(
      records.map(([, record]) => this.waitForExit(record, timeoutMs))
    )

    for (const [id, record] of records) {
      record.exitDisposable.dispose()
      this.instances.delete(id)
    }

    const closed = results.filter(Boolean).length
    return { total: records.length, closed, timedOut: records.length - closed }
  }

  private disposeExternalListeners(record: PtyRecord): void {
    for (const disposable of record.externalDisposables) {
      disposable.dispose()
    }
    record.externalDisposables = []
  }

  private killRecord(record: PtyRecord): void {
    try {
      record.pty.kill()
    } catch (error) {
      console.warn('[PTY] kill failed:', error)
    }
  }

  private async waitForExit(record: PtyRecord, timeoutMs: number): Promise<boolean> {
    if (record.exited) {
      return true
    }
    if (timeoutMs <= 0) {
      return false
    }
    const result = await Promise.race([
      record.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ])
    return result
  }
}

export const ptyManager = new PtyManager()
