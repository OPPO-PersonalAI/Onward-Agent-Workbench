/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { readFileSync } from 'fs'
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
    displayName = `${productName} ${tag}`
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
  }

  return appInfo
}
