/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { existsSync } = require('fs')
const { resolve } = require('path')
const { spawnSync } = require('child_process')

function resolveRipgrepPackageRoot() {
  const packageJsonPath = require.resolve('@vscode/ripgrep/package.json')
  return resolve(packageJsonPath, '..')
}

function ensureRipgrepBinary() {
  const packageRoot = resolveRipgrepPackageRoot()
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const binaryPath = resolve(packageRoot, 'bin', binaryName)

  if (existsSync(binaryPath)) {
    console.log(`[ripgrep] Binary already present: ${binaryPath}`)
    return
  }

  const installerPath = resolve(packageRoot, 'lib', 'postinstall.js')
  console.log(`[ripgrep] Downloading binary via ${installerPath}`)

  const result = spawnSync(process.execPath, [installerPath], {
    stdio: 'inherit',
    env: process.env
  })

  if (result.status !== 0 || !existsSync(binaryPath)) {
    throw new Error(`ripgrep binary is unavailable after postinstall: ${binaryPath}`)
  }

  console.log(`[ripgrep] Binary installed: ${binaryPath}`)
}

try {
  ensureRipgrepBinary()
} catch (error) {
  console.error('[ripgrep] Failed to prepare binary.')
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
