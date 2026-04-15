/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  assert,
  fetchJson,
  postJson,
  spawnApp,
  terminateProcessByPid,
  waitFor,
  waitForHealthVersion,
  waitForLockFile,
  waitForUpdaterStatus
} from './auto-update-test-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const defaultLocalTag = 'v2.1.0-daily.20260414.1'
const defaultTargetVersion = '2.1.0-daily.20260415.1'
const productName = 'Onward 2'
const releaseChannel = 'daily'
const releaseOs = 'windows'
const arch = 'x64'
const publicManifestUrl = `https://raw.githubusercontent.com/OPPO-PersonalAI/Onward/gh-pages/updates/${releaseChannel}/${releaseOs}/${arch}/latest.json`

function parseArgs(argv) {
  const args = {
    localTag: process.env.ONWARD_PUBLIC_GITHUB_TEST_LOCAL_TAG || defaultLocalTag,
    targetVersion: process.env.ONWARD_PUBLIC_GITHUB_TEST_TARGET_VERSION || defaultTargetVersion,
    installerPath: '',
    installDir: join(process.env.LOCALAPPDATA || '', 'Programs', 'onward2'),
    keepRunning: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--local-tag') {
      args.localTag = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--target-version') {
      args.targetVersion = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--installer') {
      args.installerPath = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--install-dir') {
      args.installDir = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--keep-running') {
      args.keepRunning = true
    }
  }

  if (!args.localTag || !args.targetVersion || !args.installDir) {
    throw new Error('Usage: node test/test-auto-update-public-github-windows-installer.mjs [--local-tag <tag>] [--target-version <version>] [--installer <path>] [--install-dir <path>] [--keep-running]')
  }

  if (!args.installerPath) {
    args.installerPath = join(repoRoot, 'release', `${productName}-${args.localTag}-${releaseOs}-${arch}.exe`)
  }

  return args
}

function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function getExactProcessIdsByExecutable(executablePath) {
  const processName = basename(executablePath)
  const escapedProcessName = processName.replace(/'/g, "''")
  const script = [
    `$target = ${powershellSingleQuote(resolve(executablePath))}`,
    `$items = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '${escapedProcessName}'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -ExpandProperty ProcessId)`,
    '$items | ConvertTo-Json'
  ].join('; ')
  const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf-8'
  }).trim()
  if (!output) return []
  const parsed = JSON.parse(output)
  return Array.isArray(parsed) ? parsed.map(Number) : [Number(parsed)]
}

async function terminateInstalledAppIfRunning(executablePath) {
  const pids = getExactProcessIdsByExecutable(executablePath).filter((pid) => Number.isInteger(pid) && pid > 0)
  for (const pid of pids) {
    console.log(`[public-github-windows] Terminating running installed app PID=${pid}`)
    await terminateProcessByPid(pid, { stdio: 'pipe' }).catch(() => {})
  }
}

function runInstaller(installerPath, installDir) {
  assert(existsSync(installerPath), `Installer not found: ${installerPath}`)
  mkdirSync(installDir, { recursive: true })
  console.log(`[public-github-windows] Installing ${installerPath}`)
  execFileSync(installerPath, ['/S', `/D=${installDir}`], {
    cwd: dirname(installerPath),
    stdio: 'inherit'
  })
}

async function fetchPublicManifest() {
  const response = await fetch(publicManifestUrl, {
    headers: {
      Accept: 'application/json'
    }
  })
  if (!response.ok) {
    throw new Error(`Public manifest request failed: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

function getDownloadedFilePath(userDataDir, status) {
  if (!status.targetVersion || !status.downloadedFileName) return null
  return join(userDataDir, 'updates', status.targetVersion, status.downloadedFileName)
}

async function waitForPublicUpdateDownload(port, userDataDir, targetVersion) {
  let lastProgressAt = 0
  return waitForUpdaterStatus(
    port,
    (status) => {
      const filePath = getDownloadedFilePath(userDataDir, status)
      const size = filePath && existsSync(filePath) ? statSync(filePath).size : 0
      if (Date.now() - lastProgressAt >= 10000) {
        lastProgressAt = Date.now()
        console.log(
          `[public-github-windows] update status: phase=${status.phase} target=${status.targetVersion || 'n/a'} file=${status.downloadedFileName || 'n/a'} size=${size}`
        )
      }
      return status.phase === 'downloaded' && status.targetVersion === targetVersion ? status : null
    },
    {
      timeoutMs: 1200000,
      intervalMs: 2000,
      description: `public GitHub update ${targetVersion} download`
    }
  )
}

async function waitForInstallLogSuccess(installLogPath, timeoutMs) {
  let captured = ''
  await waitFor(() => {
    if (!existsSync(installLogPath)) return null
    captured = readFileSync(installLogPath, 'utf-8')
    return captured.includes('Update installed successfully.') || captured.includes('Update installed successfully') ? true : null
  }, {
    timeoutMs,
    intervalMs: 500,
    description: 'install log success marker'
  }).catch(() => {})
  return captured
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This test is designed for Windows only.')
  }

  const args = parseArgs(process.argv.slice(2))
  const localVersion = args.localTag.startsWith('v') ? args.localTag.slice(1) : args.localTag
  const installDir = resolve(args.installDir)
  const executablePath = join(installDir, `${productName}.exe`)
  const tempRoot = mkdtempSync(join(tmpdir(), 'onward-public-github-windows-'))
  const userDataDir = join(tempRoot, 'user-data')
  const installLogPath = join(userDataDir, 'updates', 'install.log')
  let appProcess = null
  let latestLockData = null
  let finalPid = null

  try {
    const manifest = await fetchPublicManifest()
    assert(manifest.version === args.targetVersion, `Expected public manifest version ${args.targetVersion}, got ${manifest.version}`)
    assert(manifest.platform === releaseOs, `Expected public manifest platform ${releaseOs}, got ${manifest.platform}`)
    assert(manifest.arch === arch, `Expected public manifest arch ${arch}, got ${manifest.arch}`)
    console.log(`[public-github-windows] Public manifest target: ${manifest.version} (${manifest.artifactName})`)

    await terminateInstalledAppIfRunning(executablePath)
    runInstaller(resolve(args.installerPath), installDir)
    assert(existsSync(executablePath), `Installed executable not found: ${executablePath}`)

    const launchEnv = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: userDataDir,
      ONWARD_UPDATE_CHECK_INTERVAL_MS: '1000'
    }

    console.log(`[public-github-windows] Launching installed local version from ${executablePath}`)
    appProcess = spawnApp(executablePath, {
      cwd: installDir,
      env: launchEnv
    })
    latestLockData = await waitForLockFile(userDataDir, { timeoutMs: 60000 })

    const oldHealth = await waitForHealthVersion(latestLockData.port, localVersion, {
      timeoutMs: 60000,
      intervalMs: 1000
    })
    assert(oldHealth.version === localVersion, `Expected local installed version ${localVersion}, got ${oldHealth.version}`)
    console.log(`[public-github-windows] Local version confirmed: ${oldHealth.version}`)

    const downloadedStatus = await waitForPublicUpdateDownload(latestLockData.port, userDataDir, args.targetVersion)
    assert(downloadedStatus.targetVersion === args.targetVersion, `Expected downloaded target ${args.targetVersion}`)
    assert(String(downloadedStatus.downloadedFileName || '').endsWith('.exe'), `Expected Windows installer download, got ${downloadedStatus.downloadedFileName}`)
    console.log(`[public-github-windows] Downloaded public GitHub installer: ${downloadedStatus.downloadedFileName}`)

    const previousStartedAt = latestLockData.startedAt
    const restartExitPromise = appProcess.waitForExit()
    const restartResult = await postJson(latestLockData.port, '/api/debug/updater/restart')
    assert(restartResult.success === true, `Restart-to-update failed: ${restartResult.error || 'unknown error'}`)
    console.log('[public-github-windows] Restart-to-update requested')
    await restartExitPromise

    const installLogPromise = waitForInstallLogSuccess(installLogPath, 180000)
    latestLockData = await waitForLockFile(userDataDir, {
      previousStartedAt,
      timeoutMs: 240000
    })
    finalPid = latestLockData.pid
    const updatedHealth = await waitForHealthVersion(latestLockData.port, args.targetVersion, {
      timeoutMs: 120000,
      intervalMs: 1000
    })
    assert(updatedHealth.version === args.targetVersion, `Expected updated version ${args.targetVersion}, got ${updatedHealth.version}`)
    const capturedInstallLog = await installLogPromise
    if (capturedInstallLog) {
      assert(capturedInstallLog.includes('Update installed successfully'), 'Expected install log to include success marker.')
    }

    console.log(`[public-github-windows] Updated version confirmed: ${updatedHealth.version}`)
    console.log(`[public-github-windows] PASS installDir=${installDir} pid=${finalPid} userData=${userDataDir}`)

    if (!args.keepRunning && finalPid) {
      await terminateProcessByPid(finalPid, { stdio: 'pipe' }).catch(() => {})
      finalPid = null
    }
  } finally {
    if (!args.keepRunning) {
      if (latestLockData?.pid) {
        await terminateProcessByPid(latestLockData.pid, { stdio: 'pipe' }).catch(() => {})
      } else if (appProcess?.child) {
        await terminateProcessByPid(appProcess.child.pid, { stdio: 'pipe' }).catch(() => {})
      }
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(`[public-github-windows] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
