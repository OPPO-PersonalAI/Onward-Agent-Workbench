#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Live GitHub Releases + gh-pages end-to-end verification for Windows seamless update.
 *
 * Uses zero ONWARD_UPDATE_BASE_URL overrides so the packaged Windows app queries
 * the production default manifest endpoint (raw.githubusercontent.com/.../gh-pages)
 * and streams the real .zip update archive from GitHub Releases CDN.
 *
 * Usage:
 *   node test/autotest/verify-github-dev-update-e2e.mjs \
 *     --tag-from v2.1.0-dev.20261112.1 \
 *     --tag-to v2.1.0-dev.20261112.2 \
 *     --from-zip <path-to-downloaded-tag-from-windows-x64.zip>
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import https from 'node:https'
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
  waitForLockFile
} from './auto-update-test-lib.mjs'

const require = createRequire(import.meta.url)
const { IMAGE_SUBSYSTEM_WINDOWS_GUI, readPeSubsystem } = require('../../scripts/ensure-windows-updater.js')

function parseArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      result[key] = 'true'
    } else {
      result[key] = next
      i += 1
    }
  }
  return result
}

function fetchHttpsText(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'AgentWorkbench-Live-E2E-Verifier',
          'Cache-Control': 'no-cache'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          fetchHttpsText(res.headers.location).then(resolvePromise, rejectPromise)
          return
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolvePromise({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8')
          })
        })
      }
    )
    req.on('error', rejectPromise)
  })
}

function headHttpsNoRedirect(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.request(
      url,
      {
        method: 'HEAD',
        headers: { 'User-Agent': 'AgentWorkbench-Live-E2E-Verifier' }
      },
      (res) => {
        res.resume()
        resolvePromise({
          statusCode: res.statusCode || 0,
          location: res.headers.location || null
        })
      }
    )
    req.on('error', rejectPromise)
    req.end()
  })
}

async function extractZipToDirectory(zipPath, destDir) {
  const { extractWindowsUpdateZip } = await import('../../electron/main/windows-zip-extract.ts')
  await extractWindowsUpdateZip({
    zipPath,
    destinationDir: destDir,
    expectedExecutableName: 'Onward 2.exe'
  })
}

function resolveExtractedAppDir(rootDir) {
  if (existsSync(join(rootDir, 'Onward 2.exe'))) {
    return rootDir
  }
  const nested = join(rootDir, 'win-unpacked')
  if (existsSync(join(nested, 'Onward 2.exe'))) {
    return nested
  }
  throw new Error(`Could not locate "Onward 2.exe" inside extracted directory: ${rootDir}`)
}

async function waitForLiveManifestVersion(manifestUrl, expectedVersion, timeoutMs = 420_000) {
  return waitFor(
    async () => {
      const resp = await fetchHttpsText(manifestUrl)
      if (resp.statusCode !== 200) {
        return null
      }
      const parsed = JSON.parse(resp.body)
      if (parsed && parsed.version === expectedVersion) {
        return parsed
      }
      console.log(`  [cdn-wait] ${manifestUrl} currently reports version=${parsed?.version ?? 'unknown'}, waiting for ${expectedVersion}...`)
      return null
    },
    {
      timeoutMs,
      intervalMs: 10_000,
      description: `live GitHub manifest ${expectedVersion} at ${manifestUrl}`
    }
  )
}

let verificationCompleted = false

async function main() {
  const requiredNodeFlags = ['--use-system-ca', '--experimental-strip-types']
  const missingFlags = requiredNodeFlags.filter((flag) => !process.execArgv.includes(flag))
  if (missingFlags.length > 0) {
    const child = spawnSync(
      process.execPath,
      [...missingFlags, ...process.execArgv, ...process.argv.slice(1)],
      { stdio: 'inherit' }
    )
    process.exit(child.status ?? 1)
  }

  process.on('beforeExit', (code) => {
    if (code === 0 && !verificationCompleted) {
      console.error('\n[LIVE GITHUB E2E FAILED] Event loop drained prematurely before verificationCompleted=true!')
      process.exit(1)
    }
  })

  if (process.platform !== 'win32') {
    throw new Error('verify-github-dev-update-e2e.mjs must run on Windows.')
  }

  const args = parseArgs(process.argv.slice(2))
  const tagFrom = String(args['tag-from'] || '').trim()
  const tagTo = String(args['tag-to'] || '').trim()
  const fromZip = String(args['from-zip'] || '').trim()
  const expectedDailyVersion = String(args['expected-daily-version'] || '').trim()

  if (!tagFrom || !tagTo || !fromZip) {
    throw new Error('Required arguments: --tag-from <tag1> --tag-to <tag2> --from-zip <zipPath>')
  }
  assert(existsSync(fromZip), `Source release zip not found: ${fromZip}`)

  const versionFrom = tagFrom.replace(/^v/, '')
  const versionTo = tagTo.replace(/^v/, '')

  const prodWinManifestUrl = 'https://raw.githubusercontent.com/OPPO-PersonalAI/Onward/gh-pages/updates/dev/windows/x64/latest.json'
  const prodMacArmManifestUrl = 'https://raw.githubusercontent.com/OPPO-PersonalAI/Onward/gh-pages/updates/dev/macos/arm64/latest.json'
  const prodMacX64ManifestUrl = 'https://raw.githubusercontent.com/OPPO-PersonalAI/Onward/gh-pages/updates/dev/macos/x64/latest.json'
  const prodDailyWinManifestUrl = 'https://raw.githubusercontent.com/OPPO-PersonalAI/Onward/gh-pages/updates/daily/windows/x64/latest.json'

  console.log('\n[Step 1] Verifying live gh-pages manifests & GitHub Release CDN redirects...')
  const winManifest = await waitForLiveManifestVersion(prodWinManifestUrl, versionTo)

  assert(winManifest.channel === 'dev', `Expected channel=dev, got ${winManifest.channel}`)
  assert(winManifest.platform === 'windows', `Expected platform=windows, got ${winManifest.platform}`)
  assert(/\.exe$/i.test(winManifest.artifactName), `Expected primary artifactName to end in .exe, got ${winManifest.artifactName}`)
  assert(winManifest.archive && typeof winManifest.archive === 'object', 'Expected Windows manifest to include archive (.zip) block')
  assert(/\.zip$/i.test(winManifest.archive.artifactName), `Expected archive.artifactName to end in .zip, got ${winManifest.archive.artifactName}`)
  assert(/^[a-f0-9]{64}$/i.test(winManifest.sha256), 'Invalid primary sha256')
  assert(/^[a-f0-9]{64}$/i.test(winManifest.archive.sha256), 'Invalid archive sha256')

  const exeHead = await headHttpsNoRedirect(winManifest.artifactUrl)
  const zipHead = await headHttpsNoRedirect(winManifest.archive.artifactUrl)
  assert(exeHead.statusCode === 302 && exeHead.location, `Expected HTTP 302 for .exe asset URL, got ${exeHead.statusCode}`)
  assert(zipHead.statusCode === 302 && zipHead.location, `Expected HTTP 302 for .zip asset URL, got ${zipHead.statusCode}`)
  console.log(`  [PASS] Windows dual-field manifest verified (.exe 302 + .zip 302) for ${versionTo}`)

  for (const macUrl of [prodMacArmManifestUrl, prodMacX64ManifestUrl]) {
    const macResp = await fetchHttpsText(macUrl)
    assert(macResp.statusCode === 200, `Expected HTTP 200 for ${macUrl}, got ${macResp.statusCode}`)
    const macManifest = JSON.parse(macResp.body)
    assert(macManifest.version === versionTo, `Expected macOS manifest version=${versionTo}, got ${macManifest.version}`)
    assert(/\.zip$/i.test(macManifest.artifactName), `Expected macOS artifactName=.zip, got ${macManifest.artifactName}`)
    assert(!('archive' in macManifest), `macOS manifest must NOT contain Windows archive block: ${macUrl}`)
  }
  console.log('  [PASS] macOS arm64 + x64 manifests verified (untouched schema)')

  if (expectedDailyVersion) {
    const dailyResp = await fetchHttpsText(prodDailyWinManifestUrl)
    assert(dailyResp.statusCode === 200, `Expected HTTP 200 for daily Windows manifest, got ${dailyResp.statusCode}`)
    const dailyManifest = JSON.parse(dailyResp.body)
    assert(
      dailyManifest.version === expectedDailyVersion,
      `Daily channel manifest must remain untouched at ${expectedDailyVersion}, got ${dailyManifest.version}`
    )
    console.log(`  [PASS] Daily channel isolation verified (still ${expectedDailyVersion})`)
  }

  const scratchRoot = mkdtempSync(join(tmpdir(), 'onward-gh-live-e2e-'))
  const trackedPids = new Set()
  let activeRun = null

  try {
    // ── Live Scenario A: Restart-to-Update from Real GitHub ────────────────
    console.log(`\n[Step 2] Live Scenario A: ${versionFrom} -> ${versionTo} via Restart-to-Update (real GitHub CDN)...`)
    const restartRoot = join(scratchRoot, 'case-restart')
    const restartExtractDir = join(restartRoot, 'Onward 2')
    const restartUserData = join(restartRoot, 'user-data')
    await extractZipToDirectory(fromZip, restartExtractDir)
    const restartInstallDir = resolveExtractedAppDir(restartExtractDir)
    const restartExe = join(restartInstallDir, 'Onward 2.exe')

    // Plant realistic NSIS uninstaller sentinel to verify preservation across real swap
    const uninstallerSentinel = join(restartInstallDir, 'Uninstall Onward 2.exe')
    writeFileSync(uninstallerSentinel, 'NSIS-UNINSTALLER-SENTINEL', 'utf-8')

    // Verify bundled onward-updater.exe inside the real CI-built Windows package
    const bundledUpdaterPath = join(restartInstallDir, 'resources', 'resources', 'updater', 'win32', 'onward-updater.exe')
    assert(existsSync(bundledUpdaterPath), `Bundled onward-updater.exe missing in CI artifact: ${bundledUpdaterPath}`)
    const subsystem = readPeSubsystem(bundledUpdaterPath)
    assert(
      subsystem === IMAGE_SUBSYSTEM_WINDOWS_GUI,
      `Expected bundled onward-updater.exe PE subsystem=${IMAGE_SUBSYSTEM_WINDOWS_GUI} (WINDOWS_GUI), got ${subsystem}`
    )
    console.log('  [PASS] CI-built onward-updater.exe verified (PE Subsystem = 2 WINDOWS_GUI)')

    const envA = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: restartUserData,
      ONWARD_UPDATER_WAIT_GRACE_MS: '15000',
      ONWARD_UPDATER_MOVE_RETRY_MS: '10000'
    }
    // Guarantee zero ONWARD_UPDATE_BASE_URL override in process environment
    delete envA.ONWARD_UPDATE_BASE_URL

    activeRun = spawnApp(restartExe, {
      cwd: restartInstallDir,
      env: envA
    })
    trackedPids.add(activeRun.child.pid)

    const lockA1 = await waitForLockFile(restartUserData, { timeoutMs: 45_000 })
    trackedPids.add(lockA1.pid)
    const healthA1 = await waitForHealthVersion(lockA1.port, versionFrom, { timeoutMs: 30_000 })
    assert(healthA1.buildChannel === 'prod', `Expected buildChannel=prod, got ${healthA1.buildChannel}`)
    assert(healthA1.releaseChannel === 'dev', `Expected releaseChannel=dev, got ${healthA1.releaseChannel}`)
    console.log(`  [PASS] Booted ${versionFrom} (pid=${lockA1.pid}, port=${lockA1.port})`)

    const checkRespA = await postJson(lockA1.port, '/api/debug/updater/check')
    assert(
      checkRespA?.phase === 'available' && checkRespA?.targetVersion === versionTo,
      `Expected phase=available for ${versionTo}, got ${JSON.stringify(checkRespA)}`
    )
    console.log(`  [PASS] Live GitHub check detected ${versionTo}`)

    console.log('  [download] Downloading real .zip from GitHub Releases CDN and staging into "_" ...')
    const downloadStart = Date.now()
    const downloadRespA = await postJson(lockA1.port, '/api/debug/updater/download')
    const downloadElapsedSec = ((Date.now() - downloadStart) / 1000).toFixed(1)
    assert(
      downloadRespA?.phase === 'downloaded' && downloadRespA?.targetVersion === versionTo,
      `Expected phase=downloaded for ${versionTo}, got ${JSON.stringify(downloadRespA)}`
    )
    assert(
      /\.zip$/i.test(downloadRespA?.downloadedFileName || ''),
      `Expected downloadedFileName to be .zip, got ${downloadRespA?.downloadedFileName}`
    )
    assert(existsSync(join(restartInstallDir, '_', 'Onward 2.exe')), 'Expected staged "<installDir>\\_\\Onward 2.exe" to exist')
    console.log(`  [PASS] Downloaded & staged ${downloadRespA.downloadedFileName} in ${downloadElapsedSec}s`)

    const installLogPathA = join(restartUserData, 'updates', 'install.log')
    assert(!existsSync(installLogPathA), 'Expected install.log not to exist before restart swap')

    const restartStart = Date.now()
    const restartResp = await postJson(lockA1.port, '/api/debug/updater/restart')
    assert(restartResp?.success === true, `Restart endpoint failed: ${JSON.stringify(restartResp)}`)
    await activeRun.waitForExit()
    activeRun = null

    let capturedInstallLogA = ''
    const lockA2 = await waitFor(
      async () => {
        if (existsSync(installLogPathA)) {
          try {
            const raw = readFileSync(installLogPathA, 'utf-8').trim()
            if (raw.length > capturedInstallLogA.length) {
              capturedInstallLogA = raw
            }
          } catch {
            // ignore transient file contention while onward-updater.exe writes install.log
          }
        }
        const lockPath = join(restartUserData, 'onward-api.lock')
        if (!existsSync(lockPath)) return null
        const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'))
        if (!parsed?.port || !parsed?.pid || parsed.pid === lockA1.pid) return null
        const health = await fetchJson(`http://127.0.0.1:${parsed.port}/api/health`).catch(() => null)
        if (health && health.version === versionTo) {
          return { lock: parsed, health }
        }
        return null
      },
      {
        timeoutMs: 60_000,
        intervalMs: 100,
        description: `relaunched instance reporting ${versionTo}`
      }
    )
    const restartSwapSec = ((Date.now() - restartStart) / 1000).toFixed(2)
    trackedPids.add(lockA2.lock.pid)
    console.log(`  [PASS] Relaunched directly into ${lockA2.health.version} (pid=${lockA2.lock.pid}) in ${restartSwapSec}s!`)

    // Wait for onward-updater.exe post-relaunch cleanup (_ / _old / cached .zip) to finish
    await waitFor(
      () =>
        !existsSync(join(restartInstallDir, '_')) &&
        !existsSync(join(restartInstallDir, '_old')) &&
        listUpdateFiles(restartUserData).filter((name) => name.endsWith('.zip')).length === 0,
      {
        timeoutMs: 20_000,
        intervalMs: 250,
        description: 'post-relaunch cleanup of _, _old, and cached .zip'
      }
    )
    assert(!existsSync(join(restartInstallDir, '_')), 'Expected "_" staging directory to be moved/cleaned after swap')
    assert(!existsSync(join(restartInstallDir, '_old')), 'Expected "_old" backup directory to be removed after swap')
    assert(existsSync(uninstallerSentinel), 'Expected Uninstall Onward 2.exe sentinel to be preserved across swap')
    assert(!existsSync(join(restartUserData, 'updates', 'pending-update.json')), 'Expected pending-update.json to be cleaned up')
    assert(!existsSync(join(restartUserData, 'updates', 'last-install-error.json')), 'Expected no last-install-error.json after clean swap')
    const remainingZipsA = listUpdateFiles(restartUserData).filter((name) => name.endsWith('.zip'))
    assert(remainingZipsA.length === 0, `Expected cached .zip to be removed via cleanupPaths, remaining: ${remainingZipsA.join(', ')}`)
    assert(existsSync(installLogPathA), 'Expected onward-updater.exe to have created install.log')
    // Note: UpdateService.reportPreviousInstallResult() in the relaunched vTo process reads install.log,
    // emits telemetry, and truncates install.log to "". Accept either captured pre-truncation content
    // or post-reconciliation empty file alongside verified versionTo health + absence of last-install-error.json.
    const postLaunchInstallLogA = readFileSync(installLogPathA, 'utf-8').trim()
    assert(
      capturedInstallLogA.includes('Update installed successfully.') || postLaunchInstallLogA === '',
      `Unexpected install.log content after relaunch:\ncaptured=${capturedInstallLogA}\ncurrent=${postLaunchInstallLogA}`
    )

    await postJson(lockA2.lock.port, '/api/debug/app/quit').catch(() => {})
    await sleep(1500)
    await terminateProcessByPid(lockA2.lock.pid).catch(() => {})
    trackedPids.delete(lockA2.lock.pid)
    console.log('  [PASS] Live Scenario A (Restart-to-Update) 100% GREEN!')

    // ── Live Scenario B: Silent Swap on Normal Graceful Quit ───────────────
    console.log(`\n[Step 3] Live Scenario B: ${versionFrom} -> ${versionTo} via Normal Graceful Quit (relaunch=false)...`)
    const quitRoot = join(scratchRoot, 'case-quit')
    const quitExtractDir = join(quitRoot, 'Onward 2')
    const quitUserData = join(quitRoot, 'user-data')
    await extractZipToDirectory(fromZip, quitExtractDir)
    const quitInstallDir = resolveExtractedAppDir(quitExtractDir)
    const quitExe = join(quitInstallDir, 'Onward 2.exe')

    const envB = {
      ONWARD_DEBUG: '1',
      ONWARD_USER_DATA_DIR: quitUserData,
      ONWARD_UPDATER_WAIT_GRACE_MS: '15000',
      ONWARD_UPDATER_MOVE_RETRY_MS: '10000'
    }
    delete envB.ONWARD_UPDATE_BASE_URL

    activeRun = spawnApp(quitExe, {
      cwd: quitInstallDir,
      env: envB
    })
    trackedPids.add(activeRun.child.pid)

    const lockB1 = await waitForLockFile(quitUserData, { timeoutMs: 45_000 })
    trackedPids.add(lockB1.pid)
    await waitForHealthVersion(lockB1.port, versionFrom, { timeoutMs: 30_000 })

    const checkRespB = await postJson(lockB1.port, '/api/debug/updater/check')
    assert(checkRespB?.phase === 'available', `Expected phase=available, got ${JSON.stringify(checkRespB)}`)

    const downloadRespB = await postJson(lockB1.port, '/api/debug/updater/download')
    assert(downloadRespB?.phase === 'downloaded', `Expected phase=downloaded, got ${JSON.stringify(downloadRespB)}`)
    assert(existsSync(join(quitInstallDir, '_', 'Onward 2.exe')), 'Expected "_" staging directory before quit')

    const quitResp = await postJson(lockB1.port, '/api/debug/app/quit')
    assert(quitResp?.success === true, `Graceful quit failed: ${JSON.stringify(quitResp)}`)
    await activeRun.waitForExit()
    activeRun = null

    await waitFor(
      () => {
        const logPath = join(quitUserData, 'updates', 'install.log')
        if (!existsSync(logPath)) return false
        const content = readFileSync(logPath, 'utf-8')
        return (
          content.includes('Update installed successfully.') &&
          !existsSync(join(quitInstallDir, '_')) &&
          !existsSync(join(quitInstallDir, '_old'))
        )
      },
      {
        timeoutMs: 45_000,
        intervalMs: 300,
        description: 'silent swap completion in install.log after normal quit'
      }
    )

    // Confirm no auto-relaunch occurred during 3 seconds after silent swap
    await sleep(3000)
    assert(!existsSync(join(quitUserData, 'onward-api.lock')), 'Expected app NOT to auto-relaunch after normal quit (relaunch=false)')
    console.log('  [PASS] Silent swap completed on normal quit with zero auto-relaunch')

    // Next manual launch must boot straight into versionTo
    activeRun = spawnApp(quitExe, {
      cwd: quitInstallDir,
      env: envB
    })
    trackedPids.add(activeRun.child.pid)
    const lockB2 = await waitForLockFile(quitUserData, { timeoutMs: 45_000 })
    trackedPids.add(lockB2.pid)
    const healthB2 = await waitForHealthVersion(lockB2.port, versionTo, { timeoutMs: 30_000 })
    assert(healthB2.version === versionTo, `Expected next launch version=${versionTo}, got ${healthB2.version}`)
    console.log(`  [PASS] Manual next launch booted directly into ${healthB2.version}!`)

    await postJson(lockB2.port, '/api/debug/app/quit').catch(() => {})
    await activeRun.waitForExit()
    activeRun = null
    console.log('  [PASS] Live Scenario B (Silent Swap on Normal Quit) 100% GREEN!')

    console.log('\n============================================================')
    console.log(`LIVE GITHUB E2E VERIFICATION PASSED: ${versionFrom} -> ${versionTo}`)
    console.log('============================================================\n')
    verificationCompleted = true
  } finally {
    if (activeRun?.child) {
      await stopChildProcess(activeRun.child).catch(() => {})
    }
    for (const pid of trackedPids) {
      await terminateProcessByPid(pid).catch(() => {})
    }
    await sleep(1000)
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[LIVE GITHUB E2E FAILED]', error)
  process.exit(1)
})
