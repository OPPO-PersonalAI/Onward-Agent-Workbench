#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { execSync, spawnSync, spawn } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function getBranchName() {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.toString().trim()
  } catch {
    return 'detached'
  }
}

function sanitizeBranchName(value) {
  let name = String(value || '').trim()
  if (!name || name === 'HEAD') {
    name = 'detached'
  }
  name = name.replace(/[^a-zA-Z0-9._-]+/g, '-')
  name = name.replace(/-+/g, '-')
  name = name.replace(/^-+|-+$/g, '')
  return name || 'branch'
}

function getPackageVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function isTruthyCi() {
  const ci = process.env.CI
  return ci === 'true' || ci === '1' || Boolean(process.env.GITHUB_ACTIONS)
}

/** Whether to open the packaged app after a successful dev build. */
function shouldOpenPackagedApp() {
  if (process.env.ONWARD_DIST_DEV_OPEN === '0') return false
  if (process.env.ONWARD_DIST_DEV_OPEN === '1') return true
  return !isTruthyCi()
}

/**
 * Resolve path to the unpacked packaged app (electron-builder --dir).
 * @param {string} productName
 * @returns {string | null}
 */
function getPackagedAppPath(productName) {
  const releaseRoot = join(__dirname, '..', 'release')
  // Match electron-builder's default output names; never launch a foreign target.
  const directories = {
    darwin: { x64: ['mac', 'mac-universal'], arm64: ['mac-arm64', 'mac-universal'] },
    win32: { x64: ['win-unpacked'], arm64: ['win-arm64-unpacked'], ia32: ['win-ia32-unpacked'] },
    linux: { x64: ['linux-unpacked'], arm64: ['linux-arm64-unpacked'], ia32: ['linux-ia32-unpacked'], arm: ['linux-armv7l-unpacked'] }
  }
  for (const directory of directories[process.platform]?.[process.arch] || []) {
    const name = process.platform === 'darwin' ? `${productName}.app`
      : process.platform === 'win32' ? `${productName}.exe` : productName
    const appPath = join(releaseRoot, directory, name)
    const binary = process.platform === 'darwin' ? join(appPath, 'Contents', 'MacOS', productName) : appPath
    if (existsSync(binary)) return appPath
  }
  return null
}

/**
 * Open the packaged app in a GUI session (non-blocking where supported).
 * @param {string} appPath
 */
function openPackagedApp(appPath) {
  if (process.platform === 'darwin') {
    spawnSync('open', [appPath], { stdio: 'inherit' })
    return
  }
  if (process.platform === 'win32') {
    // Launch the GUI exe detached. Do NOT route through `cmd /c start`: the
    // product name contains spaces ("Under Development <ver>-<branch>.exe"), so
    // `cmd /c start "" <unquoted path>` splits the path at the first space
    // ("...\Under"), which both fails to launch ("The system cannot find the file specified") AND leaves
    // the blocking spawnSync waiting — the build appears to hang. spawn() with
    // an args array passes the full path as a single argument (no shell, no
    // quoting), and detached + unref makes it fire-and-forget so the build
    // script returns immediately.
    const child = spawn(appPath, [], { detached: true, stdio: 'ignore' })
    child.unref()
    return
  }
  spawnSync('xdg-open', [appPath], { stdio: 'inherit' })
}

const branchRaw = getBranchName()
const branch = sanitizeBranchName(branchRaw)
const version = getPackageVersion()
const productName = `Under Development ${version}-${branch}`

run('node', [join(__dirname, 'check-chinese-comments.js')])
run('node', [join(__dirname, 'check-sensitive-info.js')])
run('node', [join(__dirname, 'compile-changelog.js')])
run('pnpm', ['typecheck'])
// Generate third-party license notices for binary distribution
run('pnpm', ['generate-notices'])
run('node', [join(__dirname, 'ensure-node-pty-spawn-helper.js')])
run('node', [join(__dirname, 'ensure-windows-process-tree.js')])
run('node', [join(__dirname, 'ensure-windows-updater.js')])
run('electron-vite', ['build'])
// On Windows with shell: true, arguments containing spaces must be quoted
const q = process.platform === 'win32' ? '"' : ''
run('electron-builder', [
  `${q}-c.productName=${productName}${q}`,
  `${q}-c.extraMetadata.productName=${productName}${q}`,
  '-c.extraMetadata.buildChannel=dev',
  `${q}-c.extraMetadata.branch=${branch}${q}`,
  '-c.npmRebuild=false',
  '--dir'
])

if (!shouldOpenPackagedApp()) {
  if (process.env.ONWARD_DIST_DEV_OPEN === '0') {
    console.log('[dist:dev] Skipping packaged app launch (ONWARD_DIST_DEV_OPEN=0)')
  } else {
    console.log('[dist:dev] Skipping packaged app launch (CI); set ONWARD_DIST_DEV_OPEN=1 to force')
  }
} else {
  const appPath = getPackagedAppPath(productName)
  if (appPath) {
    console.log(`[dist:dev] Opening packaged app: ${appPath}`)
    openPackagedApp(appPath)
  } else {
    console.warn('[dist:dev] Packaged app not found under release/; skip auto-launch')
  }
}
