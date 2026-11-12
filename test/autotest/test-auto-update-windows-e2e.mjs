#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Windows seamless auto-update end-to-end test (VS Code background-staging architecture).
 *
 * Builds THREE release versions (OLD, A, B) and validates the full update
 * lifecycle against a local simulated GitHub Releases + gh-pages + CDN server:
 *
 *  S1. Malformed pending-update markers (legacy v2 & broken v3) are ignored and removed
 *  S2. Version check + auto-download via 302 CDN redirect + 206 Range resume + background "_" staging
 *  S3. Manifest switch: stage A -> switch manifest -> stage B (in-place "_" supersede)
 *  S4. Forced taskkill without graceful quit -> update NOT installed; relaunch recovers B from "_"
 *  S5. File-lock fault injection during Restart-to-Update -> atomic rollback to OLD, "_" preserved,
 *      error surfaced in updater status, subsequent retry succeeds without re-downloading
 *  S6. Restart-to-Update swaps "_" via GUI onward-updater.exe, preserves Uninstall*.exe,
 *      cleans "_", "_old", pending-update.json, and cached .zip, and boots into VERSION_B
 *  S7. Normal graceful quit (POST /api/debug/app/quit without clicking Restart) silently applies
 *      staged update with relaunch=false; next manual launch boots directly into VERSION_A
 *
 * Usage: node test/autotest/test-auto-update-windows-e2e.mjs
 */

import { execSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import {
  createMockGitHubUpdateServer,
  createZipFromUnpackedDir,
  publishMockReleaseManifest
} from './mock-github-update-server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')

const OLD_TAG = 'v2.1.0-daily.20261112.1'
const TAG_A = 'v2.1.0-daily.20261112.2'
const TAG_B = 'v2.1.0-daily.20261112.3'
const OLD_VERSION = OLD_TAG.slice(1)
const VERSION_A = TAG_A.slice(1)
const VERSION_B = TAG_B.slice(1)
const RELEASE_CHANNEL = 'daily'
const PLATFORM = 'windows'
const PRODUCT_NAME = 'Onward 2'

function computeUpdaterSourceFingerprint() {
  const hash = createHash('sha256')
  const watchedFiles = [
    'electron.vite.config.ts',
    'resources/updater/win32/OnwardUpdater.cs',
    'scripts/ensure-windows-updater.js',
    'scripts/generate-update-manifest.js',
    'electron/main/raw-fs.ts',
    'electron/main/update-manifest-utils.ts',
    'electron/main/windows-zip-extract.ts',
    'electron/main/windows-update-stage-worker-entry.ts',
    'electron/main/windows-update-staging.ts',
    'electron/main/update-service.ts',
    'electron/main/index.ts',
    'electron/main/api-server.ts'
  ]
  for (const rel of watchedFiles) {
    const abs = join(PROJECT_ROOT, rel)
    if (existsSync(abs)) {
      hash.update(rel)
      hash.update(readFileSync(abs))
    }
  }
  return hash.digest('hex').slice(0, 16)
}

function ensureUpdaterHelperBuilt() {
  execSync('node scripts/ensure-windows-updater.js', {
    cwd: PROJECT_ROOT,
    stdio: 'pipe'
  })
}

let viteBuiltThisRun = false

function ensureElectronViteBundle() {
  if (viteBuiltThisRun && existsSync(join(PROJECT_ROOT, 'out', 'main', 'index.js'))) {
    return
  }
  console.log('  [build] Compiling electron-vite bundle...')
  rmSync(join(PROJECT_ROOT, 'out'), { recursive: true, force: true })
  ensureUpdaterHelperBuilt()
  execSync('pnpm exec electron-vite build', {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
  })
  viteBuiltThisRun = true
}

async function buildUnpackedAndZip(tag, fixturesRoot, options = {}) {
  const version = tag.slice(1)
  const channel = options.channel || RELEASE_CHANNEL
  const outputDir = join(fixturesRoot, tag)
  const zipFileName = `${PRODUCT_NAME}-${version}-${PLATFORM}-x64.zip`.replace(/ /g, '.')
  const zipPath = join(fixturesRoot, zipFileName)
  const needZip = options.zip === true

  if (existsSync(join(outputDir, `${PRODUCT_NAME}.exe`)) && (!needZip || existsSync(zipPath))) {
    console.log(`  [build] Reusing cached build: ${tag}`)
    return { dir: outputDir, zipPath, zipFileName }
  }

  ensureElectronViteBundle()
  console.log(`  [build] Packaging ${tag} (--dir) ...`)
  rmSync(join(PROJECT_ROOT, 'release'), { recursive: true, force: true })
  rmSync(outputDir, { recursive: true, force: true })

  const q = '"'
  const artifactName = `${PRODUCT_NAME}-${tag}-${PLATFORM}-\${arch}.\${ext}`
  const builderArgs = [
    '--dir',
    '-c.appId=com.onward2.autoupdate.e2e',
    `${q}-c.artifactName=${artifactName}${q}`,
    `${q}-c.extraMetadata.version=${version}${q}`,
    '-c.extraMetadata.buildChannel=prod',
    `${q}-c.extraMetadata.tag=${tag}${q}`,
    `-c.extraMetadata.releaseChannel=${channel}`,
    `-c.extraMetadata.releaseOs=${PLATFORM}`,
    '-c.npmRebuild=false'
  ].join(' ')

  execSync(`pnpm exec electron-builder ${builderArgs}`, {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
  })

  mkdirSync(outputDir, { recursive: true })
  cpSync(join(PROJECT_ROOT, 'release', 'win-unpacked'), outputDir, { recursive: true })

  if (needZip) {
    rmSync(zipPath, { force: true })
    console.log(`  [build] Compressing ${zipFileName} ...`)
    await createZipFromUnpackedDir(outputDir, zipPath)
  }

  return { dir: outputDir, zipPath, zipFileName }
}

function compileLockHolderExe(outExePath) {
  const winDir = process.env.WINDIR || 'C:\\Windows'
  const cscPath = join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  assert(existsSync(cscPath), `csc.exe not found at ${cscPath}`)
  const csPath = `${outExePath}.cs`
  writeFileSync(
    csPath,
    `
using System;
using System.IO;
using System.Threading;
internal static class Program {
  [STAThread]
  private static int Main(string[] args) {
    string targetFile = args[0];
    string readyFile = args[1];
    string releaseFile = args[2];
    using (var fs = new FileStream(targetFile, FileMode.Open, FileAccess.Read, FileShare.Read)) {
      File.WriteAllText(readyFile, "locked");
      var sw = System.Diagnostics.Stopwatch.StartNew();
      while (!File.Exists(releaseFile) && sw.ElapsedMilliseconds < 45000) {
        Thread.Sleep(50);
      }
    }
    return 0;
  }
}
`,
    'utf-8'
  )
  const res = spawnSync(cscPath, ['/nologo', '/target:winexe', '/optimize+', `/out:${outExePath}`, csPath], {
    encoding: 'utf-8',
    windowsHide: true
  })
  assert(res.status === 0, `Failed to compile LockHolder.exe: ${res.stdout}\n${res.stderr}`)
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This test is designed for Windows only.')
  }

  console.log('=== Windows Seamless Auto-Update E2E Test ===\n')

  const testRoot = join(PROJECT_ROOT, 'test', 'autotest', 'results', 'auto-update-windows-e2e')
  const fixturesRoot = join(testRoot, 'fixtures')
  const fingerprintFile = join(fixturesRoot, '.build-fingerprint')
  const runRoot = join(testRoot, 'run')
  const serverRoot = join(testRoot, 'mock-github-root')

  mkdirSync(testRoot, { recursive: true })
  rmSync(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  rmSync(serverRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })

  const currentFingerprint = computeUpdaterSourceFingerprint()
  const cachedFingerprint = existsSync(fingerprintFile) ? readFileSync(fingerprintFile, 'utf-8').trim() : ''
  if (cachedFingerprint !== currentFingerprint) {
    console.log(`[Cache] Updater source changed (${cachedFingerprint || 'none'} -> ${currentFingerprint}); refreshing cached builds...`)
    rmSync(fixturesRoot, { recursive: true, force: true })
  }
  mkdirSync(fixturesRoot, { recursive: true })
  mkdirSync(runRoot, { recursive: true })
  mkdirSync(serverRoot, { recursive: true })

  // ── Step 1: Build OLD, A, B ────────────────────────────────────────────
  console.log('[Step 1] Preparing three packaged Windows app versions...')
  const buildOld = await buildUnpackedAndZip(OLD_TAG, fixturesRoot, { zip: false })
  const buildA = await buildUnpackedAndZip(TAG_A, fixturesRoot, { zip: true })
  const buildB = await buildUnpackedAndZip(TAG_B, fixturesRoot, { zip: true })
  writeFileSync(fingerprintFile, `${currentFingerprint}\n`, 'utf-8')
  rmSync(join(PROJECT_ROOT, 'release'), { recursive: true, force: true })

  // ── Step 2: Start Simulated GitHub Server ──────────────────────────────
  console.log('\n[Step 2] Starting simulated GitHub Releases + CDN server...')
  const mockServer = createMockGitHubUpdateServer(serverRoot, {
    interruptFirstCdnStreamAfterBytes: 0
  })

  let appProcess = null
  let markerProcess = null
  let lockHolderChild = null
  let latestLockData = null
  let capturedInstallLog = ''
  const userDataDir = join(runRoot, 'user-data')
  const installLogPath = join(userDataDir, 'updates', 'install.log')
  const pendingMarkerPath = join(userDataDir, 'updates', 'pending-update.json')

  try {
    const port = await mockServer.listen()
    const manifestA = publishMockReleaseManifest({
      serverRootDir: serverRoot,
      port,
      tag: TAG_A,
      channel: RELEASE_CHANNEL,
      zipArtifactPath: buildA.zipPath
    })
    console.log(`  Mock GitHub listening at http://127.0.0.1:${port}`)

    const baseLaunchEnv = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: userDataDir,
      ONWARD_UPDATE_BASE_URL: `http://127.0.0.1:${port}/updates`,
      ONWARD_UPDATE_CHECK_INTERVAL_MS: '2000'
    }

    const installDir = join(runRoot, 'app')
    cpSync(buildOld.dir, installDir, { recursive: true })
    // Place an NSIS uninstaller sentinel to prove swaps preserve Uninstall*.exe
    const uninstallerSentinelPath = join(installDir, 'Uninstall Onward 2.exe')
    writeFileSync(uninstallerSentinelPath, 'nsis-uninstaller-sentinel', 'utf-8')

    const execPath = join(installDir, `${PRODUCT_NAME}.exe`)
    const stageReadyMarkerPath = join(installDir, '_', '.onward-stage-ready.json')

    // ── Step 3 (S1): Malformed pending-update markers must be ignored ────
    console.log('\n[Step 3] Verifying malformed pending-update markers (v2 & invalid v3) are cleaned...')
    for (const [label, badPayload] of [
      ['v2-legacy', { schemaVersion: 2, artifactPath: 'C:\\missing.exe' }],
      ['v3-invalid', { schemaVersion: 3, installDir: 'relative-path' }]
    ]) {
      const badDataDir = join(runRoot, `bad-marker-${label}`)
      const badMarker = join(badDataDir, 'updates', 'pending-update.json')
      mkdirSync(dirname(badMarker), { recursive: true })
      writeFileSync(badMarker, JSON.stringify(badPayload), 'utf-8')

      markerProcess = spawnApp(execPath, {
        env: {
          ...baseLaunchEnv,
          ONWARD_USER_DATA_DIR: badDataDir,
          ONWARD_UPDATE_BASE_URL: `http://127.0.0.1:${port}/updates-disabled`
        }
      })
      const lock = await waitForLockFile(badDataDir, { timeoutMs: 60000 })
      await waitForHealthVersion(lock.port, OLD_VERSION, { timeoutMs: 15000 })
      assert(!existsSync(badMarker), `Invalid ${label} marker must be deleted on startup`)
      await terminateProcessByPid(lock.pid, { stdio: 'pipe' }).catch(() => {})
      await Promise.race([markerProcess.waitForExit(), sleep(10000)])
      markerProcess = null
    }
    console.log('  Invalid markers safely cleaned ✓')

    // ── Step 4 (S2): Launch OLD, download A via 302 + 206 resume + "_" stage
    console.log('\n[Step 4] Launching OLD version and staging update A...')
    // Arm mid-stream socket drop right before Step 4 so Step 3 smoke apps do not consume it
    mockServer.setInterruptFirstCdnStreamAfterBytes(2 * 1024 * 1024)
    appProcess = spawnApp(execPath, { env: baseLaunchEnv })
    latestLockData = await waitForLockFile(userDataDir, { timeoutMs: 60000 })
    await waitForHealthVersion(latestLockData.port, OLD_VERSION, { timeoutMs: 15000 })

    await postJson(latestLockData.port, '/api/debug/updater/check')
    const statusA = await waitForUpdaterStatus(
      latestLockData.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_A,
      { timeoutMs: 240000, description: `downloaded & staged ${VERSION_A}` }
    )
    assert(statusA.downloadedFileName.endsWith('.zip'), `Expected .zip artifact, got ${statusA.downloadedFileName}`)
    assert(mockServer.stats.redirectRequests >= 1, 'Expected 302 GitHub release redirect to be exercised')
    assert(mockServer.stats.interruptedStreams >= 1 && mockServer.stats.rangeRequests >= 1, 'Expected 206 Range resume after mid-stream interruption')
    assert(existsSync(stageReadyMarkerPath), 'Expected <installDir>\\_\\.onward-stage-ready.json to exist')
    const stagedMetaA = JSON.parse(readFileSync(stageReadyMarkerPath, 'utf-8'))
    assert(stagedMetaA.version === VERSION_A, `Expected staged version ${VERSION_A}, got ${stagedMetaA.version}`)
    assert(stagedMetaA.sha256 === manifestA.archive.sha256, 'Staged SHA-256 mismatch for A')
    console.log(`  Staged A in <installDir>\\_ (302 redirects=${mockServer.stats.redirectRequests}, 206 range resumes=${mockServer.stats.rangeRequests}) ✓`)

    // ── Step 5 (S3): Switch manifest to B -> supersede "_" in-place ──────
    console.log('\n[Step 5] Publishing B manifest and verifying in-place "_" supersede...')
    mockServer.setInterruptFirstCdnStreamAfterBytes(0)
    const manifestB = publishMockReleaseManifest({
      serverRootDir: serverRoot,
      port,
      tag: TAG_B,
      channel: RELEASE_CHANNEL,
      zipArtifactPath: buildB.zipPath
    })
    const statusB = await waitForUpdaterStatus(
      latestLockData.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_B,
      { timeoutMs: 240000, description: `downloaded & staged ${VERSION_B}` }
    )
    assert(statusB.targetTag === TAG_B, 'Expected targetTag B')
    const stagedMetaB = JSON.parse(readFileSync(stageReadyMarkerPath, 'utf-8'))
    assert(stagedMetaB.version === VERSION_B, `Expected "_" superseded to ${VERSION_B}, got ${stagedMetaB.version}`)
    assert(stagedMetaB.sha256 === manifestB.archive.sha256, 'Staged SHA-256 mismatch for B')
    console.log('  "_" superseded from A -> B ✓')

    // ── Step 6 (S4): Forced kill must NOT apply; relaunch recovers "_" ───
    console.log('\n[Step 6] Force-killing without graceful quit...')
    const killExit = appProcess.waitForExit()
    await terminateProcessByPid(latestLockData.pid, { stdio: 'pipe' }).catch(() => {})
    await Promise.race([killExit, sleep(10000)])
    assert(!existsSync(installLogPath), 'install.log must NOT exist after forced kill')
    assert(existsSync(stageReadyMarkerPath), '"_" must still hold B after forced kill')
    console.log('  Forced kill did not trigger swap ✓')

    console.log('\n[Step 7] Relaunching OLD with rollback fault-injection env and verifying fast "_" recovery...')
    // Create a file inside installDir that we will hold locked to test rollback
    const lockedProbePath = join(installDir, 'zz-locked-probe.dll')
    writeFileSync(lockedProbePath, 'live-dll-vOld', 'utf-8')

    const rollbackEnv = {
      ...baseLaunchEnv,
      ONWARD_UPDATER_MOVE_RETRY_MS: '800',
      ONWARD_UPDATER_DISABLE_LINGERING_KILL: '1'
    }
    appProcess = spawnApp(execPath, { env: rollbackEnv })
    latestLockData = await waitForLockFile(userDataDir, {
      previousStartedAt: latestLockData.startedAt,
      timeoutMs: 60000
    })
    await waitForHealthVersion(latestLockData.port, OLD_VERSION, { timeoutMs: 15000 })
    await waitForUpdaterStatus(
      latestLockData.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_B,
      { timeoutMs: 30000, description: `fast "_" startup recovery of ${VERSION_B}` }
    )
    const filesAfterRecovery = listUpdateFiles(userDataDir)
    assert(!filesAfterRecovery.some((f) => f.includes(VERSION_A) && f.endsWith('.zip')), 'Stale cached A .zip should be purged on startup')
    console.log('  Instant "_" recovery & stale cache purge verified ✓')

    // ── Step 8 (S5): Lock fault injection -> atomic rollback -> UI error ─
    console.log('\n[Step 8] Injecting FileShare.Read lock and triggering Restart-to-Update (expecting atomic rollback)...')
    const helperDir = join(runRoot, 'helpers')
    mkdirSync(helperDir, { recursive: true })
    const lockHolderExe = join(helperDir, 'LockHolder.exe')
    compileLockHolderExe(lockHolderExe)

    const lockReadyFile = join(helperDir, 'lock-ready.txt')
    const lockReleaseFile = join(helperDir, 'lock-release.txt')
    lockHolderChild = spawn(lockHolderExe, [lockedProbePath, lockReadyFile, lockReleaseFile], {
      stdio: 'ignore',
      windowsHide: true
    })
    await waitFor(() => existsSync(lockReadyFile), { timeoutMs: 10000, intervalMs: 50, description: 'LockHolder ready' })

    const preRollbackStartedAt = latestLockData.startedAt
    const rollbackExitPromise = appProcess.waitForExit()
    const rollbackRestartReq = await postJson(latestLockData.port, '/api/debug/updater/restart')
    assert(rollbackRestartReq.success === true, 'Expected restart request to succeed')
    await rollbackExitPromise

    // Wait for onward-updater.exe to roll back and relaunch OLD_VERSION
    const rolledBackLock = await waitForLockFile(userDataDir, {
      previousStartedAt: preRollbackStartedAt,
      timeoutMs: 90000
    })
    latestLockData = rolledBackLock
    await waitForHealthVersion(latestLockData.port, OLD_VERSION, { timeoutMs: 20000 })
    assert(existsSync(stageReadyMarkerPath), '"_" must remain intact after rollback')
    assert(!existsSync(join(installDir, '_old')), '"_old" must be restored and removed after rollback')

    const statusAfterRollback = await waitForUpdaterStatus(
      latestLockData.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_B && Boolean(s.error),
      { timeoutMs: 30000, description: 'rolled-back status with surfaced error and preserved downloaded state' }
    )
    console.log(`  Atomic rollback succeeded; surfaced error="${statusAfterRollback.error}" while keeping B staged ✓`)

    // Release file lock and retry Restart-to-Update without re-downloading!
    console.log('\n[Step 9] Releasing lock and retrying Restart-to-Update on preserved "_" ...')
    writeFileSync(lockReleaseFile, 'release', 'utf-8')
    await waitFor(() => lockHolderChild.exitCode !== null, { timeoutMs: 10000, intervalMs: 50, description: 'LockHolder exit' })
    lockHolderChild = null

    const preSuccessStartedAt = latestLockData.startedAt
    const retryRes = await postJson(latestLockData.port, '/api/debug/updater/restart')
    assert(retryRes.success === true, `Retry restart failed: ${retryRes.error}`)

    capturedInstallLog = ''
    const updatedLockData = await waitFor(
      () => {
        if (existsSync(installLogPath)) {
          try {
            const content = readFileSync(installLogPath, 'utf-8').trim()
            if (content.length > capturedInstallLog.length) capturedInstallLog = content
          } catch {
            // ignore transient read contention
          }
        }
        const lockFile = join(userDataDir, 'onward-api.lock')
        if (!existsSync(lockFile)) return null
        try {
          const data = JSON.parse(readFileSync(lockFile, 'utf-8'))
          return Number(data.startedAt || 0) > preSuccessStartedAt ? data : null
        } catch {
          return null
        }
      },
      { timeoutMs: 120000, intervalMs: 300, description: 'updated VERSION_B lock file' }
    )
    latestLockData = updatedLockData

    // ── Step 10 (S6): Verify VERSION_B + post-install hygiene ────────────
    const healthB = await waitForHealthVersion(latestLockData.port, VERSION_B, { timeoutMs: 30000 })
    assert(healthB.version === VERSION_B, `Expected ${VERSION_B}, got ${healthB.version}`)
    assert(capturedInstallLog.includes('Update installed successfully.'), `install.log missing success line:\n${capturedInstallLog}`)
    assert(!existsSync(pendingMarkerPath), 'pending-update.json must be deleted after successful swap')
    assert(!existsSync(join(installDir, '_')), '"_" must be consumed after swap')
    assert(!existsSync(join(installDir, '_old')), '"_old" must be deleted after swap')
    assert(readFileSync(uninstallerSentinelPath, 'utf-8') === 'nsis-uninstaller-sentinel', 'Uninstall Onward 2.exe must be preserved')
    const remainingUpdateFiles = listUpdateFiles(userDataDir)
    assert(!remainingUpdateFiles.some((f) => f.endsWith('.zip')), `Cached .zip must be cleaned up, found: ${remainingUpdateFiles.join(', ')}`)
    console.log(`  Restart-to-Update booted ${VERSION_B} cleanly with zero leftover staging artifacts ✓`)

    await terminateProcessByPid(latestLockData.pid, { stdio: 'pipe' }).catch(() => {})
    await sleep(1000)

    // ── Step 11 (S7): Normal Graceful Quit silent apply (relaunch=false) ─
    console.log('\n[Step 11] Verifying normal graceful quit applies staged update silently (relaunch=false)...')
    const quitInstallDir = join(runRoot, 'app-quit-mode')
    const quitUserDataDir = join(runRoot, 'user-data-quit-mode')
    const quitLogPath = join(quitUserDataDir, 'updates', 'install.log')
    cpSync(buildOld.dir, quitInstallDir, { recursive: true })
    const quitExecPath = join(quitInstallDir, `${PRODUCT_NAME}.exe`)

    publishMockReleaseManifest({
      serverRootDir: serverRoot,
      port,
      tag: TAG_A,
      channel: RELEASE_CHANNEL,
      zipArtifactPath: buildA.zipPath
    })

    const quitEnv = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: quitUserDataDir,
      ONWARD_UPDATE_BASE_URL: `http://127.0.0.1:${port}/updates`,
      ONWARD_UPDATE_CHECK_INTERVAL_MS: '2000'
    }

    appProcess = spawnApp(quitExecPath, { env: quitEnv })
    const quitInitialLock = await waitForLockFile(quitUserDataDir, { timeoutMs: 60000 })
    await waitForHealthVersion(quitInitialLock.port, OLD_VERSION, { timeoutMs: 15000 })
    await postJson(quitInitialLock.port, '/api/debug/updater/check')
    await waitForUpdaterStatus(
      quitInitialLock.port,
      (s) => s.phase === 'downloaded' && s.targetVersion === VERSION_A,
      { timeoutMs: 240000, description: `staged ${VERSION_A} for apply-on-quit` }
    )

    const quitExitPromise = appProcess.waitForExit()
    await postJson(quitInitialLock.port, '/api/debug/app/quit')
    await quitExitPromise
    appProcess = null

    await waitFor(
      () =>
        !existsSync(join(quitInstallDir, '_')) &&
        existsSync(quitLogPath) &&
        readFileSync(quitLogPath, 'utf-8').includes('Update installed successfully.'),
      { timeoutMs: 45000, intervalMs: 250, description: 'silent swap completion on normal quit' }
    )

    // Confirm app did NOT auto-relaunch during a 2.5s observation window
    await sleep(2500)
    const lockPathAfterQuit = join(quitUserDataDir, 'onward-api.lock')
    if (existsSync(lockPathAfterQuit)) {
      const maybeLock = JSON.parse(readFileSync(lockPathAfterQuit, 'utf-8'))
      assert(
        Number(maybeLock.startedAt || 0) <= quitInitialLock.startedAt,
        'Normal graceful quit must NOT auto-relaunch the application'
      )
    }
    console.log('  Silent apply on normal quit completed with zero auto-relaunch ✓')

    // Manual next launch must boot directly into VERSION_A
    appProcess = spawnApp(quitExecPath, { env: quitEnv })
    const nextBootLock = await waitForLockFile(quitUserDataDir, {
      previousStartedAt: quitInitialLock.startedAt,
      timeoutMs: 60000
    })
    const nextBootHealth = await waitForHealthVersion(nextBootLock.port, VERSION_A, { timeoutMs: 20000 })
    assert(nextBootHealth.version === VERSION_A, `Expected ${VERSION_A} on next boot, got ${nextBootHealth.version}`)
    console.log(`  Next manual launch booted directly into ${VERSION_A} ✓`)

    await terminateProcessByPid(nextBootLock.pid, { stdio: 'pipe' }).catch(() => {})
    await Promise.race([appProcess.waitForExit(), sleep(10000)])
    appProcess = null

    console.log('\n=== Test Results ===')
    console.log(`  [PASS] S1: Malformed pending-update markers (v2 & v3) ignored and removed`)
    console.log(`  [PASS] S2: 302 CDN redirect + 206 Range resume + background "_" staging (${VERSION_A})`)
    console.log(`  [PASS] S3: Manifest switch A -> B superseded "_" in-place (${VERSION_B})`)
    console.log(`  [PASS] S4: Forced kill left live install untouched; relaunch recovered "_" immediately`)
    console.log(`  [PASS] S5: File-lock fault injection rolled back atomically, preserved "_", and surfaced UI error`)
    console.log(`  [PASS] S6: Retry Restart-to-Update swapped "_" cleanly into ${VERSION_B} and preserved Uninstall*.exe`)
    console.log(`  [PASS] S7: Normal graceful quit silently swapped "_" (relaunch=false) and next launch booted ${VERSION_A}`)
    console.log('\n=== PASS ===')
  } catch (error) {
    console.error('\n=== FAIL ===')
    console.error(`  ${error instanceof Error ? error.stack || error.message : String(error)}`)
    if (existsSync(installLogPath)) {
      console.error(`\n--- install.log ---\n${readFileSync(installLogPath, 'utf-8')}\n--- end ---`)
    }
    if (capturedInstallLog) {
      console.error(`\n--- captured install.log ---\n${capturedInstallLog}\n--- end ---`)
    }
    process.exitCode = 1
  } finally {
    if (lockHolderChild && lockHolderChild.exitCode === null) {
      try {
        lockHolderChild.kill()
      } catch {
        // ignore
      }
    }
    if (latestLockData?.pid) {
      await terminateProcessByPid(latestLockData.pid, { stdio: 'pipe' }).catch(() => {})
    }
    if (markerProcess?.child) await stopChildProcess(markerProcess.child).catch(() => {})
    if (appProcess?.child) await stopChildProcess(appProcess.child).catch(() => {})
    await mockServer.close().catch(() => {})
    await sleep(500)
    // Clean per-run directories while preserving fixtures cache for fast re-runs
    try {
      rmSync(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      rmSync(serverRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (cleanupErr) {
      console.warn(`[Cleanup] Deferred scratch cleanup warning: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
    }
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
