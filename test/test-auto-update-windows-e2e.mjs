#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Windows auto-update end-to-end test.
 *
 * Builds THREE release versions (old, A, B) and validates the full update
 * lifecycle with all verifications as hard assertions.
 *
 * Scenarios covered:
 *  S1. Version check + auto-download (daily channel)
 *  S2. Malformed pending-update marker is ignored and removed
 *  S3. Manifest switch: download A → switch manifest → download B (supersede)
 *  S4. Kill without restart → assert update NOT installed (safety)
 *  S5. Relaunch recovery: downloaded B recovered from disk, stale A cleaned up
 *  S6. Restart-to-update → new version launches, version confirmed
 *  S7. install.log written before relaunch, contains "installed successfully"
 *  S8. pending-update.json cleaned up after successful update
 *  S9. Downloaded installer cleaned up after installation
 *
 * Usage: node test/test-auto-update-windows-e2e.mjs
 */

import * as http from 'http'
import { createHash } from 'crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync
} from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import {
  assert,
  fetchJson,
  listUpdateFiles,
  postJson,
  sleep,
  spawnApp,
  stopChildProcess,
  terminateProcessByPid,
  waitFor,
  waitForHealthVersion,
  waitForLockFile,
  waitForUpdaterStatus
} from './auto-update-test-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const OLD_TAG = 'v2.1.0-daily.20260413.1'
const TAG_A = 'v2.1.0-daily.20260413.2'
const TAG_B = 'v2.1.0-daily.20260413.3'
const OLD_VERSION = OLD_TAG.slice(1)
const VERSION_A = TAG_A.slice(1)
const VERSION_B = TAG_B.slice(1)
const RELEASE_CHANNEL = 'daily'
const ARCH = 'x64'
const PLATFORM = 'windows'
const PRODUCT_NAME = 'Onward 2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function isPathInside(rootDir, filePath) {
  const normalizedRoot = resolve(rootDir)
  const normalizedFilePath = resolve(filePath)
  const rootForPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
  const compareRoot = process.platform === 'win32' ? rootForPrefix.toLowerCase() : rootForPrefix
  const compareFile = process.platform === 'win32' ? normalizedFilePath.toLowerCase() : normalizedFilePath
  const compareExactRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  return compareFile === compareExactRoot || compareFile.startsWith(compareRoot)
}

/**
 * Build a release version of the app.
 * Uses electron-vite + electron-builder directly (skips changelog/notices for speed).
 * Caches the output — if the directory already exists, the build is skipped.
 */
function buildVersion(tag, fixturesRoot, options = {}) {
  const version = tag.slice(1)
  const outputDir = join(fixturesRoot, tag)
  const installerArtifactName = `${PRODUCT_NAME}-${tag}-${PLATFORM}-${ARCH}.exe`
  const installerFileName = installerArtifactName.replace(/ /g, '.')
  const installerPath = join(fixturesRoot, installerFileName)
  const needsInstaller = options.installer === true
  if (existsSync(join(outputDir, `${PRODUCT_NAME}.exe`)) && (!needsInstaller || existsSync(installerPath))) {
    console.log(`  [build] Reusing cached build: ${outputDir}`)
    return { dir: outputDir, installerPath, installerFileName }
  }

  console.log(`  [build] Building ${tag} (this may take several minutes) ...`)

  // Clean previous build output
  rmSync(join(PROJECT_ROOT, 'out'), { recursive: true, force: true })
  rmSync(join(PROJECT_ROOT, 'release'), { recursive: true, force: true })

  // electron-vite build
  execSync('pnpm exec electron-vite build', {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
  })

  // electron-builder --dir with release metadata
  const q = '"'
  const artifactName = `${PRODUCT_NAME}-${tag}-${PLATFORM}-\${arch}.\${ext}`
  const builderArgs = [
    '-c.appId=com.onward2.autoupdate.e2e',
    `${q}-c.artifactName=${artifactName}${q}`,
    `${q}-c.extraMetadata.version=${version}${q}`,
    '-c.extraMetadata.buildChannel=prod',
    `${q}-c.extraMetadata.tag=${tag}${q}`,
    `-c.extraMetadata.releaseChannel=${RELEASE_CHANNEL}`,
    `-c.extraMetadata.releaseOs=${PLATFORM}`,
    '-c.npmRebuild=false',
    ...(needsInstaller ? [] : ['--dir'])
  ].join(' ')

  execSync(`pnpm exec electron-builder ${builderArgs}`, {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
  })

  mkdirSync(outputDir, { recursive: true })
  cpSync(join(PROJECT_ROOT, 'release', 'win-unpacked'), outputDir, { recursive: true })
  console.log(`  [build] Built ${tag} → ${outputDir}`)
  if (needsInstaller) {
    const builtInstallerPath = join(PROJECT_ROOT, 'release', installerArtifactName)
    assert(existsSync(builtInstallerPath), `Installer not found: ${builtInstallerPath}`)
    cpSync(builtInstallerPath, installerPath)
  }
  return { dir: outputDir, installerPath, installerFileName }
}

function makeRelease(tag, build) {
  return {
    tag,
    version: tag.slice(1),
    dir: build.dir,
    installerPath: build.installerPath,
    installerFileName: build.installerFileName
  }
}

function createManifest(release, port) {
  return {
    channel: RELEASE_CHANNEL,
    version: release.version,
    tag: release.tag,
    platform: PLATFORM,
    arch: ARCH,
    artifactName: release.installerFileName,
    artifactUrl: `http://127.0.0.1:${port}/downloads/${encodeURIComponent(release.installerFileName)}`,
    sha256: sha256File(release.installerPath),
    releaseNotes: `Test update to ${release.version}`,
    publishedAt: new Date().toISOString()
  }
}

function createStaticServer(rootDir) {
  const normalizedRoot = resolve(rootDir)
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    let decodedPath
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname)
    } catch {
      res.writeHead(400); res.end('Bad Request'); return
    }
    const relativePath = decodedPath.replace(/^\/+/, '')
    const filePath = resolve(normalizedRoot, relativePath)

    console.log(`  [HTTP] ${req.method} ${decodedPath}`)

    if (!isPathInside(normalizedRoot, filePath)) {
      res.writeHead(403); res.end('Forbidden'); return
    }
    if (!existsSync(filePath)) {
      res.writeHead(404); res.end('Not Found'); return
    }

    const content = readFileSync(filePath)
    const ct = filePath.endsWith('.json') ? 'application/json; charset=utf-8'
      : filePath.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': content.length })
    res.end(content)
  })

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('Server bind failed')
      return addr.port
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()))
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This test is designed for Windows only.')
  }

  console.log('=== Windows Auto-Update E2E Test ===\n')

  const testRoot = join(PROJECT_ROOT, 'test', 'e2e-update-test')
  const fixturesRoot = join(testRoot, 'fixtures')
  const runRoot = join(testRoot, 'run')
  const updateRoot = join(testRoot, 'update-root')
  const downloadsRoot = join(updateRoot, 'downloads')
  const manifestDir = join(updateRoot, 'updates', RELEASE_CHANNEL, PLATFORM, ARCH)
  const manifestPath = join(manifestDir, 'latest.json')
  const userDataDir = join(runRoot, 'user-data')
  const installLogPath = join(userDataDir, 'updates', 'install.log')
  const pendingMarkerPath = join(userDataDir, 'updates', 'pending-update.json')

  // Clean per-run state; preserve fixture cache
  rmSync(runRoot, { recursive: true, force: true })
  rmSync(updateRoot, { recursive: true, force: true })

  mkdirSync(fixturesRoot, { recursive: true })
  mkdirSync(downloadsRoot, { recursive: true })
  mkdirSync(manifestDir, { recursive: true })

  // ── Step 1: Build three versions ───────────────────────────────────────

  console.log('[Step 1] Building three app versions...')
  const buildB = buildVersion(TAG_B, fixturesRoot, { installer: true })
  rmSync(join(PROJECT_ROOT, 'out'), { recursive: true, force: true })
  rmSync(join(PROJECT_ROOT, 'release'), { recursive: true, force: true })
  const buildA = buildVersion(TAG_A, fixturesRoot, { installer: true })
  rmSync(join(PROJECT_ROOT, 'out'), { recursive: true, force: true })
  rmSync(join(PROJECT_ROOT, 'release'), { recursive: true, force: true })
  const buildOld = buildVersion(OLD_TAG, fixturesRoot)

  // Step 2: Prepare Windows installer artifacts.

  console.log('\n[Step 2] Preparing Windows installer artifacts...')
  const releaseA = makeRelease(TAG_A, buildA)
  const releaseB = makeRelease(TAG_B, buildB)

  cpSync(releaseA.installerPath, join(downloadsRoot, releaseA.installerFileName))
  cpSync(releaseB.installerPath, join(downloadsRoot, releaseB.installerFileName))

  // ── Step 3: Start HTTP server with manifest → A ────────────────────────

  console.log('\n[Step 3] Starting local HTTP server (manifest → A)...')
  const staticServer = createStaticServer(updateRoot)
  let appProcess = null
  let markerProcess = null
  let latestLockData = null

  let capturedInstallLog = ''

  try {
    const port = await staticServer.listen()
    const manifestA = createManifest(releaseA, port)
    writeFileSync(manifestPath, `${JSON.stringify(manifestA, null, 2)}\n`, 'utf-8')
    console.log(`  Server: http://127.0.0.1:${port}`)

    const launchEnv = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: userDataDir,
      ONWARD_UPDATE_BASE_URL: `http://127.0.0.1:${port}/updates`,
      ONWARD_UPDATE_CHECK_INTERVAL_MS: '2000'
    }

    // ── Step 4: Launch old version ────────────────────────────────────────

    console.log('\n[Step 4] Launching old version...')
    const installDir = join(runRoot, 'app')
    cpSync(buildOld.dir, installDir, { recursive: true })
    const execPath = join(installDir, `${PRODUCT_NAME}.exe`)
    assert(existsSync(execPath), `Executable not found: ${execPath}`)

    // ── Step 4a: Invalid marker must not trap startup ────────────────────

    console.log('\n[Step 4a] Verifying malformed pending-update marker is ignored...')
    const invalidMarkerUserDataDir = join(runRoot, 'invalid-marker-user-data')
    const invalidMarkerPath = join(invalidMarkerUserDataDir, 'updates', 'pending-update.json')
    mkdirSync(dirname(invalidMarkerPath), { recursive: true })
    writeFileSync(invalidMarkerPath, JSON.stringify({
      schemaVersion: 2,
      artifactPath: 'missing.exe'
    }), 'utf-8')

    markerProcess = spawnApp(execPath, {
      env: {
        ...launchEnv,
        ONWARD_USER_DATA_DIR: invalidMarkerUserDataDir
      }
    })
    const invalidMarkerLockData = await waitForLockFile(invalidMarkerUserDataDir, { timeoutMs: 60000 })
    await waitForHealthVersion(invalidMarkerLockData.port, OLD_VERSION, { timeoutMs: 15000 })
    assert(!existsSync(invalidMarkerPath), 'Malformed pending-update marker should be removed during startup')
    console.log(`  Malformed marker removed and app stayed launchable ✓`)
    await terminateProcessByPid(invalidMarkerLockData.pid, { stdio: 'pipe' }).catch(() => {})
    await Promise.race([
      markerProcess.waitForExit(),
      sleep(10000).then(() => { throw new Error('Invalid-marker smoke app did not exit within 10s after taskkill') })
    ])
    markerProcess = null

    appProcess = spawnApp(execPath, { env: launchEnv })
    latestLockData = await waitForLockFile(userDataDir, { timeoutMs: 60000 })
    console.log(`  App started (PID=${latestLockData.pid}, port=${latestLockData.port})`)

    // ── Step 5: Verify old version ────────────────────────────────────────

    console.log('\n[Step 5] Verifying current version...')
    const health = await waitForHealthVersion(latestLockData.port, OLD_VERSION, { timeoutMs: 15000 })
    console.log(`  Version: ${health.version} ✓`)

    // ── Step 6: Download A ────────────────────────────────────────────────

    console.log('\n[Step 6] Triggering update check (expecting A)...')
    await postJson(latestLockData.port, '/api/debug/updater/check')

    const downloadedA = await waitForUpdaterStatus(
      latestLockData.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_A,
      { timeoutMs: 300000, description: `downloaded ${VERSION_A}` }
    )
    console.log(`  Downloaded A: ${downloadedA.downloadedFileName} ✓`)

    const filesAfterA = listUpdateFiles(userDataDir)
    assert(filesAfterA.some((f) => f.endsWith('.exe')), 'Expected A installer on disk')
    assert(!filesAfterA.some((f) => f.includes(VERSION_B)), 'B must not be present before manifest switch')
    console.log(`  Only A on disk ✓`)

    // ── Step 7: Manifest switch → B ───────────────────────────────────────

    console.log('\n[Step 7] Switching manifest to B and waiting for re-check...')
    const manifestB = createManifest(releaseB, port)
    writeFileSync(manifestPath, `${JSON.stringify(manifestB, null, 2)}\n`, 'utf-8')

    const downloadedB = await waitForUpdaterStatus(
      latestLockData.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_B,
      { timeoutMs: 300000, description: `downloaded ${VERSION_B}` }
    )
    assert(downloadedB.targetTag === TAG_B, 'Expected downloaded tag to match B')
    console.log(`  Downloaded B: ${downloadedB.downloadedFileName} ✓`)

    // B installer must be on disk
    const filesAfterB = listUpdateFiles(userDataDir)
    assert(filesAfterB.some((f) => f.includes(VERSION_B) && f.endsWith('.exe')), 'Expected B installer on disk')
    // Note: A installer stays on disk until next startup cleanup (no runtime purge)
    console.log(`  B installer on disk ✓`)

    // Verify SHA-256 of B
    const bInstaller = filesAfterB.find((f) => f.includes(VERSION_B) && f.endsWith('.exe'))
    assert(bInstaller, 'B installer not found')
    assert(sha256File(bInstaller) === manifestB.sha256, 'SHA-256 mismatch for B')
    console.log(`  SHA-256 verified ✓`)

    // ── Step 8: Safety check — kill without restart ──────────────────────

    console.log('\n[Step 8] Safety check: terminate without restart...')
    const killExitPromise = appProcess.waitForExit()
    // taskkill /T /F may return non-zero when a child process already exited;
    // we rely on waitForExit to confirm the main process is actually gone.
    await terminateProcessByPid(latestLockData.pid, { stdio: 'pipe' }).catch(() => {})
    await Promise.race([
      killExitPromise,
      sleep(10000).then(() => { throw new Error('Process did not exit within 10s after taskkill') })
    ])
    assert(!existsSync(installLogPath), 'install.log must NOT exist after kill without restart')
    console.log(`  install.log absent ✓`)

    // ── Step 9: Relaunch + verify recovery ───────────────────────────────

    console.log('\n[Step 9] Relaunching old version...')
    appProcess = spawnApp(execPath, { env: launchEnv })
    latestLockData = await waitForLockFile(userDataDir, {
      previousStartedAt: latestLockData.startedAt,
      timeoutMs: 60000
    })
    console.log(`  Relaunched (PID=${latestLockData.pid}, port=${latestLockData.port})`)

    // B should be recovered from disk (newest candidate)
    const recovered = await waitForUpdaterStatus(
      latestLockData.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_B,
      { timeoutMs: 120000, description: `recovery of ${VERSION_B}` }
    )
    assert(recovered.targetVersion === VERSION_B, 'Expected B recovered')
    console.log(`  B recovered from disk ✓`)

    // Startup cleanup should have removed the stale A installer
    const filesAfterRelaunch = listUpdateFiles(userDataDir)
    assert(!filesAfterRelaunch.some((f) => f.includes(VERSION_A) && f.endsWith('.exe')),
      'Expected stale A installer to be cleaned up by startup recovery')
    console.log(`  Stale A installer cleaned up ✓`)

    // ── Step 10: Restart-to-update ──────────────────────────────────────

    console.log('\n[Step 10] Triggering restart-to-update...')
    const restartExitPromise = appProcess.waitForExit()
    const restartResult = await postJson(latestLockData.port, '/api/debug/updater/restart')
    assert(restartResult.success === true, `Restart failed: ${restartResult.error}`)
    console.log(`  Restart requested ✓`)

    const oldExit = await restartExitPromise
    console.log(`  Old process exited (code=${oldExit.code})`)

    // ── Step 11: Wait for new version ───────────────────────────────────

    console.log('\n[Step 11] Waiting for new version to launch...')
    capturedInstallLog = ''
    const newLockData = await waitFor(
      () => {
        // Capture install.log while waiting (before new version clears it)
        if (existsSync(installLogPath)) {
          try {
            const content = readFileSync(installLogPath, 'utf-8').trim()
            if (content.length > capturedInstallLog.length) {
              capturedInstallLog = content
            }
          } catch { /* briefly locked */ }
        }
        const lockFile = join(userDataDir, 'onward-api.lock')
        if (!existsSync(lockFile)) return null
        try {
          const data = JSON.parse(readFileSync(lockFile, 'utf-8'))
          return Number(data.startedAt || 0) > latestLockData.startedAt ? data : null
        } catch { return null }
      },
      { timeoutMs: 180000, intervalMs: 500, description: 'new version lock file' }
    )
    console.log(`  New process detected (PID=${newLockData.pid}, port=${newLockData.port})`)

    // ── Step 12: Verify new version ─────────────────────────────────────

    console.log('\n[Step 12] Verifying new version...')
    const newHealth = await waitForHealthVersion(newLockData.port, VERSION_B, { timeoutMs: 30000 })
    assert(newHealth.version === VERSION_B, `Expected ${VERSION_B}, got ${newHealth.version}`)
    console.log(`  Version: ${newHealth.version} ✓`)

    // install.log must indicate success
    assert(capturedInstallLog.includes('installed successfully'),
      `install.log does not indicate success:\n${capturedInstallLog}`)
    console.log(`  install.log confirms success ✓`)

    // pending-update.json must be cleaned up
    assert(!existsSync(pendingMarkerPath), 'pending-update.json must be removed after successful update')
    console.log(`  pending-update.json cleaned up ✓`)

    // Downloaded installers must be cleaned up
    const finalFiles = listUpdateFiles(userDataDir)
    assert(!finalFiles.some((f) => f.endsWith('.exe')),
      `Expected all installers cleaned up, found: ${finalFiles.filter(f => f.endsWith('.exe')).join(', ')}`)
    console.log(`  Downloaded installers cleaned up ✓`)

    // ── Cleanup ─────────────────────────────────────────────────────────

    console.log('\n[Cleanup] Terminating new version...')
    await terminateProcessByPid(newLockData.pid, { stdio: 'pipe' }).catch(() => {})
    await waitFor(async () => {
      try { await fetchJson(`http://127.0.0.1:${newLockData.port}/api/health`); return null }
      catch { return true }
    }, { timeoutMs: 15000, intervalMs: 500, description: 'new app shutdown' }).catch(() => {})

    // ── Summary ─────────────────────────────────────────────────────────

    console.log('\n=== Test Results ===')
    console.log(`  ✓ S1: Old version launched and reported ${OLD_VERSION}`)
    console.log(`  ✓ S2: Malformed pending-update marker is removed without blocking startup`)
    console.log(`  ✓ S3: Update check found A (${VERSION_A}) and downloaded it`)
    console.log(`  ✓ S4: Manifest switch to B (${VERSION_B}), superseded A`)
    console.log(`  ✓ S5: SHA-256 of B verified`)
    console.log(`  ✓ S6: Kill without restart did NOT trigger install`)
    console.log(`  ✓ S7: Relaunch recovered B from disk, stale A cleaned up`)
    console.log(`  ✓ S8: Restart-to-update applied B successfully`)
    console.log(`  ✓ S9: New version (${VERSION_B}) launched and confirmed`)
    console.log(`  ✓ S10: install.log indicates success`)
    console.log(`  ✓ S11: pending-update.json cleaned up`)
    console.log(`  ✓ S12: All downloaded installers cleaned up`)
    console.log('\n=== PASS ===')

  } catch (error) {
    console.error(`\n=== FAIL ===`)
    console.error(`  ${error.message}`)
    if (existsSync(installLogPath)) {
      console.error(`\n--- install.log ---\n${readFileSync(installLogPath, 'utf-8')}\n--- end ---`)
    }
    if (capturedInstallLog) {
      console.error(`\n--- captured install.log (during wait) ---\n${capturedInstallLog}\n--- end ---`)
    }
    if (latestLockData?.port) {
      try {
        const s = await fetchJson(`http://127.0.0.1:${latestLockData.port}/api/debug/updater/status`)
        console.error(`\n--- updater status ---\n${JSON.stringify(s, null, 2)}\n--- end ---`)
      } catch { /* unreachable */ }
    }
    process.exitCode = 1
  } finally {
    if (markerProcess?.child) await stopChildProcess(markerProcess.child).catch(() => {})
    if (appProcess?.child) await stopChildProcess(appProcess.child).catch(() => {})
    await staticServer.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
