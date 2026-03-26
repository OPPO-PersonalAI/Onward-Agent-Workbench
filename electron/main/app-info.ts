/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'

export type BuildChannel = 'dev' | 'prod'

export interface AppInfo {
  buildChannel: BuildChannel
  branch: string | null
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

export function getAppInfo(): AppInfo {
  if (cachedInfo) return cachedInfo

  const pkg = readPackagedMetadata()
  const envBuild = process.env.ONWARD_BUILD
  const envBranch = process.env.ONWARD_BRANCH
  const isPackaged = app.isPackaged

  const productName = (pkg?.productName as string) || app.getName() || 'Onward 2'
  const buildChannel = normalizeBuildChannel(pkg?.buildChannel ?? envBuild, isPackaged)
  const branch = normalizeBranch(pkg?.branch ?? envBranch)

  let displayName = productName
  if (buildChannel === 'dev' && branch && !displayName.includes(branch)) {
    displayName = `${displayName}-${branch}`
  }

  cachedInfo = {
    buildChannel,
    branch,
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

  if (app.getName() !== appInfo.displayName) {
    app.setName(appInfo.displayName)
  }

  if (appInfo.buildChannel === 'dev' && appInfo.isPackaged) {
    const userDataPath = getDevUserDataPath(appInfo.displayName)
    app.setPath('userData', userDataPath)
  }

  return appInfo
}
