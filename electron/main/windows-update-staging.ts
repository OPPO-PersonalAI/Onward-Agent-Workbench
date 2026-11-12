/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process'
import { existsSync as asarAwareExistsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { ReleaseChannel } from './app-info.ts'
import { rawFs } from './raw-fs.ts'
import type { NormalizedUpdateManifest } from './update-manifest-utils.ts'
import { isNonEmptyString, isSafeZipArtifactName, isValidSha256 } from './update-manifest-utils.ts'
import { compareVersions } from './update-version.ts'
import { extractWindowsUpdateZip } from './windows-zip-extract.ts'

const { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = rawFs

const MODULE_DIR = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))

export class WindowsStagingError extends Error {
  readonly code = 'disk-error' as const

  constructor(message: string) {
    super(message)
    this.name = 'WindowsStagingError'
  }
}

export const WINDOWS_STAGE_DIR_NAME = '_'
export const WINDOWS_STAGING_TEMP_DIR_NAME = '_staging'
export const WINDOWS_BACKUP_DIR_NAME = '_old'
export const WINDOWS_STAGE_READY_MARKER = '.onward-stage-ready.json'
export const STAGE_READY_SCHEMA_VERSION = 1

export interface StageReadyMetadata {
  schemaVersion: 1
  channel: ReleaseChannel
  version: string
  tag: string
  arch: 'arm64' | 'x64'
  artifactName: string
  sha256: string
  executableName: string
  stagedAt: number
}

export interface WindowsUpdaterEnvEntry {
  key: string
  value: string
}

export interface WindowsUpdaterPlan {
  installDir: string
  stageDir: string
  backupDir: string
  execPath: string
  parentPid: number
  relaunch: boolean
  targetVersion: string
  logPath: string
  markerPath: string
  lockPath: string
  errorReportPath: string
  cleanupPaths: string[]
  waitGraceMs: number
  moveRetryMs: number
  killLingeringProcesses: boolean
  env: WindowsUpdaterEnvEntry[]
}

export interface LastInstallErrorReport {
  timestamp: number
  targetVersion: string
  error: string
  rolledBack: boolean
}

export type StagedInspectionResult =
  | { state: 'absent' }
  | { state: 'cleaned-invalid'; reason: string }
  | { state: 'cleaned-expired'; version: string }
  | { state: 'ready'; stageDir: string; metadata: StageReadyMetadata }

export function getWindowsStagePaths(installDir: string): {
  stageDir: string
  stagingTempDir: string
  backupDir: string
  readyMarkerPath: string
} {
  const stageDir = join(installDir, WINDOWS_STAGE_DIR_NAME)
  return {
    stageDir,
    stagingTempDir: join(installDir, WINDOWS_STAGING_TEMP_DIR_NAME),
    backupDir: join(installDir, WINDOWS_BACKUP_DIR_NAME),
    readyMarkerPath: join(stageDir, WINDOWS_STAGE_READY_MARKER)
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, ms))
}

async function renameDirectoryWithRetry(sourcePath: string, targetPath: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown = null

  while (true) {
    try {
      renameSync(sourcePath, targetPath)
      return
    } catch (error) {
      lastError = error
      if (Date.now() - startedAt >= timeoutMs) {
        break
      }
      await sleepMs(200)
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new WindowsStagingError(`Failed to finalize staged update directory: ${message}`)
}

export function ensureInstallDirWritable(installDir: string): void {
  const probePath = join(installDir, `.onward-write-probe-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(probePath, 'ok', 'utf-8')
    rmSync(probePath, { force: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WindowsStagingError(`Installation directory is not writable (${installDir}): ${message}`)
  }
}

export function cleanupTransientStageArtifacts(installDir: string): void {
  const { stagingTempDir, backupDir } = getWindowsStagePaths(installDir)
  for (const dirPath of [stagingTempDir, backupDir]) {
    if (!existsSync(dirPath)) continue
    try {
      rmSync(dirPath, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; next updater run or startup will retry if locked briefly.
    }
  }
}

export function removeStagedUpdateDir(installDir: string): void {
  const { stageDir } = getWindowsStagePaths(installDir)
  if (!existsSync(stageDir)) return
  try {
    rmSync(stageDir, { recursive: true, force: true })
  } catch {
    // Non-blocking best-effort removal.
  }
}

function parseStageReadyMetadata(raw: unknown): StageReadyMetadata | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<StageReadyMetadata>
  if (candidate.schemaVersion !== STAGE_READY_SCHEMA_VERSION) return null
  if (candidate.channel !== 'daily' && candidate.channel !== 'dev' && candidate.channel !== 'stable') return null
  if (candidate.arch !== 'arm64' && candidate.arch !== 'x64') return null
  if (!isNonEmptyString(candidate.version) || !isNonEmptyString(candidate.tag)) return null
  if (!isNonEmptyString(candidate.artifactName) || !isSafeZipArtifactName(candidate.artifactName)) return null
  if (!isValidSha256(candidate.sha256)) return null
  if (!isNonEmptyString(candidate.executableName) || candidate.executableName !== basename(candidate.executableName)) {
    return null
  }
  if (typeof candidate.stagedAt !== 'number' || !Number.isFinite(candidate.stagedAt)) return null
  return {
    schemaVersion: 1,
    channel: candidate.channel,
    version: candidate.version,
    tag: candidate.tag,
    arch: candidate.arch,
    artifactName: candidate.artifactName,
    sha256: candidate.sha256.toLowerCase(),
    executableName: candidate.executableName,
    stagedAt: candidate.stagedAt
  }
}

export function inspectStagedWindowsUpdate(params: {
  installDir: string
  execPath: string
  currentVersion: string
  currentChannel: ReleaseChannel
  currentArch: 'arm64' | 'x64' | null
}): StagedInspectionResult {
  const { stageDir, readyMarkerPath } = getWindowsStagePaths(params.installDir)
  if (!existsSync(stageDir)) {
    return { state: 'absent' }
  }

  if (!existsSync(readyMarkerPath)) {
    removeStagedUpdateDir(params.installDir)
    return { state: 'cleaned-invalid', reason: 'missing ready marker' }
  }

  let metadata: StageReadyMetadata | null = null
  try {
    metadata = parseStageReadyMetadata(JSON.parse(readFileSync(readyMarkerPath, 'utf-8')))
  } catch {
    metadata = null
  }

  if (!metadata) {
    removeStagedUpdateDir(params.installDir)
    return { state: 'cleaned-invalid', reason: 'malformed ready marker' }
  }

  const expectedExeName = basename(params.execPath)
  if (
    metadata.channel !== params.currentChannel ||
    !params.currentArch ||
    metadata.arch !== params.currentArch ||
    metadata.executableName.toLowerCase() !== expectedExeName.toLowerCase()
  ) {
    removeStagedUpdateDir(params.installDir)
    return { state: 'cleaned-invalid', reason: 'incompatible channel, arch, or executable' }
  }

  let isNewer = false
  try {
    isNewer = compareVersions(metadata.version, params.currentVersion) > 0
  } catch {
    removeStagedUpdateDir(params.installDir)
    return { state: 'cleaned-invalid', reason: 'invalid staged version' }
  }

  if (!isNewer) {
    const expiredVersion = metadata.version
    removeStagedUpdateDir(params.installDir)
    return { state: 'cleaned-expired', version: expiredVersion }
  }

  const stagedExecutablePath = join(stageDir, expectedExeName)
  if (!existsSync(stagedExecutablePath)) {
    removeStagedUpdateDir(params.installDir)
    return { state: 'cleaned-invalid', reason: 'staged executable missing' }
  }

  return {
    state: 'ready',
    stageDir,
    metadata
  }
}

async function runZipExtractionOffThreadOrInline(params: {
  zipPath: string
  destinationDir: string
  expectedExecutableName: string
}): Promise<{ extractedFiles: number }> {
  const workerScriptPath = join(MODULE_DIR, 'windows-update-stage-worker-entry.js')
  if (!asarAwareExistsSync(workerScriptPath)) {
    return await extractWindowsUpdateZip(params)
  }

  return await new Promise<{ extractedFiles: number }>((resolveExtract, rejectExtract) => {
    let settled = false
    const worker = new Worker(workerScriptPath, {
      workerData: params
    })

    worker.on('message', (msg: { type?: string; success?: boolean; extractedFiles?: number; error?: string }) => {
      if (msg?.type !== 'result' || settled) return
      settled = true
      if (msg.success) {
        resolveExtract({ extractedFiles: msg.extractedFiles ?? 0 })
      } else {
        rejectExtract(new Error(msg.error || 'Background zip extraction failed.'))
      }
    })

    worker.on('error', (error) => {
      if (settled) return
      settled = true
      rejectExtract(error)
    })

    worker.on('exit', (code) => {
      if (settled) return
      settled = true
      rejectExtract(new Error(`Windows zip extraction worker exited unexpectedly with code ${code}`))
    })
  })
}

export async function stageWindowsUpdateArchive(params: {
  zipPath: string
  installDir: string
  execPath: string
  currentVersion: string
  manifest: NormalizedUpdateManifest
}): Promise<StageReadyMetadata> {
  const { zipPath, installDir, execPath, currentVersion, manifest } = params
  const executableName = basename(execPath)

  const existing = inspectStagedWindowsUpdate({
    installDir,
    execPath,
    currentVersion,
    currentChannel: manifest.channel,
    currentArch: manifest.arch
  })
  if (
    existing.state === 'ready' &&
    existing.metadata.version === manifest.version &&
    existing.metadata.sha256.toLowerCase() === manifest.sha256.toLowerCase()
  ) {
    return existing.metadata
  }

  ensureInstallDirWritable(installDir)

  const { stageDir, stagingTempDir } = getWindowsStagePaths(installDir)
  rmSync(stagingTempDir, { recursive: true, force: true })

  try {
    await runZipExtractionOffThreadOrInline({
      zipPath,
      destinationDir: stagingTempDir,
      expectedExecutableName: executableName
    })

    const metadata: StageReadyMetadata = {
      schemaVersion: STAGE_READY_SCHEMA_VERSION,
      channel: manifest.channel,
      version: manifest.version,
      tag: manifest.tag,
      arch: manifest.arch,
      artifactName: manifest.artifactName,
      sha256: manifest.sha256.toLowerCase(),
      executableName,
      stagedAt: Date.now()
    }

    writeFileSync(
      join(stagingTempDir, WINDOWS_STAGE_READY_MARKER),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf-8'
    )

    if (existsSync(stageDir)) {
      rmSync(stageDir, { recursive: true, force: true })
    }

    await renameDirectoryWithRetry(stagingTempDir, stageDir)
    return metadata
  } catch (error) {
    rmSync(stagingTempDir, { recursive: true, force: true })
    if (error instanceof WindowsStagingError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new WindowsStagingError(`Failed to stage Windows update archive: ${message}`)
  }
}

export function resolveBundledWindowsUpdaterExe(resourcesPath?: string | null): string | null {
  const candidates = [
    resourcesPath ? join(resourcesPath, 'resources', 'updater', 'win32', 'onward-updater.exe') : null,
    resourcesPath ? join(resourcesPath, 'updater', 'win32', 'onward-updater.exe') : null,
    resolve(MODULE_DIR, '..', '..', 'resources', 'updater', 'win32', 'onward-updater.exe'),
    resolve(MODULE_DIR, '..', '..', '..', 'resources', 'updater', 'win32', 'onward-updater.exe')
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function launchWindowsGuiUpdater(params: {
  bundledUpdaterExePath: string
  plan: WindowsUpdaterPlan
  tempBaseDir?: string
}): { ok: boolean; pid: number | null; planPath: string; error?: string } {
  const baseTemp = params.tempBaseDir || process.env.TEMP || tmpdir()
  const runnerDir = join(baseTemp, `onward-up-${Date.now().toString(36)}-${process.pid}`)
  mkdirSync(runnerDir, { recursive: true })

  const tempExePath = join(runnerDir, 'onward-updater.exe')
  const planPath = join(runnerDir, 'update-plan.json')

  try {
    cpSync(params.bundledUpdaterExePath, tempExePath)
    writeFileSync(planPath, `${JSON.stringify(params.plan, null, 2)}\n`, 'utf-8')

    const child = spawn(tempExePath, ['--plan', planPath], {
      cwd: runnerDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    return {
      ok: true,
      pid: child.pid ?? null,
      planPath
    }
  } catch (error) {
    return {
      ok: false,
      pid: null,
      planPath,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function resolveLastInstallErrorPath(updatesRootPath: string): string {
  return join(updatesRootPath, 'last-install-error.json')
}

export function readAndClearLastInstallError(updatesRootPath: string): LastInstallErrorReport | null {
  const errorPath = resolveLastInstallErrorPath(updatesRootPath)
  if (!existsSync(errorPath)) return null

  try {
    const raw = JSON.parse(readFileSync(errorPath, 'utf-8')) as Partial<LastInstallErrorReport>
    rmSync(errorPath, { force: true })
    if (!raw || typeof raw.error !== 'string' || !raw.error.trim()) {
      return null
    }
    return {
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
      targetVersion: typeof raw.targetVersion === 'string' ? raw.targetVersion : '',
      error: raw.error,
      rolledBack: Boolean(raw.rolledBack)
    }
  } catch {
    try {
      rmSync(errorPath, { force: true })
    } catch {
      // ignore
    }
    return null
  }
}
