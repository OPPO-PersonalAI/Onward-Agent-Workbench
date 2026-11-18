/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createMockGitHubUpdateServer, createZipFromUnpackedDir } from './mock-github-update-server.mjs'
import { postJson, waitFor, waitForLockFile, waitForUpdaterStatus, waitForHealthVersion } from './auto-update-test-lib.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const asar = createRequire(require.resolve('electron-builder'))('@electron/asar')
const fixture = join(repo, 'test/autotest/fixtures/change-log')
const oldTag = 'v9.9.1-daily.20980101.1'
const newTag = 'v9.9.9-daily.20990101.1'

export async function runReleaseNotesUpdateTest(appBinary) {
  assert.ok(['darwin', 'win32'].includes(process.platform), 'Native installer test requires macOS or Windows')
  assert.ok(appBinary, 'Pass --release-notes <development-app-binary>')
  const sourceBinary = resolve(appBinary)
  const mac = process.platform === 'darwin'
  const releaseOs = mac ? 'macos' : 'windows'
  const sourceBundle = mac ? resolve(dirname(sourceBinary), '../..') : dirname(sourceBinary)
  const processName = basename(sourceBinary)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'onward-release-notes-update-')))
  const userData = join(root, 'user-data')
  const workspace = join(root, 'workspace')
  const serverRoot = join(root, 'server')
  const server = createMockGitHubUpdateServer(serverRoot)
  let browser
  let appProcess
  const stop = () => {
    if (mac) spawnSync('pkill', ['-x', processName], { stdio: 'ignore' })
    else spawnSync('taskkill.exe', ['/IM', processName, '/F'], { stdio: 'ignore' })
  }
  const cleanup = () => {
    stop()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  const interrupt = () => { cleanup(); process.exit(130) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  function command(bin, args) {
    const result = spawnSync(bin, args, { encoding: 'utf8' })
    assert.equal(result.status, 0, `${bin}: ${result.stderr}`)
  }
  try {
    mkdirSync(userData)
    mkdirSync(workspace)
    cpSync(join(fixture, 'startup/README.md'), join(workspace, 'README.md'))
    cpSync(join(fixture, 'startup/settings.json'), join(userData, 'settings.json'))
    const portHolder = createServer()
    await new Promise(resolveListen => portHolder.listen(0, '127.0.0.1', resolveListen))
    const cdpPort = portHolder.address().port
    await new Promise(resolveClose => portHolder.close(resolveClose))
    const bootstrap = readFileSync(join(fixture, 'startup/cdp-bootstrap.cjs'), 'utf8').replace('__CDP_PORT__', String(cdpPort))
    async function makePackage(tag, name) {
      const parent = join(root, name)
      mkdirSync(parent)
      const bundle = join(parent, basename(sourceBundle))
      cpSync(sourceBundle, bundle, { recursive: true, verbatimSymlinks: true })
      const resources = mac ? join(bundle, 'Contents/Resources') : join(bundle, 'resources')
      const archive = join(resources, 'app.asar')
      const extracted = join(parent, 'extracted')
      asar.extractAll(archive, extracted)
      const pkgPath = join(extracted, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      Object.assign(pkg, { version: tag.slice(1), tag, buildChannel: 'prod', releaseChannel: 'daily', releaseOs })
      writeFileSync(pkgPath, JSON.stringify(pkg))
      const entry = join(extracted, pkg.main)
      writeFileSync(entry, bootstrap + '\n' + readFileSync(entry, 'utf8'))
      rmSync(archive)
      rmSync(`${archive}.unpacked`, { recursive: true, force: true })
      await asar.createPackageWithOptions(extracted, archive, { unpackDir: 'node_modules' })
      rmSync(extracted, { recursive: true })
      cpSync(fixture, join(resources, 'resources/changelog'), { recursive: true })
      if (mac) {
        const plist = join(bundle, 'Contents/Info.plist')
        spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity', plist], { stdio: 'ignore' })
        command('codesign', ['--force', '--deep', '--sign', '-', bundle])
      }
      return { bundle, binary: mac ? join(bundle, 'Contents/MacOS', processName) : join(bundle, processName) }
    }
    console.log('Preparing isolated update packages from the development build')
    const installed = await makePackage(oldTag, 'installed')
    const updated = await makePackage(newTag, 'updated')
    const assets = join(serverRoot, 'assets', newTag)
    mkdirSync(assets, { recursive: true })
    const artifactName = 'release-notes-fixture.zip'
    const artifact = join(assets, artifactName)
    if (mac) command('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', updated.bundle, artifact])
    else await createZipFromUnpackedDir(updated.bundle, artifact)
    const port = await server.listen()
    const manifestPath = join(serverRoot, 'updates/daily', releaseOs, process.arch, 'latest.json')
    mkdirSync(dirname(manifestPath), { recursive: true })
    const manifest = {
      channel: 'daily', version: newTag.slice(1), tag: newTag, platform: releaseOs, arch: process.arch,
      artifactName, artifactUrl: `http://127.0.0.1:${port}/releases/download/${newTag}/${artifactName}`,
      sha256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
      publishedAt: '2099-01-01T00:00:00Z', releaseNotes: null
    }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const launchEnv = { ...process.env, ONWARD_DEBUG: '1', ONWARD_AUTOTEST: '0', ONWARD_USER_DATA_DIR: userData,
      ONWARD_UPDATE_BASE_URL: `http://127.0.0.1:${port}/updates`, ONWARD_UPDATE_CHECK_INTERVAL_MS: '3600000' }
    delete launchEnv.ONWARD_TAG
    delete launchEnv.ONWARD_CHANGELOG_ROOT
    delete launchEnv.ONWARD_SIMULATE_UPGRADE
    const launch = () => {
      stop()
      appProcess = spawn(installed.binary, [], { cwd: workspace, env: launchEnv, stdio: ['ignore', 'ignore', 'ignore'] })
    }
    const connect = async () => {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
      const page = browser.contexts()[0].pages()[0]
      await page.waitForSelector('[data-testid="sidebar-change-log-button"]')
      return page
    }
    launch()
    let lock = await waitForLockFile(userData)
    const oldPage = await connect()
    await oldPage.evaluate(() => window.electronAPI.changelog.getStartupState())
    assert.equal(await oldPage.locator('[data-testid="change-log-overlay"]').count(), 0)
    await waitForUpdaterStatus(lock.port, status => status.phase === 'downloaded', { timeoutMs: 120000 })
    // Emulate a pre-feature installation that has session history but no display marker.
    rmSync(join(userData, 'release-notes-state.json'), { force: true })
    console.log('Installing update and waiting for the installer-triggered relaunch')
    await browser.close()
    browser = null
    const exited = new Promise(resolveExit => appProcess.once('exit', resolveExit))
    assert.equal((await postJson(lock.port, '/api/debug/updater/restart')).success, true)
    await exited
    lock = await waitForLockFile(userData, { previousStartedAt: lock.startedAt, timeoutMs: 120000 })
    await waitForHealthVersion(lock.port, newTag.slice(1))
    const page = await connect()
    await page.waitForSelector('.change-log-markdown')
    await page.waitForFunction(async () => (await window.electronAPI.changelog.getStartupState()).pendingTag === null)
    assert.equal(await page.locator('.change-log-modal').getAttribute('data-locale'), 'zh-CN')
    assert.equal(await page.locator('.change-log-markdown [data-lang="zh-CN"]').first().isVisible(), true)
    assert.equal(await page.locator('.change-log-markdown [data-lang="en"]').first().isVisible(), false)
    assert.equal(JSON.parse(readFileSync(join(userData, 'release-notes-state.json'), 'utf8')).pendingVersion, null)
    console.log('PASS installer relaunch displayed and acknowledged the current release')
    await browser.close()
    browser = null
    await postJson(lock.port, '/api/debug/app/quit')
    await waitFor(() => {
      try { process.kill(lock.pid, 0); return false } catch { return true }
    })
    launch()
    lock = await waitForLockFile(userData, { previousStartedAt: lock.startedAt })
    const secondPage = await connect()
    const state = await secondPage.evaluate(() => window.electronAPI.changelog.getStartupState())
    assert.equal(state.pendingTag, null)
    assert.equal(await secondPage.locator('[data-testid="change-log-overlay"]').count(), 0)
    console.log('PASS second launch does not reopen release notes')
    if (!mac) {
      await browser.close()
      browser = null
      stop()
      Object.assign(installed, await makePackage(oldTag, 'quit-install'))
      launch()
      lock = await waitForLockFile(userData, { previousStartedAt: lock.startedAt })
      const downgradedPage = await connect()
      assert.equal((await downgradedPage.evaluate(() => window.electronAPI.changelog.getStartupState())).pendingTag, null)
      await waitForUpdaterStatus(lock.port, status => status.phase === 'downloaded', { timeoutMs: 120000 })
      await browser.close()
      browser = null
      const quitExit = new Promise(resolveExit => appProcess.once('exit', resolveExit))
      assert.equal((await postJson(lock.port, '/api/debug/app/quit')).success, true)
      await quitExit
      await waitFor(() => {
        asar.uncacheAll()
        const archive = join(installed.bundle, 'resources/app.asar')
        return JSON.parse(asar.extractFile(archive, 'package.json').toString()).tag === newTag
          && !existsSync(join(userData, 'updates/pending-update.json'))
      }, { timeoutMs: 120000, description: 'silent quit-time install' })
      launch()
      lock = await waitForLockFile(userData, { previousStartedAt: lock.startedAt })
      const manualLaunchPage = await connect()
      await manualLaunchPage.waitForSelector('.change-log-markdown')
      await manualLaunchPage.waitForFunction(async () => (await window.electronAPI.changelog.getStartupState()).pendingTag === null)
      console.log('PASS Windows quit-time install displays release notes on the next manual launch')
    }
  } finally {
    await browser?.close().catch(() => {})
    stop()
    await server.close().catch(() => {})
    cleanup()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}
