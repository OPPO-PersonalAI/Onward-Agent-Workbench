/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, BrowserWindow, net } from 'electron'
import { createHash } from 'crypto'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import { spawn, execFileSync } from 'child_process'
import { getAppInfo, type ReleaseChannel, type ReleaseOs } from './app-info'
import { compareVersions, parseVersion } from './update-version'
import { getTelemetryService } from './telemetry/telemetry-service'

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'unsupported' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  supported: boolean
  currentVersion: string
  currentTag: string | null
  currentChannel: ReleaseChannel
  currentReleaseOs: ReleaseOs
  targetVersion: string | null
  targetTag: string | null
  downloadedFileName: string | null
  lastCheckedAt: number | null
  error: string | null
  bannerDismissed: boolean
}

interface UpdateManifest {
  channel: ReleaseChannel
  version: string
  tag: string
  platform: ReleaseOs
  arch: 'arm64' | 'x64'
  artifactName: string
  artifactUrl: string
  sha256: string
  releaseNotes: string | null
  publishedAt: string
}

interface DownloadedUpdate {
  manifest: UpdateManifest
  archivePath: string
}

const RELAUNCH_ENV_KEYS = [
  'ONWARD_USER_DATA_DIR',
  'ONWARD_DEBUG',
  'ONWARD_UPDATE_CHECK_INTERVAL_MS',
  'ONWARD_UPDATE_BASE_URL',
  'ONWARD_AUTOTEST',
  'ONWARD_AUTOTEST_CWD',
  'ONWARD_AUTOTEST_EXIT',
  'ONWARD_DEBUG_CAPTURE'
] as const

const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_UPDATE_REQUEST_TIMEOUT_MS = 60 * 1000
const DEFAULT_UPDATE_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000
const LOG_PREFIX = '[UpdateService]'
const PENDING_UPDATE_MARKER_SCHEMA_VERSION = 1
const MAX_PENDING_UPDATE_MARKER_AGE_MS = 60 * 60 * 1000
const MAX_PENDING_UPDATE_STARTUP_ATTEMPTS = 1

/** Pending update marker written before launching the installer script. */
interface PendingUpdateInfo {
  schemaVersion: 1
  archivePath: string
  archiveSha256: string
  artifactName: string
  installDir: string
  execPath: string
  logPath: string
  timestamp: number
  targetVersion: string
  attempts: number
}

/** Append a timestamped line to the install log (non-blocking, never throws). */
function appendToInstallLog(logPath: string, message: string): void {
  try {
    const dir = dirname(logPath)
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    appendFileSync(logPath, `${ts} ${message}\n`, 'utf-8')
  } catch { /* non-critical */ }
}

function safeRemoveFile(filePath: string): void {
  try { rmSync(filePath, { force: true }) } catch {}
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isSafeArtifactName(value: string): boolean {
  return value === basename(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value.toLowerCase().endsWith('.zip')
}

function normalizeWindowsPathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '').toLowerCase()
}

function validatePendingUpdateInfo(raw: unknown): { info: PendingUpdateInfo | null; error: string | null } {
  if (!raw || typeof raw !== 'object') {
    return { info: null, error: 'marker is not an object' }
  }

  const value = raw as Partial<PendingUpdateInfo>
  const requiredStrings: Array<keyof Pick<PendingUpdateInfo, 'archivePath' | 'archiveSha256' | 'artifactName' | 'installDir' | 'execPath' | 'logPath' | 'targetVersion'>> = [
    'archivePath',
    'archiveSha256',
    'artifactName',
    'installDir',
    'execPath',
    'logPath',
    'targetVersion'
  ]

  if (value.schemaVersion !== PENDING_UPDATE_MARKER_SCHEMA_VERSION) {
    return { info: null, error: `unsupported marker schema version: ${String(value.schemaVersion)}` }
  }
  for (const key of requiredStrings) {
    if (!isNonEmptyString(value[key])) {
      return { info: null, error: `missing or invalid marker field: ${key}` }
    }
  }
  if (!Number.isFinite(value.timestamp) || typeof value.timestamp !== 'number') {
    return { info: null, error: 'missing or invalid marker timestamp' }
  }
  if (!Number.isInteger(value.attempts) || typeof value.attempts !== 'number' || value.attempts < 0) {
    return { info: null, error: 'missing or invalid marker attempts' }
  }
  if (!/^[a-f0-9]{64}$/i.test(value.archiveSha256!)) {
    return { info: null, error: 'invalid archive checksum in marker' }
  }
  if (!isSafeArtifactName(value.artifactName!)) {
    return { info: null, error: 'invalid artifact name in marker' }
  }
  for (const key of ['archivePath', 'installDir', 'execPath', 'logPath'] as const) {
    if (!isAbsolute(value[key]!)) {
      return { info: null, error: `marker path must be absolute: ${key}` }
    }
  }

  return { info: value as PendingUpdateInfo, error: null }
}

function writePendingUpdateInfo(markerPath: string, info: PendingUpdateInfo): void {
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(markerPath, `${JSON.stringify(info, null, 2)}\n`, 'utf-8')
}

/** Build PowerShell $env:KEY = 'VALUE' statements for preserved env vars. */
function buildEnvSetStatements(): string {
  return RELAUNCH_ENV_KEYS
    .map((key) => {
      const value = process.env[key]
      if (!value) return null
      return `$env:${key} = ${powershellEscape(value)}`
    })
    .filter((value): value is string => Boolean(value))
    .join('\n')
}

/**
 * Generate the PowerShell script that waits for the parent process to exit,
 * replaces the installation directory with the new archive, and relaunches.
 */
function buildWindowsUpdateScript(params: {
  installDir: string
  execPath: string
  archivePath: string
  archiveSha256: string
  parentPid: number
  stagingRoot: string
  logPath: string
  markerPath: string
  lockPath: string
  envSetStatements: string
}): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$installDir = ${powershellEscape(params.installDir)}`,
    `$execPath = ${powershellEscape(params.execPath)}`,
    `$archivePath = ${powershellEscape(params.archivePath)}`,
    `$archiveSha256 = ${powershellEscape(params.archiveSha256)}`,
    `$parentPid = ${params.parentPid}`,
    `$stagingRoot = ${powershellEscape(params.stagingRoot)}`,
    `$logPath = ${powershellEscape(params.logPath)}`,
    `$markerPath = ${powershellEscape(params.markerPath)}`,
    `$lockPath = ${powershellEscape(params.lockPath)}`,
    '$extractRoot = Join-Path $stagingRoot "e"',
    '$installParent = Split-Path $installDir -Parent',
    '$installLeaf = Split-Path $installDir -Leaf',
    '$backupPath = Join-Path $installParent "${installLeaf}.bak"',
    '$lockCreated = $false',
    '$parentExited = $false',
    '',
    'function Write-Log($msg) {',
    '    $dir = Split-Path $logPath -Parent',
    '    if (-not (Test-Path -LiteralPath $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }',
    '    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
    '    Add-Content -LiteralPath $logPath -Value "$ts $msg" -ErrorAction SilentlyContinue',
    '}',
    '',
    'function Clear-Marker {',
    '    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue',
    '}',
    '',
    'function Relaunch-CurrentApp($reason) {',
    '    if (-not (Test-Path -LiteralPath $execPath)) {',
    '        Write-Log "Cannot relaunch ${reason}: executable not found at $execPath"',
    '        return',
    '    }',
    '    try {',
    params.envSetStatements,
    '        Write-Log "Relaunching ${reason}."',
    '        Start-Process -FilePath $execPath',
    '    } catch {',
    '        Write-Log "Failed to relaunch ${reason}: $_"',
    '    }',
    '}',
    '',
    'function Restore-Backup {',
    '    if (-not (Test-Path -LiteralPath $backupPath)) { return }',
    '    try {',
    '        if (Test-Path -LiteralPath $installDir) {',
    '            $failedPath = Join-Path $installParent "${installLeaf}.failed-$PID"',
    '            try {',
    '                Rename-Item -LiteralPath $installDir -NewName (Split-Path $failedPath -Leaf) -Force',
    '                Remove-Item -LiteralPath $failedPath -Recurse -Force -ErrorAction SilentlyContinue',
    '            } catch {',
    '                Write-Log "Could not move failed install directory aside: $_"',
    '                try {',
    '                    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction Stop',
    '                } catch {',
    '                    Write-Log "Could not remove failed install directory: $_"',
    '                }',
    '            }',
    '        }',
    '        if (-not (Test-Path -LiteralPath $installDir)) {',
    '            Rename-Item -LiteralPath $backupPath -NewName $installLeaf -Force',
    '            Write-Log "Restored backup after failure."',
    '        }',
    '    } catch {',
    '        Write-Log "Backup restore failed: $_"',
    '    }',
    '}',
    '',
    'try {',
    '    Write-Log "Starting Windows update install helper. PID=$PID"',
    '',
    '    $lockDir = Split-Path $lockPath -Parent',
    '    if (-not (Test-Path -LiteralPath $lockDir)) { New-Item -Path $lockDir -ItemType Directory -Force | Out-Null }',
    '    if (Test-Path -LiteralPath $lockPath) {',
    '        try {',
    '            $lockItem = Get-Item -LiteralPath $lockPath -ErrorAction Stop',
    '            if (((Get-Date) - $lockItem.LastWriteTime).TotalMinutes -gt 30) {',
    '                Write-Log "Removing stale install lock: $lockPath"',
    '                Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop',
    '            }',
    '        } catch {',
    '            Write-Log "Failed to inspect stale install lock: $_"',
    '        }',
    '    }',
    '    try {',
    '        New-Item -Path $lockPath -ItemType File -Value "$PID" -ErrorAction Stop | Out-Null',
    '        $lockCreated = $true',
    '    } catch {',
    '        Write-Log "Another update install helper is already active: $_"',
    '        exit 0',
    '    }',
    '',
    '    # Wait for parent process to exit',
    '    try {',
    '        $proc = Get-Process -Id $parentPid -ErrorAction SilentlyContinue',
    '        if ($proc) {',
    '            Write-Log "Waiting for parent process ($parentPid) to exit."',
    '            $parentExited = $proc.WaitForExit(120000)',
    '            if (-not $parentExited) { throw "Parent process $parentPid did not exit within 120s." }',
    '        } else {',
    '            $parentExited = $true',
    '        }',
    '    } catch { throw }',
    '    Write-Log "Parent process exited."',
    '',
    '    # Wait briefly for OS to release file handles',
    '    Start-Sleep -Seconds 2',
    '',
    '    # Clean previous staging and backup',
    '    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }',
    '    if (Test-Path -LiteralPath $backupPath) {',
    '        if (-not (Test-Path -LiteralPath $installDir)) {',
    '            Rename-Item -LiteralPath $backupPath -NewName $installLeaf -Force',
    '            Write-Log "Restored leftover backup before retry."',
    '            Clear-Marker',
    '            Relaunch-CurrentApp "existing app after backup restore"',
    '            exit 0',
    '        }',
    '        Remove-Item -LiteralPath $backupPath -Recurse -Force',
    '    }',
    '',
    '    # Verify archive before touching the installed app',
    '    Write-Log "Verifying update archive checksum."',
    '    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()',
    '    if ($actualSha256 -ne $archiveSha256.ToLowerInvariant()) {',
    '        throw "Archive checksum mismatch: expected=$archiveSha256 actual=$actualSha256"',
    '    }',
    '',
    '    # Extract archive',
    '    Write-Log "Extracting update archive: $archivePath"',
    '    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force',
    '    Write-Log "Extraction complete."',
    '',
    '    # Detect extracted content: single subdirectory or flat contents',
    '    $extractedItems = @(Get-ChildItem -LiteralPath $extractRoot -Force)',
    '    if ($extractedItems.Count -eq 0) { throw "Extracted update archive is empty." }',
    '    if ($extractedItems.Count -eq 1 -and $extractedItems[0].PSIsContainer) {',
    '        $sourceDir = $extractedItems[0].FullName',
    '    } else {',
    '        $sourceDir = $extractRoot',
    '    }',
    '    $sourceExe = Join-Path $sourceDir (Split-Path $execPath -Leaf)',
    '    if (-not (Test-Path -LiteralPath $sourceExe)) {',
    '        throw "Extracted update does not contain expected executable: $sourceExe"',
    '    }',
    '',
    '    # Backup current installation (with retries for locked files)',
    '    Write-Log "Backing up current installation."',
    '    $retryCount = 0',
    '    $maxRetries = 5',
    '    while ($true) {',
    '        try {',
    '            Rename-Item -LiteralPath $installDir -NewName (Split-Path $backupPath -Leaf) -Force',
    '            break',
    '        } catch {',
    '            $retryCount++',
    '            if ($retryCount -ge $maxRetries) {',
    '                Write-Log "Backup failed after $maxRetries attempts: $_"',
    '                throw',
    '            }',
    '            Write-Log "Backup attempt $retryCount failed, retrying in 3s: $_"',
    '            Start-Sleep -Seconds 3',
    '        }',
    '    }',
    '',
    '    # Install update',
    '    Write-Log "Installing update."',
    '    if ($sourceDir -ne $extractRoot) {',
    '        Move-Item -LiteralPath $sourceDir -Destination $installDir -Force',
    '    } else {',
    '        New-Item -Path $installDir -ItemType Directory -Force | Out-Null',
    '        Get-ChildItem -LiteralPath $extractRoot -Force | Move-Item -Destination $installDir -Force',
    '    }',
    '    if (-not (Test-Path -LiteralPath $execPath)) {',
    '        throw "Installed update is missing expected executable: $execPath"',
    '    }',
    '',
    '    # Mark success BEFORE relaunching, because the new app reads and',
    '    # clears install.log on startup (reportPreviousInstallResult).',
    '    Write-Log "Update installed successfully."',
    '    Clear-Marker',
    '',
    '    # Relaunch the updated app.',
    '    Relaunch-CurrentApp "updated app"',
    '',
    '    # Cleanup (non-critical, runs after relaunch)',
    '    Remove-Item -LiteralPath $backupPath -Recurse -Force -ErrorAction SilentlyContinue',
    '    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue',
    '    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue',
    '} catch {',
    '    Write-Log "Update install failed: $_"',
    '    Restore-Backup',
    '    Clear-Marker',
    '    if ($parentExited) {',
    '        Relaunch-CurrentApp "existing app after update failure"',
    '    } else {',
    '        Write-Log "Skipping relaunch because parent process may still be running."',
    '    }',
    '} finally {',
    '    if ($lockCreated) {',
    '        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue',
    '    }',
    '}'
  ].join('\n')
}

function windowsCommandQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function launchWindowsUpdateScript(params: {
  stagingRoot: string
  scriptPath: string
  logPath: string
}): boolean {
  const psPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  // Strategy 1: WMI process creation.
  // Win32_Process.Create() spawns the process through the WMI service, outside
  // the caller's Job Object. This helps the helper survive Electron shutdown.
  const workerCmd = [
    windowsCommandQuote(psPath),
    '-ExecutionPolicy Bypass',
    '-NoProfile',
    '-WindowStyle Hidden',
    '-File',
    windowsCommandQuote(params.scriptPath)
  ].join(' ')
  const launcherPath = join(params.stagingRoot, 'launch.ps1')
  const launcherContent = [
    '$ErrorActionPreference = "Stop"',
    `$result = ([wmiclass]'Win32_Process').Create(${powershellEscape(workerCmd)})`,
    'if ($result.ReturnValue -ne 0) {',
    `    Add-Content -LiteralPath ${powershellEscape(params.logPath)} -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') WMI Create failed: ReturnValue=$($result.ReturnValue)" -ErrorAction SilentlyContinue`,
    '    exit 1',
    '}'
  ].join('\n')
  writeFileSync(launcherPath, launcherContent, { encoding: 'utf-8' })

  try {
    execFileSync(psPath, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', launcherPath], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15000
    })
    appendToInstallLog(params.logPath, 'Node.js: WMI launch succeeded.')
    return true
  } catch (err) {
    appendToInstallLog(params.logPath, `Node.js: WMI launch failed: ${err}. Trying batch launcher.`)
  }

  // Strategy 2: Batch file with cmd.exe /c start (legacy fallback).
  const batPath = join(params.stagingRoot, 'up.bat')
  const batContent = `@echo off\r\nstart "" /min "${psPath}" -ExecutionPolicy Bypass -NoProfile -File "${params.scriptPath}"\r\n`
  writeFileSync(batPath, batContent, { encoding: 'utf-8' })

  try {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', batPath], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000
    })
    appendToInstallLog(params.logPath, 'Node.js: Batch launcher succeeded.')
    return true
  } catch (err) {
    appendToInstallLog(params.logPath, `Node.js: Batch launcher failed: ${err}. Trying detached spawn.`)
  }

  // Strategy 3: Direct detached spawn (least reliable during will-quit).
  try {
    const child = spawn(psPath, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-WindowStyle', 'Hidden', '-File', params.scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', (err) => {
      appendToInstallLog(params.logPath, `Node.js: Detached spawn emitted error: ${err}`)
    })
    child.unref()
    appendToInstallLog(params.logPath, 'Node.js: Detached spawn succeeded (fire-and-forget).')
    return true
  } catch (err) {
    appendToInstallLog(params.logPath, `Node.js: All launch strategies failed: ${err}`)
    return false
  }
}

/** Track when update failure telemetry was last sent (keyed by date string). */
let lastFailureTelemetryDate = ''

function trackUpdateEvent(
  name: string,
  properties: Record<string, string | number | boolean | null>
): void {
  const telemetry = getTelemetryService()
  telemetry.track(name, { ...properties, platform: process.platform })
}

function trackUpdateFailure(
  phase: string,
  error: string,
  properties: Record<string, string | number | boolean | null> = {}
): void {
  const today = new Date().toISOString().slice(0, 10)
  const telemetry = getTelemetryService()

  // Always log locally
  telemetry.track('update/error', {
    phase,
    error,
    platform: process.platform,
    ...properties
  })

  // Send to Azure immediately, but at most once per day
  if (lastFailureTelemetryDate !== today) {
    lastFailureTelemetryDate = today
    telemetry.trackImmediate('update/error', {
      phase,
      error,
      platform: process.platform,
      ...properties
    })
    console.log(`${LOG_PREFIX} Update failure telemetry sent for ${today}`)
  }
}

function readPackageMetadata(): Record<string, unknown> | null {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeArch(value: string): 'arm64' | 'x64' | null {
  if (value === 'arm64' || value === 'x64') return value
  return null
}

function parseRepositoryOwnerAndName(pkg: Record<string, unknown> | null): { owner: string; name: string } | null {
  const repositoryValue = pkg?.repository
  const repositoryObject = typeof repositoryValue === 'object' && repositoryValue !== null
    ? repositoryValue as { url?: unknown }
    : null
  const url =
    typeof repositoryValue === 'string'
      ? repositoryValue
      : repositoryObject && typeof repositoryObject.url === 'string'
        ? repositoryObject.url
        : ''

  const match = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url)
  if (!match) return null
  return { owner: match[1], name: match[2] }
}

function resolveUpdateBaseUrl(pkg: Record<string, unknown> | null, repository: { owner: string; name: string } | null): string | null {
  const envBaseUrl = String(process.env.ONWARD_UPDATE_BASE_URL || '').trim()
  if (envBaseUrl) return envBaseUrl.replace(/\/+$/, '')

  const onwardValue = pkg?.onward
  const onwardObject = typeof onwardValue === 'object' && onwardValue !== null
    ? onwardValue as { updateManifestBaseUrl?: unknown }
    : null
  if (onwardObject && typeof onwardObject.updateManifestBaseUrl === 'string') {
    return onwardObject.updateManifestBaseUrl.replace(/\/+$/, '')
  }

  if (!repository) return null
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/gh-pages/updates`
}

function resolveCurrentInstallPath(): string | null {
  const exePath = app.getPath('exe')
  if (process.platform === 'darwin') {
    // macOS: exe is at Foo.app/Contents/MacOS/Foo, install path is Foo.app
    return dirname(dirname(dirname(exePath)))
  }
  if (process.platform === 'win32') {
    // Windows NSIS per-user: exe is at %LOCALAPPDATA%\Programs\Onward 2\Onward 2.exe
    return dirname(exePath)
  }
  return null
}

function hashFileSha256(filePath: string): string {
  const hash = createHash('sha256')
  const buffer = readFileSync(filePath)
  hash.update(buffer)
  return hash.digest('hex')
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function powershellEscape(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function resolveUpdateLogPath(): string {
  return join(app.getPath('userData'), 'updates', 'install.log')
}

function resolveUpdatesRootPath(): string {
  return join(app.getPath('userData'), 'updates')
}

function resolveUpdateCheckIntervalMs(): number {
  const rawValue = String(process.env.ONWARD_UPDATE_CHECK_INTERVAL_MS || '').trim()
  if (!rawValue) return DEFAULT_UPDATE_CHECK_INTERVAL_MS

  const parsedValue = Number(rawValue)
  if (!Number.isInteger(parsedValue) || parsedValue < 1000) {
    return DEFAULT_UPDATE_CHECK_INTERVAL_MS
  }

  return parsedValue
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetchUpdateResource(url, {
    timeoutMs: DEFAULT_UPDATE_DOWNLOAD_TIMEOUT_MS
  })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  }

  mkdirSync(dirname(destinationPath), { recursive: true })
  const fileStream = createWriteStream(destinationPath)
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), fileStream)
}

async function fetchUpdateResource(
  url: string,
  options: {
    headers?: Record<string, string>
    timeoutMs?: number
  } = {}
): Promise<Response> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => {
    controller.abort()
  }, options.timeoutMs ?? DEFAULT_UPDATE_REQUEST_TIMEOUT_MS)

  try {
    return await net.fetch(url, {
      headers: options.headers,
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Update request timed out: ${url}`)
    }
    throw error
  } finally {
    clearTimeout(timeoutHandle)
  }
}

export class UpdateService {
  private status: UpdateStatus = this.createInitialStatus()
  private mainWindow: BrowserWindow | null = null
  private checkingPromise: Promise<UpdateStatus> | null = null
  private intervalHandle: NodeJS.Timeout | null = null
  private downloadedUpdate: DownloadedUpdate | null = null
  private pendingManifest: UpdateManifest | null = null
  private installRequested = false
  private readonly checkIntervalMs = resolveUpdateCheckIntervalMs()

  private createInitialStatus(): UpdateStatus {
    const appInfo = getAppInfo()
    const pkg = readPackageMetadata()
    const repository = parseRepositoryOwnerAndName(pkg)
    const baseUrl = resolveUpdateBaseUrl(pkg, repository)
    const arch = normalizeArch(process.arch)
    const isSupportedPlatform =
      (process.platform === 'darwin' && appInfo.releaseOs === 'macos') ||
      (process.platform === 'win32' && appInfo.releaseOs === 'windows')
    const supported =
      appInfo.isPackaged &&
      appInfo.buildChannel === 'prod' &&
      isSupportedPlatform &&
      (appInfo.releaseChannel === 'daily' || appInfo.releaseChannel === 'dev' || appInfo.releaseChannel === 'stable') &&
      arch !== null &&
      Boolean(baseUrl)

    return {
      phase: supported ? 'idle' : 'unsupported',
      supported,
      currentVersion: appInfo.version,
      currentTag: appInfo.tag,
      currentChannel: appInfo.releaseChannel,
      currentReleaseOs: appInfo.releaseOs,
      targetVersion: null,
      targetTag: null,
      downloadedFileName: null,
      lastCheckedAt: null,
      error: null,
      bannerDismissed: false
    }
  }

  private emitStatus(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('updater:status-changed', this.getStatus())
  }

  private setStatus(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = {
      ...this.status,
      ...patch
    }
    this.emitStatus()
    return this.getStatus()
  }

  private getManifestUrl(): string | null {
    const pkg = readPackageMetadata()
    const repository = parseRepositoryOwnerAndName(pkg)
    const baseUrl = resolveUpdateBaseUrl(pkg, repository)
    const arch = normalizeArch(process.arch)
    if (!baseUrl || !arch) return null
    return `${baseUrl}/${this.status.currentChannel}/${this.status.currentReleaseOs}/${arch}/latest.json`
  }

  private async fetchManifest(): Promise<UpdateManifest> {
    const manifestUrl = this.getManifestUrl()
    if (!manifestUrl) {
      throw new Error('Update manifest URL is not configured.')
    }

    const response = await fetchUpdateResource(manifestUrl, {
      headers: {
        Accept: 'application/json'
      },
      timeoutMs: DEFAULT_UPDATE_REQUEST_TIMEOUT_MS
    })
    if (!response.ok) {
      throw new Error(`Manifest request failed: ${response.status} ${response.statusText}`)
    }

    const manifest = await response.json() as Partial<UpdateManifest>
    const arch = normalizeArch(process.arch)
    if (!manifest.version || !manifest.tag || !manifest.artifactUrl || !manifest.sha256 || !manifest.artifactName) {
      throw new Error('Manifest is missing required fields.')
    }
    if (!isSafeArtifactName(manifest.artifactName)) {
      throw new Error(`Manifest artifact name is invalid: ${manifest.artifactName}`)
    }
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
      throw new Error('Manifest SHA-256 is invalid.')
    }
    if (manifest.channel !== this.status.currentChannel) {
      throw new Error(`Manifest channel mismatch: expected ${this.status.currentChannel}, got ${String(manifest.channel)}`)
    }
    if (manifest.platform !== this.status.currentReleaseOs) {
      throw new Error(`Manifest platform mismatch: expected ${this.status.currentReleaseOs}, got ${String(manifest.platform)}`)
    }
    if (!arch || manifest.arch !== arch) {
      throw new Error(`Manifest architecture mismatch: expected ${arch || 'unknown'}, got ${String(manifest.arch)}`)
    }

    return {
      channel: manifest.channel,
      version: manifest.version,
      tag: manifest.tag,
      platform: manifest.platform,
      arch: manifest.arch,
      artifactName: manifest.artifactName,
      artifactUrl: manifest.artifactUrl,
      sha256: manifest.sha256,
      releaseNotes: manifest.releaseNotes ?? null,
      publishedAt: manifest.publishedAt ?? new Date().toISOString()
    }
  }

  private getDownloadPath(manifest: UpdateManifest): string {
    return join(app.getPath('userData'), 'updates', manifest.version, manifest.artifactName)
  }

  private saveManifestFile(manifest: UpdateManifest): void {
    const versionDir = join(resolveUpdatesRootPath(), manifest.version)
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
  }

  private loadManifestFile(version: string): UpdateManifest | null {
    const manifestPath = join(resolveUpdatesRootPath(), version, 'manifest.json')
    if (!existsSync(manifestPath)) return null
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8')) as UpdateManifest
    } catch {
      return null
    }
  }

  /**
   * Clean up stale downloads and recover the latest pending update on startup.
   *
   * Expiration rules:
   * 1. Versions ≤ currentVersion are expired (already installed or older) → delete
   * 2. Among versions > currentVersion, try to recover from newest to oldest
   * 3. On first successful recovery, delete all remaining older candidates
   * 4. Each candidate is verified (channel/platform/arch + manifest + checksum);
   *    corrupt/incomplete/incompatible files are removed.
   *
   * The verify-before-delete order ensures that a corrupt newest version does
   * not cause valid older versions to be discarded prematurely.
   */
  private cleanupAndRecoverPendingUpdate(): void {
    const updatesRoot = resolveUpdatesRootPath()
    if (!existsSync(updatesRoot)) return

    const currentVersion = this.status.currentVersion
    const pendingVersions: string[] = []
    let cleanedCount = 0

    for (const entry of readdirSync(updatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const version = entry.name

      // Skip directories that are not valid version strings
      try {
        parseVersion(version)
      } catch {
        rmSync(join(updatesRoot, version), { recursive: true, force: true })
        cleanedCount++
        continue
      }

      if (compareVersions(version, currentVersion) <= 0) {
        rmSync(join(updatesRoot, version), { recursive: true, force: true })
        console.log(`${LOG_PREFIX} Cleaned up expired download: ${version}`)
        cleanedCount++
      } else {
        pendingVersions.push(version)
      }
    }

    if (pendingVersions.length === 0) {
      if (cleanedCount > 0) {
        console.log(`${LOG_PREFIX} Startup cleanup: removed ${cleanedCount} stale download(s), no pending updates`)
      }
      return
    }

    // Sort descending — try newest first, fall back to older candidates
    pendingVersions.sort((a, b) => compareVersions(b, a))

    // Try candidates in descending order. Only delete superseded versions
    // AFTER a successful recovery (verify-before-delete).
    let recoveredIndex = -1
    for (let i = 0; i < pendingVersions.length; i++) {
      if (this.recoverPendingUpdate(pendingVersions[i])) {
        recoveredIndex = i
        break
      }
      // recoverPendingUpdate already cleaned up the failed candidate
      cleanedCount++
    }

    // Delete remaining untried candidates that are older than the recovered one
    if (recoveredIndex >= 0) {
      for (let i = recoveredIndex + 1; i < pendingVersions.length; i++) {
        rmSync(join(updatesRoot, pendingVersions[i]), { recursive: true, force: true })
        console.log(`${LOG_PREFIX} Cleaned up superseded download: ${pendingVersions[i]}`)
        cleanedCount++
      }
    }

    if (cleanedCount > 0) {
      const recovered = recoveredIndex >= 0 ? pendingVersions[recoveredIndex] : 'none'
      console.log(`${LOG_PREFIX} Startup cleanup: removed ${cleanedCount} stale download(s), recovered: ${recovered}`)
    }
  }

  /**
   * Attempt to recover a previously downloaded update from disk.
   * Validates channel/platform/arch compatibility, manifest integrity, and
   * archive checksum. Removes the version directory on any failure.
   * @returns true if recovery succeeded, false if the candidate was invalid.
   */
  private recoverPendingUpdate(version: string): boolean {
    const versionDir = join(resolveUpdatesRootPath(), version)
    const manifest = this.loadManifestFile(version)

    if (!manifest) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed unverifiable download (no manifest): ${version}`)
      return false
    }

    // Reject archives from a different channel, platform, or architecture.
    // Prod builds across release channels (daily/dev/stable) share the same
    // userData directory, so a channel switch can leave foreign archives behind.
    const arch = normalizeArch(process.arch)
    if (manifest.channel !== this.status.currentChannel ||
        manifest.platform !== this.status.currentReleaseOs ||
        !arch || manifest.arch !== arch) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(
        `${LOG_PREFIX} Removed incompatible download: ${version}` +
        ` (channel=${String(manifest.channel)}, platform=${String(manifest.platform)}, arch=${String(manifest.arch)})`)
      return false
    }
    if (!isSafeArtifactName(manifest.artifactName) || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed invalid download manifest: ${version}`)
      return false
    }

    const archivePath = join(versionDir, manifest.artifactName)
    if (!existsSync(archivePath)) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed incomplete download (archive missing): ${version}`)
      return false
    }

    try {
      const checksum = hashFileSha256(archivePath)
      if (checksum.toLowerCase() !== manifest.sha256.toLowerCase()) {
        rmSync(versionDir, { recursive: true, force: true })
        console.log(`${LOG_PREFIX} Removed corrupted download (checksum mismatch): ${version}`)
        return false
      }
    } catch {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed unreadable download: ${version}`)
      return false
    }

    this.downloadedUpdate = { manifest, archivePath }
    this.setStatus({
      phase: 'downloaded',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      error: null
    })
    console.log(`${LOG_PREFIX} Recovered pending update: ${version} (${manifest.artifactName})`)
    return true
  }

  private async ensureDownloaded(manifest: UpdateManifest): Promise<DownloadedUpdate> {
    const archivePath = this.getDownloadPath(manifest)
    if (!existsSync(archivePath)) {
      console.log(`${LOG_PREFIX} Downloading: ${manifest.artifactUrl}`)
      await downloadFile(manifest.artifactUrl, archivePath)
      console.log(`${LOG_PREFIX} Download saved to: ${archivePath}`)
    } else {
      console.log(`${LOG_PREFIX} Archive already exists, verifying checksum: ${archivePath}`)
    }

    const checksum = hashFileSha256(archivePath)
    if (checksum.toLowerCase() !== manifest.sha256.toLowerCase()) {
      console.error(`${LOG_PREFIX} Checksum mismatch: expected=${manifest.sha256}, got=${checksum}`)
      rmSync(archivePath, { force: true })
      throw new Error('Downloaded update failed checksum verification.')
    }
    console.log(`${LOG_PREFIX} Checksum verified: ${checksum}`)

    // Persist manifest alongside the archive for cross-session recovery
    this.saveManifestFile(manifest)

    return {
      manifest,
      archivePath
    }
  }

  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.status = this.createInitialStatus()
    this.cleanupAndRecoverPendingUpdate()
    this.emitStatus()

    console.log(`${LOG_PREFIX} Initialized: supported=${this.status.supported}, version=${this.status.currentVersion}, os=${this.status.currentReleaseOs}, channel=${this.status.currentChannel}`)

    // Check install log from previous update attempt and report result via telemetry
    this.reportPreviousInstallResult()

    if (!this.status.supported) return

    // DEV channel: updates are manual only — no auto-check, no auto-download.
    // User must click Check Now → Download → Restart in the Settings UI.
    if (this.status.currentChannel === 'dev') return

    void this.checkNow()
    this.intervalHandle = setInterval(() => {
      void this.checkNow()
    }, this.checkIntervalMs)
  }

  /**
   * Read the install log left by the previous update helper script.
   * If the log indicates a failure, report it via telemetry.
   * The log is cleared after reading to avoid duplicate reports.
   */
  private reportPreviousInstallResult(): void {
    const logPath = resolveUpdateLogPath()
    if (!existsSync(logPath)) return

    try {
      const content = readFileSync(logPath, 'utf-8').trim()
      if (!content) return

      const lines = content.split('\n').filter(Boolean)
      let lastSuccessIndex = -1
      let lastFailureIndex = -1
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.includes('installed successfully')) lastSuccessIndex = i
        if (line.includes('install failed')) lastFailureIndex = i
      }
      const success = lastSuccessIndex >= 0 && lastSuccessIndex > lastFailureIndex
      const failed = lastFailureIndex >= 0 && lastFailureIndex > lastSuccessIndex

      if (success) {
        console.log(`${LOG_PREFIX} Previous update installed successfully`)
        trackUpdateEvent('update/installComplete', { result: 'success' })
      } else if (failed) {
        const failedLine = lines[lastFailureIndex] || ''
        // Extract error from the log line: "YYYY-MM-DD HH:MM:SS Update install failed: <error>"
        const errorMatch = /install failed:\s*(.+)$/i.exec(failedLine)
        const errorDetail = errorMatch ? errorMatch[1] : 'unknown'
        console.error(`${LOG_PREFIX} Previous update install failed: ${errorDetail}`)
        trackUpdateFailure('install', errorDetail, {
          installLog: lines.slice(-5).join('\n')
        })
      }

      // Clear the log after reading
      writeFileSync(logPath, '', 'utf-8')
    } catch {
      // Non-blocking: log read failure is not critical
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  async checkNow(): Promise<UpdateStatus> {
    if (!this.status.supported) {
      return this.getStatus()
    }
    if (this.checkingPromise) {
      return this.checkingPromise
    }

    this.checkingPromise = this.checkNowInternal()
    try {
      return await this.checkingPromise
    } finally {
      this.checkingPromise = null
    }
  }

  private async checkNowInternal(): Promise<UpdateStatus> {
    console.log(`${LOG_PREFIX} Starting update check (current: ${this.status.currentVersion})`)
    this.setStatus({
      phase: 'checking',
      error: null
    })

    try {
      const manifest = await this.fetchManifest()
      const lastCheckedAt = Date.now()
      const isNewer = compareVersions(manifest.version, this.status.currentVersion) > 0
      console.log(`${LOG_PREFIX} Manifest fetched: version=${manifest.version}, isNewer=${isNewer}`)

      if (!isNewer) {
        if (this.downloadedUpdate && this.downloadedUpdate.manifest.version === manifest.version) {
          return this.setStatus({
            phase: 'downloaded',
            targetVersion: manifest.version,
            targetTag: manifest.tag,
            downloadedFileName: this.downloadedUpdate.manifest.artifactName,
            lastCheckedAt,
            error: null
          })
        }

        this.downloadedUpdate = null
        console.log(`${LOG_PREFIX} Already up-to-date`)
        trackUpdateEvent('update/check', { result: 'up-to-date', currentVersion: this.status.currentVersion })
        return this.setStatus({
          phase: 'up-to-date',
          targetVersion: null,
          targetTag: null,
          downloadedFileName: null,
          bannerDismissed: false,
          lastCheckedAt,
          error: null
        })
      }

      console.log(`${LOG_PREFIX} New version available: ${manifest.version}`)
      trackUpdateEvent('update/check', {
        result: 'new-version',
        currentVersion: this.status.currentVersion,
        targetVersion: manifest.version
      })

      // If we already have this version downloaded and verified (e.g., recovered
      // from a previous session), skip re-download and confirm downloaded state.
      if (this.downloadedUpdate && this.downloadedUpdate.manifest.version === manifest.version) {
        console.log(`${LOG_PREFIX} Update already downloaded, skipping re-download: ${manifest.version}`)
        return this.setStatus({
          phase: 'downloaded',
          targetVersion: manifest.version,
          targetTag: manifest.tag,
          downloadedFileName: this.downloadedUpdate.manifest.artifactName,
          bannerDismissed: false,
          lastCheckedAt,
          error: null
        })
      }

      // DEV channel: stop at 'available' and wait for user to manually trigger download.
      if (this.status.currentChannel === 'dev') {
        // Clear any stale downloaded update superseded by the newer available version.
        // Without this, downloadedUpdate would reference an older version while
        // the UI shows the newer version as "available", causing an inconsistency
        // where requestRestartToUpdate() could install the wrong version.
        if (this.downloadedUpdate) {
          this.downloadedUpdate = null
        }
        this.pendingManifest = manifest
        console.log(`${LOG_PREFIX} Dev channel: waiting for manual download`)
        return this.setStatus({
          phase: 'available',
          targetVersion: manifest.version,
          targetTag: manifest.tag,
          downloadedFileName: null,
          bannerDismissed: false,
          lastCheckedAt,
          error: null
        })
      }

      // Daily/Stable channel: auto-download immediately.
      return this.downloadAndApply(manifest, lastCheckedAt)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const failedPhase = this.status.phase === 'downloading' ? 'download' : 'check'
      console.error(`${LOG_PREFIX} Update ${failedPhase} failed: ${errorMessage}`)
      trackUpdateFailure(failedPhase, errorMessage, {
        currentVersion: this.status.currentVersion,
        targetVersion: this.status.targetVersion
      })
      // If a previously downloaded update is still valid on disk, restore its
      // state so the UI shows the correct (actually downloaded) version, not
      // the version whose download just failed.
      if (this.downloadedUpdate) {
        return this.setStatus({
          phase: 'downloaded',
          targetVersion: this.downloadedUpdate.manifest.version,
          targetTag: this.downloadedUpdate.manifest.tag,
          downloadedFileName: this.downloadedUpdate.manifest.artifactName,
          lastCheckedAt: Date.now(),
          error: errorMessage
        })
      }
      return this.setStatus({
        phase: 'error',
        lastCheckedAt: Date.now(),
        error: errorMessage
      })
    }
  }

  private async downloadAndApply(manifest: UpdateManifest, lastCheckedAt: number): Promise<UpdateStatus> {
    this.setStatus({
      phase: 'downloading',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      bannerDismissed: false,
      lastCheckedAt,
      error: null
    })

    this.downloadedUpdate = await this.ensureDownloaded(manifest)
    console.log(`${LOG_PREFIX} Download complete: ${manifest.artifactName}`)
    trackUpdateEvent('update/downloaded', {
      targetVersion: manifest.version,
      artifactName: manifest.artifactName
    })

    return this.setStatus({
      phase: 'downloaded',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      bannerDismissed: false,
      lastCheckedAt,
      error: null
    })
  }

  /**
   * Manually trigger download of the available update (DEV channel only).
   * Only valid when phase is 'available' and a pending manifest exists.
   */
  async downloadNow(): Promise<UpdateStatus> {
    if (this.status.phase !== 'available' || !this.pendingManifest) {
      return this.getStatus()
    }

    const manifest = this.pendingManifest
    this.pendingManifest = null

    try {
      return await this.downloadAndApply(manifest, this.status.lastCheckedAt ?? Date.now())
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`${LOG_PREFIX} Download failed: ${errorMessage}`)
      trackUpdateFailure('download', errorMessage, {
        currentVersion: this.status.currentVersion,
        targetVersion: manifest.version
      })
      return this.setStatus({
        phase: 'error',
        error: errorMessage
      })
    }
  }

  dismissBanner(): UpdateStatus {
    if (this.status.phase !== 'downloaded') {
      return this.getStatus()
    }
    return this.setStatus({ bannerDismissed: true })
  }

  canInstallDownloadedUpdate(): boolean {
    return (process.platform === 'darwin' || process.platform === 'win32') && Boolean(this.downloadedUpdate)
  }

  requestRestartToUpdate(): { success: boolean; error?: string } {
    if (!this.canInstallDownloadedUpdate()) {
      return { success: false, error: 'No downloaded update is ready to install.' }
    }
    this.installRequested = true
    return { success: true }
  }

  shouldInstallOnQuit(): boolean {
    return this.installRequested
  }

  installDownloadedUpdateOnQuit(): void {
    if (!this.downloadedUpdate) return

    const targetVersion = this.downloadedUpdate.manifest.version
    console.log(`${LOG_PREFIX} Installing update on quit: ${this.status.currentVersion} → ${targetVersion}`)
    trackUpdateEvent('update/installStart', {
      currentVersion: this.status.currentVersion,
      targetVersion
    })

    if (process.platform === 'darwin') {
      this.installDownloadedUpdateOnQuitMacOS()
    } else if (process.platform === 'win32') {
      this.installDownloadedUpdateOnQuitWindows()
    }
  }

  private installDownloadedUpdateOnQuitMacOS(): void {
    const bundlePath = resolveCurrentInstallPath()
    if (!bundlePath) return

    const stagingRoot = join(tmpdir(), `onward-update-${Date.now()}`)
    mkdirSync(stagingRoot, { recursive: true })
    const scriptPath = join(stagingRoot, 'install-update.sh')
    const logPath = resolveUpdateLogPath()
    const relaunchEnvAssignments = RELAUNCH_ENV_KEYS
      .map((key) => {
        const value = process.env[key]
        if (!value) return null
        return `${key}=${shellEscape(value)}`
      })
      .filter((value): value is string => Boolean(value))
      .join(' ')
    const scriptContent = [
      '#!/bin/sh',
      'set -eu',
      `APP_PATH=${shellEscape(bundlePath)}`,
      `EXEC_PATH=${shellEscape(app.getPath('exe'))}`,
      `ARCHIVE_PATH=${shellEscape(this.downloadedUpdate!.archivePath)}`,
      `PARENT_PID=${process.pid}`,
      `STAGING_ROOT=${shellEscape(stagingRoot)}`,
      `LOG_PATH=${shellEscape(logPath)}`,
      `RELAUNCH_ENV_ASSIGNMENTS=${shellEscape(relaunchEnvAssignments)}`,
      'EXTRACT_ROOT="$STAGING_ROOT/extracted"',
      'BACKUP_PATH="$APP_PATH.onward-backup"',
      'mkdir -p "$(dirname "$LOG_PATH")"',
      'log() {',
      '  printf "%s %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$1" >> "$LOG_PATH"',
      '}',
      'restore_backup() {',
      '  if [ ! -d "$APP_PATH" ] && [ -d "$BACKUP_PATH" ]; then',
      '    mv "$BACKUP_PATH" "$APP_PATH"',
      '  fi',
      '}',
      'handle_error() {',
      '  local exit_code=$?',
      '  log "Update install failed: exit code $exit_code (last command at line $1)"',
      '  restore_backup',
      '}',
      'trap \'handle_error $LINENO\' EXIT',
      'log "Starting update install helper."',
      'for _ in $(seq 1 120); do',
      '  if ! kill -0 "$PARENT_PID" 2>/dev/null; then',
      '    log "Detected parent process exit."',
      '    break',
      '  fi',
      '  sleep 1',
      'done',
      'rm -rf "$EXTRACT_ROOT" "$BACKUP_PATH"',
      'mkdir -p "$EXTRACT_ROOT"',
      'log "Extracting update archive."',
      'ditto -x -k "$ARCHIVE_PATH" "$EXTRACT_ROOT"',
      'NEW_APP_PATH="$(find "$EXTRACT_ROOT" -maxdepth 1 -name \'*.app\' -print -quit)"',
      'if [ -z "$NEW_APP_PATH" ]; then',
      '  log "No .app bundle found in extracted archive."',
      '  exit 1',
      'fi',
      'log "Replacing app bundle with downloaded update."',
      'mv "$APP_PATH" "$BACKUP_PATH"',
      'mv "$NEW_APP_PATH" "$APP_PATH"',
      'trap - EXIT',
      'rm -rf "$BACKUP_PATH" "$EXTRACT_ROOT"',
      'log "Update installed successfully."',
      'log "Relaunching updated app."',
      'if [ -n "$RELAUNCH_ENV_ASSIGNMENTS" ]; then',
      '  eval "/usr/bin/env $RELAUNCH_ENV_ASSIGNMENTS \\"$EXEC_PATH\\"" >/dev/null 2>&1 &',
      'else',
      '  open -n "$APP_PATH"',
      'fi',
      'rm -f "$ARCHIVE_PATH" "$0"',
      'rmdir "$STAGING_ROOT" 2>/dev/null || true'
    ].join('\n')

    writeFileSync(scriptPath, `${scriptContent}\n`, { encoding: 'utf-8', mode: 0o755 })
    spawn('/bin/sh', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  }

  private installDownloadedUpdateOnQuitWindows(): void {
    const installDir = resolveCurrentInstallPath()
    if (!installDir) return

    // Use a short staging path to avoid Windows 260-char path length limit
    // during zip extraction (deep node_modules paths inside the archive).
    const stagingId = Date.now().toString(36)
    const stagingRoot = join(process.env.TEMP || tmpdir(), `ou-${stagingId}`)
    mkdirSync(stagingRoot, { recursive: true })
    const scriptPath = join(stagingRoot, 'up.ps1')
    const logPath = resolveUpdateLogPath()
    const execPath = app.getPath('exe')
    const markerPath = join(resolveUpdatesRootPath(), 'pending-update.json')
    const lockPath = join(resolveUpdatesRootPath(), 'install.lock')

    // Pre-flight logging from Node.js side (appears in install.log)
    appendToInstallLog(logPath, `Node.js: Preparing update install helper. PID=${process.pid}`)
    appendToInstallLog(logPath, `Node.js: installDir=${installDir}`)
    appendToInstallLog(logPath, `Node.js: archivePath=${this.downloadedUpdate!.archivePath}`)
    appendToInstallLog(logPath, `Node.js: stagingRoot=${stagingRoot}`)

    // Write pending-update marker for startup recovery fallback.
    // If the helper script fails to launch or is killed during Electron's
    // shutdown, the next app startup will detect this marker and retry.
    try {
      const marker: PendingUpdateInfo = {
        schemaVersion: PENDING_UPDATE_MARKER_SCHEMA_VERSION,
        archivePath: this.downloadedUpdate!.archivePath,
        archiveSha256: this.downloadedUpdate!.manifest.sha256,
        artifactName: this.downloadedUpdate!.manifest.artifactName,
        installDir,
        execPath,
        logPath,
        timestamp: Date.now(),
        targetVersion: this.downloadedUpdate!.manifest.version,
        attempts: 0
      }
      writePendingUpdateInfo(markerPath, marker)
      appendToInstallLog(logPath, 'Node.js: Wrote pending-update marker.')
    } catch (err) {
      appendToInstallLog(logPath, `Node.js: Failed to write pending-update marker: ${err}`)
    }

    const envSetStatements = buildEnvSetStatements()
    const scriptContent = buildWindowsUpdateScript({
      installDir,
      execPath,
      archivePath: this.downloadedUpdate!.archivePath,
      archiveSha256: this.downloadedUpdate!.manifest.sha256,
      parentPid: process.pid,
      stagingRoot,
      logPath,
      markerPath,
      lockPath,
      envSetStatements
    })

    writeFileSync(scriptPath, scriptContent, { encoding: 'utf-8' })
    if (!launchWindowsUpdateScript({ stagingRoot, scriptPath, logPath })) {
      safeRemoveFile(markerPath)
    }
  }
}

let updateService: UpdateService | null = null

export function getUpdateService(): UpdateService {
  if (!updateService) {
    updateService = new UpdateService()
  }
  return updateService
}

/**
 * Called early during app startup (after initializeAppIdentity but before
 * createWindow). If the previous quit-time update script failed to run,
 * this detects the pending-update marker and retries the update.
 *
 * Returns true if a recovery update was launched and the caller should
 * exit immediately (the helper script will relaunch the app).
 */
export function applyPendingUpdateOnStartup(): boolean {
  if (process.platform !== 'win32') return false

  const markerPath = join(resolveUpdatesRootPath(), 'pending-update.json')
  if (!existsSync(markerPath)) return false

  let info: PendingUpdateInfo
  let rawMarker: unknown
  try {
    rawMarker = JSON.parse(readFileSync(markerPath, 'utf-8')) as unknown
  } catch {
    safeRemoveFile(markerPath)
    return false
  }

  const validation = validatePendingUpdateInfo(rawMarker)
  if (!validation.info) {
    const rawLogPath = rawMarker && typeof rawMarker === 'object'
      ? (rawMarker as { logPath?: unknown }).logPath
      : null
    const fallbackLogPath = isNonEmptyString(rawLogPath) && isAbsolute(rawLogPath)
      ? rawLogPath
      : resolveUpdateLogPath()
    appendToInstallLog(fallbackLogPath, `Node.js: Removing invalid pending-update marker: ${validation.error}`)
    safeRemoveFile(markerPath)
    return false
  }
  info = validation.info

  const currentInstallDir = resolveCurrentInstallPath()
  const currentExecPath = app.getPath('exe')
  if (!currentInstallDir ||
      normalizeWindowsPathForCompare(currentInstallDir) !== normalizeWindowsPathForCompare(info.installDir) ||
      normalizeWindowsPathForCompare(currentExecPath) !== normalizeWindowsPathForCompare(info.execPath)) {
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker install path no longer matches current app, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  if (basename(info.archivePath) !== info.artifactName) {
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker archive path does not match artifact name, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  let isTargetNewer = false
  const { version: currentVersion } = getAppInfo()
  try {
    isTargetNewer = compareVersions(info.targetVersion, currentVersion) > 0
  } catch {
    appendToInstallLog(info.logPath, `Node.js: Pending update marker target version is invalid: ${info.targetVersion}`)
    safeRemoveFile(markerPath)
    return false
  }

  // If current version already matches or exceeds the target, the update was applied.
  if (!isTargetNewer) {
    console.log(`${LOG_PREFIX} Pending update target (${info.targetVersion}) is not newer than current (${currentVersion}), clearing marker.`)
    safeRemoveFile(markerPath)
    return false
  }

  // Skip if marker is too old (> 1 hour)
  if (Date.now() - info.timestamp > MAX_PENDING_UPDATE_MARKER_AGE_MS) {
    console.log(`${LOG_PREFIX} Pending update marker is stale (${new Date(info.timestamp).toISOString()}), removing.`)
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker is stale, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  if (info.attempts >= MAX_PENDING_UPDATE_STARTUP_ATTEMPTS) {
    console.log(`${LOG_PREFIX} Pending update startup recovery already attempted, removing marker.`)
    appendToInstallLog(info.logPath, 'Node.js: Startup recovery attempt limit reached, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  // Skip if archive is gone (already cleaned up or never downloaded)
  if (!existsSync(info.archivePath)) {
    console.log(`${LOG_PREFIX} Pending update archive not found: ${info.archivePath}, removing marker.`)
    appendToInstallLog(info.logPath, `Node.js: Pending update archive not found: ${info.archivePath}`)
    safeRemoveFile(markerPath)
    return false
  }

  try {
    const checksum = hashFileSha256(info.archivePath)
    if (checksum.toLowerCase() !== info.archiveSha256.toLowerCase()) {
      console.log(`${LOG_PREFIX} Pending update archive checksum mismatch, removing marker and archive.`)
      appendToInstallLog(info.logPath, `Node.js: Pending update archive checksum mismatch: expected=${info.archiveSha256} actual=${checksum}`)
      safeRemoveFile(info.archivePath)
      safeRemoveFile(markerPath)
      return false
    }
  } catch (err) {
    appendToInstallLog(info.logPath, `Node.js: Pending update archive could not be verified: ${err}`)
    safeRemoveFile(markerPath)
    return false
  }

  console.log(`${LOG_PREFIX} Found pending update ${info.targetVersion}. Launching recovery update script.`)
  appendToInstallLog(info.logPath, `Node.js: Startup recovery: launching update script for ${info.targetVersion}. PID=${process.pid}`)

  try {
    writePendingUpdateInfo(markerPath, {
      ...info,
      attempts: info.attempts + 1
    })
  } catch (err) {
    appendToInstallLog(info.logPath, `Node.js: Startup recovery: failed to update marker attempt count: ${err}`)
    safeRemoveFile(markerPath)
    return false
  }

  // Create a new staging directory and PowerShell script with the CURRENT PID
  const stagingRoot = join(process.env.TEMP || tmpdir(), `ou-${Date.now().toString(36)}`)
  mkdirSync(stagingRoot, { recursive: true })
  const scriptPath = join(stagingRoot, 'up.ps1')
  const lockPath = join(resolveUpdatesRootPath(), 'install.lock')

  const scriptContent = buildWindowsUpdateScript({
    installDir: info.installDir,
    execPath: info.execPath,
    archivePath: info.archivePath,
    archiveSha256: info.archiveSha256,
    parentPid: process.pid,
    stagingRoot,
    logPath: info.logPath,
    markerPath,
    lockPath,
    envSetStatements: buildEnvSetStatements()
  })
  writeFileSync(scriptPath, scriptContent, 'utf-8')

  if (!launchWindowsUpdateScript({ stagingRoot, scriptPath, logPath: info.logPath })) {
    appendToInstallLog(info.logPath, 'Node.js: Startup recovery: failed to launch script.')
    console.error(`${LOG_PREFIX} Startup recovery failed to launch.`)
    safeRemoveFile(markerPath)
    return false
  }
  appendToInstallLog(info.logPath, 'Node.js: Startup recovery: script launched successfully.')
  return true
}
