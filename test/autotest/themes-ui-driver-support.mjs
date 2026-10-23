/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, closeSync, openSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { stopLinuxMainProcessesByExecutable } from './themes-linux-process-identity.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURE_SOURCE = path.join(REPO_ROOT, 'test/autotest/fixtures/themes-ui')
export const GROUPS = ['core', 'draft', 'tasks', 'imports', 'visual', 'latency', 'persistence', 'migration', 'surfaces']
export const SETTINGS_PAGES = ['general', 'appearance', 'fonts', 'shortcuts', 'about']

export async function openSettingsPage(page, id = 'appearance') {
  assert(SETTINGS_PAGES.includes(id), `Unknown Settings page: ${id}`)
  const panel = page.locator('.settings-container')
  if (!await panel.isVisible()) await page.getByTestId('sidebar-settings-button').click()
  await panel.waitFor({ state: 'visible' })
  if (await panel.locator('.settings-content').getAttribute('data-settings-page') !== id) {
    const compact = page.getByTestId('settings-page-select')
    if (await compact.isVisible()) await compact.selectOption(id)
    else await page.getByTestId(`settings-tab-${id}`).click()
  }
  await panel.locator(`.settings-content[data-settings-page="${id}"]`).waitFor({ state: 'visible' })
  assert.equal(await panel.locator('.settings-content:visible').count(), 1, 'Exactly one Settings page is visible')
  if (id === 'appearance') await page.getByTestId('themes-root').waitFor({ state: 'visible' })
  else assert.equal(await page.getByTestId('themes-root').count(), 0, 'Leaving Appearance unmounts ThemeSelector')
}

export async function eventually(label, action, predicate, timeoutMs = 6000) {
  const started = performance.now()
  let last
  do {
    last = await action()
    if (predicate(last)) return last
    await delay(50)
  } while (performance.now() - started < timeoutMs)
  throw new Error(`${label}: timed out; last=${JSON.stringify(last)}`)
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function bounded(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds) })])
  } finally {
    clearTimeout(timer)
  }
}

export class ThemeUiHarness {
  constructor({ appBin, logFile, group }) {
    this.appBin = path.resolve(appBin)
    this.group = group
    this.results = []
    this.launches = []
    this.consoleErrors = []
    this.measurements = []
    this.cancelled = false
    this.sequence = 0
    this.startedAt = new Date().toISOString()
    const stamp = this.startedAt.replace(/[:.]/g, '-')
    this.artifacts = path.join(REPO_ROOT, 'traces/test-logs/themes-ui', `${group}-${stamp}-${process.pid}`)
    this.transcript = logFile ? path.resolve(logFile) : path.join(REPO_ROOT, 'traces/test-logs', `themes-autotest-${group}.log`)
  }

  async initialize() {
    await mkdir(this.artifacts, { recursive: true })
    await mkdir(path.dirname(this.transcript), { recursive: true })
    await writeFile(this.transcript, '')
    this.scratch = await mkdtemp(path.join(tmpdir(), 'onward-themes-ui-'))
    this.userData = path.join(this.scratch, 'profile')
    this.fixture = path.join(this.scratch, 'import fixtures 主题')
    this.workspace = path.join(this.scratch, 'workspace')
    await Promise.all([mkdir(this.userData), mkdir(this.workspace), cp(FIXTURE_SOURCE, this.fixture, { recursive: true })])
    await cp(path.join(FIXTURE_SOURCE, 'terminal-screen.txt'), path.join(this.workspace, 'terminal-screen.txt'))
    await cp(path.join(REPO_ROOT, 'test/autotest/fixtures/theme-surfaces/sample.ts'), path.join(this.workspace, 'sample.ts'))
    await this.log('START', { group: this.group, appBin: this.appBin, artifacts: this.artifacts })
  }

  async log(message, detail) {
    const line = `${new Date().toISOString()} ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`
    process.stdout.write(line)
    await Promise.all([
      appendFile(this.transcript, line),
      appendFile(path.join(this.artifacts, 'driver.log'), line)
    ])
  }

  async case(id, action) {
    assert(!this.cancelled, 'Runner canceled before next case')
    const started = performance.now()
    try {
      const detail = await action()
      assert(!this.cancelled, 'Runner canceled during case')
      this.results.push({ id, status: 'PASS', durationMs: performance.now() - started, detail })
      await this.log(`PASS ${id}`, detail)
      return detail
    } catch (error) {
      this.results.push({ id, status: 'FAIL', durationMs: performance.now() - started, error: error.stack ?? String(error) })
      await this.log(`FAIL ${id}`, { error: String(error) })
      throw error
    }
  }

  async start(colorScheme = 'dark') {
    assert(!this.cancelled, 'Runner canceled before app launch')
    assert(!this.child, 'Previous app must be stopped before relaunch')
    const { chromium } = await import('playwright-core')
    await this.stopExistingExactApp()
    assert(!this.cancelled, 'Runner canceled before spawning app')
    const port = await freePort()
    const appLog = path.join(this.artifacts, `app-${++this.sequence}.log`)
    const fd = openSync(appLog, 'w')
    try {
      this.child = spawn(this.appBin, [`--remote-debugging-port=${port}`], {
        cwd: this.workspace,
        env: {
          ...process.env,
          HOME: this.scratch,
          USERPROFILE: this.scratch,
          ZDOTDIR: this.scratch,
          ONWARD_DEBUG: '1',
          ONWARD_AUTOTEST: '1',
          ONWARD_AUTOTEST_SUITE: 'themes-ui-external',
          ONWARD_AUTOTEST_CWD: this.workspace,
          ONWARD_AUTOTEST_EXIT: '0',
          ONWARD_AUTOTEST_SKIP_CONSENT: '1',
          ONWARD_USER_DATA_DIR: this.userData,
          ONWARD_REPO_ROOT: REPO_ROOT,
          ONWARD_PERF_TRACE: ['core', 'persistence', 'latency', 'surfaces', 'imports', 'draft', 'tasks', 'visual'].includes(this.group) ? '1' : '0',
          ONWARD_AUTOTEST_THEME_NOW: this.themeNow === undefined ? '' : String(this.themeNow),
          ONWARD_DIST_DEV_OPEN: '0'
        },
        stdio: ['ignore', fd, fd],
        windowsHide: false
      })
    } finally {
      closeSync(fd)
    }
    this.exitResult = null
    this.childExit = new Promise(resolve => {
      const finish = result => {
        this.exitResult = result
        resolve(result)
      }
      this.child.once('error', error => finish({ error: String(error) }))
      this.child.once('exit', (code, signal) => finish({ code, signal }))
    })
    const launch = { pid: this.child.pid, port, log: appLog, startedAt: new Date().toISOString() }
    this.launches.push(launch)

    const connectStarted = performance.now()
    let connectError
    while (performance.now() - connectStarted < 45000) {
      assert(!this.cancelled, 'Runner canceled while attaching CDP')
      if (this.exitResult) throw new Error(`App exited before CDP attached: ${JSON.stringify(this.exitResult)}`)
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 })
        if (this.cancelled) {
          await bounded(this.browser.close().catch(() => {}), 1000)
          this.browser = null
          throw new Error('Runner canceled during CDP connection')
        }
        break
      } catch (error) {
        connectError = error
        await delay(100)
      }
    }
    if (!this.browser) throw new Error(`CDP startup failed: ${connectError}`)
    assert(!this.cancelled, 'Runner canceled after CDP connection')
    this.context = this.browser.contexts()[0]
    assert(this.context, 'Packaged app exposes a browser context')
    this.page = this.context.pages()[0] ?? await this.context.waitForEvent('page', { timeout: 10000 })
    this.page.setDefaultTimeout(7000)
    this.page.on('pageerror', error => this.consoleErrors.push({ launch: this.sequence, message: error.message }))
    await this.page.setViewportSize({ width: 1720, height: 1080 })
    await this.page.emulateMedia({ colorScheme })
    await this.page.getByTestId('sidebar-settings-button').waitFor({ state: 'visible', timeout: 25000 })
    const cwd = await this.page.evaluate(() => window.electronAPI?.debug?.autotestCwd)
    assert.equal(path.resolve(cwd ?? ''), path.resolve(this.workspace), 'CDP target belongs to this isolated app')

    // The production autotest bootstrap opens Project Editor once. Let it mount,
    // then close through its existing test boundary before interacting with UI.
    await this.page.waitForFunction(() => window.__onwardProjectEditorDebug?.isOpen(), null, { timeout: 25000 })
    await this.page.evaluate(() => window.__onwardTerminalDebug.closeAllSubpages())
    await this.page.waitForFunction(() => !window.__onwardProjectEditorDebug?.isOpen())
    await this.page.getByTestId('sidebar-settings-button').click()
    await this.page.locator('.settings-content[data-settings-page="general"]').waitFor({ state: 'visible' })
    assert.equal(await this.page.getByTestId('themes-root').count(), 0, 'Settings initially opens General, with Appearance unmounted')
    await this.openSettings()
    await this.page.waitForFunction(() => Boolean(window.__onwardThemeDebug?.getState && window.__onwardThemeDebug?.getTerminalThemes))
    const state = await this.state()
    assert.equal(state.settings.version, 4, 'getState().settings must be ThemeSettings v4')
    assert(!Object.hasOwn(state.settings, 'taskOverrides'), 'Task color overrides are retired')
    await this.log('APP_READY', { launch: this.sequence, pid: this.child.pid, port })
    return this.page
  }

  async stopExistingExactApp() {
    const exactName = path.basename(this.appBin)
    assert(exactName.startsWith('Under Development '), 'Prelaunch cleanup requires the named packaged development app')
    assert(!/[\r\n*?\[\]{}()|^$\\]/.test(exactName), 'Application name must not contain process-pattern metacharacters')
    const run = (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false })
      if (result.error) throw result.error
      assert.equal(result.signal, null, `Prelaunch ${command} completed without a signal`)
      return result
    }
    let matched = false
    let linuxIdentityCleanup
    if (process.platform === 'win32') {
      const listed = run('tasklist.exe', ['/FI', `IMAGENAME eq ${exactName}`, '/FO', 'CSV', '/NH'])
      assert.equal(listed.status, 0, `Exact-image tasklist failed: ${listed.stderr}`)
      const prefix = `"${exactName.replaceAll('"', '""')}",`
      matched = listed.stdout.split(/\r?\n/).some(line => line.startsWith(prefix))
      if (matched) {
        const killed = run('taskkill.exe', ['/F', '/IM', exactName])
        assert([0, 128].includes(killed.status), `Exact-image taskkill failed: ${killed.stderr}`)
      }
    } else if (process.platform === 'linux') {
      // Linux comm truncates long product names; require exact /proc executable
      // identity and a revalidated main-process PID instead of name matching.
      linuxIdentityCleanup = stopLinuxMainProcessesByExecutable(this.appBin)
      matched = linuxIdentityCleanup.matchedPids.length > 0
    } else {
      const listed = run('pgrep', ['-lx', exactName])
      assert([0, 1].includes(listed.status), `Exact-name pgrep failed: ${listed.stderr}`)
      matched = listed.status === 0
      if (matched) {
        // pgrep/pkill use regular expressions even with -x. Verify the names
        // actually returned before passing the exact executable name to pkill.
        const names = listed.stdout.trim().split(/\r?\n/).map(line => line.replace(/^\d+\s+/, ''))
        assert(names.every(name => name === exactName), 'Process selector matched a different application; refusing cleanup')
        const killed = run('pkill', ['-x', exactName])
        assert([0, 1].includes(killed.status), `Exact-name pkill failed: ${killed.stderr}`)
      }
    }
    await this.log('PRELAUNCH_EXACT_CLEANUP', { platform: process.platform, exactName, matched, linuxIdentityCleanup })
    await delay(500)
  }

  async openSettings(id = 'appearance') {
    await openSettingsPage(this.page, id)
  }

  async freshProfile() {
    assert(!this.child, 'Stop the owned application before creating a clean profile')
    this.userData = await mkdtemp(path.join(this.scratch, 'clean-profile-'))
  }

  async writeSettingsFixture(settings) {
    assert(!this.child, 'Stop the owned application before seeding its settings fixture')
    await writeFile(path.join(this.userData, 'settings.json'), JSON.stringify(settings, null, 2))
  }

  async state() {
    return this.page.evaluate(() => {
      const state = window.__onwardThemeDebug.getState()
      return { ...state, settings: state.settings.theme ?? state.settings }
    })
  }

  async diskSettings() {
    try {
      return JSON.parse(await readFile(path.join(this.userData, 'settings.json'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  }

  async persisted(theme) {
    return eventually('theme persisted to real settings.json', () => this.diskSettings(), data =>
      isDeepStrictEqual(data?.theme, theme), 8000)
  }

  async screenshot(name) {
    const filename = path.join(this.artifacts, `${String(this.sequence).padStart(2, '0')}-${name}.png`)
    await this.page.screenshot({ path: filename, fullPage: true, timeout: 3000 })
    return filename
  }

  async buildVsix() {
    const { default: yazl } = await import('yazl')
    const source = path.join(this.fixture, 'vsix-source')
    const zip = new yazl.ZipFile()
    const addDirectory = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) await addDirectory(absolute)
        else zip.addFile(absolute, path.relative(source, absolute).split(path.sep).join('/'))
      }
    }
    await addDirectory(source)
    const target = path.join(this.fixture, 'Acceptance theme pair.vsix')
    const done = pipeline(zip.outputStream, createWriteStream(target))
    zip.end()
    await done
    return target
  }

  async stop(requireCleanExit = false) {
    if (!this.child) return
    if (!this.exitResult) {
      // Only this app's own debug IPC or child handle may terminate it.
      await bounded(this.page?.evaluate(() => window.electronAPI.debug.quit()).catch(() => {}), 1500)
      let exited = await bounded(this.childExit, 10000)
      if (!exited) {
        this.child.kill('SIGTERM')
        exited = await bounded(this.childExit, 2500)
      }
      if (!exited) {
        this.child.kill('SIGKILL')
        await bounded(this.childExit, 1500)
      }
    }
    const result = this.exitResult
    this.launches[this.launches.length - 1].exit = result
    if (this.browser) await bounded(this.browser.close().catch(() => {}), 1000)
    this.browser = null
    this.page = null
    this.child = null
    assert(result, 'Owned app exited before scratch cleanup')
    if (requireCleanExit) {
      assert.deepEqual(result, { code: 0, signal: null }, 'Restart scenario requires a clean natural app exit')
    }
  }

  async finish(error) {
    let finalError = error
    try {
      await this.stop(!error)
    } catch (cleanupError) {
      finalError ??= cleanupError
    }
    if (this.scratch) {
      try {
        await rm(this.scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
      } catch (cleanupError) {
        finalError ??= cleanupError
      }
    }
    if (this.consoleErrors.length) finalError ??= new Error(`Renderer errors: ${JSON.stringify(this.consoleErrors)}`)
    const report = {
      group: this.group,
      status: finalError ? 'FAIL' : 'PASS',
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      platform: process.platform,
      appBin: this.appBin,
      launches: this.launches,
      cases: this.results,
      consoleErrors: this.consoleErrors,
      measurements: this.measurements,
      error: finalError ? finalError.stack ?? String(finalError) : null
    }
    await writeFile(path.join(this.artifacts, 'results.json'), JSON.stringify(report, null, 2))
    await this.log(`RESULT: ${report.status}`, { cases: this.results.length, report: path.join(this.artifacts, 'results.json'), error: report.error })
    return report.status === 'PASS' ? 0 : 1
  }
}
