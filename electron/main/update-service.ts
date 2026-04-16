/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getAppInfo, type ReleaseChannel, type ReleaseOs } from './app-info'
import { compareVersions, parseVersion } from './update-version'
import { getTelemetryService } from './telemetry/telemetry-service'
import {
  DownloadError,
  type DownloadErrorCode,
  type DownloadProgress,
  downloadFileWithRetry,
  fetchUpdateResource,
  formatDownloadBytes,
  getPartialDownloadPath
} from './update-download'
import {
  canInstallUpdatesOnCurrentPlatform,
  installDownloadedUpdateOnQuit as launchUpdateInstaller,
  resolveUpdateLogPath
} from './update-installer'

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
  errorCode: DownloadErrorCode | null
  bannerDismissed: boolean
  downloadProgress: DownloadProgress | null
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

const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_UPDATE_REQUEST_TIMEOUT_MS = 60 * 1000
const LOG_PREFIX = '[UpdateService]'

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
  const repositoryObject = typeof repositoryValue === 'object' && repositoryValue
    ? repositoryValue as Record<string, unknown>
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
  const onwardObject = typeof onwardValue === 'object' && onwardValue
    ? onwardValue as Record<string, unknown>
    : null
  if (onwardObject && typeof onwardObject.updateManifestBaseUrl === 'string') {
    return onwardObject.updateManifestBaseUrl.replace(/\/+$/, '')
  }

  if (!repository) return null
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/gh-pages/updates`
}

function hashFileSha256(filePath: string): string {
  const hash = createHash('sha256')
  const buffer = readFileSync(filePath)
  hash.update(buffer)
  return hash.digest('hex')
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
    const releaseOsMatchesPlatform =
      (process.platform === 'darwin' && appInfo.releaseOs === 'macos') ||
      (process.platform === 'win32' && appInfo.releaseOs === 'windows') ||
      (process.platform === 'linux' && appInfo.releaseOs === 'linux')
    const installSupported = canInstallUpdatesOnCurrentPlatform()
    const supported =
      appInfo.isPackaged &&
      appInfo.buildChannel === 'prod' &&
      releaseOsMatchesPlatform &&
      installSupported &&
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
      errorCode: null,
      bannerDismissed: false,
      downloadProgress: null
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
   * 1. Versions <= currentVersion are expired (already installed or older), then deleted
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

    // Sort descending: try newest first, fall back to older candidates.
    pendingVersions.sort((a, b) => compareVersions(b, a))

    // Try candidates in descending order. Only delete superseded versions
    // AFTER a successful recovery (verify-before-delete).
    let recoveredIndex = -1
    for (let i = 0; i < pendingVersions.length; i++) {
      if (this.recoverPendingUpdate(pendingVersions[i])) {
        recoveredIndex = i
        break
      }
      // Count as cleaned only if the directory was actually removed
      // (partial downloads are preserved for cross-session resume)
      if (!existsSync(join(updatesRoot, pendingVersions[i]))) {
        cleanedCount++
      }
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

    const archivePath = join(versionDir, manifest.artifactName)
    if (!existsSync(archivePath)) {
      // Preserve directories with a .partial file so they can be resumed.
      const partialPath = getPartialDownloadPath(archivePath)
      if (existsSync(partialPath)) {
        const partialSize = statSync(partialPath).size
        console.log(`${LOG_PREFIX} Found resumable partial download: ${version} (${formatDownloadBytes(partialSize)})`)
        return false
      }
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
      error: null,
      errorCode: null,
      downloadProgress: null
    })
    console.log(`${LOG_PREFIX} Recovered pending update: ${version} (${manifest.artifactName})`)
    return true
  }

  private async ensureDownloaded(
    manifest: UpdateManifest,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadedUpdate> {
    const archivePath = this.getDownloadPath(manifest)

    // Persist manifest before download so partial files can be resumed across sessions
    this.saveManifestFile(manifest)

    if (!existsSync(archivePath)) {
      console.log(`${LOG_PREFIX} Downloading: ${manifest.artifactUrl}`)
      await downloadFileWithRetry(manifest.artifactUrl, archivePath, {
        onProgress,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          console.log(`${LOG_PREFIX} Retry ${attempt}/${maxAttempts} in ${delayMs}ms: ${error.message}`)
        },
        log: (message) => console.log(`${LOG_PREFIX} ${message}`)
      })
      console.log(`${LOG_PREFIX} Download saved to: ${archivePath}`)
    } else {
      console.log(`${LOG_PREFIX} Archive already exists, verifying checksum: ${archivePath}`)
    }

    const checksum = hashFileSha256(archivePath)
    if (checksum.toLowerCase() !== manifest.sha256.toLowerCase()) {
      console.error(`${LOG_PREFIX} Checksum mismatch: expected=${manifest.sha256}, got=${checksum}`)
      rmSync(archivePath, { force: true })
      rmSync(getPartialDownloadPath(archivePath), { force: true })
      throw new DownloadError('checksum-mismatch', 'Downloaded update failed checksum verification.')
    }
    console.log(`${LOG_PREFIX} Checksum verified: ${checksum}`)

    // Clean up partial file after successful verification
    rmSync(getPartialDownloadPath(archivePath), { force: true })

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

    // DEV channel updates are manual only: Check Now, then Download, then Restart.
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
      const lastLine = lines[lines.length - 1] || ''
      const success = lastLine.includes('installed successfully')
      const failed = lastLine.includes('install failed')

      if (success) {
        console.log(`${LOG_PREFIX} Previous update installed successfully`)
        trackUpdateEvent('update/installComplete', { result: 'success' })
      } else if (failed) {
        // Extract error from the log line: "YYYY-MM-DD HH:MM:SS Update install failed: <error>"
        const errorMatch = /install failed:\s*(.+)$/i.exec(lastLine)
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
      error: null,
      errorCode: null,
      downloadProgress: null
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
            error: null,
            errorCode: null,
            downloadProgress: null
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
          error: null,
          errorCode: null,
          downloadProgress: null
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
          error: null,
          errorCode: null,
          downloadProgress: null
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
          error: null,
          errorCode: null,
          downloadProgress: null
        })
      }

      // Daily/Stable channel: auto-download immediately.
      return this.downloadUpdate(manifest, lastCheckedAt)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = error instanceof DownloadError ? error.code : null
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
          error: errorMessage,
          errorCode,
          downloadProgress: null
        })
      }
      return this.setStatus({
        phase: 'error',
        lastCheckedAt: Date.now(),
        error: errorMessage,
        errorCode,
        downloadProgress: null
      })
    }
  }

  private async downloadUpdate(manifest: UpdateManifest, lastCheckedAt: number): Promise<UpdateStatus> {
    this.setStatus({
      phase: 'downloading',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      bannerDismissed: false,
      lastCheckedAt,
      error: null,
      errorCode: null,
      downloadProgress: null
    })

    const onProgress = (progress: DownloadProgress): void => {
      this.setStatus({ downloadProgress: progress })
    }

    this.downloadedUpdate = await this.ensureDownloaded(manifest, onProgress)
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
      error: null,
      errorCode: null,
      downloadProgress: null
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
      return await this.downloadUpdate(manifest, this.status.lastCheckedAt ?? Date.now())
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = error instanceof DownloadError ? error.code : null
      console.error(`${LOG_PREFIX} Download failed: ${errorMessage}`)
      trackUpdateFailure('download', errorMessage, {
        currentVersion: this.status.currentVersion,
        targetVersion: manifest.version
      })
      return this.setStatus({
        phase: 'error',
        error: errorMessage,
        errorCode,
        downloadProgress: null
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
    return canInstallUpdatesOnCurrentPlatform() && Boolean(this.downloadedUpdate)
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
    console.log(`${LOG_PREFIX} Installing update on quit: ${this.status.currentVersion} -> ${targetVersion}`)
    trackUpdateEvent('update/installStart', {
      currentVersion: this.status.currentVersion,
      targetVersion
    })

    const started = launchUpdateInstaller({
      archivePath: this.downloadedUpdate.archivePath
    })
    if (!started) {
      trackUpdateFailure('install', 'Current platform does not have an update installer.', {
        currentVersion: this.status.currentVersion,
        targetVersion
      })
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
