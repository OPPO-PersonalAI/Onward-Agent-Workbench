/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { readFileSync, readdirSync, existsSync, copyFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

export type BuildChannel = 'dev' | 'prod'
export type ReleaseChannel = 'daily' | 'stable' | 'unknown'
export type ReleaseOs = 'macos' | 'windows' | 'linux' | 'unknown'

export interface AppInfo {
  buildChannel: BuildChannel
  branch: string | null
  tag: string | null
  releaseChannel: ReleaseChannel
  releaseOs: ReleaseOs
  version: string
  productName: string
  displayName: string
  isPackaged: boolean
}

let cachedInfo: AppInfo | null = null

function readPackagedMetadata(): Record<string, unknown> | null {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeBuildChannel(value: unknown, isPackaged: boolean): BuildChannel {
  if (value === 'dev') return 'dev'
  if (!isPackaged) return 'dev'
  return 'prod'
}

function normalizeBranch(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeReleaseOs(value: unknown): ReleaseOs {
  if (value === 'macos' || value === 'windows' || value === 'linux') {
    return value
  }
  return 'unknown'
}

function normalizeReleaseChannel(value: unknown): ReleaseChannel {
  if (value === 'daily' || value === 'stable') {
    return value
  }
  return 'unknown'
}

function normalizeVersion(value: unknown): string {
  if (typeof value !== 'string') return '0.0.0'
  const trimmed = value.trim()
  return trimmed || '0.0.0'
}

function formatDailyTagForDisplay(tag: string): string | null {
  const semverDailyMatch = /^v\d+\.\d+\.\d+-daily\.(\d{4})(\d{2})(\d{2})\.\d+$/.exec(tag)
  if (semverDailyMatch) {
    return `v${semverDailyMatch[1]}.${semverDailyMatch[2]}.${semverDailyMatch[3]}`
  }

  const legacyDailyMatch = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.\d+)?$/.exec(tag)
  if (legacyDailyMatch) {
    return `v${legacyDailyMatch[1]}.${legacyDailyMatch[2]}.${legacyDailyMatch[3]}`
  }

  return null
}

function formatTagForDisplay(tag: string, releaseChannel: ReleaseChannel): string {
  if (releaseChannel === 'daily') {
    return formatDailyTagForDisplay(tag) ?? tag
  }
  return tag
}

export function getAppInfo(): AppInfo {
  if (cachedInfo) return cachedInfo

  const pkg = readPackagedMetadata()
  const envBuild = process.env.ONWARD_BUILD
  const envBranch = process.env.ONWARD_BRANCH
  const isPackaged = app.isPackaged

  const productName = (pkg?.productName as string) || app.getName() || 'Onward 2'
  const buildChannel = normalizeBuildChannel(pkg?.buildChannel ?? envBuild, isPackaged)
  const branch = normalizeBranch(pkg?.branch ?? envBranch)
  const tag = normalizeTag(pkg?.tag ?? process.env.ONWARD_TAG)
  const releaseChannel = normalizeReleaseChannel(pkg?.releaseChannel)
  const releaseOs = normalizeReleaseOs(pkg?.releaseOs)
  const version = normalizeVersion(pkg?.version ?? app.getVersion())

  let displayName = productName
  if (buildChannel === 'dev' && branch && !displayName.includes(branch)) {
    displayName = `${displayName}-${branch}`
  }
  if (buildChannel === 'prod' && tag) {
    displayName = `${productName} ${formatTagForDisplay(tag, releaseChannel)}`
  }

  cachedInfo = {
    buildChannel,
    branch,
    tag,
    releaseChannel,
    releaseOs,
    version,
    productName,
    displayName,
    isPackaged
  }

  return cachedInfo
}

function getDevUserDataPath(displayName: string): string {
  const exePath = app.getPath('exe')
  const dataDirName = `${displayName}-data`

  if (process.platform === 'darwin') {
    const appBundlePath = dirname(dirname(dirname(exePath)))
    const appBundleParent = dirname(appBundlePath)
    return join(appBundleParent, dataDirName)
  }

  return join(dirname(exePath), dataDirName)
}

/**
 * Migrate state files from a versioned userData directory (e.g. "Onward 2 v2026.03.01")
 * to the stable productName-based directory (e.g. "Onward 2").
 * Only runs when the stable directory has no existing app-state.json.
 * Copies files without deleting the source.
 */
function migrateFromVersionedUserData(stableUserDataPath: string, productName: string): void {
  try {
    if (existsSync(join(stableUserDataPath, 'app-state.json'))) {
      return
    }

    const appDataPath = app.getPath('appData')
    const prefix = `${productName} v`

    let entries: string[]
    try {
      entries = readdirSync(appDataPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith(prefix))
        .map(d => d.name)
    } catch {
      return
    }

    if (entries.length === 0) return

    // Find the most recently updated candidate.
    // A directory qualifies if it has app-state.json OR legacy files (terminal-config.json / prompts.json).
    let bestDir: string | null = null
    let bestUpdatedAt = -1

    for (const dirName of entries) {
      const candidatePath = join(appDataPath, dirName)
      const statePath = join(candidatePath, 'app-state.json')
      const hasLegacy = existsSync(join(candidatePath, 'terminal-config.json'))
        || existsSync(join(candidatePath, 'prompts.json'))

      if (!existsSync(statePath) && !hasLegacy) continue

      let updatedAt = 0
      if (existsSync(statePath)) {
        try {
          const raw = readFileSync(statePath, 'utf-8')
          const parsed = JSON.parse(raw) as { updatedAt?: number }
          updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
        } catch {
          // Unreadable app-state.json; still consider if legacy files exist
        }
      }

      if (updatedAt > bestUpdatedAt || (bestDir === null && hasLegacy)) {
        bestUpdatedAt = updatedAt
        bestDir = candidatePath
      }
    }

    if (!bestDir) return

    if (!existsSync(stableUserDataPath)) {
      mkdirSync(stableUserDataPath, { recursive: true })
    }

    const filesToMigrate = [
      'app-state.json',
      'settings.json',
      'command-presets.json',
      'coding-agent-config.json',
      'window-state.json',
      // Legacy files needed by AppStateStorage.migrateFromLegacy()
      'terminal-config.json',
      'prompts.json'
    ]

    let copiedCount = 0
    for (const fileName of filesToMigrate) {
      const src = join(bestDir, fileName)
      if (existsSync(src)) {
        copyFileSync(src, join(stableUserDataPath, fileName))
        copiedCount++
      }
    }

    console.log(`[AppInfo] Migrated ${copiedCount} state files from "${bestDir}" to "${stableUserDataPath}"`)
  } catch (error) {
    console.error('[AppInfo] State migration failed (non-blocking):', error)
  }
}

export function initializeAppIdentity(): AppInfo {
  const appInfo = getAppInfo()
  const forcedUserDataPath = String(process.env.ONWARD_USER_DATA_DIR || '').trim()

  if (app.getName() !== appInfo.displayName) {
    app.setName(appInfo.displayName)
  }

  if (forcedUserDataPath) {
    app.setPath('userData', forcedUserDataPath)
    return appInfo
  }

  if (appInfo.buildChannel === 'dev' && appInfo.isPackaged) {
    const userDataPath = getDevUserDataPath(appInfo.displayName)
    app.setPath('userData', userDataPath)
    return appInfo
  }

  // For prod builds with tags, displayName includes the version tag (e.g. "Onward 2 v2026.04.06").
  // Since app.setName(displayName) changes the default userData path, explicitly set userData
  // to a stable path based on productName to prevent state loss across upgrades.
  if (appInfo.buildChannel === 'prod' && appInfo.isPackaged && appInfo.tag) {
    const stableUserDataPath = join(app.getPath('appData'), appInfo.productName)
    app.setPath('userData', stableUserDataPath)
    migrateFromVersionedUserData(stableUserDataPath, appInfo.productName)
  }

  return appInfo
}
