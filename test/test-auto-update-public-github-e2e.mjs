/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  assert,
  fetchJson,
  postJson,
  readPlistVersion,
  runShellCommand,
  shellEscape,
  spawnApp,
  stopChildProcess,
  terminateProcessByPid,
  waitFor,
  waitForHealthVersion,
  waitForLockFile,
  waitForUpdaterStatus
} from './auto-update-test-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const productName = 'Onward 2'
const releaseArch = 'arm64'

function parseArgs(argv) {
  const args = {
    oldTag: '',
    targetVersion: ''
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--old-tag') {
      args.oldTag = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--target-version') {
      args.targetVersion = argv[index + 1] || ''
      index += 1
      continue
    }
  }

  if (!args.oldTag || !args.targetVersion) {
    throw new Error('Usage: node test/test-auto-update-public-github-e2e.mjs --old-tag <tag> --target-version <version>')
  }

  return args
}

async function buildOldFixture(tag, outputRoot) {
  console.log(`[public-github-e2e] Building local old fixture ${tag}`)
  await runShellCommand(
    `rm -rf out release && ONWARD_TAG=${shellEscape(tag)} ONWARD_RELEASE_OS=macos pnpm dist:release`,
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )

  const sourceAppPath = join(repoRoot, 'release', `mac-${releaseArch}`, `${productName}.app`)
  const outputAppPath = join(outputRoot, `${productName}.app`)

  rmSync(outputAppPath, { recursive: true, force: true })
  await runShellCommand(
    `ditto ${shellEscape(sourceAppPath)} ${shellEscape(outputAppPath)}`,
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )

  return {
    appPath: outputAppPath,
    executablePath: join(outputAppPath, 'Contents', 'MacOS', productName),
    plistPath: join(outputAppPath, 'Contents', 'Info.plist'),
    version: tag.slice(1)
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Public GitHub updater E2E currently supports macOS only.')
  }

  const args = parseArgs(process.argv.slice(2))
  const tempRoot = mkdtempSync(join(tmpdir(), 'onward-auto-update-public-'))
  const fixtureRoot = join(tempRoot, 'fixture')
  const userDataDir = join(tempRoot, 'user-data')
  const installLogPath = join(userDataDir, 'updates', 'install.log')

  const oldRelease = await buildOldFixture(args.oldTag, fixtureRoot)

  let appProcess = null
  let latestLockData = null

  try {
    const launchEnv = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: userDataDir,
      ONWARD_UPDATE_CHECK_INTERVAL_MS: '1000'
    }

    console.log('[public-github-e2e] Launching old app against public GitHub update source')
    appProcess = spawnApp(oldRelease.executablePath, {
      cwd: dirname(oldRelease.executablePath),
      env: launchEnv
    })

    latestLockData = await waitForLockFile(userDataDir, {
      timeoutMs: 60000
    })

    const downloadedStatus = await waitForUpdaterStatus(
      latestLockData.port,
      (status) => status.phase === 'downloaded' && status.targetVersion === args.targetVersion,
      {
        timeoutMs: 300000,
        intervalMs: 2000,
        description: `downloaded GitHub update ${args.targetVersion}`
      }
    )

    assert(downloadedStatus.targetVersion === args.targetVersion, 'Expected downloaded target version to match the public GitHub release.')

    console.log('[public-github-e2e] Verifying process termination still does not install')
    const firstExitPromise = appProcess.waitForExit()
    await terminateProcessByPid(latestLockData.pid)
    await firstExitPromise
    assert(!existsSync(installLogPath), 'Install log must not exist after process termination without restart request.')

    const versionAfterQuit = await readPlistVersion(oldRelease.plistPath)
    assert(versionAfterQuit === oldRelease.version, `Expected old bundle version ${oldRelease.version}, got ${versionAfterQuit}`)

    console.log('[public-github-e2e] Relaunching old app and installing public GitHub update')
    appProcess = spawnApp(oldRelease.executablePath, {
      cwd: dirname(oldRelease.executablePath),
      env: launchEnv
    })

    latestLockData = await waitForLockFile(userDataDir, {
      previousStartedAt: latestLockData.startedAt,
      timeoutMs: 60000
    })

    await waitForUpdaterStatus(
      latestLockData.port,
      (status) => status.phase === 'downloaded' && status.targetVersion === args.targetVersion,
      {
        timeoutMs: 300000,
        intervalMs: 2000,
        description: `redownloaded GitHub update ${args.targetVersion}`
      }
    )

    const restartExitPromise = appProcess.waitForExit()
    const restartResult = await postJson(latestLockData.port, '/api/debug/updater/restart')
    assert(restartResult.success === true, 'Expected restart-to-update request to succeed.')
    await restartExitPromise

    latestLockData = await waitForLockFile(userDataDir, {
      previousStartedAt: latestLockData.startedAt,
      timeoutMs: 180000
    })

    const updatedHealth = await waitForHealthVersion(latestLockData.port, args.targetVersion, {
      timeoutMs: 180000,
      intervalMs: 2000
    })
    assert(updatedHealth.version === args.targetVersion, 'Expected relaunched app to report the public GitHub target version.')
    assert(existsSync(installLogPath), 'Expected helper install log after explicit restart-to-update.')

    const updatedBundleVersion = await readPlistVersion(oldRelease.plistPath)
    assert(updatedBundleVersion === args.targetVersion, `Expected installed bundle version ${args.targetVersion}, got ${updatedBundleVersion}`)

    console.log('[public-github-e2e] Cleaning up relaunched app')
    await terminateProcessByPid(latestLockData.pid)
    await waitFor(async () => {
      try {
        await fetchJson(`http://127.0.0.1:${latestLockData.port}/api/health`)
        return null
      } catch {
        return true
      }
    }, {
      timeoutMs: 30000,
      intervalMs: 500,
      description: 'public GitHub relaunched app shutdown'
    })

    console.log('[public-github-e2e] Passed')
  } finally {
    if (appProcess?.child) {
      await stopChildProcess(appProcess.child).catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error(`[public-github-e2e] Failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
