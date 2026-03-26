/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { platform, tmpdir } from 'os'
import { readFile, stat, writeFile, mkdir, access, mkdtemp, rm } from 'fs/promises'
import { constants } from 'fs'
import { resolve, relative, sep, isAbsolute, dirname, delimiter, basename, join } from 'path'
import { ptyManager } from './pty-manager'
import { gitRuntimeManager, type GitTaskKind, type GitTaskPriority } from './git-runtime-manager'

const rawExecAsync = promisify(exec)
const rawExecFileAsync = promisify(execFile)

type ExecResult = Awaited<ReturnType<typeof rawExecAsync>>
type ExecFileResult = Awaited<ReturnType<typeof rawExecFileAsync>>

type GitTaskMeta = {
  priority?: GitTaskPriority
  kind?: GitTaskKind
  repoKey?: string | null
  dedupeKey?: string
  label?: string
}

function normalizeRepoKey(cwd: string | null | undefined): string | undefined {
  if (!cwd) return undefined
  const trimmed = cwd.trim()
  if (!trimmed) return undefined
  return resolve(trimmed)
}

async function execAsync(command: string, options?: Parameters<typeof rawExecAsync>[1], meta: GitTaskMeta = {}): Promise<ExecResult> {
  return gitRuntimeManager.enqueueTask(
    {
      key: meta.dedupeKey,
      repoKey: normalizeRepoKey(meta.repoKey ?? options?.cwd),
      priority: meta.priority || 'normal',
      kind: meta.kind || 'git',
      label: meta.label || command
    },
    () => rawExecAsync(command, options)
  )
}

async function execFileAsync(
  file: string,
  args: string[],
  options?: Parameters<typeof rawExecFileAsync>[2],
  meta: GitTaskMeta = {}
): Promise<ExecFileResult> {
  const label = [file, ...args].join(' ')
  return gitRuntimeManager.enqueueTask(
    {
      key: meta.dedupeKey,
      repoKey: normalizeRepoKey(meta.repoKey ?? options?.cwd),
      priority: meta.priority || 'normal',
      kind: meta.kind || 'git',
      label: meta.label || label
    },
    () => rawExecFileAsync(file, args, options)
  )
}

export type GitChangeType = 'unstaged' | 'staged' | 'untracked'
export type GitStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | '?'

// Git file status
export interface GitFileStatus {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
  changeType: GitChangeType
}

// Git Diff results
export interface GitDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  files: GitFileStatus[]
  error?: string
}

export interface GitCommitInfo {
  sha: string
  shortSha: string
  parents: string[]
  summary: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: string
  refs?: string
}

export interface GitHistoryResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  commits: GitCommitInfo[]
  totalCount?: number
  error?: string
}

export interface GitHistoryFile {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
}

export interface GitHistoryDiffOptions {
  base: string
  head: string
  filePath?: string
  hideWhitespace?: boolean
  includeFiles?: boolean
}

export interface GitHistoryDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  base: string
  head: string
  patch: string
  files: GitHistoryFile[]
  error?: string
}

export interface TerminalGitInfo {
  cwd: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
}

export type TerminalGitStatus = 'clean' | 'modified' | 'added' | 'unknown'

// Git file content results
export interface GitFileContentResult {
  success: boolean
  cwd: string
  filename: string
  originalContent: string
  modifiedContent: string
  isBinary: boolean
  error?: string
}

// Git file save results
export interface GitFileSaveResult {
  success: boolean
  filename: string
  error?: string
}

export interface GitFileActionResult {
  success: boolean
  filename: string
  error?: string
}

// Timeout for command execution (milliseconds)
const EXEC_TIMEOUT = 10000
const MAX_FILE_SIZE = 1024 * 1024  // 1MB
const MAX_DIFF_OUTPUT = 10 * 1024 * 1024 // 10MB
// Short TTL + in-flight reuse: avoid frequent forks (lsof/git) causing CPU spikes and cwd read failures.
const TERMINAL_CWD_CACHE_TTL = 1200
const TERMINAL_INFO_CACHE_TTL = 2000
const GIT_META_CACHE_TTL = 1000
let cachedGitExecutable: string | null | undefined
let cachedGitAvailable: boolean | null = null
let cachedGitCheckedAt: number | null = null

// Diagnosis timeline (for maintenance; retain the key evidence points)
// T0 reproduction: sample repository -> ProjectEditor -> open Git Diff; CPU spikes and occasionally reports "not a Git repository".
// T0+ sample: /usr/bin/sample(main) shows uv_spawn/posix_spawn hotspots, indicating a child-process creation storm.
// T0+ log: gitdiff:view in /tmp/onward_debug.log falls back to the user home directory instead of the repository root.
// T0+ trace: TerminalGrid periodic refresh -> terminal-session-manager -> getTerminalInfo -> getTerminalCwd.
// T0+ root cause: polling re-entry/concurrency repeatedly forks lsof/git in a short window, saturating the main process and causing cwd reads to fail.
// T0+ fix: add short-TTL caches for cwd/info plus in-flight deduplication to stop the concurrency storm.
const terminalCwdCache = new Map<string, { value: string | null; at: number }>()
const terminalCwdInFlight = new Map<string, Promise<string | null>>()
const terminalInfoCache = new Map<string, { value: TerminalGitInfo; at: number }>()
const terminalInfoInFlight = new Map<string, Promise<TerminalGitInfo>>()
const gitMetaCache = new Map<string, { value: GitRepoMeta; at: number }>()
const gitMetaInFlight = new Map<string, Promise<GitRepoMeta>>()

function getExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const currentPath = env[pathKey] || ''
  const extraPaths: string[] = []

  if (platform() === 'win32') {
    extraPaths.push(
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files (x86)\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\bin'
    )
  } else {
    extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  }

  const merged = [
    ...currentPath.split(delimiter).filter(Boolean),
    ...extraPaths
  ]
  env[pathKey] = Array.from(new Set(merged)).join(delimiter)
  return env
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, platform() === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function formatGitError(error: unknown): string {
  if (!error) return ''
  const anyError = error as { stderr?: string | Buffer; message?: string }
  if (anyError.stderr) {
    const stderrText = typeof anyError.stderr === 'string'
      ? anyError.stderr
      : anyError.stderr.toString('utf-8')
    return stderrText.trim()
  }
  if (anyError.message) return anyError.message.trim()
  return String(error).trim()
}

async function resolveGitExecutable(): Promise<string | null> {
  if (cachedGitExecutable !== undefined) return cachedGitExecutable

  const candidates: string[] = []
  const envGitPath = process.env.GIT_PATH
  if (envGitPath) {
    candidates.push(envGitPath)
  }

  if (platform() === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe'
    )
  } else {
    candidates.push(
      '/usr/bin/git',
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/opt/local/bin/git',
      '/bin/git'
    )
  }

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedGitExecutable = candidate
      return candidate
    }
  }

  try {
    await execFileAsync(
      'git',
      ['--version'],
      { timeout: EXEC_TIMEOUT, env: getExecEnv() },
      { kind: 'misc', priority: 'low', dedupeKey: 'git:version:resolve' }
    )
    cachedGitExecutable = 'git'
    return cachedGitExecutable
  } catch {
    cachedGitExecutable = null
    return null
  }
}

function resolvePathInRepo(cwd: string, filename: string): string | null {
  const resolved = resolve(cwd, filename)
  const relativePath = relative(cwd, resolved)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null
  }
  return resolved
}

function toGitPath(cwd: string, filename: string): string | null {
  const resolved = resolvePathInRepo(cwd, filename)
  if (!resolved) return null
  const relativePath = relative(cwd, resolved)
  return relativePath.split(sep).join('/')
}

function hasNullByte(content: string): boolean {
  return content.includes('\u0000')
}

function normalizeGitStatusFromCode(statusCode: string): TerminalGitStatus {
  if (!statusCode) return 'clean'
  if (
    statusCode === '??' ||
    statusCode.includes('A') ||
    statusCode.includes('D') ||
    statusCode.includes('R') ||
    statusCode.includes('C')
  ) {
    return 'added'
  }
  if (statusCode.includes('M') || statusCode.includes('U')) {
    return 'modified'
  }
  return 'clean'
}

function mergeTerminalStatus(a: TerminalGitStatus, b: TerminalGitStatus): TerminalGitStatus {
  if (a === 'added' || b === 'added') return 'added'
  if (a === 'modified' || b === 'modified') return 'modified'
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  return 'clean'
}

function parseStatusPorcelainOutput(output: string): TerminalGitStatus {
  if (!output.trim()) return 'clean'
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  let status: TerminalGitStatus = 'clean'
  for (const line of lines) {
    const statusCode = line.substring(0, 2)
    status = mergeTerminalStatus(status, normalizeGitStatusFromCode(statusCode))
    if (status === 'added') return status
  }
  return status
}

export type GitBranchAndStatus = {
  branch: string | null
  status: TerminalGitStatus
}

function parsePorcelainV2BranchAndStatus(output: string): GitBranchAndStatus {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  let branchHead: string | null = null
  let branchOid: string | null = null
  let status: TerminalGitStatus = 'clean'

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branchHead = line.slice('# branch.head '.length).trim()
      continue
    }
    if (line.startsWith('# branch.oid ')) {
      branchOid = line.slice('# branch.oid '.length).trim()
      continue
    }

    if (line.startsWith('? ')) {
      status = 'added'
      continue
    }

    if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const tokens = line.split(' ')
      const statusCode = tokens[1] || ''
      status = mergeTerminalStatus(status, normalizeGitStatusFromCode(statusCode))
      if (status === 'added') continue
    }
  }

  if (branchHead && branchHead !== '(detached)' && branchHead !== 'HEAD') {
    return { branch: branchHead, status }
  }

  if (branchHead === '(detached)' || branchHead === 'HEAD') {
    if (branchOid && branchOid !== '(initial)') {
      const shortSha = branchOid.slice(0, 7)
      return { branch: shortSha ? `detached@${shortSha}` : 'detached', status }
    }
    return { branch: 'detached', status }
  }

  return { branch: branchHead || null, status }
}

/**
 * Check if Git is installed
 */
export async function checkGitInstalled(): Promise<boolean> {
  if (cachedGitAvailable === true) {
    return true
  }
  if (cachedGitAvailable === false && cachedGitCheckedAt) {
    if (Date.now() - cachedGitCheckedAt < 5000) {
      return false
    }
  }

  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    cachedGitAvailable = false
    cachedGitCheckedAt = Date.now()
    return false
  }

  try {
    await execFileAsync(
      gitExecutable,
      ['--version'],
      { timeout: EXEC_TIMEOUT, env: getExecEnv() },
      { kind: 'misc', priority: 'low', dedupeKey: 'git:version:check-installed' }
    )
    cachedGitAvailable = true
    cachedGitCheckedAt = Date.now()
    return true
  } catch {
    cachedGitAvailable = false
    cachedGitCheckedAt = Date.now()
    return false
  }
}

/**
 * Get the terminal's working directory (via PID)
 */
export async function getTerminalCwd(terminalId: string): Promise<string | null> {
  const now = Date.now()
  const cached = terminalCwdCache.get(terminalId)
  if (cached && now - cached.at < TERMINAL_CWD_CACHE_TTL) {
    return cached.value
  }
  const inflight = terminalCwdInFlight.get(terminalId)
  if (inflight) {
    return inflight
  }

  const task = (async () => {
    const probeStartedAt = Date.now()
    const ptyProcess = ptyManager.get(terminalId)
    if (!ptyProcess) {
      terminalCwdCache.set(terminalId, { value: null, at: Date.now() })
      return null
    }

    const pid = ptyProcess.pid

    try {
      const os = platform()

      if (os === 'darwin' || os === 'linux') {
        // macOS/Linux uses single-process lsof to avoid pipeline chains creating additional child processes
        const { stdout } = await execFileAsync(
          'lsof',
          ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          { timeout: EXEC_TIMEOUT, env: getExecEnv() },
          {
            kind: 'cwd',
            priority: 'high',
            dedupeKey: `cwd:lsof:${terminalId}:${pid}`,
            label: `lsof cwd pid=${pid}`
          }
        )
        const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
        const cwdLine = output.split('\n').find((line) => line.startsWith('n')) || ''
        const cwd = cwdLine.slice(1).trim()
        const value = cwd || null
        terminalCwdCache.set(terminalId, { value, at: Date.now() })
        return value
      } else if (os === 'win32') {
        // Windows: use CWD tracked via shell integration (OSC 9;9 escape
        // sequence emitted by the injected PowerShell prompt / cmd PROMPT).
        // The old approach — (Get-Process -Id $pid).Path | Split-Path —
        // returned the *executable* path, not the working directory.
        const trackedCwd = ptyManager.getCwd(terminalId)
        terminalCwdCache.set(terminalId, { value: trackedCwd, at: Date.now() })
        return trackedCwd
      }

      terminalCwdCache.set(terminalId, { value: null, at: Date.now() })
      return null
    } catch (error) {
      console.error('Failed to get terminal cwd:', error)
      terminalCwdCache.set(terminalId, { value: null, at: Date.now() })
      return null
    } finally {
      gitRuntimeManager.recordCwdProbeLatency(Date.now() - probeStartedAt)
    }
  })()

  terminalCwdInFlight.set(terminalId, task)
  try {
    return await task
  } finally {
    terminalCwdInFlight.delete(terminalId)
  }
}

/**
 * Check whether the directory is a Git repository
 */
async function checkGitRepository(cwd: string, gitExecutable: string): Promise<{ isRepo: boolean; error?: string }> {
  try {
    await execFileAsync(
      gitExecutable,
      ['rev-parse', '--is-inside-work-tree'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      },
      {
        repoKey: cwd,
        priority: 'high',
        dedupeKey: `repo:check:${resolve(cwd)}`,
        label: 'git rev-parse --is-inside-work-tree'
      }
    )
    return { isRepo: true }
  } catch (error) {
    return {
      isRepo: false,
      error: formatGitError(error)
    }
  }
}

async function getGitRoot(cwd: string, gitExecutable: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['rev-parse', '--show-toplevel'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      },
      {
        repoKey: cwd,
        priority: 'high',
        dedupeKey: `repo:root:${resolve(cwd)}`,
        label: 'git rev-parse --show-toplevel'
      }
    )
    const root = (typeof stdout === 'string' ? stdout : stdout.toString('utf-8')).trim()
    return root || null
  } catch {
    return null
  }
}

/**
 * Get the Git branch name (non-repository or null on failure)
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      },
      {
        repoKey: cwd,
        priority: 'normal',
        dedupeKey: `branch:${resolve(cwd)}`,
        label: 'git rev-parse --abbrev-ref HEAD'
      }
    )
    const branch = (typeof stdout === 'string' ? stdout : stdout.toString('utf-8')).trim()
    if (!branch) return null
    if (branch === 'HEAD') {
      try {
        const { stdout: sha } = await execFileAsync(
          'git',
          ['rev-parse', '--short', 'HEAD'],
          {
            cwd,
            timeout: EXEC_TIMEOUT,
            env: getExecEnv()
          },
          {
            repoKey: cwd,
            priority: 'normal',
            dedupeKey: `branch-short:${resolve(cwd)}`,
            label: 'git rev-parse --short HEAD'
          }
        )
        const shortSha = (typeof sha === 'string' ? sha : sha.toString('utf-8')).trim()
        return shortSha ? `detached@${shortSha}` : 'detached'
      } catch {
        return 'detached'
      }
    }
    return branch
  } catch {
    return null
  }
}

/**
 * Get the Git repository name (not a repository or return null on failure)
 */
export async function getGitRepoName(cwd: string): Promise<string | null> {
  try {
    const meta = await getGitRepoMeta(cwd)
    const repoRoot = meta.repoRoot
    if (!repoRoot) return null
    const normalizedRoot = repoRoot.replace(/[\\/]+$/, '')
    const name = basename(normalizedRoot)
    return name || null
  } catch {
    return null
  }
}

export type GitRepoMeta = {
  gitExecutable: string | null
  repoRoot: string | null
  gitDir: string | null
  isRepo: boolean
}

export async function getGitRepoMeta(cwd: string): Promise<GitRepoMeta> {
  const normalizedCwd = resolve(cwd)
  const now = Date.now()
  const cached = gitMetaCache.get(normalizedCwd)
  if (cached && now - cached.at < GIT_META_CACHE_TTL) {
    return cached.value
  }

  const inflight = gitMetaInFlight.get(normalizedCwd)
  if (inflight) {
    return inflight
  }

  const task = (async () => {
    const gitExecutable = await resolveGitExecutable()
    if (!gitExecutable) {
      return { gitExecutable: null, repoRoot: null, gitDir: null, isRepo: false }
    }

    // Run all three rev-parse queries in a single git invocation
    // to cut 3 sequential process spawns down to 1
    try {
      const { stdout } = await execFileAsync(
        gitExecutable,
        ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-dir'],
        {
          cwd,
          timeout: EXEC_TIMEOUT,
          env: getExecEnv()
        },
        {
          repoKey: cwd,
          priority: 'high',
          dedupeKey: `repo:meta:${resolve(cwd)}`,
          label: 'git rev-parse --is-inside-work-tree --show-toplevel --git-dir'
        }
      )
      const output = (typeof stdout === 'string' ? stdout : stdout.toString('utf-8')).trim()
      const lines = output.split(/\r?\n/)
      // lines[0] = "true", lines[1] = repo root path, lines[2] = git dir path
      const isRepo = lines[0]?.trim() === 'true'
      if (!isRepo) {
        return { gitExecutable, repoRoot: null, gitDir: null, isRepo: false }
      }
      const repoRoot = lines[1]?.trim() || cwd
      const rawGitDir = lines[2]?.trim() || null
      const gitDir = rawGitDir
        ? (isAbsolute(rawGitDir) ? rawGitDir : resolve(repoRoot, rawGitDir))
        : null
      return { gitExecutable, repoRoot, gitDir, isRepo: true }
    } catch {
      return { gitExecutable, repoRoot: null, gitDir: null, isRepo: false }
    }
  })()

  gitMetaInFlight.set(normalizedCwd, task)
  try {
    const value = await task
    gitMetaCache.set(normalizedCwd, { value, at: Date.now() })
    return value
  } finally {
    gitMetaInFlight.delete(normalizedCwd)
  }
}

/**
 * Parse the Git repository root directory corresponding to the specified path.
 * Use getGitRepoMeta's cache to avoid repeated execution of git commands.
 * If it is not a Git repository, the original path is returned.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const meta = await getGitRepoMeta(cwd)
  return meta.repoRoot || cwd
}

async function getStatToken(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return `${Math.floor(info.mtimeMs)}:${info.size}`
  } catch {
    return '-'
  }
}

export async function getGitRepoFingerprint(gitDir: string | null, repoRoot: string): Promise<string> {
  const root = gitDir || join(repoRoot, '.git')
  const [headToken, indexToken, packedRefsToken, refsToken, logsHeadToken] = await Promise.all([
    getStatToken(join(root, 'HEAD')),
    getStatToken(join(root, 'index')),
    getStatToken(join(root, 'packed-refs')),
    getStatToken(join(root, 'refs')),
    getStatToken(join(root, 'logs', 'HEAD'))
  ])
  return [headToken, indexToken, packedRefsToken, refsToken, logsHeadToken].join('|')
}

export async function getGitBranchAndStatus(cwd: string): Promise<GitBranchAndStatus> {
  const meta = await getGitRepoMeta(cwd)
  if (!meta.isRepo || !meta.repoRoot) {
    return { branch: null, status: 'unknown' }
  }

  try {
    const { stdout } = await execFileAsync(
      meta.gitExecutable || 'git',
      ['-c', 'core.quotepath=false', 'status', '--porcelain=2', '--branch', '-uno'],
      {
        cwd: meta.repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv(),
        maxBuffer: MAX_DIFF_OUTPUT
      },
      {
        repoKey: meta.repoRoot,
        priority: 'high',
        dedupeKey: `branch-status:${resolve(meta.repoRoot)}`,
        label: 'git status --porcelain=2 --branch -uno'
      }
    )
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    return parsePorcelainV2BranchAndStatus(output)
  } catch {
    return { branch: null, status: 'unknown' }
  }
}

/**
 * Get Git status summary
 */
export async function getGitStatusSummary(cwd: string): Promise<TerminalGitStatus> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return 'unknown'
  }
  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uno'],
      {
        cwd,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv(),
        maxBuffer: MAX_DIFF_OUTPUT
      },
      {
        repoKey: cwd,
        priority: 'normal',
        label: 'git status --porcelain -uno'
      }
    )
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    return parseStatusPorcelainOutput(output)
  } catch {
    return 'unknown'
  }
}

/**
 * Get terminal Git information (cwd + branch)
 */
export async function getTerminalGitInfo(terminalId: string): Promise<TerminalGitInfo> {
  const now = Date.now()
  const cached = terminalInfoCache.get(terminalId)
  if (cached && now - cached.at < TERMINAL_INFO_CACHE_TTL) {
    return cached.value
  }
  const inflight = terminalInfoInFlight.get(terminalId)
  if (inflight) {
    return inflight
  }

  const task = (async () => {
    const cwd = await getTerminalCwd(terminalId)
    if (!cwd) {
      return { cwd: null, branch: null, repoName: null, status: null }
    }

    const meta = await getGitRepoMeta(cwd)
    if (!meta.isRepo || !meta.repoRoot) {
      return { cwd, branch: null, repoName: null, status: null }
    }

    const repoName = basename(meta.repoRoot.replace(/[\\/]+$/, '')) || null
    const branchStatus = await getGitBranchAndStatus(meta.repoRoot)
    return { cwd, branch: branchStatus.branch, repoName, status: branchStatus.status }
  })()

  terminalInfoInFlight.set(terminalId, task)
  try {
    const info = await task
    terminalInfoCache.set(terminalId, { value: info, at: Date.now() })
    return info
  } finally {
    terminalInfoInFlight.delete(terminalId)
  }
}

function normalizeGitStatusCode(raw: string): GitStatusCode {
  const code = raw.trim()
  if (!code) return 'M'
  const lead = code.charAt(0) as GitStatusCode
  switch (lead) {
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'M':
      return lead
    case '?':
      return '?'
    default:
      return 'M'
  }
}

function parseNameStatusZ(output: string): Array<{ status: GitStatusCode; filename: string; originalFilename?: string }> {
  if (!output) return []
  const tokens = output.split('\0')
  const entries: Array<{ status: GitStatusCode; filename: string; originalFilename?: string }> = []
  let i = 0
  while (i < tokens.length) {
    const statusToken = tokens[i]
    if (!statusToken) {
      i += 1
      continue
    }
    const statusCode = normalizeGitStatusCode(statusToken)
    if (statusCode === 'R' || statusCode === 'C') {
      const originalFilename = tokens[i + 1] || ''
      const filename = tokens[i + 2] || ''
      if (filename) {
        entries.push({
          status: statusCode,
          filename,
          originalFilename: originalFilename || undefined
        })
      }
      i += 3
      continue
    }
    const filename = tokens[i + 1] || ''
    if (filename) {
      entries.push({ status: statusCode, filename })
    }
    i += 2
  }
  return entries
}

function parseNumstatZ(output: string): Map<string, { additions: number; deletions: number; originalFilename?: string }> {
  const stats = new Map<string, { additions: number; deletions: number; originalFilename?: string }>()
  if (!output) return stats
  const tokens = output.split('\0')
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) {
      i += 1
      continue
    }
    const parts = token.split('\t')
    if (parts.length < 3) {
      i += 1
      continue
    }
    const additions = parseInt(parts[0], 10)
    const deletions = parseInt(parts[1], 10)
    const pathPart = parts.slice(2).join('\t')
    const nextToken = tokens[i + 1]
    const isRename = !!nextToken && nextToken.length > 0 && !nextToken.includes('\t')
    if (isRename) {
      stats.set(nextToken, {
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
        originalFilename: pathPart || undefined
      })
      i += 2
      continue
    }
    stats.set(pathPart, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0
    })
    i += 1
  }
  return stats
}

const HISTORY_RECORD_SEPARATOR = '\x1e'
const HISTORY_FIELD_SEPARATOR = '\x1f'

function parseGitLogOutput(output: string): GitCommitInfo[] {
  if (!output) return []
  const records = output.split(HISTORY_RECORD_SEPARATOR).map(item => item.trim()).filter(Boolean)
  const commits: GitCommitInfo[] = []
  for (const record of records) {
    const fields = record.split(HISTORY_FIELD_SEPARATOR)
    if (fields.length < 8) continue
    const [
      sha,
      shortSha,
      parentsRaw,
      authorName,
      authorEmail,
      authorDate,
      refs,
      summary,
      body = ''
    ] = fields
    commits.push({
      sha,
      shortSha,
      parents: parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [],
      summary,
      body,
      authorName,
      authorEmail,
      authorDate,
      refs: refs || undefined
    })
  }
  return commits
}

async function getGitDiffNameStatus(
  cwd: string,
  gitExecutable: string,
  staged: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z']
  if (staged) args.push('--cached')
  args.push('--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitDiffNumstat(
  cwd: string,
  gitExecutable: string,
  staged: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z']
  if (staged) args.push('--cached')
  args.push('--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitRangeNameStatus(
  cwd: string,
  gitExecutable: string,
  base: string,
  head: string,
  hideWhitespace: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z']
  if (hideWhitespace) args.push('-w')
  args.push(base, head, '--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitRangeNumstat(
  cwd: string,
  gitExecutable: string,
  base: string,
  head: string,
  hideWhitespace: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z']
  if (hideWhitespace) args.push('-w')
  args.push(base, head, '--')
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitRangePatch(
  cwd: string,
  gitExecutable: string,
  base: string,
  head: string,
  filePath: string | undefined,
  hideWhitespace: boolean,
  meta?: GitTaskMeta
): Promise<string> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--patch', '--no-color']
  if (hideWhitespace) args.push('-w')
  args.push(base, head)
  if (filePath) {
    args.push('--', filePath)
  }
  const { stdout } = await execFileAsync(gitExecutable, args, {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_DIFF_OUTPUT
  }, meta)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
}

async function getGitUntrackedFiles(cwd: string, gitExecutable: string, meta?: GitTaskMeta): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'],
      { cwd, timeout: EXEC_TIMEOUT, env: getExecEnv(), maxBuffer: MAX_DIFF_OUTPUT },
      meta
    )
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    return output.split('\0').map(item => item.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Get Git Diff information
 */
export async function getGitDiff(cwd: string): Promise<GitDiffResult> {

  // Use getGitRepoMeta (single git process) for install + repo + root checks
  const meta = await getGitRepoMeta(cwd)
  if (!meta.gitExecutable) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: false,
      files: [],
      error: 'Git is not installed. Install Git first.'
    }
  }
  if (!meta.isRepo || !meta.repoRoot) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: true,
      files: [],
      error: 'The current directory is not a Git repository.'
    }
  }
  const gitExecutable = meta.gitExecutable

  try {
    const repoRoot = meta.repoRoot
    const diffMeta: GitTaskMeta = { repoKey: repoRoot, priority: 'high' }

    // Run all five diff queries in parallel for faster results
    const [
      unstagedNameResult,
      stagedNameResult,
      unstagedNumstatResult,
      stagedNumstatResult,
      untrackedResult
    ] = await Promise.all([
      getGitDiffNameStatus(repoRoot, gitExecutable, false, diffMeta).catch((e) => ({ error: e })),
      getGitDiffNameStatus(repoRoot, gitExecutable, true, diffMeta).catch((e) => ({ error: e })),
      getGitDiffNumstat(repoRoot, gitExecutable, false, diffMeta).catch((e) => {
        console.warn('Failed to get unstaged git diff stats:', e)
        return ''
      }),
      getGitDiffNumstat(repoRoot, gitExecutable, true, diffMeta).catch((e) => {
        console.warn('Failed to get staged git diff stats:', e)
        return ''
      }),
      getGitUntrackedFiles(repoRoot, gitExecutable, diffMeta)
    ])

    // Check name-status results for fatal errors
    if (typeof unstagedNameResult === 'object' && 'error' in unstagedNameResult) {
      return {
        success: false,
        cwd: repoRoot,
        isGitRepo: true,
        gitInstalled: true,
        files: [],
        error: `Failed to run git diff: ${formatGitError(unstagedNameResult.error) || String(unstagedNameResult.error)}`
      }
    }
    if (typeof stagedNameResult === 'object' && 'error' in stagedNameResult) {
      return {
        success: false,
        cwd: repoRoot,
        isGitRepo: true,
        gitInstalled: true,
        files: [],
        error: `Failed to run git diff: ${formatGitError(stagedNameResult.error) || String(stagedNameResult.error)}`
      }
    }

    const unstagedNameOutput = unstagedNameResult as string
    const stagedNameOutput = stagedNameResult as string
    const unstagedNumstatOutput = unstagedNumstatResult as string
    const stagedNumstatOutput = stagedNumstatResult as string
    const untrackedFiles = untrackedResult

    const unstagedEntries = parseNameStatusZ(unstagedNameOutput)
    const stagedEntries = parseNameStatusZ(stagedNameOutput)
    const unstagedStats = parseNumstatZ(unstagedNumstatOutput)
    const stagedStats = parseNumstatZ(stagedNumstatOutput)

    const files: GitFileStatus[] = []

    for (const entry of unstagedEntries) {
      const stat = unstagedStats.get(entry.filename)
      files.push({
        filename: entry.filename,
        originalFilename: entry.originalFilename,
        status: entry.status,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        changeType: 'unstaged'
      })
    }

    for (const entry of stagedEntries) {
      const stat = stagedStats.get(entry.filename)
      files.push({
        filename: entry.filename,
        originalFilename: entry.originalFilename,
        status: entry.status,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        changeType: 'staged'
      })
    }

    for (const filename of untrackedFiles) {
      files.push({
        filename,
        status: '?',
        additions: 0,
        deletions: 0,
        changeType: 'untracked'
      })
    }

    return {
      success: true,
      cwd: repoRoot,
      isGitRepo: true,
      gitInstalled: true,
      files
    }
  } catch (error) {
    console.error('Failed to get git diff:', error)
    const message = formatGitError(error) || String(error)
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      files: [],
      error: `Failed to load Git Diff: ${message}`
    }
  }
}

export async function getGitHistory(
  cwd: string,
  limit = 50,
  skip = 0
): Promise<GitHistoryResult> {
  // Use getGitRepoMeta (single git process) for install + repo + root checks
  const repoMeta = await getGitRepoMeta(cwd)
  if (!repoMeta.gitExecutable) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: false,
      commits: [],
      error: 'Git is not installed. Install Git first.'
    }
  }
  if (!repoMeta.isRepo || !repoMeta.repoRoot) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: true,
      commits: [],
      error: 'The current directory is not a Git repository.'
    }
  }
  const gitExecutable = repoMeta.gitExecutable

  try {
    const repoRoot = repoMeta.repoRoot
    const meta: GitTaskMeta = { repoKey: repoRoot, priority: 'high' }

    const format = [
      '%H',
      '%h',
      '%P',
      '%an',
      '%ae',
      '%ad',
      '%D',
      '%s',
      '%b'
    ].join(HISTORY_FIELD_SEPARATOR) + HISTORY_RECORD_SEPARATOR

    const logArgs = [
      '-c',
      'core.quotepath=false',
      'log',
      '--date=iso-strict',
      `--pretty=format:${format}`,
      `-n`,
      `${Math.max(1, Math.min(limit, 500))}`,
      `--skip=${Math.max(0, skip)}`
    ]

    const [countResult, logResult] = await Promise.all([
      execFileAsync(gitExecutable, ['rev-list', '--count', 'HEAD'], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      }, meta).catch(() => null),
      execFileAsync(gitExecutable, logArgs, {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv(),
        maxBuffer: MAX_DIFF_OUTPUT
      }, meta)
    ])

    let totalCount: number | undefined
    if (countResult) {
      const count = parseInt(typeof countResult.stdout === 'string' ? countResult.stdout.trim() : countResult.stdout.toString('utf-8').trim(), 10)
      if (Number.isFinite(count)) {
        totalCount = count
      }
    }

    const output = typeof logResult.stdout === 'string' ? logResult.stdout : logResult.stdout.toString('utf-8')
    const commits = parseGitLogOutput(output)
    return {
      success: true,
      cwd: repoRoot,
      isGitRepo: true,
      gitInstalled: true,
      commits,
      totalCount
    }
  } catch (error) {
    const message = formatGitError(error) || String(error)
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      commits: [],
      error: `Failed to load Git History: ${message}`
    }
  }
}

export async function getGitHistoryDiff(
  cwd: string,
  options: GitHistoryDiffOptions
): Promise<GitHistoryDiffResult> {
  const gitInstalled = await checkGitInstalled()
  const gitExecutable = await resolveGitExecutable()
  if (!gitInstalled || !gitExecutable) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: false,
      base: options.base,
      head: options.head,
      patch: '',
      files: [],
      error: 'Git is not installed. Install Git first.'
    }
  }

  const repoCheck = await checkGitRepository(cwd, gitExecutable)
  if (!repoCheck.isRepo) {
    return {
      success: false,
      cwd,
      isGitRepo: false,
      gitInstalled: true,
      base: options.base,
      head: options.head,
      patch: '',
      files: [],
      error: repoCheck.error || 'The current directory is not a Git repository.'
    }
  }

  const { base, head, filePath, hideWhitespace = false, includeFiles = true } = options
  if (!base || !head) {
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      base: base || '',
      head: head || '',
      patch: '',
      files: [],
      error: 'Missing commit range.'
    }
  }

  try {
    const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
    const meta: GitTaskMeta = { repoKey: repoRoot, priority: 'high' }
    let files: GitHistoryFile[] = []
    if (includeFiles) {
      const [nameOutput, numstatOutput] = await Promise.all([
        getGitRangeNameStatus(repoRoot, gitExecutable, base, head, hideWhitespace, meta),
        getGitRangeNumstat(repoRoot, gitExecutable, base, head, hideWhitespace, meta)
      ])
      const entries = parseNameStatusZ(nameOutput)
      const stats = parseNumstatZ(numstatOutput)
      files = entries.map((entry) => {
        const stat = stats.get(entry.filename)
        return {
          filename: entry.filename,
          originalFilename: entry.originalFilename,
          status: entry.status,
          additions: stat?.additions ?? 0,
          deletions: stat?.deletions ?? 0
        }
      })
    }

    const patch = filePath
      ? await getGitRangePatch(repoRoot, gitExecutable, base, head, filePath, hideWhitespace, meta)
      : ''

    return {
      success: true,
      cwd: repoRoot,
      isGitRepo: true,
      gitInstalled: true,
      base,
      head,
      patch,
      files
    }
  } catch (error) {
    const message = formatGitError(error) || String(error)
    return {
      success: false,
      cwd,
      isGitRepo: true,
      gitInstalled: true,
      base: options.base,
      head: options.head,
      patch: '',
      files: [],
      error: `Failed to load Git History diff: ${message}`
    }
  }
}

async function readWorkingFile(fullPath: string): Promise<{ content: string; isBinary: boolean }> {
  const fileStat = await stat(fullPath)
  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(`File is too large to load (>${Math.floor(MAX_FILE_SIZE / 1024)}KB).`)
  }
  const buffer = await readFile(fullPath)
  const isBinary = buffer.includes(0)
  if (isBinary) {
    return { content: '', isBinary: true }
  }
  return { content: buffer.toString('utf-8'), isBinary: false }
}

async function readGitFileByRef(cwd: string, gitExecutable: string, ref: string): Promise<{ content: string; isBinary: boolean }> {
  try {
    const sizeResult = await execFileAsync(gitExecutable, ['cat-file', '-s', ref], {
      cwd,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    const sizeText = typeof sizeResult.stdout === 'string' ? sizeResult.stdout : sizeResult.stdout.toString('utf-8')
    const size = parseInt(sizeText.trim(), 10)
    if (Number.isFinite(size) && size > MAX_FILE_SIZE) {
      throw new Error(`File is too large to load (>${Math.floor(MAX_FILE_SIZE / 1024)}KB).`)
    }
  } catch (error) {
    throw new Error(`Failed to read Git file metadata: ${String(error)}`)
  }

  const contentResult = await execFileAsync(gitExecutable, ['-c', 'core.quotepath=false', 'show', ref], {
    cwd,
    timeout: EXEC_TIMEOUT,
    env: getExecEnv(),
    maxBuffer: MAX_FILE_SIZE * 2
  })
  const contentText = typeof contentResult.stdout === 'string' ? contentResult.stdout : contentResult.stdout.toString('utf-8')
  const isBinary = hasNullByte(contentText)
  if (isBinary) {
    return { content: '', isBinary: true }
  }
  return { content: contentText, isBinary: false }
}

async function readGitHeadFile(cwd: string, gitExecutable: string, gitPath: string): Promise<{ content: string; isBinary: boolean }> {
  return readGitFileByRef(cwd, gitExecutable, `HEAD:${gitPath}`)
}

async function readGitIndexFile(cwd: string, gitExecutable: string, gitPath: string): Promise<{ content: string; isBinary: boolean }> {
  return readGitFileByRef(cwd, gitExecutable, `:${gitPath}`)
}

export async function getGitFileContent(
  cwd: string,
  file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType'>
): Promise<GitFileContentResult> {
  const gitInstalled = await checkGitInstalled()
  const gitExecutable = await resolveGitExecutable()
  if (!gitInstalled || !gitExecutable) {
    return {
      success: false,
      cwd,
      filename: file.filename,
      originalContent: '',
      modifiedContent: '',
      isBinary: false,
      error: 'Git is not installed. Install Git first.'
    }
  }

  const repoCheck = await checkGitRepository(cwd, gitExecutable)
  if (!repoCheck.isRepo) {
    return {
      success: false,
      cwd,
      filename: file.filename,
      originalContent: '',
      modifiedContent: '',
      isBinary: false,
      error: repoCheck.error || 'The current directory is not a Git repository.'
    }
  }

  const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  const filename = file.filename
  const changeType: GitChangeType = file.changeType || 'unstaged'
  const originalTarget = file.status === 'R' && file.originalFilename ? file.originalFilename : filename

  let originalContent = ''
  let modifiedContent = ''
  let isBinary = false

  try {
    if (changeType === 'staged') {
      if (file.status !== 'A' && file.status !== '?') {
        const gitPath = toGitPath(repoRoot, originalTarget)
        if (!gitPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent: '',
            modifiedContent: '',
            isBinary: false,
            error: 'Invalid file path.'
          }
        }
        const originalResult = await readGitHeadFile(repoRoot, gitExecutable, gitPath)
        originalContent = originalResult.content
        if (originalResult.isBinary) {
          isBinary = true
        }
      }

      if (file.status !== 'D') {
        const gitPath = toGitPath(repoRoot, filename)
        if (!gitPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent,
            modifiedContent: '',
            isBinary,
            error: 'Invalid file path.'
          }
        }
        const modifiedResult = await readGitIndexFile(repoRoot, gitExecutable, gitPath)
        modifiedContent = modifiedResult.content
        if (modifiedResult.isBinary) {
          isBinary = true
        }
      }
    } else if (changeType === 'unstaged') {
      if (file.status !== 'A' && file.status !== '?') {
        const gitPath = toGitPath(repoRoot, originalTarget)
        if (!gitPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent: '',
            modifiedContent: '',
            isBinary: false,
            error: 'Invalid file path.'
          }
        }
        const originalResult = await readGitIndexFile(repoRoot, gitExecutable, gitPath)
        originalContent = originalResult.content
        if (originalResult.isBinary) {
          isBinary = true
        }
      }

      if (file.status !== 'D') {
        const fullPath = resolvePathInRepo(repoRoot, filename)
        if (!fullPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent,
            modifiedContent: '',
            isBinary,
            error: 'Invalid file path.'
          }
        }
        const workingResult = await readWorkingFile(fullPath)
        modifiedContent = workingResult.content
        if (workingResult.isBinary) {
          isBinary = true
        }
      }
    } else {
      if (file.status !== 'D') {
        const fullPath = resolvePathInRepo(repoRoot, filename)
        if (!fullPath) {
          return {
            success: false,
            cwd: repoRoot,
            filename,
            originalContent,
            modifiedContent: '',
            isBinary,
            error: 'Invalid file path.'
          }
        }
        const workingResult = await readWorkingFile(fullPath)
        modifiedContent = workingResult.content
        if (workingResult.isBinary) {
          isBinary = true
        }
      }
    }

    return {
      success: true,
      cwd: repoRoot,
      filename,
      originalContent,
      modifiedContent,
      isBinary
    }
  } catch (error) {
    return {
      success: false,
      cwd: repoRoot,
      filename,
      originalContent: '',
      modifiedContent: '',
      isBinary,
      error: `Failed to read file: ${String(error)}`
    }
  }
}

export async function saveGitFileContent(
  cwd: string,
  filename: string,
  content: string
): Promise<GitFileSaveResult> {
  let repoRoot = cwd
  const gitExecutable = await resolveGitExecutable()
  if (gitExecutable) {
    repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  }
  const fullPath = resolvePathInRepo(repoRoot, filename)
  if (!fullPath) {
    return {
      success: false,
      filename,
      error: 'Invalid file path.'
    }
  }

  try {
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
    return { success: true, filename }
  } catch (error) {
    return {
      success: false,
      filename,
      error: `Failed to save file: ${String(error)}`
    }
  }
}

async function resolveIndexFileMode(
  repoRoot: string,
  gitExecutable: string,
  gitPath: string,
  filename: string
): Promise<string> {
  try {
    const lsResult = await execFileAsync(gitExecutable, ['ls-files', '-s', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    const text = typeof lsResult.stdout === 'string'
      ? lsResult.stdout
      : lsResult.stdout.toString('utf-8')
    const line = text.trim()
    if (line) {
      const mode = line.split(/\s+/)[0]
      if (mode) return mode
    }
  } catch {
    // ignore
  }

  if (platform() !== 'win32') {
    try {
      const fullPath = resolvePathInRepo(repoRoot, filename)
      if (fullPath) {
        const fileStat = await stat(fullPath)
        return (fileStat.mode & 0o111) !== 0 ? '100755' : '100644'
      }
    } catch {
      // ignore
    }
  }

  return '100644'
}

export async function updateGitIndexContent(
  cwd: string,
  filename: string,
  content: string
): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, filename)
  if (!gitPath) {
    return { success: false, filename, error: 'Invalid file path.' }
  }

  const mode = await resolveIndexFileMode(repoRoot, gitExecutable, gitPath, filename)
  const tempDir = await mkdtemp(resolve(tmpdir(), 'onward-git-'))
  const tempFile = resolve(tempDir, 'index-content')

  try {
    await writeFile(tempFile, content, 'utf-8')
    const hashResult = await execFileAsync(gitExecutable, ['hash-object', '-w', '--', tempFile], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    const hash = typeof hashResult.stdout === 'string'
      ? hashResult.stdout.trim()
      : hashResult.stdout.toString('utf-8').trim()
    if (!hash) {
      throw new Error('Failed to create Git object.')
    }
    await execFileAsync(gitExecutable, ['update-index', '--add', '--cacheinfo', mode, hash, gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    return { success: true, filename }
  } catch (error) {
    return { success: false, filename, error: `Failed to update the Git index: ${formatGitError(error) || String(error)}` }
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

export async function stageGitFile(cwd: string, filename: string): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, filename)
  if (!gitPath) {
    return { success: false, filename, error: 'Invalid file path.' }
  }

  try {
    await execFileAsync(gitExecutable, ['add', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    return { success: true, filename }
  } catch (error) {
    return { success: false, filename, error: `Failed to stage file: ${formatGitError(error) || String(error)}` }
  }
}

export async function unstageGitFile(cwd: string, filename: string): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, filename)
  if (!gitPath) {
    return { success: false, filename, error: 'Invalid file path.' }
  }

  try {
    await execFileAsync(gitExecutable, ['reset', 'HEAD', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    return { success: true, filename }
  } catch (error) {
    return { success: false, filename, error: `Failed to unstage file: ${formatGitError(error) || String(error)}` }
  }
}

export async function discardGitFile(
  cwd: string,
  file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status'>
): Promise<GitFileActionResult> {
  const gitExecutable = await resolveGitExecutable()
  if (!gitExecutable) {
    return { success: false, filename: file.filename, error: 'Git is not installed. Install Git first.' }
  }
  const repoRoot = (await getGitRoot(cwd, gitExecutable)) || cwd
  const gitPath = toGitPath(repoRoot, file.filename)
  if (!gitPath) {
    return { success: false, filename: file.filename, error: 'Invalid file path.' }
  }

  try {
    if (file.changeType === 'staged') {
      await execFileAsync(gitExecutable, ['reset', 'HEAD', '--', gitPath], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      })
      return { success: true, filename: file.filename }
    }

    if (file.changeType === 'untracked' || file.status === '?') {
      await execFileAsync(gitExecutable, ['clean', '-f', '--', gitPath], {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT,
        env: getExecEnv()
      })
      return { success: true, filename: file.filename }
    }

    await execFileAsync(gitExecutable, ['checkout', '--', gitPath], {
      cwd: repoRoot,
      timeout: EXEC_TIMEOUT,
      env: getExecEnv()
    })
    return { success: true, filename: file.filename }
  } catch (error) {
    return {
      success: false,
      filename: file.filename,
      error: `Failed to discard changes: ${formatGitError(error) || String(error)}`
    }
  }
}
