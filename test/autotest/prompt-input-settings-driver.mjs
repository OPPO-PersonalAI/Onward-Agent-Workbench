/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ThemeUiHarness, eventually } from './themes-ui-driver-support.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = path.join(ROOT, 'test/autotest/fixtures/prompt-input-settings')
const TRIALS = 5
// This is an execution watchdog, not a product latency assertion. Leave the
// default 180-second orchestrator budget room to collect evidence and clean up.
const WORK_DEADLINE_MS = 150000
const DEFAULT_TIMEOUT_MS = 6000
const WIDTHS = [300, 400, 499, 500, 600]
const LANGUAGES = ['en', 'zh-CN']
const INPUT_PAGE = 'shortcuts'
const EXTERNAL_SUITE = 'prompt-input-settings-external'
const UI = {
  root: 'prompt-input-settings', leader: 'prompt-input-leader', timeout: 'prompt-input-timeout',
  add: 'prompt-input-add', save: 'prompt-input-save', status: 'prompt-input-status',
  row: 'prompt-input-action'
}

function under(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function freePort() {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return server.address().port
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

/** Only generic lifecycle, disk, screenshot and reporting helpers are inherited. */
class InputSettingsHarness extends ThemeUiHarness {
  constructor(options, acceptance) {
    super({ ...options, group: 'prompt-input-settings' })
    this.acceptance = acceptance
    this.artifacts = path.join(ROOT, 'traces/test-logs/prompt-input-settings', `${Date.now()}-${process.pid}`)
    this.transcript = options.logFile ? path.resolve(options.logFile) : path.join(ROOT, 'traces/test-logs/prompt-input-settings-autotest.log')
    assert(under(path.join(ROOT, 'traces'), this.transcript), 'Runner logs must remain under the checkout traces directory')
  }

  async initialize() {
    await mkdir(this.artifacts, { recursive: true })
    await mkdir(path.dirname(this.transcript), { recursive: true })
    await writeFile(this.transcript, '')
    this.scratch = await mkdtemp(path.join(tmpdir(), 'onward-prompt-input-settings-'))
    this.userData = path.join(this.scratch, 'owned profile')
    this.workspace = path.join(this.scratch, this.acceptance.workspaceName)
    await mkdir(this.userData)
    await cp(path.join(FIXTURES, 'workspace'), this.workspace, { recursive: true })
    const source = await readFile(path.join(FIXTURES, 'legacy-settings-v9.json'), 'utf8')
    const legacyText = source.replace(/\r?\n/g, '\r\n')
    assert.equal(this.acceptance.legacyCopyLineEndings, 'CRLF')
    assert(legacyText.includes('\r\n') && /[^\u0000-\u007f]/.test(legacyText), 'The on-disk migration case includes CRLF and Unicode')
    await writeFile(path.join(this.userData, 'settings.json'), legacyText, 'utf8')
    this.legacy = JSON.parse(legacyText)
    await this.log('START', { platform: process.platform, trials: TRIALS, artifacts: this.artifacts })
  }

  async stop(requireCleanExit = false) {
    if (this.stopping) return this.stopping
    const pid = this.child?.pid
    this.stopping = (async () => {
      await super.stop(requireCleanExit)
      if (!pid) return
      const directory = path.join(ROOT, 'traces/perf')
      const destination = path.join(this.artifacts, 'perf')
      await mkdir(destination, { recursive: true })
      for (const filename of await readdir(directory)) {
        if (filename.endsWith(`-${pid}.jsonl`) || filename.endsWith(`-${pid}.json`)) {
          await cp(path.join(directory, filename), path.join(destination, filename))
        }
      }
    })()
    try { await this.stopping }
    finally { this.stopping = null }
  }

  async start() {
    assert(!this.cancelled && !this.child, 'Only one owned app may be running')
    assert(this.scratch && this.workspace && this.userData, 'Owned fixtures must be initialized before launch')
    const { chromium } = await import('playwright-core')
    await this.stopExistingExactApp()
    assert(!this.cancelled, 'Runner canceled before launch')
    const port = await freePort()
    assert(!this.cancelled, 'Runner canceled before child creation')
    const appLog = path.join(this.artifacts, `app-${++this.sequence}.log`)
    const fd = openSync(appLog, 'w')
    this.exitResult = null
    try {
      this.child = spawn(this.appBin, [`--remote-debugging-port=${port}`], {
        cwd: this.workspace,
        env: {
          ...process.env,
          HOME: this.scratch, USERPROFILE: this.scratch, ZDOTDIR: this.scratch,
          ONWARD_DEBUG: '1', ONWARD_PROFILE: '0', ONWARD_AUTOTEST: '1', ONWARD_AUTOTEST_EXIT: '0',
          ONWARD_AUTOTEST_SUITE: EXTERNAL_SUITE, ONWARD_AUTOTEST_SKIP_CONSENT: '1',
          ONWARD_AUTOTEST_CWD: this.workspace, ONWARD_USER_DATA_DIR: this.userData,
          ONWARD_REPO_ROOT: ROOT, ONWARD_PERF_TRACE: '1', ONWARD_DIST_DEV_OPEN: '0'
        },
        stdio: ['ignore', fd, fd], windowsHide: false
      })
    } finally {
      closeSync(fd)
    }
    this.childExit = new Promise(resolve => {
      const finish = result => { this.exitResult = result; resolve(result) }
      this.child.once('error', error => finish({ error: String(error) }))
      this.child.once('exit', (code, signal) => finish({ code, signal }))
    })
    this.launches.push({ pid: this.child.pid, port, log: appLog, startedAt: new Date().toISOString() })
    await eventually('owned app CDP connection', async () => {
      assert(!this.cancelled, 'Runner canceled during CDP connection')
      assert(!this.exitResult, `Owned app exited before connection: ${JSON.stringify(this.exitResult)}`)
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 })
        if (this.cancelled) {
          await this.browser.close().catch(() => {})
          this.browser = null
          return false
        }
        return true
      } catch {
        return false
      }
    }, Boolean, 30000)
    assert(!this.cancelled, 'Runner canceled after CDP connection')
    this.context = this.browser.contexts()[0]
    assert(this.context, 'Packaged app exposes a browser context')
    await this.context.setOffline(true)
    this.page = this.context.pages()[0] ?? await this.context.waitForEvent('page', { timeout: 10000 })
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
    this.page.on('pageerror', error => this.consoleErrors.push({ launch: this.sequence, message: error.message }))
    await this.page.setViewportSize({ width: 1400, height: 1000 })
    await this.page.getByTestId('sidebar-settings-button').waitFor({ state: 'visible', timeout: 25000 })
    const identity = await this.page.evaluate(() => ({
      cwd: window.electronAPI?.debug?.autotestCwd,
      suite: window.electronAPI?.debug?.autotestSuite,
      platform: window.electronAPI?.platform
    }))
    assert.equal(path.resolve(identity.cwd ?? ''), path.resolve(this.workspace), 'CDP must connect to this runner profile')
    assert.equal(identity.suite, EXTERNAL_SUITE, 'The owned renderer runs only the external Settings suite')
    assert.equal(identity.platform, process.platform, 'Visual label expectations use the app host platform')
    this.platform = identity.platform
    // Wait for the automatic bootstrap before closing it, so a late editor
    // open cannot steal focus from the Settings recorder during this scenario.
    await this.page.waitForFunction(() => window.__onwardProjectEditorDebug?.isOpen() &&
      typeof window.__onwardTerminalDebug?.closeAllSubpages === 'function', null, { timeout: 25000 })
    await this.page.evaluate(() => window.__onwardTerminalDebug.closeAllSubpages())
    await this.page.waitForFunction(() => !window.__onwardProjectEditorDebug?.isOpen())
    await this.page.bringToFront()
    await this.page.evaluate(() => window.electronAPI.debug.focusWindow())
    await this.page.waitForFunction(() => document.hasFocus())
    this.language = (await this.settings()).language
    await this.openInputSettings()
    await this.log('APP_READY', { launch: this.sequence, pid: this.child.pid, port })
    return this.page
  }

  async settings() {
    return this.page.evaluate(() => window.electronAPI.settings.load())
  }

  async nativePress(keyCode, modifiers = []) {
    const inputs = [{ type: 'keyDown', keyCode, modifiers }]
    if (!modifiers.length && /^[a-z0-9]$/i.test(keyCode)) inputs.push({ type: 'char', keyCode: keyCode.toLowerCase(), modifiers })
    inputs.push({ type: 'keyUp', keyCode, modifiers })
    for (const input of inputs) {
      assert.equal(await this.page.evaluate(input => window.electronAPI.debug.sendInputEvent(input), input), true,
        'Preview probes cross the focused native before-input-event boundary')
    }
  }

  async openPage(pageId) {
    const panel = this.page.locator('.settings-container')
    if (!await panel.isVisible()) await this.page.getByTestId('sidebar-settings-button').click()
    await panel.waitFor({ state: 'visible' })
    const compact = this.page.getByTestId('settings-page-select')
    if (await compact.isVisible()) await compact.selectOption(pageId)
    else await this.page.getByTestId(`settings-tab-${pageId}`).click()
    await panel.locator(`.settings-content[data-settings-page="${pageId}"]`).waitFor({ state: 'visible' })
  }

  async openInputSettings() {
    await this.openPage(INPUT_PAGE)
    const root = this.page.getByTestId(UI.root)
    await root.waitFor({ state: 'visible' })
    const expand = this.page.getByTestId('prompt-input-expand')
    this.initialCollapsed ??= await expand.getAttribute('aria-expanded') === 'false'
    if (await expand.getAttribute('aria-expanded') === 'false') await expand.click()
    await root.locator('fieldset:not(:disabled)').waitFor({ state: 'attached' })
  }

  row(id) {
    assert(/^[a-zA-Z0-9-]+$/.test(id), 'Fixture actions use selector-safe stable IDs')
    return this.page.getByTestId(UI.root).locator(`.prompt-input-action[data-action-id="${id}"]`)
  }

  async selectAction(id) {
    await this.page.getByTestId('prompt-input-action-select').selectOption(id)
    await this.row(id).waitFor({ state: 'visible' })
  }

  field(id, field) {
    return this.row(id).getByTestId(`prompt-input-action-${id}-${field}`)
  }

  async openAppearance(id) {
    await this.selectAction(id)
    await this.field(id, 'appearance').click()
    await this.page.getByTestId('prompt-emoji-picker').waitFor({ state: 'visible' })
    await this.page.waitForFunction(() => {
      const list = document.querySelector('[data-testid="prompt-emoji-list"]')
      const options = [...(list?.querySelectorAll('[role="option"]') ?? [])]
      return document.querySelector('[data-testid="prompt-emoji-picker"]')?.dataset.inputReady === 'true'
        && document.activeElement === document.querySelector('[data-testid="prompt-emoji-search"]')
        && list?.getAttribute('aria-busy') === 'false' && options.length === Math.min(48, Number(list.dataset.total))
        && options.length > 0 && options.every(option => {
          const image = option.querySelector('img')
          return image?.complete && image.naturalWidth > 0
        })
    })
  }

  async selectEmoji(id, sample) {
    await this.openAppearance(id)
    await this.page.getByTestId('prompt-emoji-search').fill(sample.query)
    await this.page.getByTestId(`prompt-emoji-option-${sample.key}`).click()
    await this.page.getByTestId('prompt-emoji-picker').waitFor({ state: 'detached' })
    assert.equal(await this.field(id, 'appearance').locator('[data-emoji]').getAttribute('data-emoji'), sample.emoji)
  }

  async setColor(id, color) {
    await this.openAppearance(id)
    await this.page.getByTestId(`prompt-input-action-${id}-color`).fill(color)
    await this.page.getByTestId('prompt-emoji-close').click()
  }

  async rowIds() {
    return this.page.getByTestId('prompt-input-action-select').locator('option').evaluateAll(options => options.map(option => option.value))
  }

  shortcutLabel(key, mode = 'action') {
    if (key === null) return this.acceptance.copy[this.language][mode === 'leader' ? 'leaderNotSet' : 'shortcutNotSet']
    const label = this.acceptance.shortcutLabels[this.platform]?.[key]
    assert.equal(typeof label, 'string', `An independent ${this.platform} label oracle is required for ${key}`)
    return label
  }

  clearButton(control) {
    return control.locator('xpath=..').locator('button.shortcut-clear-btn')
  }

  async clearRecordedKey(control, mode) {
    const clear = this.clearButton(control)
    assert.equal(await clear.count(), 1, 'Each recorder owns exactly one clear button')
    assert.equal(await clear.getAttribute('title'), this.acceptance.copy[this.language].clearShortcut)
    assert(await clear.isEnabled(), 'A configured shortcut can be cleared')
    await clear.click()
    await eventually('cleared shortcut placeholder', () => control.innerText(), text => text.trim() === this.shortcutLabel(null, mode))
    assert(await clear.isDisabled(), 'Clear is disabled once the binding is empty')
    assert.equal(await control.getAttribute('data-recording'), 'idle')
  }

  async recordKey(control, key) {
    const stroke = this.acceptance.recordingKeys[key]
    assert.equal(typeof stroke, 'string', `A trusted recording stroke is required for ${key}`)
    const expectedLabel = this.shortcutLabel(key)
    await control.click()
    await eventually('recorder ready after main suspension ACK', () => control.getAttribute('data-recording'), value => value === 'ready')
    assert.equal(await control.getAttribute('aria-busy'), 'false')
    assert.equal(await control.getAttribute('aria-pressed'), 'true')
    await this.page.keyboard.press(stroke)
    await eventually('recorder accepted the trusted key', () => control.getAttribute('data-recording'), value => value === 'idle')
    await eventually('recorded key has the intended display label', () => control.innerText(), text => text.trim() === expectedLabel)
    assert.equal(await control.getAttribute('aria-invalid'), 'false')
    assert.equal(await control.getAttribute('aria-pressed'), 'false')
    assert(await this.clearButton(control).isEnabled(), 'Recorded shortcut exposes the real clear control')
  }

  async status(state, message) {
    await this.page.waitForFunction(({ id, state, message }) => {
      const status = document.querySelector(`[data-testid="${id}"]`)
      return status?.getAttribute('data-state') === state && status.textContent.trim() === message &&
        status.getAttribute('role') === (state === 'error' ? 'alert' : 'status')
    }, { id: UI.status, state, message })
  }

  async save(expected) {
    assert(!this.cancelled, 'Runner canceled before save')
    const button = this.page.getByTestId(UI.save)
    assert(await button.isEnabled(), 'Changed settings must be savable')
    await button.click()
    await this.status('saved', this.acceptance.copy[this.language].saved)
    // The success status is the user-visible durable acknowledgement. Restart
    // callers quit immediately after this method; disk is checked after exit.
    if (expected) assert.deepEqual((await this.settings()).promptInput, expected)
  }
}

function unrelated(state) {
  const { promptInput, updatedAt, version, settingsPanelWidth, language, ...rest } = state
  return rest
}

async function assertUi(h, expected) {
  const actual = await h.page.getByTestId(UI.root).evaluate((root, ids) => {
    const control = id => {
      const node = root.querySelector(`[data-testid="${id}"]`)
      if (!node) throw new Error(`Settings control missing: ${id}`)
      return node
    }
    return {
      leaderLabel: control(ids.leader).textContent.trim(),
      leaderClearDisabled: control(ids.leader).parentElement.querySelector('.shortcut-clear-btn').disabled,
      timeoutMs: Number(control(ids.timeout).value)
    }
  }, UI)
  actual.actions = []
  assert.deepEqual(await h.rowIds(), expected.actions.map(action => action.id))
  for (const action of expected.actions) {
    await h.selectAction(action.id)
    actual.actions.push(await h.row(action.id).evaluate(row => {
        const id = row.dataset.actionId
        const field = name => {
          const node = row.querySelector(`[data-testid="prompt-input-action-${id}-${name}"]`)
          if (!node) throw new Error(`Action ${id} is missing control ${name}`)
          return node
        }
        return {
          id, name: field('name').value, visible: field('visible').checked,
          includePrompt: field('include-prompt').checked, terminalKey: field('terminal-key').value,
          target: field('target').value, shortcutLabel: field('shortcut').textContent.trim(),
          shortcutClearDisabled: field('shortcut').parentElement.querySelector('.shortcut-clear-btn').disabled,
          terminalKeyLabel: field('terminal-key').selectedOptions[0].textContent,
           targetLabel: field('target').selectedOptions[0].textContent,
            color: field('appearance').style.getPropertyValue('--prompt-action-color') || '#808080',
            emoji: field('appearance').querySelector('[data-emoji]').dataset.emoji
         }
    }))
  }
  assert.equal(actual.timeoutMs, expected.timeoutMs)
  assert.equal(actual.leaderLabel, h.shortcutLabel(expected.leader, 'leader'), 'The hydrated Leader has its exact intended visual label')
  assert.equal(actual.leaderClearDisabled, expected.leader === null)
  assert.deepEqual(actual.actions, expected.actions.map(({ preset, shortcut, color, emoji, ...action }) => ({
    ...action, color: color ?? '#808080', shortcutLabel: h.shortcutLabel(shortcut), shortcutClearDisabled: shortcut === null,
    emoji: emoji ?? h.acceptance.defaultEmoji[preset ?? 'custom'],
    terminalKeyLabel: h.acceptance.copy[h.language].terminalKeys[action.terminalKey],
    targetLabel: h.acceptance.copy[h.language].targets[action.target]
  })))
}

async function configureThroughUi(h) {
  const expected = structuredClone(h.acceptance.defaults)
  const leader = h.page.getByTestId(UI.leader)
  const shortcut = h.field('execute', 'shortcut')
  await h.selectAction('execute')
  for (let trial = 0; trial < TRIALS; trial++) {
    assert(!h.cancelled, 'Runner canceled during recorder/clear trials')
    await h.recordKey(leader, h.acceptance.modifiedLeaderProbe)
    await h.clearRecordedKey(leader, 'leader')
    await h.recordKey(leader, h.acceptance.leader)
    await h.clearRecordedKey(shortcut, 'action')
    await h.recordKey(shortcut, 'E')
  }
  expected.leader = h.acceptance.leader
  await h.page.getByTestId(UI.timeout).fill(String(h.acceptance.timeoutMs))
  expected.timeoutMs = h.acceptance.timeoutMs
  const execute = expected.actions.find(action => action.id === 'execute')
  await h.selectAction('execute')
  await h.setColor('execute', '#3579ab')
  await h.selectEmoji('execute', h.acceptance.emojiSamples[3])
  await h.field('execute', 'name').fill(h.acceptance.executeName)
  await h.field('execute', 'visible').uncheck()
  await h.field('execute', 'terminal-key').selectOption('Tab')
  Object.assign(execute, { name: h.acceptance.executeName, visible: false, terminalKey: 'Tab', color: '#3579ab', emoji: h.acceptance.emojiSamples[3].emoji })
  await h.page.getByTestId('prompt-input-action-select').press('Alt+ArrowLeft')
  expected.actions = [execute, ...expected.actions.filter(action => action.id !== 'execute')]
  await h.selectAction('send')
  await h.field('send', 'delete').click()
  expected.actions = expected.actions.filter(action => action.id !== 'send')
  for (const fixture of h.acceptance.actions) {
    assert(!h.cancelled, 'Runner canceled while configuring actions')
    const previous = await h.rowIds()
    await h.page.getByTestId(UI.add).click()
    const ids = await eventually('new action row', () => h.rowIds(), rows => rows.length === previous.length + 1)
    const added = ids.filter(id => !previous.includes(id))
    assert.equal(added.length, 1, 'One Add gesture creates exactly one stable action ID')
    const id = added[0]
    await h.field(id, 'name').fill(fixture.name)
    await h.field(id, 'visible').setChecked(fixture.visible)
    await h.field(id, 'include-prompt').setChecked(fixture.includePrompt)
    await h.field(id, 'terminal-key').selectOption(fixture.terminalKey)
    await h.field(id, 'target').selectOption(fixture.target)
    expected.actions.push({ id, ...fixture, shortcut: null })
  }
  await h.save(expected)
  await assertUi(h, expected)
  return expected
}

async function setLanguage(h, language) {
  await h.openPage('general')
  await h.page.getByTestId('settings-language-select').selectOption(language)
  await eventually('language saved', () => h.diskSettings(), data => data?.language === language)
  h.language = language
  await h.openInputSettings()
}

async function resizeSettings(h, width) {
  const panel = h.page.locator('.settings-container')
  const before = await panel.boundingBox()
  const handle = await h.page.locator('.settings-resize-handle').boundingBox()
  assert(before && handle, 'Settings resize affordance is visible')
  const x = handle.x + handle.width / 2
  const y = handle.y + Math.min(handle.height / 2, 30)
  await h.page.mouse.move(x, y)
  await h.page.mouse.down()
  try { await h.page.mouse.move(x + width - before.width, y, { steps: 3 }) }
  finally { await h.page.mouse.up() }
  await eventually(`Settings width ${width}`, () => panel.boundingBox(), box => box && Math.abs(box.width - width) <= 2)
}

async function layoutTrial(h, trial, expected) {
  const labels = {}
  for (const language of LANGUAGES) {
    await setLanguage(h, language)
    labels[language] = await h.page.getByTestId(UI.save).innerText()
    assert.equal(labels[language], h.acceptance.copy[language].save)
    assert((await h.page.getByTestId(UI.root).locator('h3').innerText()).endsWith(h.acceptance.copy[language].title))
    assert.equal(await h.page.getByTestId('prompt-input-action-select').locator('option[value="queue"]').innerText(), h.acceptance.copy[language].queue)
    for (const width of WIDTHS) {
      assert(!h.cancelled, 'Runner canceled during layout validation')
      await resizeSettings(h, width)
      const geometry = await h.page.getByTestId(UI.root).evaluate(root => {
        const panel = root.closest('.settings-content').getBoundingClientRect()
        const controls = [...root.querySelectorAll('input, select, button, [role="button"]')]
          .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.prompt-action-rail'))
        return {
          count: controls.length,
          outside: controls.flatMap(node => {
            const rect = node.getBoundingClientRect()
            return rect.width > 0 && rect.left >= panel.left - 2 && rect.right <= panel.right + 2
              ? [] : [{ id: node.dataset.testid, left: rect.left, right: rect.right, width: rect.width }]
          }),
          clippedLabels: controls.filter(node => node.tagName === 'BUTTON' && node.textContent.trim()).flatMap(node =>
            node.scrollWidth <= node.clientWidth + 2 && node.scrollHeight <= node.clientHeight + 2 ? [] : [node.dataset.testid]),
          editorRows: root.querySelectorAll('.prompt-input-edit-row').length,
          actionEditors: root.querySelectorAll('.prompt-input-action').length,
          rail: (() => {
            const rail = root.querySelector('.prompt-action-rail')
            const blocks = [...rail.querySelectorAll('button')].map(node => node.getBoundingClientRect())
            return { scrolls: rail.scrollWidth > rail.clientWidth, rows: new Set(blocks.map(rect => rect.top)).size,
              min: Math.min(...blocks.map(rect => rect.width)), max: Math.max(...blocks.map(rect => rect.width)) }
          })(),
          overlaps: [...root.querySelectorAll('.prompt-input-action')].flatMap(row => {
            const fields = [...row.querySelectorAll('input, select, button')].filter(node => node.getClientRects().length)
            const collisions = []
            for (let left = 0; left < fields.length; left++) {
              const a = fields[left].getBoundingClientRect()
              for (let right = left + 1; right < fields.length; right++) {
                const b = fields[right].getBoundingClientRect()
                if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) {
                  collisions.push([row.dataset.actionId, fields[left].dataset.testid, fields[right].dataset.testid])
                }
              }
            }
            return collisions
          }),
          rawKeys: /promptInput\.(?:settings|recording|runtime|action|target|key)\./.test(root.textContent)
        }
      })
      assert.equal((await h.rowIds()).length, expected.actions.length, 'Every action remains selectable')
      assert.equal(geometry.editorRows, 3, 'Only three selected-action editor rows are mounted')
      assert.equal(geometry.actionEditors, 1)
      assert.equal(geometry.rail.rows, 1)
      assert(geometry.rail.min >= 24 && geometry.rail.max - geometry.rail.min < 1)
      assert(geometry.rail.scrolls, 'Many actions scroll horizontally instead of wrapping or shrinking')
      assert.deepEqual(geometry.outside, [], `Controls fit at ${width}px in ${language}`)
      assert.deepEqual(geometry.clippedLabels, [], `Button copy is not clipped at ${width}px in ${language}`)
      assert.deepEqual(geometry.overlaps, [], `Action controls do not overlap at ${width}px in ${language}`)
      assert.equal(geometry.rawKeys, false, 'No untranslated dictionary key is visible')
      assert.equal(await h.page.getByTestId('settings-page-select').isVisible(), width < 500)
      await h.selectAction(expected.actions.at(-1).id)
      await h.field(expected.actions.at(-1).id, 'name').scrollIntoViewIfNeeded()
      assert(await h.field(expected.actions.at(-1).id, 'name').isVisible(), 'Last action remains reachable by scrolling')
      assert(await h.page.getByTestId('prompt-input-preview').evaluate((rail, id) => {
        const button = [...rail.querySelectorAll('[data-action-id]')].find(node => node.dataset.actionId === id)
        const a = rail.getBoundingClientRect(), b = button?.getBoundingClientRect()
        return b && b.left >= a.left && b.right <= a.right
      }, expected.actions.at(-1).id), 'Selecting the last action reveals its preview block')
      if (trial === 1 && (width === 300 || width === 600)) await h.screenshot(`layout-${language}-${width}`)
      await h.openAppearance(expected.actions.at(-1).id)
      assert.equal(await h.page.getByTestId('prompt-emoji-picker').locator('h3').innerText(), h.acceptance.copy[language].emojiAppearance)
      await h.page.getByTestId('prompt-emoji-search').fill('rocket')
      const rocket = h.page.getByTestId('prompt-emoji-option-1f680')
      await rocket.waitFor({ state: 'visible' })
      assert.equal(await rocket.getAttribute('aria-label'), h.acceptance.copy[language].rocket)
      assert(await h.page.getByTestId('prompt-emoji-picker').evaluate(node => {
        const bounds = node.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
          && node.scrollWidth <= node.clientWidth
          && Math.abs((bounds.left + bounds.right) / 2 - innerWidth / 2) <= 2
          && Math.abs((bounds.top + bounds.bottom) / 2 - innerHeight / 2) <= 2
      }), 'Localized picker fits without horizontal clipping')
      if (trial === 1 && width === 300) await h.screenshot(`emoji-${language}-${width}`)
      await h.page.keyboard.press('Escape')
    }
    await assertUi(h, expected)
  }
  assert(labels.en.trim() && labels['zh-CN'].trim() && labels.en !== labels['zh-CN'], 'Save copy localizes in both supported languages')
  return { trial, widths: WIDTHS, languages: LANGUAGES, actions: expected.actions.length }
}

async function failureAndRetry(h, trial, expected) {
  await h.openInputSettings()
  await eventually('resize persistence settled before write-failure setup', () => h.diskSettings(), state => state?.settingsPanelWidth === WIDTHS.at(-1) && state?.language === h.language)
  const before = await h.settings()
  const id = expected.actions.at(-1).id
  await h.selectAction(id)
  const nextName = `${h.acceptance.actions.at(-1).name} revision ${trial}`
  await h.field(id, 'name').fill(nextName)
  const settingsPath = path.join(h.userData, 'settings.json')
  const backup = path.join(h.userData, 'settings-before-failure.json')
  assert(under(h.scratch, settingsPath) && under(h.scratch, backup))
  await rename(settingsPath, backup)
  let blocked = false
  try {
    await mkdir(settingsPath)
    blocked = true
    await h.page.getByTestId(UI.save).click()
    await h.status('error', h.acceptance.copy[h.language].saveFailed)
    const rejected = await h.settings()
    assert.deepEqual(rejected.promptInput, before.promptInput, 'Failed save rolls back the input section')
    assert.deepEqual(unrelated(rejected), unrelated(before), 'Rollback preserves unrelated settings')
    assert.equal(rejected.language, before.language)
    assert.equal(rejected.settingsPanelWidth, before.settingsPanelWidth)
    assert(await h.page.getByTestId(UI.status).isVisible(), 'Save failure has visible feedback')
    assert.equal(await h.field(id, 'name').inputValue(), nextName, 'A rejected save retains the user edit for retry')
  } finally {
    if (blocked) await rm(settingsPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
    await rename(backup, settingsPath)
  }
  // Re-enter the intended value even if the UI retained its rejected draft.
  await h.field(id, 'name').fill(nextName)
  expected.actions.find(action => action.id === id).name = nextName
  await h.save()
  // Deliberately no disk poll/sleep after the visible durable acknowledgement.
  await h.stop(true)
  const disk = await h.diskSettings()
  assert.deepEqual(disk.promptInput, expected, 'Acknowledged settings survive immediate natural exit')
  assert.deepEqual(unrelated(disk), unrelated(before))
  assert.equal(disk.language, before.language)
  assert.equal(disk.settingsPanelWidth, before.settingsPanelWidth)
  return { trial, actions: expected.actions.length, failedWrite: 'owned-settings-path-is-directory' }
}

async function trustedDispatch(h, trial) {
  if (await h.page.locator('.settings-container').isVisible()) await h.page.locator('.settings-close-btn').click()
  await h.page.locator('.settings-container').waitFor({ state: 'hidden' })
  await h.page.evaluate(() => window.__onwardTerminalDebug?.closeAllSubpages?.())
  const terminal = h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .xterm-helper-textarea').first()
  await terminal.waitFor({ state: 'attached' })
  await terminal.focus()
  await h.page.evaluate(() => window.electronAPI.debug.focusWindow())
  await h.page.waitForFunction(() => document.hasFocus())
  const tabId = await h.page.evaluate(() => window.__onwardAppDebug.getActiveTabId())
  assert(tabId, 'Current Tab identity is available even while Prompt is hidden')
  await h.page.evaluate(() => {
    if (!window.electronAPI.promptInput?.onShortcut) throw new Error('Prompt input shortcut observer is unavailable')
    window.__pisShortcutEvents = []
    window.__pisShortcutStop = window.electronAPI.promptInput.onShortcut(event => window.__pisShortcutEvents.push(event))
  })
  const press = async keyCode => {
    for (const type of ['keyDown', 'keyUp']) {
      const accepted = await h.page.evaluate(input => window.electronAPI.debug.sendInputEvent(input), { type, keyCode })
      assert.equal(accepted, true, 'Native input reaches only the focused owned WebContents')
    }
  }
  try {
    await press(h.acceptance.leader)
    await h.page.waitForFunction(() => window.__pisShortcutEvents.some(event => event.kind === 'state' && event.active))
    await press('E')
    await h.page.waitForFunction(() => window.__pisShortcutEvents.some(event => event.kind === 'dispatch'))
    const events = await h.page.evaluate(() => window.__pisShortcutEvents)
    const dispatched = events.filter(event => event.kind === 'dispatch')
    assert.equal(dispatched.length, 1, 'One trusted Leader sequence dispatches once after restart')
    assert.equal(dispatched[0].actionId, 'execute', 'The hidden key-only action retains its binding')
    assert.equal(dispatched[0].tabId, tabId, 'Dispatch carries the current notebook identity')
    assert(await terminal.evaluate(node => document.activeElement === node), 'Shortcut preserves the focused terminal')
    return { trial, actionId: dispatched[0].actionId, tabId: dispatched[0].tabId }
  } finally {
    await h.page.evaluate(() => {
      window.__pisShortcutStop?.()
      delete window.__pisShortcutStop
      delete window.__pisShortcutEvents
    }).catch(() => {})
  }
}

/** Reuse the raw-PTY fixture so absence of dispatch events is not the byte oracle. */
async function startEmojiReceivers(h) {
  const fixture = path.join(h.workspace, 'raw-stdin.mjs')
  await cp(path.join(ROOT, 'test/autotest/fixtures/prompt-input-shortcuts/raw-stdin.mjs'), fixture)
  const ids = await h.page.locator('.terminal-grid-cell[data-terminal-id]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.terminalId))])
  assert(ids.length > 0, 'Picker isolation requires real Task receivers')
  const receivers = []
  for (const [index, id] of ids.entries()) {
    const directory = path.join(h.scratch, `emoji-receiver-${index}`)
    await mkdir(directory)
    const { shellKind } = await h.page.evaluate(id => window.electronAPI.terminal.getInputCapabilities(id), id)
    const values = [process.execPath, fixture, directory]
    assert(values.every(value => !/[\r\n]/.test(value)))
    const command = shellKind === 'powershell' ? `& ${values.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`
      : shellKind === 'cmd' ? values.map(value => {
        assert(!/["%!]/.test(value), 'Owned cmd paths must not contain expansion operators')
        return `"${value}"`
      }).join(' ') : values.map(value => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ')
    assert(['powershell', 'cmd', 'posix'].includes(shellKind))
    assert.equal(await h.page.evaluate(({ id, command }) => window.electronAPI.terminal.write(id, `${command}\r`), { id, command }), true)
    const readStatus = async () => {
      try { return JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    }
    await eventually('emoji receiver ready', readStatus, status => status?.ready === true, 15000)
    let sequence = 0
    receivers.push({ id, directory, async checkpoint(operation = 'snapshot') {
      const id = ++sequence
      const destination = path.join(directory, 'command.json')
      await writeFile(`${destination}.next`, JSON.stringify({ id, operation }))
      await rename(`${destination}.next`, destination)
      await eventually('emoji receiver control acknowledgement', readStatus, status => status?.commandId === id)
      return (await readFile(path.join(directory, 'stdin.bin'))).length
    } })
  }
  return receivers
}

async function run(h) {
  await h.initialize()
  await h.start()
  let baseline
  await h.case('PIS-01-v9-unicode-crlf-migration', async () => {
    baseline = await h.settings()
    assert(baseline.version >= 10)
    assert.deepEqual(baseline.promptInput, h.acceptance.defaults)
    for (const field of ['terminalStyles', 'globalTerminalStyle', 'gitDiffFontSize', 'settingsPanelWidth',
      'language', 'telemetryConsent', 'telemetryInstanceId', 'autoFollowGitBranchForTaskName', 'performanceDiagnosticsEnabled']) {
      assert.deepEqual(baseline[field], h.legacy[field], `Migration preserves ${field}`)
    }
    for (const [key, value] of Object.entries(h.legacy.shortcuts)) assert.equal(baseline.shortcuts[key], value)
    assert.equal(baseline.theme.themeId, h.legacy.theme.themeId)
    assert.deepEqual(baseline.theme.overrides, h.legacy.theme.overrides)
    assert.equal(baseline.theme.imported[0].name, h.legacy.theme.imported[0].name)
    await assertUi(h, h.acceptance.defaults)
    return { sourceVersion: h.legacy.version, version: baseline.version, lineEndings: 'CRLF' }
  })
  await h.case('PIS-10-compact-disclosure-drag-color-cancel', async () => {
    assert(h.initialCollapsed, 'The actions section starts collapsed')
    const root = h.page.getByTestId(UI.root)
    assert(await root.evaluate(node => node === node.parentElement.lastElementChild), 'Prompt actions follow all existing shortcuts')
    const original = await h.rowIds()
    const rail = h.page.getByTestId('prompt-input-preview')
    const drag = async (sourceId, targetId, after) => {
      const source = rail.locator(`[data-action-id="${sourceId}"]`)
      const target = rail.locator(`[data-action-id="${targetId}"]`)
      await target.scrollIntoViewIfNeeded()
      const rect = await target.boundingBox()
      await source.dragTo(target, { targetPosition: { x: rect.width * (after ? .7 : .3), y: rect.height / 2 } })
    }
    for (let trial = 0; trial < TRIALS; trial++) {
      await drag('queue', 'sendAndExecute', false)
      assert.deepEqual(await h.rowIds(), ['queue', ...original.filter(id => id !== 'queue')])
      await drag('queue', 'sendAllAndExecute', true)
      assert.deepEqual(await h.rowIds(), original)
      await h.selectAction('queue')
      await h.setColor('queue', '#a45bc9')
      assert.equal(await rail.locator('[data-action-id="queue"]').evaluate(node => node.style.getPropertyValue('--prompt-action-color')), '#a45bc9')
      await h.page.getByTestId('prompt-input-expand').click()
      assert.equal(await root.locator('fieldset').count(), 0, 'Collapsed controls and preview unmount')
      await h.page.getByTestId('settings-search').fill('Prompt')
      await h.page.getByTestId('settings-search-prompt-input').click()
      assert.equal(await h.page.getByTestId('prompt-input-expand').getAttribute('aria-expanded'), 'true')
      assert.equal(await h.field('queue', 'appearance').evaluate(node => node.style.getPropertyValue('--prompt-action-color')), '#a45bc9', 'Collapsing preserves the unsaved draft')
      await h.page.getByTestId('prompt-input-cancel').click()
      assert.equal(await h.field('queue', 'appearance').evaluate(node => node.style.getPropertyValue('--prompt-action-color')), '')
      assert.deepEqual((await h.settings()).promptInput, h.acceptance.defaults)
      await h.page.getByTestId('prompt-input-add').focus()
      await h.page.keyboard.press('Tab')
      const focused = rail.locator('button:focus-visible')
      assert.equal(await focused.count(), 1, 'Keyboard focus reaches an emoji action block')
      await h.page.getByRole('tooltip').waitFor({ state: 'visible' })
      assert((await h.page.getByRole('tooltip').innerText()).startsWith(await focused.getAttribute('aria-label')))
      await h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell').first().evaluate(terminal => {
        // Reproduce the capture-phase events independently of xterm's output cadence.
        for (let sample = 0; sample < 50; sample++) terminal.dispatchEvent(new Event('scroll'))
      })
      assert(await h.page.getByRole('tooltip').isVisible(), 'Unrelated Task scrolls cannot hide a stationary focused action label')
      await focused.evaluate(button => {
        const content = button.closest('.settings-content')
        content.scrollTop -= 12
      })
      await h.page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="prompt-input-preview"] button:focus-visible')
        const tooltip = document.querySelector('.prompt-action-focus-label')
        return button && tooltip && Math.abs(tooltip.getBoundingClientRect().bottom - (button.getBoundingClientRect().top - 6)) < 1
      })
      assert(await h.page.getByRole('tooltip').isVisible(), 'Focus-driven ancestor scrolls reposition the label instead of hiding it')
      await h.page.keyboard.press('Shift+Tab')
      await h.page.getByRole('tooltip').waitFor({ state: 'detached' })
    }
    await h.openPage('general')
    await h.openPage('shortcuts')
    assert.equal(await h.page.getByTestId('prompt-input-expand').getAttribute('aria-expanded'), 'false', 'A prior search does not force future category visits open')
    await h.openInputSettings()
    return { trials: TRIALS, horizontalDrag: true, colorCancel: true, searchReveal: true }
  })
  const expected = await h.case('PIS-02-real-ui-configure-and-save', () => configureThroughUi(h))
  await h.case('PIS-11-draft-shortcut-preview-isolated-five-trials', async () => {
    const diskBefore = (await h.settings()).promptInput
    await h.selectAction('queue')
    await h.recordKey(h.field('queue', 'shortcut'), 'K')
    await h.page.evaluate(() => {
      window.__pisPreviewEvents = []
      window.__pisPreviewStop = window.electronAPI.promptInput.onShortcut(event => window.__pisPreviewEvents.push(event))
    })
    try {
      const zone = h.page.getByTestId('prompt-input-preview-test')
      for (let trial = 0; trial < TRIALS; trial++) {
        await zone.focus()
        await eventually('preview acknowledges suspension', () => zone.getAttribute('data-phase'), value => value === 'ready')
        await h.nativePress('F6')
        await h.nativePress('3')
        await h.nativePress('K')
        assert.equal(await zone.getAttribute('data-result'), 'dispatch')
        assert.equal(await zone.getAttribute('data-action-id'), 'queue', 'The unsaved shortcut is recognized')
        assert.equal(await zone.getAttribute('data-target-id'), '3')
        assert.equal(await h.page.getByTestId('prompt-input-preview').locator('[data-action-id="queue"]').getAttribute('data-preview-hit'), 'true')
        assert.equal(await h.page.locator('.prompt-input-status, .prompt-input-target').count(), 0)
        await h.nativePress('F6')
        await h.nativePress('Escape')
        assert.equal(await zone.getAttribute('data-result'), 'cancel')
        await h.page.getByTestId('prompt-input-action-select').focus()
        assert.equal(await zone.getAttribute('data-phase'), 'idle')
      }
      const events = await h.page.evaluate(() => window.__pisPreviewEvents)
      assert(!events.some(event => event.kind === 'dispatch'), 'Draft preview never invokes live Task routing')
      assert.deepEqual((await h.settings()).promptInput, diskBefore)
    } finally {
      await h.page.evaluate(() => { window.__pisPreviewStop?.(); delete window.__pisPreviewStop; delete window.__pisPreviewEvents })
    }
    await h.page.getByTestId('prompt-input-cancel').click()
    return { trials: TRIALS, liveDispatches: 0, unsavedShortcut: 'K' }
  })
  await h.case('PIS-12-offline-emoji-search-selection-and-cleanup', async () => {
    const baseline = (await h.settings()).promptInput
    const receivers = await startEmojiReceivers(h)
    const workers = new Set()
    const workerListener = worker => { workers.add(worker); worker.on('close', () => workers.delete(worker)) }
    h.page.on('worker', workerListener)
    await h.context.setOffline(true)
    await h.page.evaluate(() => {
      window.__pisEmojiEvents = []
      window.__pisEmojiPressureWrites = 0
      window.__pisEmojiStop = window.electronAPI.promptInput.onShortcut(event => window.__pisEmojiEvents.push(event))
      window.__pisEmojiPressure = setInterval(() => {
        for (const node of document.querySelectorAll('.terminal-grid-cell[data-terminal-id]')) {
          if (window.__onwardTerminalDebug?.injectPtyData(`${'emoji-pressure '.repeat(100)}\r\n`, node.dataset.terminalId)) window.__pisEmojiPressureWrites += 1
        }
      }, 20)
    })
    try {
      for (const sample of h.acceptance.emojiSamples) {
        await h.selectEmoji('queue', sample)
        assert.equal(await h.page.getByTestId('prompt-input-preview').locator('[data-action-id="queue"] [data-emoji]').getAttribute('data-emoji'), sample.emoji)
        assert.deepEqual((await h.settings()).promptInput, baseline, 'Selection changes only the draft')
        await h.openAppearance('queue')
        assert.equal(Number(await h.page.getByTestId('prompt-emoji-list').getAttribute('data-total')), 3145)
        assert(await h.page.getByTestId('prompt-emoji-list').getByRole('option').count() <= 48, 'Only visible rows are mounted')
        await h.page.keyboard.type('robot')
        assert.equal(await h.page.getByTestId('prompt-emoji-search').inputValue(), 'robot', 'Typing immediately after opening targets search')
        // macOS sendInputEvent lacks Cocoa's editing-command/menu fallback. CDP
        // supplies editing commands; native window accelerators are probed below.
        await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
        assert.deepEqual(await h.page.getByTestId('prompt-emoji-search').evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 5],
          'Chromium Select All remains available while application shortcuts are suspended')
        await h.page.keyboard.type('rocket')
        assert.equal(await h.page.getByTestId('prompt-emoji-search').inputValue(), 'rocket')
        await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
        assert.notEqual(await h.page.getByTestId('prompt-emoji-search').inputValue(), 'rocket', 'Chromium Undo remains available in search')
        await h.page.getByTestId('prompt-emoji-search').fill('')
        await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-emoji-list"]')?.dataset.total === '3145'
          && document.querySelector('[data-testid="prompt-emoji-list"]')?.getAttribute('aria-busy') === 'false')
        await h.nativePress('P', ['control', 'shift'])
        await h.nativePress('J', ['control', 'shift'])
        await h.nativePress('1', ['alt'])
        assert(await h.page.getByTestId('prompt-emoji-picker').isVisible(), 'Native window shortcuts cannot discard the draft or switch surfaces')
        await h.page.getByTestId('prompt-emoji-search').focus()
        for (const key of ['Control+ArrowDown', 'Meta+ArrowDown', 'Shift+Meta+ArrowDown', 'Shift+ArrowDown']) {
          await h.page.keyboard.press(key)
          assert(await h.page.getByTestId('prompt-emoji-search').evaluate(node => node === document.activeElement), 'Modified Down retains text editing focus')
        }
        await h.page.getByTestId('prompt-emoji-list').evaluate(node => { node.scrollTop = 800; node.dispatchEvent(new Event('scroll')) })
        await h.page.waitForFunction(() => {
          const list = document.querySelector('[data-testid="prompt-emoji-list"]')
          return list?.getAttribute('aria-busy') === 'false' && Number(list.querySelector('[role="option"]')?.getAttribute('aria-posinset')) > 48
        })
        await h.page.keyboard.press('ArrowDown')
        const visibleEmoji = await h.page.getByTestId('prompt-emoji-list').evaluate(list => {
          const active = document.getElementById(list.getAttribute('aria-activedescendant'))
          const bounds = active?.getBoundingClientRect()
          const viewport = list.getBoundingClientRect()
          return bounds && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom ? active.querySelector('[data-emoji]').dataset.emoji : null
        })
        assert(visibleEmoji, 'Search Down enters a visible option after wheel scrolling')
        await h.page.keyboard.press('Enter')
        await h.page.getByTestId('prompt-emoji-picker').waitFor({ state: 'detached' })
        assert.equal(await h.field('queue', 'appearance').locator('[data-emoji]').getAttribute('data-emoji'), visibleEmoji)
        await h.openAppearance('queue')
        await h.page.getByTestId('prompt-emoji-list').focus()
        await h.page.getByTestId('prompt-emoji-list').evaluate(node => { node.scrollTop = 1200; node.dispatchEvent(new Event('scroll')) })
        await h.page.waitForFunction(() => {
          const list = document.querySelector('[data-testid="prompt-emoji-list"]')
          const active = document.getElementById(list?.getAttribute('aria-activedescendant'))
          const bounds = active?.getBoundingClientRect()
          const viewport = list?.getBoundingClientRect()
          return list?.getAttribute('aria-busy') === 'false' && bounds && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom
        })
        const scrolledEmoji = await h.page.getByTestId('prompt-emoji-list').evaluate(list => document.getElementById(list.getAttribute('aria-activedescendant')).querySelector('[data-emoji]').dataset.emoji)
        await h.page.keyboard.press('Enter')
        await h.page.getByTestId('prompt-emoji-picker').waitFor({ state: 'detached' })
        assert.equal(await h.field('queue', 'appearance').locator('[data-emoji]').getAttribute('data-emoji'), scrolledEmoji)
        await h.openAppearance('queue')
        await h.page.getByTestId('prompt-emoji-list').focus()
        await h.page.keyboard.press('End')
        await h.page.waitForFunction(() => {
          const list = document.querySelector('[data-testid="prompt-emoji-list"]')
          return list.getAttribute('aria-busy') === 'false' && list.querySelector('[aria-posinset="3145"] img')?.naturalWidth > 0
        })
        await h.page.getByTestId('prompt-emoji-search').fill(h.acceptance.emojiSamples[1].query.slice(0, 1))
        await h.page.waitForFunction(() => {
          const list = document.querySelector('[data-testid="prompt-emoji-list"]')
          return list.getAttribute('aria-busy') === 'false' && Number(list.dataset.total) > 1 && Number(list.dataset.total) < 3145
        })
        // Rapid replacements exercise stale-reply exclusion; only the final result may be selected.
        for (const query of h.acceptance.emojiSearchStressQueries) await h.page.getByTestId('prompt-emoji-search').fill(query)
        await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-emoji-list"]')?.getAttribute('aria-busy') === 'false'
          && document.querySelector('[data-testid="prompt-emoji-option-1f916"]'))
        await h.page.keyboard.press('ArrowDown')
        await h.page.keyboard.press('Space')
        await h.page.getByTestId('prompt-emoji-picker').waitFor({ state: 'detached' })
        assert.equal(await h.field('queue', 'appearance').locator('[data-emoji]').getAttribute('data-emoji'), h.acceptance.emojiSamples[0].emoji)
        await h.openAppearance('queue')
        await h.page.getByTestId('prompt-emoji-category').selectOption('4')
        await h.page.getByTestId('prompt-emoji-search').fill('rocket')
        await h.page.waitForFunction(() => {
          const list = document.querySelector('[data-testid="prompt-emoji-list"]')
          return list?.getAttribute('aria-busy') === 'false' && list.dataset.total === '0'
        })
        await h.page.getByTestId('prompt-emoji-category').selectOption('-1')
        await h.page.getByTestId('prompt-emoji-option-1f680').waitFor({ state: 'visible' })
        await h.page.getByTestId('prompt-emoji-search').focus()
        await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
        assert.deepEqual((await h.settings()).promptInput, baseline, 'Picker cannot save the underlying editor')
        await h.nativePress('F6')
        await h.nativePress('E')
        await h.page.keyboard.press('Escape')
        assert.equal(await h.field('queue', 'appearance').evaluate(node => node === document.activeElement), true)
        await h.page.getByTestId('prompt-input-cancel').click()
        assert.equal(await h.field('queue', 'appearance').locator('[data-emoji]').getAttribute('data-emoji'), h.acceptance.defaultEmoji.queue)
        await eventually('picker Worker terminated', () => workers.size, size => size === 0)
        for (const receiver of receivers) assert.equal(await receiver.checkpoint(), 0, `No bytes reach Task ${receiver.id}`)
      }
      assert(!(await h.page.evaluate(() => window.__pisEmojiEvents)).some(event => event.kind === 'dispatch'))
      assert.equal(await h.page.evaluate(() => document.querySelectorAll('dialog[open]').length), 0)
      const pressureWrites = await h.page.evaluate(() => window.__pisEmojiPressureWrites)
      assert(pressureWrites > 0, 'Terminal pressure must actually reach xterm')
      return { trials: TRIALS, catalog: 3145, liveDispatches: 0, rawReceivers: receivers.length, rawBytes: 0, pressureWrites, workersAfter: workers.size }
    } finally {
      h.page.off('worker', workerListener)
      await h.page.evaluate(() => {
        clearInterval(window.__pisEmojiPressure)
        window.__pisEmojiStop?.()
        delete window.__pisEmojiPressure; delete window.__pisEmojiPressureWrites; delete window.__pisEmojiStop; delete window.__pisEmojiEvents
      })
      for (const receiver of receivers) await receiver.checkpoint('stop')
    }
  })
  await h.case('PIS-13-emoji-worker-retry-and-reset', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      await h.selectAction('queue')
      await h.page.evaluate(() => {
        window.__pisRealWorker = window.Worker
        window.Worker = class { constructor() { throw new Error('Owned emoji Worker failure') } }
      })
      try {
        await h.field('queue', 'appearance').click()
        await h.page.getByTestId('prompt-emoji-retry').waitFor({ state: 'visible' })
      } finally {
        await h.page.evaluate(() => { window.Worker = window.__pisRealWorker; delete window.__pisRealWorker })
      }
      await h.page.getByTestId('prompt-emoji-retry').click()
      await h.page.getByTestId('prompt-emoji-search').fill('robot')
      await h.page.getByTestId('prompt-emoji-option-1f916').click()
      await h.page.evaluate(() => {
        window.__pisRealWorker = window.Worker
        window.Worker = class extends window.__pisRealWorker {
          constructor(...args) { super(...args); window.__pisEmojiWorker = this }
        }
      })
      try {
        await h.openAppearance('queue')
        await h.page.getByTestId('prompt-emoji-list').focus()
        await h.page.keyboard.press('End')
        await h.page.waitForFunction(() => document.querySelector('[aria-posinset="3145"] img')?.naturalWidth > 0)
        await h.page.evaluate(() => window.__pisEmojiWorker.dispatchEvent(new ErrorEvent('error', { cancelable: true })))
        await h.page.getByTestId('prompt-emoji-retry').click()
        await h.page.waitForFunction(() => {
          const list = document.querySelector('[data-testid="prompt-emoji-list"]')
          return list?.scrollTop === 0 && list.getAttribute('aria-busy') === 'false' && list.querySelector('[aria-posinset="1"] img')?.naturalWidth > 0
        })
        await h.page.getByTestId('prompt-emoji-close').click()
      } finally {
        await h.page.evaluate(() => { window.Worker = window.__pisRealWorker; delete window.__pisRealWorker; delete window.__pisEmojiWorker })
      }
      await h.openAppearance('queue')
      await h.page.getByTestId('prompt-input-action-queue-color').fill('#123456')
      await h.page.getByTestId('prompt-emoji-reset').click()
      await h.page.getByTestId('prompt-emoji-close').click()
      assert.equal(await h.field('queue', 'appearance').locator('[data-emoji]').getAttribute('data-emoji'), h.acceptance.defaultEmoji.queue)
      assert.equal(await h.field('queue', 'appearance').evaluate(node => node.style.getPropertyValue('--prompt-action-color')), '')
    }
    assert.deepEqual((await h.settings()).promptInput, expected)
    return { trials: TRIALS, retryAndReset: true }
  })
  await h.case('PIS-14-artwork-fallback-and-next-selection-recovery', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      await h.selectAction('queue')
      const trigger = h.field('queue', 'appearance')
      await trigger.locator('img').evaluate(image => image.dispatchEvent(new Event('error')))
      await trigger.locator('img').waitFor({ state: 'detached' })
      assert.equal(await trigger.locator('img').count(), 0)
      assert.equal(await trigger.locator('[data-emoji]').innerText(), h.acceptance.defaultEmoji.queue)
      assert.equal(await trigger.getAttribute('aria-label'), h.acceptance.copy[h.language].emojiAppearance)
      await h.selectEmoji('queue', h.acceptance.emojiSamples[0])
      await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-action-queue-appearance"] img')?.naturalWidth > 0)
      await h.page.getByTestId('prompt-input-cancel').click()
      await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-action-queue-appearance"] img')?.naturalWidth > 0)
    }
    return { trials: TRIALS, fallbackAccessible: true, nextSelectionRecovers: true }
  })
  for (let trial = 1; trial <= TRIALS; trial++) {
    assert(!h.cancelled, 'Runner canceled between trials')
    await h.case(`PIS-05-bilingual-five-widths-${trial}`, () => layoutTrial(h, trial, expected))
    const expectedLanguage = h.language
    await h.case(`PIS-08-real-write-failure-retry-immediate-quit-${trial}`, () => failureAndRetry(h, trial, expected))
    await h.start()
    await h.case(`PIS-03-full-process-restart-${trial}`, async () => {
      const restored = await h.settings()
      assert.deepEqual(restored.promptInput, expected)
      assert.equal(restored.language, expectedLanguage)
      assert.equal(restored.settingsPanelWidth, WIDTHS.at(-1))
      assert.deepEqual(h.launches.at(-2).exit, { code: 0, signal: null }, 'The previous process fully exited before restart')
      await assertUi(h, expected)
      return { trial, launch: h.sequence }
    })
    await h.case(`PIS-06-many-actions-no-resurrection-${trial}`, async () => {
      const stored = (await h.settings()).promptInput
      assert(stored.actions.length > 20)
      assert.equal(new Set(stored.actions.map(action => action.id)).size, stored.actions.length)
      assert(!stored.actions.some(action => action.id === 'send'))
      assert.deepEqual(stored, expected)
      return { trial, actions: stored.actions.length }
    })
    await h.case(`PIS-07-unrelated-preferences-preserved-${trial}`, async () => {
      assert.deepEqual(unrelated(await h.settings()), unrelated(baseline))
      return { trial }
    })
    await h.case(`PIS-04-trusted-leader-hidden-action-after-restart-${trial}`, () => trustedDispatch(h, trial))
    await h.openInputSettings()
  }
  await h.case('PIS-09-five-trial-aggregate', async () => {
    for (const prefix of ['PIS-03-', 'PIS-04-', 'PIS-05-', 'PIS-06-', 'PIS-07-', 'PIS-08-']) {
      const cases = h.results.filter(result => result.id.startsWith(prefix))
      assert.equal(cases.length, TRIALS, `All ${TRIALS} trials must run for ${prefix}`)
      assert(cases.every(result => result.status === 'PASS'), `All ${TRIALS} trials must succeed for ${prefix}`)
    }
    assert.equal(h.launches.length, TRIALS + 1, 'Each trial restarts the process exactly once')
    return { trials: TRIALS, launches: h.launches.length, newLatencyBudget: false }
  })
  await h.stop(true)
  await h.case('PIS-15-emoji-diagnostic-trace-coverage', async () => {
    const events = []
    for (const filename of await readdir(path.join(h.artifacts, 'perf'))) {
      const text = await readFile(path.join(h.artifacts, 'perf', filename), 'utf8')
      events.push(...(filename.endsWith('.jsonl') ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text).traceEvents))
    }
    const required = ['renderer:prompt-emoji.picker-lifecycle', 'renderer:prompt-emoji.load-catalog',
      'renderer:prompt-emoji.search-summary', 'worker:prompt-emoji.index-catalog', 'worker:prompt-emoji.search-summary', 'renderer:prompt-emoji.render-asset']
    const counts = Object.fromEntries(required.map(name => [name, events.filter(event => event.name === name).length]))
    for (const [name, count] of Object.entries(counts)) assert(count > 0, `Missing emoji trace boundary: ${name}`)
    for (const reason of ['open', 'select', 'close', 'input-ready', 'retry', 'grid-focus', 'reset', 'search-focus']) {
      assert(events.some(event => event.name === required[0] && event.args?.reason === reason), `Picker transition recorded: ${reason}`)
    }
    assert(events.some(event => event.name === required[0] && event.args?.reason === 'search-focus' && event.args.focused === true))
    assert(events.some(event => event.name === required[2] && event.args?.focusReconciliations > 0), 'Focused-scroll repair is visible without per-frame tracing')
    assert(events.some(event => event.name === 'main:prompt-shortcut.state-changed' && event.args?.stage === 'suspend-received'
      && event.args.suspended === true && event.args.preserveNativeMenus === true), 'Main acknowledges native-menu preservation for the dialog')
    for (const reason of ['load-failed', 'fallback-reset']) assert(events.some(event => event.name === required[5] && event.args?.reason === reason))
    for (const name of required.slice(3, 5)) assert(events.some(event => event.name === name && event.ph === 'X' && event.dur >= 0))
    await writeFile(path.join(h.artifacts, 'emoji-trace-coverage.json'), JSON.stringify({ counts, events: events.length }, null, 2))
    return { counts, events: events.length }
  })
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--help') return { help: true }
    assert(['--app-bin', '--log-file'].includes(key), `Unknown argument: ${key}`)
    assert(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${key}`)
    options[key === '--app-bin' ? 'appBin' : 'logFile'] = args[++index]
  }
  assert(options.appBin, '--app-bin must identify a packaged development executable')
  return options
}

const options = parseOptions(process.argv.slice(2))
if (options.help) {
  console.log('Usage: node test/autotest/prompt-input-settings-driver.mjs --app-bin <packaged-executable> [--log-file <path-under-traces>]\nFive real restart trials; no build or install. Owns temporary profiles/workspaces and cleans them on exit. Artifacts: traces/test-logs/prompt-input-settings/.')
} else {
  const acceptance = JSON.parse(await readFile(path.join(FIXTURES, 'acceptance.json'), 'utf8'))
  const h = new InputSettingsHarness(options, acceptance)
  let rejectAbort
  const interrupted = new Promise((_, reject) => { rejectAbort = reject })
  const abort = reason => {
    if (h.cancelled) return
    h.cancelled = true
    rejectAbort(new Error(reason))
  }
  const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : ['SIGHUP'])]
  const listeners = signals.map(signal => {
    const listener = () => abort(`Runner interrupted: ${signal}`)
    process.on(signal, listener)
    return [signal, listener]
  })
  const deadline = setTimeout(() => abort(`Runner work exceeded ${WORK_DEADLINE_MS}ms; retain the 180s outer budget and diagnose/split measured work`), WORK_DEADLINE_MS)
  let failure
  const work = run(h)
  try { await Promise.race([work, interrupted]) }
  catch (error) {
    failure = error
    h.cancelled = true
    if (h.page) await h.screenshot('failure').catch(() => {})
  } finally {
    clearTimeout(deadline)
    if (failure) {
      // Closing this child releases pending CDP operations. Drain the scenario
      // before deleting its scratch so its filesystem finally blocks finish.
      try { await h.stop(false) }
      catch (error) { console.error('Owned child cleanup failed:', error) }
      await work.catch(() => {})
    }
    try { process.exitCode = await h.finish(failure) }
    catch (error) { console.error(error); process.exitCode = 1 }
    for (const [signal, listener] of listeners) process.removeListener(signal, listener)
  }
}
