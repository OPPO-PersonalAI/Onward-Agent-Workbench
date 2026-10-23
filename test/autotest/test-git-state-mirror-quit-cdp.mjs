/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright-core'

const exec = promisify(execFile)
const ROOT = process.env.REPO_ROOT || process.cwd()
const APP_BIN = process.env.APP_BIN
const GROUP = process.env.GSM_QUIT_GROUP || 'normal'
const TRIALS = 5
// User-approved total, shared with production. The observer timeout is only
// a test-harness kill guard, never the latency acceptance threshold.
const EXIT_BUDGET_MS = 10_000
// User-approved extreme stress latency budgets (2026-10-15):
// - Standard extreme stress (queue-flood, cancel-storm-under-load, signal-supersedes-dialog): <= 1500 ms
// - Compound fault storm / SIGHUP-ignoring process tree (sighup-trap, compound-fault-storm): <= 2000 ms
const EXTREME_STRESS_BUDGET_MS = 1_500
const EXTREME_COMPOUND_HOLD_BUDGET_MS = 2_000
const OBSERVER_TIMEOUT_MS = 15_000
const LOG = process.env.LOG_FILE || join(ROOT, 'traces/test-logs', `quit-${GROUP}.log`)
const RESULT = process.env.RESULT_FILE || join(ROOT, 'traces/analysis', `quit-${GROUP}.json`)
const fixtures = join(ROOT, 'test/autotest/fixtures/quit-stress')
const draft = JSON.parse(readFileSync(join(fixtures, 'prompt-draft.json'), 'utf8'))
const groups = {
  normal: ['startup', 'menu', 'duplicate', 'cancel', 'external', 'window'],
  pressure: ['churn', 'pending-subscribe', 'pending-unsubscribe', 'recovery', 'update'],
  faults: ['service-exit', 'exit-race', 'save-hang', 'telemetry-hang'],
  'service-shutdown': ['shutdown-hang', 'blocked-service'],
  signals: process.platform === 'win32' ? ['parent-death'] : ['sigterm', 'sigint', 'parent-death'],
  extreme: process.platform === 'win32'
    ? ['sighup-trap', 'queue-flood', 'compound-fault-storm', 'cancel-storm-under-load']
    : ['sighup-trap', 'queue-flood', 'compound-fault-storm', 'cancel-storm-under-load', 'signal-supersedes-dialog']
}
const scenarios = process.env.GSM_QUIT_CASE
  ? groups[GROUP]?.filter(scenario => scenario === process.env.GSM_QUIT_CASE)
  : groups[GROUP]
assert.ok(scenarios, `Unknown quit group: ${GROUP}`)
assert.ok(scenarios.length, 'No matching quit scenarios')
assert.ok(APP_BIN, 'APP_BIN is required')
mkdirSync(resolve(LOG, '..'), { recursive: true })
mkdirSync(resolve(RESULT, '..'), { recursive: true })
writeFileSync(LOG, '')
const scratch = mkdtempSync(join(tmpdir(), 'onward-quit-stress-'))
const owned = new Set()
const results = []
const log = text => { appendFileSync(LOG, `${text}\n`); console.log(text) }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

function isolatedEnvironment() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(fixtures, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT']) delete env[name]
  return env
}

async function waitUntil(predicate, timeout = 10_000) {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error('Condition did not settle')
}

function childExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode })
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function bounded(promise, ms) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Observer exceeded ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function createRepo(path) {
  const options = { cwd: path, env: isolatedEnvironment() }
  mkdirSync(path, { recursive: true })
  cpSync(join(fixtures, 'tracked.txt'), join(path, 'tracked.txt'))
  await exec('git', ['init'], options)
  for (const [key, value] of [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['user.name', 'Onward Autotest'], ['user.email', 'autotest@example.invalid']]) {
    await exec('git', ['config', key, value], options)
  }
  await exec('git', ['add', 'tracked.txt'], options)
  await exec('git', ['commit', '-m', 'Initial quit stress fixture'], options)
}

async function launch(profile, cwd, scenario) {
  const home = join(profile, 'home')
  const temporary = join(profile, 'tmp')
  for (const path of [home, temporary, join(home, '.config'), join(home, '.cache'), join(home, '.local/share'), join(home, 'AppData/Roaming'), join(home, 'AppData/Local')]) {
    mkdirSync(path, { recursive: true })
  }
  const app = await electron.launch({
    executablePath: APP_BIN,
    env: {
      ...isolatedEnvironment(), ONWARD_DEBUG: '1', ONWARD_AUTOTEST: '1', ONWARD_AUTOTEST_EXIT: '0',
      HOME: home, USERPROFILE: home, ZDOTDIR: home, USER_ZDOTDIR: home,
      HISTFILE: join(home, '.history'), XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
      APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      ONWARD_AUTOTEST_SUITE: 'external-quit-stress', ONWARD_AUTOTEST_QUIT_STRESS: '1',
      ONWARD_AUTOTEST_SKIP_CONSENT: '1', ONWARD_USER_DATA_DIR: profile,
      ONWARD_AUTOTEST_WINDOWS_CLEAN_SHELL: '1',
      ONWARD_AUTOTEST_CWD: cwd, ONWARD_REPO_ROOT: ROOT,
      ONWARD_AUTOTEST_WATCHER_HANG_SHUTDOWN: scenario === 'shutdown-hang' ? '1' : '0',
      ONWARD_AUTOTEST_WATCHER_HANG_SUBSCRIBE: scenario === 'pending-subscribe' ? '1' : '0',
      ONWARD_AUTOTEST_WATCHER_HANG_UNSUBSCRIBE: ['pending-unsubscribe', 'compound-fault-storm'].includes(scenario) ? '1' : '0',
      ONWARD_AUTOTEST_QUIT_HOLD_STAGE: scenario === 'save-hang' ? 'app-state' : ''
    }, timeout: 30_000
  })
  const child = app.process()
  owned.add(child)
  const exit = childExit(child)
  let output = ''
  const capture = data => { output += data.toString(); appendFileSync(LOG, data) }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  if (scenario === 'startup') {
    const started = performance.now()
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()) }).catch(() => {})
    return { app, page: null, child, exit, started, output: () => output }
  }
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.electronAPI?.git && window.electronAPI?.appState)
  await page.locator('.terminal-grid').waitFor({ timeout: 20_000 })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  return { app, page, child, exit, output: () => output }
}

async function menuQuit(app, duplicates = 1) {
  await app.evaluate(({ Menu, BrowserWindow }, count) => {
    const flatten = menu => menu.items.flatMap(item => [item, ...(item.submenu ? flatten(item.submenu) : [])])
    const item = flatten(Menu.getApplicationMenu()).find(item => /(?:CommandOrControl|CmdOrCtrl)\+Q/i.test(item.accelerator || ''))
    if (!item) {
      // Windows/Linux exit through the real window-close handler.
      BrowserWindow.getAllWindows()[0].close()
      return
    }
    for (let i = 0; i < count; i++) void item.click()
  }, duplicates).catch(error => {
    if (!/closed|destroyed|Target/i.test(String(error))) throw error
  })
}

async function subscribe(page, repos) {
  await page.evaluate(async paths => {
    globalThis.__quitTreeEvents = []
    window.electronAPI.project.onTreeWatchEvent(event => globalThis.__quitTreeEvents.push(event))
    for (const cwd of paths) {
      await window.electronAPI.git.subscribeMirror(cwd)
      await window.electronAPI.project.treeWatchStart(cwd)
    }
  }, repos)
}

async function openPrompt(page) {
  await page.keyboard.press('Escape')
  const notebook = page.locator('.prompt-notebook:not(.prompt-notebook-hidden)')
  const content = notebook.locator('.prompt-editor-content[contenteditable="plaintext-only"]')
  if (!await content.isVisible()) await page.getByTitle('Prompt notebook', { exact: true }).click()
  await content.waitFor({ state: 'visible' })
  return { content, title: notebook.locator('.prompt-editor-title') }
}

async function trial(scenario, index) {
  const dir = join(scratch, `${scenario}-${index}`)
  const profile = join(dir, 'profile')
  const repos = [0, 1, 2].map(i => join(dir, `repo-${i}`))
  for (const repo of repos) await createRepo(repo)
  if (scenario === 'startup') {
    mkdirSync(profile, { recursive: true })
    cpSync(join(fixtures, 'startup-state.json'), join(profile, 'app-state.json'))
  }
  let running = null
  let churnTimer = null
  let mutations = 0
  let servicePid = null
  const pressurePids = []
  const nohupPids = []
  const result = { scenario, trial: index, ok: false }
  try {
    running = await launch(profile, repos[0], scenario)
    const { app, page, child, exit } = running
    if (scenario === 'startup') {
      const outcome = await bounded(exit, OBSERVER_TIMEOUT_MS)
      assert.equal(outcome.code, 0)
      assert.equal(outcome.signal, null)
      const saved = JSON.parse(readFileSync(join(profile, 'app-state.json'), 'utf8'))
      assert.ok(saved.globalPrompts.some(prompt => prompt.id === 'quit-startup-sentinel' && prompt.content === 'Startup exit must preserve this previously saved content.'))
      assert.doesNotMatch(running.output(), /napi_fatal_error|FATAL ERROR|SIGABRT/)
      for (const match of running.output().matchAll(/\[WatcherService\] spawned \{ pid: (\d+) \}/g)) {
        await waitUntil(() => !alive(Number(match[1])), 5000)
      }
      Object.assign(result, { ok: true, elapsedMs: performance.now() - running.started, exit: outcome })
      log(`PASS GSMQ-normal ${JSON.stringify(result)}`)
      return
    }
    await subscribe(page, repos)
    await waitUntil(async () => {
      const state = await app.evaluate(() => globalThis.__onwardQuitAutotest.inspect())
      servicePid = state.pid
      return Boolean(servicePid) && (scenario === 'pending-subscribe' ? state.pending > 0 : state.subscriptions >= 3 && state.pending === 0)
    })
    assert.notEqual(servicePid, child.pid, 'Watcher must live outside the main process')
    const nativeInMain = await app.evaluate(({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
      const modules = Object.keys(require.cache)
      const libraries = process.report.getReport().sharedObjects
      return [...modules, ...libraries].some(path => /[/\\]watcher\.node$/.test(path))
    })
    assert.equal(nativeInMain, false, 'Main process loaded watcher.node')
    log(`GSMQ-01 isolated watcher ready scenario=${scenario} trial=${index} pid=${servicePid}`)

    if (scenario !== 'pending-subscribe') {
      for (const repo of repos) appendFileSync(join(repo, 'tracked.txt'), `trial-${index}\n`)
      await page.waitForFunction(async cwd => {
        const state = await window.electronAPI.git.getMirror(cwd)
        return state?.files?.some(file => file.filename === 'tracked.txt')
      }, repos[0], { timeout: 15_000 })
      log(`GSMQ-02 file changes observed scenario=${scenario} trial=${index}`)
    }
    if (scenario === 'service-exit') {
      const previousPid = servicePid
      await app.evaluate(() => globalThis.__onwardQuitAutotest.faultWatcher())
      await waitUntil(async () => {
        const state = await app.evaluate(() => globalThis.__onwardQuitAutotest.inspect())
        servicePid = state.pid
        return servicePid && servicePid !== previousPid && state.pending === 0
      })
      assert.equal(alive(previousPid), false)
      const created = join(repos[0], 'recovered.txt')
      cpSync(join(fixtures, 'tracked.txt'), created)
      await page.waitForFunction(() => globalThis.__quitTreeEvents.some(event => event.added?.includes('recovered.txt')))
      log(`GSMQ-05 utility fault isolated and watcher recovered trial=${index}`)
    }

    if (scenario === 'cancel') {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
      await menuQuit(app, 10)
      await page.waitForTimeout(100)
      assert.equal(child.exitCode, null)
      assert.equal((await app.evaluate(() => globalThis.__onwardQuitAutotest.inspect())).stopping, false)
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    }

    if (['blocked-service', 'parent-death', 'compound-fault-storm'].includes(scenario)) {
      await app.evaluate(() => globalThis.__onwardQuitAutotest.blockWatcher())
    }
    if (['telemetry-hang', 'compound-fault-storm'].includes(scenario)) {
      await app.evaluate(() => globalThis.__onwardQuitAutotest.hangTelemetry())
    }

    if (scenario === 'churn') {
      const script = join(dir, 'output-pressure.cjs')
      cpSync(join(fixtures, 'output-pressure.cjs'), script)
      const pidFiles = Array.from({ length: 12 }, (_, i) => join(dir, `pressure-${i}.pid`))
      await page.evaluate(async ({ cwd, node, script, pidFiles }) => {
        globalThis.__quitOutputBytes = 0
        window.electronAPI.terminal.onData((id, data) => {
          if (id.startsWith('quit-pressure-')) globalThis.__quitOutputBytes += data.length
        })
        for (let i = 0; i < 12; i++) {
          const id = `quit-pressure-${i}`
          await window.electronAPI.terminal.create(id, { cwd })
          window.electronAPI.terminal.setOutputVisibility(id, true)
          const caps = await window.electronAPI.terminal.getInputCapabilities(id)
          const command = `${caps.shellKind === 'powershell' ? '& ' : ''}"${node}" "${script}" "${pidFiles[i]}"\r`
          await window.electronAPI.terminal.write(id, command)
        }
      }, { cwd: repos[0], node: process.execPath, script, pidFiles })
      await waitUntil(() => Array.from({ length: 12 }, (_, i) => existsSync(join(dir, `pressure-${i}.pid`))).every(Boolean))
      for (let i = 0; i < 12; i++) pressurePids.push(Number(readFileSync(join(dir, `pressure-${i}.pid`), 'utf8')))
      await page.waitForFunction(() => globalThis.__quitOutputBytes >= 256 * 1024)
      result.outputBytes = await page.evaluate(() => globalThis.__quitOutputBytes)
    }

    if (['sighup-trap', 'compound-fault-storm'].includes(scenario)) {
      const count = scenario === 'sighup-trap' ? 6 : 4
      const script = join(dir, 'sighup-trap-tree.cjs')
      cpSync(join(fixtures, 'sighup-trap-tree.cjs'), script)
      const pidFiles = Array.from({ length: count }, (_, i) => join(dir, `sighup-${i}.pid`))
      const nohupPidFile = scenario === 'sighup-trap' && process.platform !== 'win32'
        ? join(dir, 'nohup-0.pid')
        : null
      await page.evaluate(async ({ cwd, node, script, pidFiles, count, nohupPidFile }) => {
        globalThis.__quitOutputBytes = 0
        window.electronAPI.terminal.onData((id, data) => {
          if (id.startsWith('quit-sighup-')) globalThis.__quitOutputBytes += data.length
        })
        for (let i = 0; i < count; i++) {
          const id = `quit-sighup-${i}`
          await window.electronAPI.terminal.create(id, { cwd })
          window.electronAPI.terminal.setOutputVisibility(id, true)
          const caps = await window.electronAPI.terminal.getInputCapabilities(id)
          if (i === 0 && nohupPidFile && caps.shellKind !== 'powershell' && caps.shellKind !== 'cmd') {
            await window.electronAPI.terminal.write(
              id,
              `nohup "${node}" "${script}" "${nohupPidFile}" </dev/null >/dev/null 2>&1 &\r`
            )
          }
          const command = `${caps.shellKind === 'powershell' ? '& ' : ''}"${node}" "${script}" "${pidFiles[i]}"\r`
          await window.electronAPI.terminal.write(id, command)
        }
      }, { cwd: repos[0], node: process.execPath, script, pidFiles, count, nohupPidFile })
      await waitUntil(() => Array.from({ length: count }, (_, i) => existsSync(join(dir, `sighup-${i}.pid`))).every(Boolean))
      if (nohupPidFile) {
        await waitUntil(() => existsSync(nohupPidFile))
        const parsedNohup = readFileSync(nohupPidFile, 'utf8')
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter(pid => Number.isFinite(pid) && pid > 1)
        assert.equal(parsedNohup.length, 2, 'Expected both parent and child PIDs from background nohup job')
        nohupPids.push(...parsedNohup)
      }
      for (let i = 0; i < count; i++) {
        const parsedPids = readFileSync(join(dir, `sighup-${i}.pid`), 'utf8')
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter(pid => Number.isFinite(pid) && pid > 1)
        assert.equal(parsedPids.length, 2, 'Expected both parent and child PIDs from sighup-trap-tree.cjs')
        pressurePids.push(...parsedPids)
      }
      await page.waitForFunction(() => globalThis.__quitOutputBytes >= 64 * 1024)
      result.outputBytes = await page.evaluate(() => globalThis.__quitOutputBytes)
      result.trackedTrapPids = pressurePids.length
      if (nohupPids.length > 0) result.sparedNohupPids = nohupPids.length
    }

    churnTimer = setInterval(() => {
      for (const repo of repos) {
        const path = join(repo, `churn-${mutations % 32}.txt`)
        cpSync(join(fixtures, 'tracked.txt'), path)
        if (mutations % 3 === 0) rmSync(path, { force: true })
      }
      mutations++
    }, 4)

    if (scenario === 'cancel-storm-under-load') {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
      for (let round = 0; round < 5; round++) {
        await menuQuit(app, 5)
        await page.waitForTimeout(40)
      }
      assert.equal(child.exitCode, null)
      const postCancelWatcher = await app.evaluate(() => globalThis.__onwardQuitAutotest.inspect())
      assert.equal(postCancelWatcher.stopping, false, 'Watcher entered stopping state on cancelled quit')
      assert.equal(postCancelWatcher.pid, servicePid, 'Watcher PID changed across cancelled quits')
      const createdAfterCancel = await page.evaluate(cwd => window.electronAPI.terminal.create('post-cancel-term', { cwd }), repos[1])
      assert.equal(createdAfterCancel.success, true, 'Terminal creation rejected after cancelled quit')
      const postCancelFile = join(repos[0], `post-cancel-${index}.txt`)
      cpSync(join(fixtures, 'tracked.txt'), postCancelFile)
      await page.waitForFunction(expected => globalThis.__quitTreeEvents.some(event => event.added?.includes(expected)), `post-cancel-${index}.txt`, { timeout: 10_000 })
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    }

    const savesDraft = [
      'churn', 'recovery', 'update', 'save-hang',
      'sighup-trap', 'queue-flood', 'compound-fault-storm', 'cancel-storm-under-load', 'signal-supersedes-dialog'
    ].includes(scenario)
    if (savesDraft) {
      const prompt = await openPrompt(page)
      await prompt.title.fill(draft.title)
      await prompt.content.fill(draft.content)
    }
    if (['queue-flood', 'compound-fault-storm'].includes(scenario)) {
      const flooded = await app.evaluate(
        (_, isCompound) => globalThis.__onwardQuitAutotest.floodQueues(isCompound ? 100 : 150, isCompound ? 30 : 50),
        scenario === 'compound-fault-storm'
      )
      assert.ok(flooded.schedulerQueued >= 80, `Expected flooded scheduler queue, got ${flooded.schedulerQueued}`)
      result.floodedQueues = flooded
    }
    if (scenario === 'save-hang') {
      const saved = await page.evaluate(async language => {
        const settings = await window.electronAPI.settings.load()
        return window.electronAPI.settings.save({ ...settings, language })
      }, index % 2 === 0 ? 'zh-CN' : 'en')
      assert.equal(saved, true)
    }

    let started = performance.now()
    const quitLogOffset = running.output().length
    if (scenario === 'parent-death') child.kill('SIGKILL')
    else if (scenario === 'sigterm' || scenario === 'sigint') child.kill(scenario === 'sigterm' ? 'SIGTERM' : 'SIGINT')
    else if (scenario === 'signal-supersedes-dialog') {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = () => new Promise(() => {})
      })
      await menuQuit(app, 10)
      await waitUntil(() => running.output().slice(quitLogOffset).includes('confirmation-start'))
      started = performance.now()
      child.kill('SIGTERM')
    } else if (scenario === 'external') await app.evaluate(({ app }) => {
      const baseline = app.listenerCount('will-quit')
      for (let i = 0; i < 20; i++) app.quit()
      if (app.listenerCount('will-quit') > baseline) throw new Error('Repeated quit accumulated lifecycle listeners')
    })
    else if (scenario === 'exit-race') await app.evaluate(({ app }) => {
      app.quit()
      globalThis.__onwardQuitAutotest.faultWatcher()
    }).catch(() => {})
    else if (scenario === 'window') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      if (process.platform === 'darwin') {
        assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
        await menuQuit(app)
      }
    } else if (scenario === 'recovery' || scenario === 'update') {
      await app.evaluate(({ app }, mode) => {
        app.relaunch = () => { console.log('[QuitStress] relaunch-requested') }
        void globalThis.__onwardQuitAutotest[mode]()
      }, scenario)
    } else await menuQuit(app, scenario === 'duplicate' ? 50 : 1)
    if (scenario === 'save-hang') {
      await waitUntil(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isEnabled()))
      await app.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const baseline = app.listenerCount('will-quit')
        for (let i = 0; i < 20; i++) { app.quit(); window.close() }
        if (window.isDestroyed()) throw new Error('Repeated exit destroyed the window during a required save')
        if (app.listenerCount('will-quit') > baseline) throw new Error('Repeated quit accumulated lifecycle listeners')
      })
      const lateCreate = await page.evaluate(cwd => window.electronAPI.terminal.create('quit-late-terminal', { cwd }), repos[0])
      assert.equal(lateCreate.success, false, 'New terminal work was admitted after quit began')
      assert.equal(lateCreate.error, index % 2 === 0 ? '\u5e94\u7528\u6b63\u5728\u9000\u51fa\u3002' : 'The application is closing.')
    }
    const outcome = await bounded(exit, OBSERVER_TIMEOUT_MS)
    result.mainExitMs = performance.now() - started
    result.exit = outcome
    if (scenario === 'parent-death') {
      assert.ok(outcome.signal !== null || outcome.code !== 0)
    } else {
      assert.equal(outcome.signal, null)
      assert.equal(outcome.code, scenario === 'save-hang' ? 1 : 0)
    }
    await waitUntil(() => !alive(servicePid), 5000)
    for (const pid of pressurePids) await waitUntil(() => !alive(pid), 5000)
    for (const pid of nohupPids) {
      assert.equal(alive(pid), true, `Background nohup process ${pid} must survive terminal quit`)
    }
    result.elapsedMs = performance.now() - started
    const ledger = JSON.parse(readFileSync(join(profile, 'session-ledger.json'), 'utf8'))
    result.ledger = ledger.clean
    assert.equal(ledger.clean, !['save-hang', 'parent-death'].includes(scenario))
    if (scenario === 'sighup-trap') {
      assert.ok((ledger.terminatedActiveJobs ?? 0) >= 6, `Expected terminatedActiveJobs >= 6 in session ledger, got ${ledger.terminatedActiveJobs}`)
    }
    if (['queue-flood', 'compound-fault-storm'].includes(scenario)) {
      assert.match(running.output().slice(quitLogOffset), /background-work-aborted.*"schedulerCancelled":[1-9]\d*/)
      assert.match(running.output().slice(quitLogOffset), /background-work-aborted.*"gitQueuedCancelled":[1-9]\d*/)
    }
    if (scenario === 'signal-supersedes-dialog') {
      assert.match(running.output().slice(quitLogOffset), /stage-start \{"reason":"signal","stage":"renderer-state"\}/)
    }
    if (savesDraft && scenario !== 'save-hang') {
      const persisted = JSON.parse(readFileSync(join(profile, 'app-state.json'), 'utf8'))
      assert.ok(persisted.tabs.some(tab => tab.editorDraft?.title === draft.title && tab.editorDraft?.content === draft.content), 'Last input was not persisted before process exit')
    }
    assert.doesNotMatch(running.output(), /napi_fatal_error|FATAL ERROR|SIGABRT|Access violation|0xC0000005/)
    if (scenario === 'recovery') assert.match(running.output(), /relaunch-requested/)
    if (scenario === 'update') assert.match(running.output(), /update-install-requested/)
    assert.doesNotMatch(running.output().slice(quitLogOffset), /\[WatcherService\] spawned/, 'Watcher restarted after quit began')
    if (scenario === 'save-hang') {
      assert.match(running.output(), /deadline.*deadlineMs.*10000/)
    } else {
      assert.doesNotMatch(running.output(), /\[QuitPhase\] deadline /, 'Teardown used its 10s emergency deadline instead of bounded service shutdown')
    }
    if (['recovery', 'update'].includes(scenario)) {
      const reopened = await launch(profile, repos[0], 'reopened')
      const state = await reopened.page.evaluate(() => window.electronAPI.appState.load())
      assert.ok(state.tabs.some(tab => tab.editorDraft?.title === draft.title && tab.editorDraft?.content === draft.content), 'Last user input was not restored')
      const prompt = await openPrompt(reopened.page)
      assert.equal(await prompt.title.inputValue(), draft.title)
      assert.equal(await prompt.content.innerText(), draft.content)
      await menuQuit(reopened.app)
      assert.equal((await bounded(reopened.exit, OBSERVER_TIMEOUT_MS)).code, 0)
    }
    result.ok = true
    result.mutations = mutations
    log(`PASS GSMQ-${GROUP} ${JSON.stringify(result)}`)
  } catch (error) {
    result.error = String(error?.stack ?? error)
    log(`FAIL GSMQ-${GROUP} ${JSON.stringify(result)}`)
  } finally {
    clearInterval(churnTimer)
    for (const child of owned) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await bounded(childExit(child), 5000).catch(() => {})
      }
      owned.delete(child)
    }
    for (const pid of [...pressurePids, ...nohupPids]) {
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
    if (servicePid && alive(servicePid)) { try { process.kill(servicePid, 'SIGKILL') } catch {} }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    results.push(result)
  }
}

async function cleanup() {
  await Promise.all([...owned].map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await bounded(childExit(child), 5000).catch(() => {})
    }
  }))
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(1)) })

try {
  for (const scenario of scenarios) {
    for (let trialIndex = 1; trialIndex <= TRIALS; trialIndex++) await trial(scenario, trialIndex)
    const samples = results.filter(result => result.scenario === scenario)
    // Boolean integrity requires every trial; latency uses >=1 of 3 as specified
    // by the repository's timing gate, with setup excluded from measurement.
    assert.ok(samples.every(result => result.ok), `${scenario}: one or more trials failed`)
    const scenarioBudgetMs = ['sighup-trap', 'compound-fault-storm'].includes(scenario)
      ? EXTREME_COMPOUND_HOLD_BUDGET_MS
      : ['queue-flood', 'cancel-storm-under-load', 'signal-supersedes-dialog'].includes(scenario)
        ? EXTREME_STRESS_BUDGET_MS
        : EXIT_BUDGET_MS
    assert.ok(
      samples.slice(0, 3).some(result => result.elapsedMs <= scenarioBudgetMs),
      `${scenario}: all latency samples exceed the approved ${scenarioBudgetMs}ms budget`
    )
  }
} catch (error) {
  log(`Suite failure: ${error.stack}`)
  process.exitCode = 1
} finally {
  writeFileSync(RESULT, JSON.stringify({ ok: !process.exitCode && results.every(result => result.ok), group: GROUP, results }, null, 2))
  await cleanup()
}
