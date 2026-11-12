/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { spawn } from 'child_process'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getAppInfo, type ReleaseChannel, type ReleaseOs } from './app-info'
import { compareVersions, parseVersion } from './update-version'
import { getTelemetryService } from './telemetry/telemetry-service'
import { IPC } from '../shared/ipc-channels'
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
  isNonEmptyString,
  isSafeArtifactNameForPlatform,
  isValidSha256,
  normalizeUpdateManifest,
  type NormalizedUpdateManifest
} from './update-manifest-utils'
import {
  WindowsStagingError,
  cleanupTransientStageArtifacts,
  getWindowsStagePaths,
  inspectStagedWindowsUpdate,
  launchWindowsGuiUpdater,
  readAndClearLastInstallError,
  resolveBundledWindowsUpdaterExe,
  resolveLastInstallErrorPath,
  stageWindowsUpdateArchive,
  type WindowsUpdaterEnvEntry,
  type WindowsUpdaterPlan
} from './windows-update-staging'

function extractUpdateErrorCode(error: unknown): DownloadErrorCode | null {
  if (error instanceof DownloadError) return error.code
  if (error instanceof WindowsStagingError) return error.code
  return null
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'preparing'
  | 'downloaded'
  | 'up-to-date'
  | 'unsupported'
  | 'error'

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

type UpdateManifest = NormalizedUpdateManifest

interface DownloadedUpdate {
  manifest: UpdateManifest
  artifactPath: string
}

const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_UPDATE_REQUEST_TIMEOUT_MS = 60 * 1000
const DEFAULT_WINDOWS_WAIT_GRACE_MS = 15_000
const DEFAULT_WINDOWS_MOVE_RETRY_MS = 10_000
const LOG_PREFIX = '[UpdateService]'
const PENDING_UPDATE_MARKER_SCHEMA_VERSION = 3
const MAX_PENDING_UPDATE_MARKER_AGE_MS = 60 * 60 * 1000
const MAX_PENDING_UPDATE_STARTUP_ATTEMPTS = 1

const RELAUNCH_ENV_KEYS = [
  'ONWARD_USER_DATA_DIR',
  'ONWARD_DEBUG',
  'ONWARD_UPDATE_CHECK_INTERVAL_MS',
  'ONWARD_UPDATE_BASE_URL',
  'ONWARD_UPDATER_WAIT_GRACE_MS',
  'ONWARD_UPDATER_MOVE_RETRY_MS',
  'ONWARD_UPDATER_DISABLE_LINGERING_KILL',
  'ONWARD_AUTOTEST',
  'ONWARD_AUTOTEST_CWD',
  'ONWARD_AUTOTEST_EXIT',
  'ONWARD_DEBUG_CAPTURE',
  'ONWARD_FEATURE_GIT_DIFF_PERFORMANCE_DIAGNOSTICS'
] as const

/** Pending update marker written before launching the Windows GUI updater helper. */
interface PendingUpdateInfo {
  schemaVersion: 3
  installDir: string
  stageDir: string
  backupDir: string
  execPath: string
  logPath: string
  errorReportPath: string
  cleanupPaths: string[]
  timestamp: number
  targetVersion: string
  relaunch: boolean
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

function resolveCurrentInstallPath(): string | null {
  const exePath = app.getPath('exe')
  if (process.platform === 'darwin') {
    // macOS: exe is at Foo.app/Contents/MacOS/Foo, install path is Foo.app.
    return dirname(dirname(dirname(exePath)))
  }
  if (process.platform === 'win32') {
    // Windows per-user install: exe is at %LOCALAPPDATA%\Programs\Onward 2\Onward 2.exe.
    return dirname(exePath)
  }
  return null
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function resolveUpdateLogPath(): string {
  return join(app.getPath('userData'), 'updates', 'install.log')
}

function normalizeWindowsPathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '').toLowerCase()
}

function resolvePositiveEnvMs(envName: string, fallbackMs: number, minMs: number, maxMs: number): number {
  const raw = String(process.env[envName] || '').trim()
  if (!raw) return fallbackMs
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < minMs || parsed > maxMs) {
    return fallbackMs
  }
  return parsed
}

function collectRelaunchEnvEntries(): WindowsUpdaterEnvEntry[] {
  const entries: WindowsUpdaterEnvEntry[] = []
  for (const key of RELAUNCH_ENV_KEYS) {
    const value = process.env[key]
    if (value) {
      entries.push({ key, value })
    }
  }
  return entries
}

function validatePendingUpdateInfo(raw: unknown): { info: PendingUpdateInfo | null; error: string | null } {
  if (!raw || typeof raw !== 'object') {
    return { info: null, error: 'marker is not an object' }
  }

  const value = raw as Partial<PendingUpdateInfo>
  if (value.schemaVersion !== PENDING_UPDATE_MARKER_SCHEMA_VERSION) {
    return { info: null, error: `unsupported marker schema version: ${String(value.schemaVersion)}` }
  }

  const requiredStrings: Array<keyof Pick<PendingUpdateInfo, 'installDir' | 'stageDir' | 'backupDir' | 'execPath' | 'logPath' | 'errorReportPath' | 'targetVersion'>> = [
    'installDir',
    'stageDir',
    'backupDir',
    'execPath',
    'logPath',
    'errorReportPath',
    'targetVersion'
  ]
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
  if (typeof value.relaunch !== 'boolean') {
    return { info: null, error: 'missing or invalid marker relaunch flag' }
  }
  if (!Array.isArray(value.cleanupPaths) || !value.cleanupPaths.every((p) => isNonEmptyString(p) && isAbsolute(p))) {
    return { info: null, error: 'invalid cleanupPaths in marker' }
  }
  for (const key of ['installDir', 'stageDir', 'backupDir', 'execPath', 'logPath', 'errorReportPath'] as const) {
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
  getTelemetryService().track('update/error', {
    phase,
    error,
    platform: process.platform,
    ...properties
  })
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

function canInstallUpdatesOnCurrentPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

export class UpdateService {
  private status: UpdateStatus = this.createInitialStatus()
  private mainWindow: BrowserWindow | null = null
  private checkingPromise: Promise<UpdateStatus> | null = null
  private intervalHandle: NodeJS.Timeout | null = null
  private downloadedUpdate: DownloadedUpdate | null = null
  private pendingManifest: UpdateManifest | null = null
  private lastInstallFailure: { version: string; error: string } | null = null
  private installRequested = false
  private quitInstallLaunched = false
  private readonly checkIntervalMs = resolveUpdateCheckIntervalMs()

  private getPreservedInstallFailureError(version: string | null): string | null {
    if (!version || !this.lastInstallFailure) return null
    return this.lastInstallFailure.version === version ? this.lastInstallFailure.error : null
  }

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
    this.mainWindow.webContents.send(IPC.UPDATER_STATUS_CHANGED, this.getStatus())
  }

  private setStatus(patch: Partial<UpdateStatus>): UpdateStatus {
    const fromPhase = this.status.phase
    this.status = {
      ...this.status,
      ...patch
    }
    if (patch.phase !== undefined && patch.phase !== fromPhase) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_STATE_CHANGED, {
        fromPhase,
        toPhase: patch.phase,
        targetVersion: this.status.targetVersion ?? null
      })
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

    const rawManifest = await response.json() as unknown
    return normalizeUpdateManifest(rawManifest, {
      channel: this.status.currentChannel,
      platform: this.status.currentReleaseOs,
      arch: normalizeArch(process.arch)
    })
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

  private cleanupAndRecoverWindowsStagedUpdate(): boolean {
    const installDir = resolveCurrentInstallPath()
    if (!installDir) return false

    cleanupTransientStageArtifacts(installDir)

    const currentVersion = this.status.currentVersion
    const updatesRoot = resolveUpdatesRootPath()

    // Sweep expired version download directories (<= currentVersion).
    if (existsSync(updatesRoot)) {
      for (const entry of readdirSync(updatesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const version = entry.name
        try {
          parseVersion(version)
        } catch {
          rmSync(join(updatesRoot, version), { recursive: true, force: true })
          continue
        }
        if (compareVersions(version, currentVersion) <= 0) {
          rmSync(join(updatesRoot, version), { recursive: true, force: true })
          console.log(`${LOG_PREFIX} Cleaned up expired download: ${version}`)
        }
      }
    }

    const inspection = inspectStagedWindowsUpdate({
      installDir,
      execPath: app.getPath('exe'),
      currentVersion,
      currentChannel: this.status.currentChannel,
      currentArch: normalizeArch(process.arch)
    })

    if (inspection.state !== 'ready') {
      if (inspection.state === 'cleaned-expired') {
        console.log(`${LOG_PREFIX} Removed expired staged directory (_): ${inspection.version}`)
      } else if (inspection.state === 'cleaned-invalid') {
        console.log(`${LOG_PREFIX} Removed invalid staged directory (_): ${inspection.reason}`)
      }
      return false
    }

    const { metadata } = inspection
    const storedManifest = this.loadManifestFile(metadata.version)
    const manifest: UpdateManifest = storedManifest ?? {
      channel: metadata.channel,
      version: metadata.version,
      tag: metadata.tag,
      platform: 'windows',
      arch: metadata.arch,
      artifactName: metadata.artifactName,
      artifactUrl: '',
      sha256: metadata.sha256,
      releaseNotes: null,
      publishedAt: new Date(metadata.stagedAt).toISOString()
    }

    // Remove any older superseded download folders under userData/updates.
    if (existsSync(updatesRoot)) {
      for (const entry of readdirSync(updatesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidateVersion = entry.name
        try {
          if (compareVersions(candidateVersion, metadata.version) < 0) {
            rmSync(join(updatesRoot, candidateVersion), { recursive: true, force: true })
            console.log(`${LOG_PREFIX} Cleaned up superseded download: ${candidateVersion}`)
          }
        } catch {
          rmSync(join(updatesRoot, candidateVersion), { recursive: true, force: true })
        }
      }
    }

    const artifactPath = this.getDownloadPath(manifest)
    this.downloadedUpdate = { manifest, artifactPath }
    this.setStatus({
      phase: 'downloaded',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      error: null,
      errorCode: null,
      downloadProgress: null
    })
    console.log(`${LOG_PREFIX} Recovered ready staged Windows update (_): ${manifest.version}`)
    return true
  }

  /**
   * Clean up stale downloads and recover the latest pending update on startup.
   */
  private cleanupAndRecoverPendingUpdate(): void {
    if (process.platform === 'win32') {
      if (this.cleanupAndRecoverWindowsStagedUpdate()) {
        return
      }
      // If "_" is not ready yet, still clean invalid/superseded zip folders below;
      // any valid cached .zip will be staged asynchronously when checkNow() runs or in background.
    }

    const updatesRoot = resolveUpdatesRootPath()
    if (!existsSync(updatesRoot)) return

    const currentVersion = this.status.currentVersion
    const pendingVersions: string[] = []
    let cleanedCount = 0

    for (const entry of readdirSync(updatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const version = entry.name

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

    pendingVersions.sort((a, b) => compareVersions(b, a))

    let recoveredIndex = -1
    for (let i = 0; i < pendingVersions.length; i++) {
      if (this.recoverPendingUpdate(pendingVersions[i])) {
        recoveredIndex = i
        break
      }
      if (!existsSync(join(updatesRoot, pendingVersions[i]))) {
        cleanedCount++
      }
    }

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
   */
  private recoverPendingUpdate(version: string): boolean {
    const versionDir = join(resolveUpdatesRootPath(), version)
    const manifest = this.loadManifestFile(version)

    if (!manifest) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed unverifiable download (no manifest): ${version}`)
      return false
    }

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
    if (!isSafeArtifactNameForPlatform(manifest.artifactName, manifest.platform) || !isValidSha256(manifest.sha256)) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed invalid download manifest: ${version}`)
      return false
    }

    const artifactPath = join(versionDir, manifest.artifactName)
    if (!existsSync(artifactPath)) {
      const partialPath = getPartialDownloadPath(artifactPath)
      if (existsSync(partialPath)) {
        const partialSize = statSync(partialPath).size
        console.log(`${LOG_PREFIX} Found resumable partial download: ${version} (${formatDownloadBytes(partialSize)})`)
        return false
      }
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed incomplete download (artifact missing): ${version}`)
      return false
    }

    try {
      const checksum = hashFileSha256(artifactPath)
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

    if (process.platform === 'win32') {
      // On Windows, a cached .zip without a staged "_" directory is not yet ready for instant swap.
      // Kick off background staging asynchronously without blocking startup.
      void this.stageCachedWindowsZipOnStartup(manifest, artifactPath)
      return true
    }

    this.downloadedUpdate = { manifest, artifactPath }
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

  private async stageCachedWindowsZipOnStartup(manifest: UpdateManifest, artifactPath: string): Promise<void> {
    const installDir = resolveCurrentInstallPath()
    if (!installDir) return

    try {
      this.setStatus({
        phase: 'preparing',
        targetVersion: manifest.version,
        targetTag: manifest.tag,
        downloadedFileName: manifest.artifactName,
        error: null,
        errorCode: null,
        downloadProgress: null
      })
      await stageWindowsUpdateArchive({
        zipPath: artifactPath,
        installDir,
        execPath: app.getPath('exe'),
        currentVersion: this.status.currentVersion,
        manifest
      })
      this.downloadedUpdate = { manifest, artifactPath }
      this.setStatus({
        phase: 'downloaded',
        targetVersion: manifest.version,
        targetTag: manifest.tag,
        downloadedFileName: manifest.artifactName,
        error: null,
        errorCode: null,
        downloadProgress: null
      })
      console.log(`${LOG_PREFIX} Completed startup background staging for cached update: ${manifest.version}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.warn(`${LOG_PREFIX} Failed startup background staging for ${manifest.version}: ${errorMessage}`)
      if (this.status.phase === 'preparing') {
        this.setStatus({
          phase: 'error',
          error: errorMessage,
          errorCode: extractUpdateErrorCode(error),
          downloadProgress: null
        })
      }
    }
  }

  private isWindowsUpdateReadyOnDisk(manifest: UpdateManifest): boolean {
    if (process.platform !== 'win32') return true
    const installDir = resolveCurrentInstallPath()
    if (!installDir) return false
    const inspection = inspectStagedWindowsUpdate({
      installDir,
      execPath: app.getPath('exe'),
      currentVersion: this.status.currentVersion,
      currentChannel: this.status.currentChannel,
      currentArch: normalizeArch(process.arch)
    })
    return (
      inspection.state === 'ready' &&
      inspection.metadata.version === manifest.version &&
      inspection.metadata.sha256.toLowerCase() === manifest.sha256.toLowerCase()
    )
  }

  private async ensureDownloaded(
    manifest: UpdateManifest,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadedUpdate> {
    const artifactPath = this.getDownloadPath(manifest)

    this.saveManifestFile(manifest)

    if (!existsSync(artifactPath)) {
      console.log(`${LOG_PREFIX} Downloading: ${manifest.artifactUrl}`)
      await downloadFileWithRetry(manifest.artifactUrl, artifactPath, {
        onProgress,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          console.log(`${LOG_PREFIX} Retry ${attempt}/${maxAttempts} in ${delayMs}ms: ${error.message}`)
        },
        log: (message) => console.log(`${LOG_PREFIX} ${message}`)
      })
      console.log(`${LOG_PREFIX} Download saved to: ${artifactPath}`)
    } else {
      console.log(`${LOG_PREFIX} Artifact already exists, verifying checksum: ${artifactPath}`)
    }

    const checksum = hashFileSha256(artifactPath)
    if (checksum.toLowerCase() !== manifest.sha256.toLowerCase()) {
      console.error(`${LOG_PREFIX} Checksum mismatch: expected=${manifest.sha256}, got=${checksum}`)
      rmSync(artifactPath, { force: true })
      rmSync(getPartialDownloadPath(artifactPath), { force: true })
      throw new DownloadError('checksum-mismatch', 'Downloaded update failed checksum verification.')
    }
    console.log(`${LOG_PREFIX} Checksum verified: ${checksum}`)

    rmSync(getPartialDownloadPath(artifactPath), { force: true })

    if (process.platform === 'win32') {
      const installDir = resolveCurrentInstallPath()
      if (!installDir) {
        throw new DownloadError('disk-error', 'Unable to resolve Windows installation directory.')
      }

      this.setStatus({
        phase: 'preparing',
        targetVersion: manifest.version,
        targetTag: manifest.tag,
        downloadedFileName: manifest.artifactName,
        error: null,
        errorCode: null,
        downloadProgress: null
      })
      console.log(`${LOG_PREFIX} Staging Windows update into ${join(installDir, '_')} ...`)
      await stageWindowsUpdateArchive({
        zipPath: artifactPath,
        installDir,
        execPath: app.getPath('exe'),
        currentVersion: this.status.currentVersion,
        manifest
      })
      console.log(`${LOG_PREFIX} Windows update staged and verified: ${manifest.version}`)
    }

    return {
      manifest,
      artifactPath
    }
  }

  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.status = this.createInitialStatus()
    this.cleanupAndRecoverPendingUpdate()

    // Check install log / rollback report from previous update attempt and report via telemetry
    const previousFailureError = this.reportPreviousInstallResult()
    if (previousFailureError && this.status.phase === 'downloaded' && this.status.targetVersion) {
      this.lastInstallFailure = {
        version: this.status.targetVersion,
        error: previousFailureError
      }
      this.status = {
        ...this.status,
        error: previousFailureError
      }
    }

    this.emitStatus()

    console.log(`${LOG_PREFIX} Initialized: supported=${this.status.supported}, version=${this.status.currentVersion}, os=${this.status.currentReleaseOs}, channel=${this.status.currentChannel}`)

    if (!this.status.supported) return

    // DEV channel updates are manual only: Check Now, then Download, then Restart.
    if (this.status.currentChannel === 'dev') return

    void this.checkNow()
    this.intervalHandle = setInterval(() => {
      void this.checkNow()
    }, this.checkIntervalMs)
  }

  /**
   * Read the install log and rollback error report left by the previous update helper.
   * Returns an error summary if the previous install rolled back, otherwise null.
   */
  private reportPreviousInstallResult(): string | null {
    let surfacedInstallError: string | null = null

    if (process.platform === 'win32') {
      const lastError = readAndClearLastInstallError(resolveUpdatesRootPath())
      if (lastError) {
        surfacedInstallError = lastError.error
      }
    }

    const logPath = resolveUpdateLogPath()
    if (!existsSync(logPath)) return surfacedInstallError

    try {
      const content = readFileSync(logPath, 'utf-8').trim()
      if (!content) return surfacedInstallError

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
        surfacedInstallError = null
        console.log(`${LOG_PREFIX} Previous update installed successfully`)
        trackUpdateEvent('update/installComplete', { result: 'success' })
      } else if (failed) {
        const failedLine = lines[lastFailureIndex] || ''
        const errorMatch = /install failed:\s*(.+)$/i.exec(failedLine)
        const errorDetail = errorMatch ? errorMatch[1] : 'unknown'
        if (!surfacedInstallError) {
          surfacedInstallError = errorDetail
        }
        console.error(`${LOG_PREFIX} Previous update install failed: ${errorDetail}`)
        trackUpdateFailure('install', errorDetail, {
          installLog: lines.slice(-5).join('\n')
        })
      }

      writeFileSync(logPath, '', 'utf-8')
    } catch {
      // Non-blocking: log read failure is not critical
    }

    return surfacedInstallError
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
        if (
          this.downloadedUpdate &&
          this.downloadedUpdate.manifest.version === manifest.version &&
          this.isWindowsUpdateReadyOnDisk(manifest)
        ) {
          return this.setStatus({
            phase: 'downloaded',
            targetVersion: manifest.version,
            targetTag: manifest.tag,
            downloadedFileName: this.downloadedUpdate.manifest.artifactName,
            lastCheckedAt,
            error: this.getPreservedInstallFailureError(manifest.version),
            errorCode: null,
            downloadProgress: null
          })
        }

        this.downloadedUpdate = null
        this.lastInstallFailure = null
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

      if (
        this.downloadedUpdate &&
        this.downloadedUpdate.manifest.version === manifest.version &&
        this.isWindowsUpdateReadyOnDisk(manifest)
      ) {
        console.log(`${LOG_PREFIX} Update already downloaded and ready, skipping re-download: ${manifest.version}`)
        return this.setStatus({
          phase: 'downloaded',
          targetVersion: manifest.version,
          targetTag: manifest.tag,
          downloadedFileName: this.downloadedUpdate.manifest.artifactName,
          bannerDismissed: false,
          lastCheckedAt,
          error: this.getPreservedInstallFailureError(manifest.version),
          errorCode: null,
          downloadProgress: null
        })
      }

      // DEV channel: stop at 'available' and wait for user to manually trigger download.
      if (this.status.currentChannel === 'dev') {
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

      // Daily/Stable channel: auto-download (and background-stage on Windows) immediately.
      return await this.downloadUpdate(manifest, lastCheckedAt)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = extractUpdateErrorCode(error)
      const failedPhase =
        this.status.phase === 'preparing'
          ? 'prepare'
          : this.status.phase === 'downloading'
            ? 'download'
            : 'check'
      console.error(`${LOG_PREFIX} Update ${failedPhase} failed: ${errorMessage}`)
      trackUpdateFailure(failedPhase, errorMessage, {
        currentVersion: this.status.currentVersion,
        targetVersion: this.status.targetVersion
      })
      if (this.downloadedUpdate && this.isWindowsUpdateReadyOnDisk(this.downloadedUpdate.manifest)) {
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
    this.lastInstallFailure = null
    console.log(`${LOG_PREFIX} Update ready: ${manifest.artifactName}`)
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
      const errorCode = extractUpdateErrorCode(error)
      const failedPhase = this.getStatus().phase === 'preparing' ? 'prepare' : 'download'
      console.error(`${LOG_PREFIX} Update ${failedPhase} failed: ${errorMessage}`)
      trackUpdateFailure(failedPhase, errorMessage, {
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
    if (!canInstallUpdatesOnCurrentPlatform() || !this.downloadedUpdate) {
      return false
    }
    if (process.platform === 'win32') {
      return this.isWindowsUpdateReadyOnDisk(this.downloadedUpdate.manifest)
    }
    return true
  }

  requestRestartToUpdate(): { success: boolean; error?: string } {
    if (!this.canInstallDownloadedUpdate()) {
      return { success: false, error: 'No downloaded update is ready to install.' }
    }
    this.lastInstallFailure = null
    this.installRequested = true
    return { success: true }
  }

  shouldInstallOnQuit(): boolean {
    return this.installRequested
  }

  installDownloadedUpdateOnQuit(options?: { relaunch?: boolean }): void {
    if (this.quitInstallLaunched) return
    if (!this.downloadedUpdate) return

    const relaunch = options?.relaunch ?? true
    const targetVersion = this.downloadedUpdate.manifest.version

    if (process.platform === 'win32' && !this.isWindowsUpdateReadyOnDisk(this.downloadedUpdate.manifest)) {
      console.warn(`${LOG_PREFIX} Skipping Windows quit-time install because staged directory (_) is not ready.`)
      return
    }

    this.quitInstallLaunched = true
    console.log(`${LOG_PREFIX} Installing update on quit (relaunch=${relaunch}): ${this.status.currentVersion} -> ${targetVersion}`)
    trackUpdateEvent('update/installStart', {
      currentVersion: this.status.currentVersion,
      targetVersion,
      relaunch
    })

    if (process.platform === 'darwin') {
      this.installDownloadedUpdateOnQuitMacOS()
    } else if (process.platform === 'win32') {
      this.installDownloadedUpdateOnQuitWindows(relaunch)
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
      `ARCHIVE_PATH=${shellEscape(this.downloadedUpdate!.artifactPath)}`,
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
    const child = spawn('/bin/sh', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'macos-sh',
      platform: process.platform,
      pid: child.pid ?? null,
      ok: true
    })
    child.unref()
  }

  private installDownloadedUpdateOnQuitWindows(relaunch: boolean): void {
    const installDir = resolveCurrentInstallPath()
    if (!installDir || !this.downloadedUpdate) return

    const updatesRoot = resolveUpdatesRootPath()
    const logPath = resolveUpdateLogPath()
    const execPath = app.getPath('exe')
    const markerPath = join(updatesRoot, 'pending-update.json')
    const lockPath = join(updatesRoot, 'install.lock')
    const errorReportPath = resolveLastInstallErrorPath(updatesRoot)
    const { stageDir, backupDir } = getWindowsStagePaths(installDir)
    const targetVersion = this.downloadedUpdate.manifest.version
    const versionDownloadDir = join(updatesRoot, targetVersion)
    const cleanupPaths = existsSync(versionDownloadDir) ? [versionDownloadDir] : []

    const bundledUpdaterExePath = resolveBundledWindowsUpdaterExe(
      app.isPackaged ? process.resourcesPath : null
    )
    if (!bundledUpdaterExePath) {
      const msg = 'Bundled Windows GUI updater helper (onward-updater.exe) was not found.'
      appendToInstallLog(logPath, `Node.js: Update install failed: ${msg}`)
      console.error(`${LOG_PREFIX} ${msg}`)
      return
    }

    appendToInstallLog(
      logPath,
      `Node.js: Preparing Windows GUI updater. PID=${process.pid} target=${targetVersion} relaunch=${relaunch}`
    )

    try {
      const marker: PendingUpdateInfo = {
        schemaVersion: PENDING_UPDATE_MARKER_SCHEMA_VERSION,
        installDir,
        stageDir,
        backupDir,
        execPath,
        logPath,
        errorReportPath,
        cleanupPaths,
        timestamp: Date.now(),
        targetVersion,
        relaunch,
        attempts: 0
      }
      writePendingUpdateInfo(markerPath, marker)
    } catch (err) {
      appendToInstallLog(logPath, `Node.js: Failed to write pending-update marker: ${err}`)
    }

    const plan: WindowsUpdaterPlan = {
      installDir,
      stageDir,
      backupDir,
      execPath,
      parentPid: process.pid,
      relaunch,
      targetVersion,
      logPath,
      markerPath,
      lockPath,
      errorReportPath,
      cleanupPaths,
      waitGraceMs: resolvePositiveEnvMs('ONWARD_UPDATER_WAIT_GRACE_MS', DEFAULT_WINDOWS_WAIT_GRACE_MS, 500, 120_000),
      moveRetryMs: resolvePositiveEnvMs('ONWARD_UPDATER_MOVE_RETRY_MS', DEFAULT_WINDOWS_MOVE_RETRY_MS, 0, 60_000),
      killLingeringProcesses: process.env.ONWARD_UPDATER_DISABLE_LINGERING_KILL !== '1',
      env: collectRelaunchEnvEntries()
    }

    const spawnStart = Date.now()
    const launched = launchWindowsGuiUpdater({
      bundledUpdaterExePath,
      plan
    })

    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'win32-gui-exe',
      platform: 'win32',
      ok: launched.ok,
      pid: launched.pid,
      relaunch,
      durationMs: Date.now() - spawnStart,
      ...(launched.error ? { error: launched.error } : {})
    })

    if (launched.ok) {
      appendToInstallLog(logPath, `Node.js: Launched onward-updater.exe (pid=${String(launched.pid)}).`)
    } else {
      appendToInstallLog(logPath, `Node.js: Failed to launch onward-updater.exe: ${launched.error}`)
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
 * createWindow). If the previous quit-time updater helper was killed before it
 * could swap "_" into the installation directory, this detects the marker and
 * launches onward-updater.exe with relaunch=true.
 */
export function applyPendingUpdateOnStartup(): boolean {
  if (process.platform !== 'win32') return false

  const updatesRoot = resolveUpdatesRootPath()
  const markerPath = join(updatesRoot, 'pending-update.json')
  if (!existsSync(markerPath)) return false

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
  const info = validation.info

  const currentInstallDir = resolveCurrentInstallPath()
  const currentExecPath = app.getPath('exe')
  if (!currentInstallDir ||
      normalizeWindowsPathForCompare(currentInstallDir) !== normalizeWindowsPathForCompare(info.installDir) ||
      normalizeWindowsPathForCompare(currentExecPath) !== normalizeWindowsPathForCompare(info.execPath)) {
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker install path no longer matches current app, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  const appInfo = getAppInfo()
  let isTargetNewer = false
  try {
    isTargetNewer = compareVersions(info.targetVersion, appInfo.version) > 0
  } catch {
    appendToInstallLog(info.logPath, `Node.js: Pending update marker target version is invalid: ${info.targetVersion}`)
    safeRemoveFile(markerPath)
    return false
  }

  if (!isTargetNewer) {
    console.log(`${LOG_PREFIX} Pending update target (${info.targetVersion}) is not newer than current (${appInfo.version}), clearing marker.`)
    safeRemoveFile(markerPath)
    return false
  }

  if (Date.now() - info.timestamp > MAX_PENDING_UPDATE_MARKER_AGE_MS) {
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker is stale, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  if (info.attempts >= MAX_PENDING_UPDATE_STARTUP_ATTEMPTS) {
    appendToInstallLog(info.logPath, 'Node.js: Startup recovery attempt limit reached, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  const inspection = inspectStagedWindowsUpdate({
    installDir: currentInstallDir,
    execPath: currentExecPath,
    currentVersion: appInfo.version,
    currentChannel: appInfo.releaseChannel,
    currentArch: normalizeArch(process.arch)
  })
  if (inspection.state !== 'ready' || inspection.metadata.version !== info.targetVersion) {
    appendToInstallLog(info.logPath, 'Node.js: Pending update staged directory (_) is missing or invalid, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  const bundledUpdaterExePath = resolveBundledWindowsUpdaterExe(
    app.isPackaged ? process.resourcesPath : null
  )
  if (!bundledUpdaterExePath) {
    appendToInstallLog(info.logPath, 'Node.js: Startup recovery skipped because onward-updater.exe was not found.')
    safeRemoveFile(markerPath)
    return false
  }

  try {
    writePendingUpdateInfo(markerPath, {
      ...info,
      attempts: info.attempts + 1
    })
  } catch {
    safeRemoveFile(markerPath)
    return false
  }

  const lockPath = join(updatesRoot, 'install.lock')
  const plan: WindowsUpdaterPlan = {
    installDir: info.installDir,
    stageDir: info.stageDir,
    backupDir: info.backupDir,
    execPath: info.execPath,
    parentPid: process.pid,
    relaunch: true,
    targetVersion: info.targetVersion,
    logPath: info.logPath,
    markerPath,
    lockPath,
    errorReportPath: info.errorReportPath,
    cleanupPaths: info.cleanupPaths,
    waitGraceMs: resolvePositiveEnvMs('ONWARD_UPDATER_WAIT_GRACE_MS', DEFAULT_WINDOWS_WAIT_GRACE_MS, 500, 120_000),
    moveRetryMs: resolvePositiveEnvMs('ONWARD_UPDATER_MOVE_RETRY_MS', DEFAULT_WINDOWS_MOVE_RETRY_MS, 0, 60_000),
    killLingeringProcesses: process.env.ONWARD_UPDATER_DISABLE_LINGERING_KILL !== '1',
    env: collectRelaunchEnvEntries()
  }

  const launched = launchWindowsGuiUpdater({
    bundledUpdaterExePath,
    plan
  })
  if (!launched.ok) {
    appendToInstallLog(info.logPath, `Node.js: Startup recovery failed to launch onward-updater.exe: ${launched.error}`)
    safeRemoveFile(markerPath)
    return false
  }

  appendToInstallLog(info.logPath, `Node.js: Startup recovery launched onward-updater.exe for ${info.targetVersion}.`)
  return true
}
