/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'http'
import { createHash } from 'crypto'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  assert,
  fetchJson,
  listUpdateFiles,
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
const releaseOs = 'macos'
const releaseArch = 'arm64'

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function buildFixture(tag, rootDir) {
  console.log(`[local-e2e] Building fixture ${tag}`)
  await runShellCommand(
    `rm -rf out release && ONWARD_TAG=${shellEscape(tag)} ONWARD_RELEASE_OS=${shellEscape(releaseOs)} pnpm dist:release`,
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )

  const outputDir = join(rootDir, tag)
  mkdirSync(outputDir, { recursive: true })

  const appSourcePath = join(repoRoot, 'release', `mac-${releaseArch}`, `${productName}.app`)
  const appTargetPath = join(outputDir, `${productName}.app`)
  const zipFileName = `${productName}-${tag}-${releaseOs}-${releaseArch}.zip`
  const zipSourcePath = join(repoRoot, 'release', zipFileName)
  const zipTargetPath = join(outputDir, zipFileName)

  rmSync(appTargetPath, { recursive: true, force: true })
  await runShellCommand(
    `ditto ${shellEscape(appSourcePath)} ${shellEscape(appTargetPath)}`,
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )
  cpSync(zipSourcePath, zipTargetPath)

  return {
    tag,
    version: tag.slice(1),
    appPath: appTargetPath,
    executablePath: join(appTargetPath, 'Contents', 'MacOS', productName),
    plistPath: join(appTargetPath, 'Contents', 'Info.plist'),
    zipPath: zipTargetPath,
    zipFileName
  }
}

function createManifest(release, port) {
  return {
    channel: 'daily',
    version: release.version,
    tag: release.tag,
    platform: releaseOs,
    arch: releaseArch,
    artifactName: release.zipFileName,
    artifactUrl: `http://127.0.0.1:${port}/downloads/${encodeURIComponent(release.zipFileName)}`,
    sha256: sha256File(release.zipPath),
    releaseNotes: null,
    publishedAt: new Date().toISOString()
  }
}

function createStaticServer(rootDir) {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    const decodedPath = decodeURIComponent(requestUrl.pathname)
    const relativePath = decodedPath.replace(/^\/+/, '')
    const filePath = join(rootDir, relativePath)

    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    const content = readFileSync(filePath)
    const contentType = filePath.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : filePath.endsWith('.zip')
        ? 'application/zip'
        : 'application/octet-stream'

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length
    })
    res.end(content)
  })

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve local update server address.')
      }
      return address.port
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Local auto-update E2E currently supports macOS only.')
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'onward-auto-update-local-'))
  const fixturesRoot = join(tempRoot, 'fixtures')
  const updateRoot = join(tempRoot, 'update-root')
  const downloadsRoot = join(updateRoot, 'downloads')
  const manifestPath = join(updateRoot, 'updates', 'daily', releaseOs, releaseArch, 'latest.json')
  const userDataDir = join(tempRoot, 'user-data')
  const installLogPath = join(userDataDir, 'updates', 'install.log')

  mkdirSync(fixturesRoot, { recursive: true })
  mkdirSync(downloadsRoot, { recursive: true })
  mkdirSync(dirname(manifestPath), { recursive: true })

  const oldRelease = await buildFixture('v2.1.0-daily.20260402.101', fixturesRoot)
  const latestReleaseA = await buildFixture('v2.1.0-daily.20260402.102', fixturesRoot)
  const latestReleaseB = await buildFixture('v2.1.0-daily.20260402.103', fixturesRoot)

  cpSync(latestReleaseA.zipPath, join(downloadsRoot, latestReleaseA.zipFileName))
  cpSync(latestReleaseB.zipPath, join(downloadsRoot, latestReleaseB.zipFileName))

  const staticServer = createStaticServer(updateRoot)
  let appProcess = null
  let latestLockData = null

  try {
    const port = await staticServer.listen()
    writeFileSync(manifestPath, `${JSON.stringify(createManifest(latestReleaseA, port), null, 2)}\n`, 'utf-8')

    const launchEnv = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: userDataDir,
      ONWARD_UPDATE_BASE_URL: `http://127.0.0.1:${port}/updates`,
      ONWARD_UPDATE_CHECK_INTERVAL_MS: '1000'
    }

    console.log('[local-e2e] Launching old packaged app')
    appProcess = spawnApp(oldRelease.executablePath, {
      cwd: dirname(oldRelease.executablePath),
      env: launchEnv
    })

    latestLockData = await waitForLockFile(userDataDir, {
      timeoutMs: 60000
    })

    const downloadedA = await waitForUpdaterStatus(
      latestLockData.port,
      (status) => status.phase === 'downloaded' && status.targetVersion === latestReleaseA.version,
      {
        timeoutMs: 120000,
        description: `downloaded status for ${latestReleaseA.version}`
      }
    )

    assert(downloadedA.targetTag === latestReleaseA.tag, 'Expected first downloaded tag to match release A.')
    const filesAfterA = listUpdateFiles(userDataDir)
    assert(filesAfterA.some((file) => file.endsWith(latestReleaseA.zipFileName)), 'Expected release A archive to be cached.')
    assert(!filesAfterA.some((file) => file.endsWith(latestReleaseB.zipFileName)), 'Did not expect release B archive before manifest switch.')

    console.log('[local-e2e] Switching manifest to a newer release and waiting for automatic re-check')
    writeFileSync(manifestPath, `${JSON.stringify(createManifest(latestReleaseB, port), null, 2)}\n`, 'utf-8')

    const downloadedB = await waitForUpdaterStatus(
      latestLockData.port,
      (status) => status.phase === 'downloaded' && status.targetVersion === latestReleaseB.version,
      {
        timeoutMs: 120000,
        description: `downloaded status for ${latestReleaseB.version}`
      }
    )

    assert(downloadedB.targetTag === latestReleaseB.tag, 'Expected downloaded tag to switch to release B.')
    const filesAfterB = listUpdateFiles(userDataDir)
    assert(filesAfterB.some((file) => file.endsWith(latestReleaseB.zipFileName)), 'Expected release B archive to be cached.')
    assert(!filesAfterB.some((file) => file.endsWith(latestReleaseA.zipFileName)), 'Expected release A archive to be cleaned up after release B download.')

    console.log('[local-e2e] Verifying process termination does not install the update')
    const firstExitPromise = appProcess.waitForExit()
    await terminateProcessByPid(latestLockData.pid)
    const firstExit = await firstExitPromise
    assert(firstExit.code !== null || firstExit.signal !== null, 'Expected old app process to terminate.')

    assert(!existsSync(installLogPath), 'Install log must not exist after process termination without restart request.')
    const versionAfterQuit = await readPlistVersion(oldRelease.plistPath)
    assert(versionAfterQuit === oldRelease.version, `Expected app bundle to remain at ${oldRelease.version}, got ${versionAfterQuit}`)

    console.log('[local-e2e] Relaunching old app and triggering explicit restart-to-update')
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
      (status) => status.phase === 'downloaded' && status.targetVersion === latestReleaseB.version,
      {
        timeoutMs: 120000,
        description: `redownloaded status for ${latestReleaseB.version}`
      }
    )

    const restartExitPromise = appProcess.waitForExit()
    const restartResult = await postJson(latestLockData.port, '/api/debug/updater/restart')
    assert(restartResult.success === true, 'Expected restart-to-update request to succeed.')
    await restartExitPromise

    latestLockData = await waitForLockFile(userDataDir, {
      previousStartedAt: latestLockData.startedAt,
      timeoutMs: 120000
    })

    const updatedHealth = await waitForHealthVersion(latestLockData.port, latestReleaseB.version, {
      timeoutMs: 120000
    })
    assert(updatedHealth.version === latestReleaseB.version, 'Expected relaunched app to report the newest version.')
    assert(existsSync(installLogPath), 'Expected install log to exist after explicit restart-to-update.')

    const updatedBundleVersion = await readPlistVersion(oldRelease.plistPath)
    assert(updatedBundleVersion === latestReleaseB.version, `Expected replaced app bundle version ${latestReleaseB.version}, got ${updatedBundleVersion}`)

    const finalUpdateFiles = listUpdateFiles(userDataDir)
    assert(!finalUpdateFiles.some((file) => file.endsWith(latestReleaseA.zipFileName)), 'Expected stale release A archive to stay deleted.')
    assert(!finalUpdateFiles.some((file) => file.endsWith(latestReleaseB.zipFileName)), 'Expected downloaded archive to be removed after installation.')

    console.log('[local-e2e] Cleaning up relaunched app')
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
      description: 'relaunch app shutdown'
    })

    console.log('[local-e2e] Passed')
  } finally {
    if (appProcess?.child) {
      await stopChildProcess(appProcess.child).catch(() => {})
    }
    await staticServer.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`[local-e2e] Failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
