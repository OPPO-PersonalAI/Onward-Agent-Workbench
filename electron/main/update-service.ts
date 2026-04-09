/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, BrowserWindow, net } from 'electron'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { spawn } from 'child_process'
import { getAppInfo, type ReleaseChannel, type ReleaseOs } from './app-info'
import { compareVersions } from './update-version'

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'up-to-date' | 'unsupported' | 'error'

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
  const url =
    typeof repositoryValue === 'string'
      ? repositoryValue
      : typeof repositoryValue === 'object' && repositoryValue && typeof repositoryValue.url === 'string'
        ? repositoryValue.url
        : ''

  const match = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url)
  if (!match) return null
  return { owner: match[1], name: match[2] }
}

function resolveUpdateBaseUrl(pkg: Record<string, unknown> | null, repository: { owner: string; name: string } | null): string | null {
  const envBaseUrl = String(process.env.ONWARD_UPDATE_BASE_URL || '').trim()
  if (envBaseUrl) return envBaseUrl.replace(/\/+$/, '')

  const onwardValue = pkg?.onward
  if (typeof onwardValue === 'object' && onwardValue && typeof onwardValue.updateManifestBaseUrl === 'string') {
    return onwardValue.updateManifestBaseUrl.replace(/\/+$/, '')
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
  await pipeline(Readable.fromWeb(response.body as globalThis.ReadableStream), fileStream)
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
      (appInfo.releaseChannel === 'daily' || appInfo.releaseChannel === 'stable') &&
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

  private cleanupDownloadedArchives(keepVersions: string[] = []): void {
    const updatesRoot = resolveUpdatesRootPath()
    if (!existsSync(updatesRoot)) return

    const keepVersionSet = new Set(keepVersions)
    for (const entry of readdirSync(updatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (keepVersionSet.has(entry.name)) continue
      rmSync(join(updatesRoot, entry.name), { recursive: true, force: true })
    }
  }

  private async ensureDownloaded(manifest: UpdateManifest): Promise<DownloadedUpdate> {
    const archivePath = this.getDownloadPath(manifest)
    if (!existsSync(archivePath)) {
      await downloadFile(manifest.artifactUrl, archivePath)
    }

    const checksum = hashFileSha256(archivePath)
    if (checksum.toLowerCase() !== manifest.sha256.toLowerCase()) {
      rmSync(archivePath, { force: true })
      throw new Error('Downloaded update failed checksum verification.')
    }

    return {
      manifest,
      archivePath
    }
  }

  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.status = this.createInitialStatus()
    this.cleanupDownloadedArchives()
    this.emitStatus()

    if (!this.status.supported) return

    void this.checkNow()
    this.intervalHandle = setInterval(() => {
      void this.checkNow()
    }, this.checkIntervalMs)
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
    this.setStatus({
      phase: 'checking',
      error: null
    })

    try {
      const manifest = await this.fetchManifest()
      const lastCheckedAt = Date.now()
      const isNewer = compareVersions(manifest.version, this.status.currentVersion) > 0

      if (!isNewer) {
        if (this.downloadedUpdate && this.downloadedUpdate.manifest.version === manifest.version) {
          this.cleanupDownloadedArchives([manifest.version])
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
        this.cleanupDownloadedArchives()
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
      this.cleanupDownloadedArchives([manifest.version])

      return this.setStatus({
        phase: 'downloaded',
        targetVersion: manifest.version,
        targetTag: manifest.tag,
        downloadedFileName: manifest.artifactName,
        bannerDismissed: false,
        lastCheckedAt,
        error: null
      })
    } catch (error) {
      return this.setStatus({
        phase: this.downloadedUpdate ? 'downloaded' : 'error',
        lastCheckedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
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
      'trap \'log "Update install failed."; restore_backup\' EXIT',
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

    const stagingRoot = join(tmpdir(), `onward-update-${Date.now()}`)
    mkdirSync(stagingRoot, { recursive: true })
    const scriptPath = join(stagingRoot, 'install-update.ps1')
    const logPath = resolveUpdateLogPath()
    const execPath = app.getPath('exe')

    const envSetStatements = RELAUNCH_ENV_KEYS
      .map((key) => {
        const value = process.env[key]
        if (!value) return null
        return `$env:${key} = ${powershellEscape(value)}`
      })
      .filter((value): value is string => Boolean(value))
      .join('\n')

    const scriptContent = [
      '$ErrorActionPreference = "Stop"',
      `$installDir = ${powershellEscape(installDir)}`,
      `$execPath = ${powershellEscape(execPath)}`,
      `$archivePath = ${powershellEscape(this.downloadedUpdate!.archivePath)}`,
      `$parentPid = ${process.pid}`,
      `$stagingRoot = ${powershellEscape(stagingRoot)}`,
      `$logPath = ${powershellEscape(logPath)}`,
      '$extractRoot = Join-Path $stagingRoot "extracted"',
      '$backupPath = "$installDir.onward-backup"',
      '',
      'function Write-Log($msg) {',
      '    $dir = Split-Path $logPath -Parent',
      '    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }',
      '    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
      '    Add-Content -Path $logPath -Value "$ts $msg" -ErrorAction SilentlyContinue',
      '}',
      '',
      'try {',
      '    Write-Log "Starting Windows update install helper."',
      '',
      '    # Wait for parent process to exit',
      '    try {',
      '        $proc = Get-Process -Id $parentPid -ErrorAction SilentlyContinue',
      '        if ($proc) {',
      '            Write-Log "Waiting for parent process ($parentPid) to exit."',
      '            $proc.WaitForExit(120000) | Out-Null',
      '        }',
      '    } catch { }',
      '    Write-Log "Parent process exited."',
      '',
      '    # Clean previous staging and backup',
      '    if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }',
      '    if (Test-Path $backupPath) { Remove-Item $backupPath -Recurse -Force }',
      '',
      '    # Extract archive',
      '    Write-Log "Extracting update archive."',
      '    Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force',
      '',
      '    # Detect extracted content: single subdirectory or flat contents',
      '    $extractedItems = Get-ChildItem $extractRoot',
      '    if ($extractedItems.Count -eq 1 -and $extractedItems[0].PSIsContainer) {',
      '        $sourceDir = $extractedItems[0].FullName',
      '    } else {',
      '        $sourceDir = $extractRoot',
      '    }',
      '',
      '    # Backup current installation',
      '    Write-Log "Backing up current installation."',
      '    Rename-Item -Path $installDir -NewName (Split-Path $backupPath -Leaf) -Force',
      '',
      '    # Install update',
      '    Write-Log "Installing update."',
      '    if ($sourceDir -ne $extractRoot) {',
      '        Move-Item -Path $sourceDir -Destination $installDir -Force',
      '    } else {',
      '        New-Item -Path $installDir -ItemType Directory -Force | Out-Null',
      '        Get-ChildItem $extractRoot | Move-Item -Destination $installDir -Force',
      '    }',
      '',
      '    # Set environment variables and relaunch',
      '    Write-Log "Relaunching updated app."',
      envSetStatements,
      '    Start-Process -FilePath $execPath',
      '',
      '    # Cleanup',
      '    Remove-Item $backupPath -Recurse -Force -ErrorAction SilentlyContinue',
      '    Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue',
      '    Remove-Item $archivePath -Force -ErrorAction SilentlyContinue',
      '',
      '    Write-Log "Update installed successfully."',
      '} catch {',
      '    Write-Log "Update install failed: $_"',
      '    # Restore backup if installation dir is gone',
      '    if (-not (Test-Path $installDir) -and (Test-Path $backupPath)) {',
      '        Rename-Item -Path $backupPath -NewName (Split-Path $installDir -Leaf) -Force',
      '        Write-Log "Restored backup after failure."',
      '    }',
      '}'
    ].join('\n')

    writeFileSync(scriptPath, scriptContent, { encoding: 'utf-8' })
    spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
  }
}

let updateService: UpdateService | null = null

export function getUpdateService(): UpdateService {
  if (!updateService) {
    updateService = new UpdateService()
  }
  return updateService
}
