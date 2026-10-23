/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Trusted input crosses the real Electron before-input-event boundary. Debug
// APIs provide native ingress, readouts and barriers; none invoke an action.
// The byte oracle is a separate raw-mode Node child inside each real Task PTY.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ThemeUiHarness, REPO_ROOT, eventually } from './themes-ui-driver-support.mjs'
import { NativeShortcutKeyboard, physicalShortcutKey } from './native-shortcut-keyboard.mjs'

const SUITE = 'prompt-input-shortcuts'
const FIXTURES = path.join(REPO_ROOT, 'test', 'autotest', 'fixtures', SUITE)
const TRIALS = 5
const SEQUENCES_PER_ROUND = 20
// These are deadlock guards, not product latency acceptance thresholds.
const RUNNER_CEILING_MS = 180000
const WORK_DEADLINE_MS = RUNNER_CEILING_MS - 30000
const GROUP_CASE_COUNTS = { user: 23, guests: 4, boundaries: 18, readers: 4 }
const GROUPS = Object.keys(GROUP_CASE_COUNTS)
const MAIN_TAB = 'pis-main-tab'
const OTHER_TAB = 'pis-other-tab'
const TASKS = ['pis-task-1', 'pis-task-2', 'pis-task-3', 'pis-task-4']
const OTHER_TASK = 'pis-other-task'
const PARKED_TASK = 'pis-parked-task'
const LEADER = 'Control+KeyX'
const CONTRACT_APPROVAL = {
  reviewer: 'G', document: 'docs/prompt-input-actions.md', decision: 'approved',
  scope: 'User contract and acceptance oracles; runtime consensus requires MAIN-coordinated execution.',
  expectations: [
    'A window-owned native Leader consumes matched sequences without moving the focused surface.',
    'Numbered targets retain identity; hidden and other-Tab targets are excluded.',
    'Real drag-to-rearrange cancels pending input and blocks shortcuts while its modal is active; fresh digits use the post-drop slot order.',
    'A non-modal AppState reorder preserves an already captured target ID without requiring a new Leader or digit.',
    'One invocation snapshots content/title/source/revision and records captured delivery exactly once.',
    'Newer content, title changes and edit-undo revisions survive delayed completion.',
    'Completion belongs to the originating Tab; a busy notebook rejects a second invocation visibly without writing bytes.',
    'Child stdin bytes prove transport only, not execution or enqueueing in an external application.'
  ]
}

function args(argv) {
  const options = { appBin: '', logFile: '', group: 'user' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') return { help: true }
    if (argv[index] === '--app-bin') options.appBin = argv[++index] ?? ''
    else if (argv[index] === '--log-file') options.logFile = argv[++index] ?? ''
    else if (argv[index] === '--group') options.group = argv[++index] ?? ''
    else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  assert(options.appBin, 'Pass --app-bin with the packaged development executable')
  assert(GROUPS.includes(options.group), `Choose --group ${GROUPS.join('|')}`)
  return options
}

function assertTracePath(filename) {
  const relative = path.relative(path.join(REPO_ROOT, 'traces'), path.resolve(filename))
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Runtime artifacts must be below the repository traces directory: ${filename}`)
}

async function json(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function boundedCleanup(operation) {
  let timer
  try {
    await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cleanup IPC did not settle')), 1000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function shellCommand(shellKind, values) {
  assert(values.every(value => !/[\r\n]/.test(value)), 'Fixture command arguments must be single-line')
  if (shellKind === 'powershell') return `& ${values.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`
  if (shellKind === 'cmd') {
    assert(values.every(value => !/["%!]/.test(value)), 'cmd fixture paths may not contain expansion operators')
    return values.map(value => `"${value}"`).join(' ')
  }
  assert.equal(shellKind, 'posix', 'The real Task must report its shell kind before fixture startup')
  return values.map(value => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ')
}

class RawReceiver {
  constructor(harness, id) {
    this.h = harness
    this.id = id
    this.directory = path.join(harness.scratch, 'receivers', id)
    this.expected = Buffer.alloc(0)
    this.sequence = 0
  }

  async start() {
    await mkdir(this.directory, { recursive: true })
    const capabilities = await this.h.page.evaluate(id => window.electronAPI.terminal.getInputCapabilities(id), this.id)
    const command = shellCommand(capabilities.shellKind, [process.execPath, path.join(this.h.workspace, 'raw-stdin.mjs'), this.directory])
    // Only setup uses terminal.write. Every input under assertion comes from
    // trusted keys or a real action-button click, never from this API.
    const accepted = await this.h.page.evaluate(({ id, command }) => window.electronAPI.terminal.write(id, `${command}\r`), { id: this.id, command })
    assert.equal(accepted, true, `Start raw receiver in ${this.id}`)
    this.started = await eventually(`${this.id} raw child ready`, () => json(path.join(this.directory, 'status.json')),
      state => state?.ready === true && state.stopped === false, 20000)
    await this.capability(true)
  }

  async capability(expected) {
    return eventually(`${this.id} main-owned bracketed-paste capability`,
      () => this.h.page.evaluate(id => window.electronAPI.terminal.getInputCapabilities(id), this.id),
      value => value.bracketedPasteEnabled === expected, 5000)
  }

  append(text) { this.expected = Buffer.concat([this.expected, Buffer.from(text, 'utf8')]) }

  async command(operation, extra = {}, timeoutMs = 4000) {
    const id = ++this.sequence
    const destination = path.join(this.directory, 'command.json')
    await writeFile(`${destination}.next`, JSON.stringify({ id, operation, ...extra }))
    await rename(`${destination}.next`, destination)
    return eventually(`${this.id} receiver ${operation} acknowledgement`, () => json(path.join(this.directory, 'status.json')),
      value => value?.commandId === id, timeoutMs)
  }

  async bracketedPaste(enabled) {
    await this.command('bracketed-paste', { enabled })
    await this.capability(enabled)
  }

  async check() {
    await eventually(`${this.id} expected stdin bytes arrived`, () => readFile(path.join(this.directory, 'stdin.bin')),
      bytes => bytes.length >= this.expected.length, 6000)
    const checkpoint = await this.command('snapshot')
    const actual = await readFile(path.join(this.directory, 'stdin.bin'))
    assert.deepEqual(actual, this.expected,
      `${this.id} exact child stdin (no trimming/CRLF normalization); actual=${actual.toString('hex')} expected=${this.expected.toString('hex')}`)
    assert(checkpoint.length <= actual.length, 'Receiver checkpoint cannot exceed its durable byte file')
    return { id: this.id, bytes: actual.length }
  }
}

class ShortcutHarness extends ThemeUiHarness {
  constructor(options) {
    super({ ...options, group: SUITE })
    this.testGroup = options.group
    this.artifacts = path.join(REPO_ROOT, 'traces', 'test-logs', SUITE, `${this.testGroup}-${this.startedAt.replace(/[:.]/g, '-')}-${process.pid}`)
    this.transcript = options.logFile ? path.resolve(options.logFile) : path.join(REPO_ROOT, 'traces', 'test-logs', `${SUITE}-${this.testGroup}.log`)
    assertTracePath(this.transcript)
    this.receivers = new Map()
    this.guestSessions = []
    this.ackEvidence = []
    this.targetLossEvidence = []
    this.generationEvidence = []
    this.reorderEvidence = []
  }

  async initialize() {
    await mkdir(this.artifacts, { recursive: true })
    await mkdir(path.dirname(this.transcript), { recursive: true })
    await writeFile(this.transcript, '')
    this.scratch = await mkdtemp(path.join(tmpdir(), 'onward-prompt-shortcuts-'))
    this.userData = path.join(this.scratch, 'profile')
    this.workspace = path.join(this.scratch, 'workspace with spaces')
    await Promise.all([mkdir(this.userData), cp(FIXTURES, this.workspace, { recursive: true })])
    if (this.testGroup === 'readers') {
      for (const extension of ['pdf', 'epub']) {
        await cp(path.join(REPO_ROOT, 'test', 'autotest', 'fixtures', 'pdf-epub', `onward-autotest.${extension}`),
          path.join(this.workspace, `reader.${extension}`))
      }
    }
    const seed = await json(path.join(FIXTURES, 'app-state.json'))
    const mainTab = seed.tabs.find(tab => tab.id === MAIN_TAB)
    this.extraTargets = []
    if (this.testGroup === 'user') {
      const extra = await json(path.join(FIXTURES, 'eight-targets.json'))
      mainTab.terminals.splice(mainTab.terminals.length - 1, 0, ...extra.terminals)
      this.extraTargets = extra.terminals.map(terminal => terminal.id)
    }
    this.fixtureTaskCount = mainTab.terminals.length
    for (const tab of seed.tabs) for (const terminal of tab.terminals) terminal.lastCwd = this.workspace
    await Promise.all([
      writeFile(path.join(this.userData, 'app-state.json'), JSON.stringify(seed)),
      cp(path.join(FIXTURES, 'settings.json'), path.join(this.userData, 'settings.json'))
    ])
    await this.log('START', { suite: SUITE, group: this.testGroup, appBin: this.appBin, artifacts: this.artifacts, trials: TRIALS, ceilingMs: RUNNER_CEILING_MS })
    await this.writeCoverage()
  }

  async writeCoverage() {
    await writeFile(path.join(this.artifacts, 'coverage-contract.json'), JSON.stringify({
      approval: CONTRACT_APPROVAL, group: this.testGroup, trials: TRIALS, ceilingMs: RUNNER_CEILING_MS,
      counts: Object.fromEntries(['PASS', 'FAIL', 'SKIP'].map(status => [status, this.results.filter(result => result.status === status).length])),
      consensus: 'Contract approved; MAIN-coordinated runtime and stability validation pending.',
      cases: this.results.map(({ id, status }) => ({ id, status })), coverageGaps: []
    }, null, 2))
  }

  async boot() {
    // The shared harness's draft launch profile enables diagnostic tracing and
    // performs the existing packaged-app startup handshake. No Theme assertions
    // are substituted for shortcut assertions below.
    this.group = 'draft'
    try { await super.start() } finally { this.group = SUITE }
    await this.page.getByTestId('sidebar-settings-button').click()
    await this.page.locator('.settings-container').waitFor({ state: 'hidden' })
    await this.page.bringToFront()
    this.hostCdp = await this.context.newCDPSession(this.page)
    assert(await this.page.evaluate(() => typeof window.electronAPI.debug.sendInputEvent === 'function'),
      'Trusted shortcut tests require the real Electron sendInputEvent ingress')
    this.keyboard = new NativeShortcutKeyboard(this.page)
    await this.page.evaluate(() => {
      window.__pisProbe = { events: [], compositionStarts: 0 }
      window.__pisProbe.unsubscribe = window.electronAPI.promptInput.onShortcut(event => {
        window.__pisProbe.events.push({ ...event })
        if (event.kind === 'dispatch' && window.__pisProbe.captureDraftDispatch) {
          const api = window.__onwardPromptNotebookDebug
          const editor = document.querySelector(`.prompt-notebook:has(.prompt-sender[data-tab-id="${event.tabId}"]) .prompt-editor-content`)
          window.__pisProbe.draftAtDispatch = {
            parent: api.getEditorContent(), live: api.getLiveDraftSnapshot(),
            domText: editor?.textContent, syncHeld: api.isDraftSyncHeld()
          }
        }
      })
      document.addEventListener('compositionstart', () => { window.__pisProbe.compositionStarts += 1 }, true)
    })
    await this.switchTab(MAIN_TAB)
    await this.showPrompt()
    await this.waitTasks(TASKS)
    for (const id of TASKS) await this.startReceiver(id)
    await this.switchTab(OTHER_TAB)
    await this.waitTasks([OTHER_TASK])
    await this.startReceiver(OTHER_TASK)
    await this.switchTab(MAIN_TAB)
    await this.showPrompt()
    await this.focusTerminal(TASKS[0])
    await this.select([])
    assert(await this.page.evaluate(() => {
      const api = window.__onwardPromptNotebookDebug
      return window.electronAPI.debug.autotest &&
        ['getLiveDraftSnapshot', 'getEditorContent', 'isInputBusy', 'setInputAckHeld', 'isInputAckWaiting', 'setDraftSyncHeld', 'isDraftSyncHeld']
          .every(name => typeof api?.[name] === 'function')
    }), 'The final built product must expose F\'s real post-PTY ACK barrier; stale bundles cannot run these cases')
    if (this.testGroup === 'user' || this.testGroup === 'boundaries') {
      const hooks = await this.page.evaluate(() => ({
        layout: typeof window.__onwardAppDebug?.setLayoutCountForAutotest === 'function',
        dispatchHold: typeof window.__onwardPromptInputShortcutsDebug?.setDispatchHeld === 'function',
        dispatchCount: typeof window.__onwardPromptInputShortcutsDebug?.getHeldDispatchCount === 'function',
        blur: typeof window.electronAPI.debug.blurWindow === 'function',
        reorder: typeof window.__onwardAppDebug?.reorderActiveTabTasksForAutotest === 'function'
      }))
      assert.deepEqual(hooks, { layout: true, dispatchHold: true, dispatchCount: true, blur: true, reorder: true },
        'Mandatory PIK-29/30/33/34/35 require layout, real-dispatch hold, native blur and real AppState reorder hooks')
    }
  }

  notebook(tab = MAIN_TAB) { return this.page.locator(`.prompt-notebook:has(.prompt-sender[data-tab-id="${tab}"])`) }
  editor(tab = MAIN_TAB) { return this.notebook(tab).locator('.prompt-editor-content') }
  title(tab = MAIN_TAB) { return this.notebook(tab).locator('.prompt-editor-title') }
  sender(tab = MAIN_TAB) { return this.page.locator(`.prompt-sender[data-tab-id="${tab}"]`) }
  task(id) { return this.page.locator(`.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-terminal-id="${id}"]`) }

  async switchTab(id) {
    const selected = await this.page.evaluate(id => window.__onwardAppDebug.switchToTabById(id), id)
    assert(selected, `Fixture Tab ${id} exists`)
    await this.page.waitForFunction(id => window.__onwardAppDebug?.getActiveTabId() === id, id)
  }

  async waitTasks(ids) {
    await this.page.waitForFunction(ids => ids.every(id => {
      const cell = document.querySelector(`.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-terminal-id="${id}"]`)
      return cell && cell.getBoundingClientRect().width > 0 && window.__onwardTerminalDebug?.getSessionState(id)?.status === 'ready'
    }), ids, { timeout: 45000 })
  }

  async startReceiver(id) {
    const receiver = new RawReceiver(this, id)
    this.receivers.set(id, receiver)
    try { await receiver.start() } catch (error) {
      const tail = await this.page.evaluate(id => window.__onwardTerminalDebug?.getTailText(id, 20), id).catch(() => null)
      await this.log('RECEIVER_START_FAILED', { id, error: String(error), tail })
      throw error
    }
  }

  async showPrompt(tab = MAIN_TAB) {
    if (!await this.editor(tab).isVisible()) await this.page.getByTitle('Prompt notebook', { exact: true }).click()
    await this.editor(tab).waitFor({ state: 'visible' })
  }

  async seed(content) {
    await this.showPrompt()
    // Chromium fill('') leaves a filler BR whose innerText is a newline. Use
    // the existing fixture setter for a genuinely empty draft, without relaxing
    // the byte/string oracle or touching the action dispatch path.
    if (content === '') {
      await this.page.evaluate(() => window.__onwardPromptNotebookDebug.setEditorContent(''))
      await this.editor().focus()
    } else await this.editor().fill(content)
    assert.equal(await this.editor().innerText(), content, 'Fixture preparation reaches the real contenteditable DOM')
  }

  async focusTerminal(id) {
    await this.task(id).locator('.xterm-screen').click({ position: { x: 8, y: 8 } })
    await this.page.waitForFunction(id => document.activeElement?.closest('.terminal-grid-cell')?.getAttribute('data-terminal-id') === id, id)
    const tabId = await this.page.evaluate(() => window.__onwardAppDebug.getActiveTabId())
    await eventually('Focused Task activation reaches AppState', () => this.page.evaluate(() => window.electronAPI.appState.load()),
      state => state.tabs.find(tab => tab.id === tabId)?.activeTerminalId === id)
  }

  async select(ids) {
    await this.showPrompt()
    const cards = this.sender().locator('.prompt-sender-terminal')
    for (let index = 0; index < await cards.count(); index += 1) {
      const card = cards.nth(index)
      const id = await card.getAttribute('data-terminal-id')
      if ((await card.getAttribute('aria-pressed') === 'true') !== ids.includes(id)) {
        await card.click()
        await this.page.waitForFunction(({ id, selected }) =>
          document.querySelector(`.prompt-sender[data-tab-id="pis-main-tab"] .prompt-sender-terminal[data-terminal-id="${id}"]`)?.getAttribute('aria-pressed') === String(selected),
        { id, selected: ids.includes(id) })
      }
    }
    assert.deepEqual((await this.sender().locator('.prompt-sender-terminal[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.terminalId))).sort(), [...ids].sort())
  }

  async selectedIds() {
    return this.page.evaluate(() => window.__onwardPromptSenderDebug.getSelectedTerminalIds())
  }

  async taskOrder() {
    return this.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-terminal-id]')
      .evaluateAll(nodes => nodes.map(node => node.dataset.terminalId))
  }

  async waitTaskOrder(order) {
    await this.page.waitForFunction(({ order, tabId }) => {
      const grid = [...document.querySelectorAll('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-terminal-id]')]
      const cards = [...document.querySelectorAll(`.prompt-sender[data-tab-id="${tabId}"] .prompt-sender-terminal`)]
      return [grid, cards].every(nodes => nodes.length === order.length && nodes.every((node, index) => node.dataset.terminalId === order[index]))
    }, { order, tabId: MAIN_TAB })
    // The reordered render's useLayoutEffect has sent setContext before this
    // DOM predicate resolves. This ordinary same-frame IPC round-trip runs
    // behind that main handler; it never supplies or overwrites shortcut context.
    const state = await eventually('Real Task order reaches persisted AppState',
      () => this.page.evaluate(() => window.electronAPI.appState.load()), state => {
        const terminals = state.tabs.find(tab => tab.id === MAIN_TAB)?.terminals ?? []
        return terminals.length === this.fixtureTaskCount && order.every((id, index) => terminals[index]?.id === id)
      })
    assert.equal(state.activeTabId, MAIN_TAB, 'Reordering must not switch the active Tab')
    assert.equal(state.tabs.find(tab => tab.id === MAIN_TAB).terminals.at(-1).id, PARKED_TASK, 'Reordering visible Tasks leaves the parked tail intact')
  }

  async parkLayout(count) {
    assert([2, 4, 8].includes(count), 'Only the fixture\'s two/four/eight visible Task layouts are used')
    const accepted = await this.page.evaluate(count => window.__onwardAppDebug.setLayoutCountForAutotest(count), count)
    assert.notEqual(accepted, false, 'The real AppState layout mutation was accepted')
    await this.page.waitForFunction(({ count, tabId }) => {
      const cards = document.querySelectorAll(`.prompt-sender[data-tab-id="${tabId}"] .prompt-sender-terminal`)
      const grid = document.querySelector('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid')
      return cards.length === count && grid?.getAttribute('data-layout') === String(count) &&
        window.__onwardPromptSenderDebug.getTerminalCards().length === count
    }, { count, tabId: MAIN_TAB })
    await eventually('Layout visibility reaches real AppState', () => this.page.evaluate(() => window.electronAPI.appState.load()), state => {
      const tab = state.tabs.find(tab => tab.id === MAIN_TAB)
      return tab?.layoutMode.kind === 'preset' && tab.layoutMode.count === count && tab.terminals.length === this.fixtureTaskCount
    })
  }

  async holdShortcutDispatch(held) {
    const count = await this.page.evaluate(held => {
      const api = window.__onwardPromptInputShortcutsDebug
      api.setDispatchHeld(held)
      return api.getHeldDispatchCount()
    }, held)
    if (!held) assert.equal(count, 0, 'Release synchronously drains actual queued renderer dispatch callbacks')
  }

  async shortcutDispatchWaiting() {
    await this.page.waitForFunction(() => window.__onwardPromptInputShortcutsDebug.getHeldDispatchCount() === 1)
  }

  async eventMark() { return this.page.evaluate(() => window.__pisProbe.events.length) }
  async eventsSince(mark) { return this.page.evaluate(mark => window.__pisProbe.events.slice(mark), mark) }

  async eventAfter(mark, kind, reason) {
    const events = await eventually(`shortcut ${kind}${reason ? `/${reason}` : ''}`, () => this.eventsSince(mark),
      values => values.some(value => value.kind === kind && (!reason || value.reason === reason)), 5000)
    return events.find(value => value.kind === kind && (!reason || value.reason === reason))
  }

  async rememberFocus() { await this.page.evaluate(() => { window.__pisFocus = document.activeElement }) }
  async focusPreserved() { assert(await this.page.evaluate(() => document.activeElement === window.__pisFocus), 'Action preserves the originating DOM focus') }

  async idle() {
    await this.page.waitForFunction(() => {
      const sender = document.querySelector('.prompt-sender[data-tab-id="pis-main-tab"]')
      const action = sender?.querySelector('[data-action-id="execute"]')
      return window.__onwardPromptNotebookDebug?.isInputBusy() === false &&
        action && !action.disabled && Boolean(window.__onwardPromptSenderDebug?.getNotice())
    }, null, { timeout: 7000 })
  }

  async openSettings(page = 'appearance') {
    await super.openSettings(page)
    if (page === 'shortcuts') {
      const expand = this.page.getByTestId('prompt-input-expand')
      if (await expand.getAttribute('aria-expanded') === 'false') await expand.click()
    }
  }

  async leaderState(active) {
    await this.page.waitForFunction(active => Boolean(window.__onwardPromptInputShortcutsDebug?.getLeaderState()?.active) === active, active)
    await this.page.getByTestId('prompt-leader-indicator').waitFor({ state: active ? 'visible' : 'detached' })
    if (!active) await this.page.waitForFunction(() => !document.querySelector(
      '[data-testid="prompt-task-target-badge"], [data-testid="prompt-target-map"]'))
  }

  async choosingTargets(order) {
    await this.page.waitForFunction(count => {
      const cue = document.querySelector('[data-testid="prompt-leader-indicator"]')
      return cue?.dataset.selecting === 'true' && cue.textContent === `1–${count}` &&
        document.querySelectorAll('.terminal-grid-wrapper:not(.terminal-grid-hidden) [data-testid="prompt-task-target-badge"]').length === count
    }, order.length)
    const badges = await this.page.getByTestId('prompt-task-target-badge').evaluateAll(nodes => nodes.map(node => ({
      id: node.closest('[data-terminal-id]')?.getAttribute('data-terminal-id'), number: node.textContent,
      selected: node.dataset.selected
    })))
    assert.deepEqual(badges, order.map((id, index) => ({ id, number: String(index + 1), selected: 'false' })),
      'Choosing labels follow visible slot order and never include another Tab or parked Task')
  }

  async selectedTarget(id, number) {
    await this.page.waitForFunction(({ id, number }) => {
      const cue = document.querySelector('[data-testid="prompt-leader-indicator"]')
      const badges = [...document.querySelectorAll('[data-testid="prompt-task-target-badge"]')]
      return cue?.dataset.targetId === id && cue.dataset.selecting === 'false' && cue.textContent === `→${number}` &&
        badges.length === 1 && badges[0].dataset.selected === 'true' && badges[0].textContent === String(number) &&
        badges[0].closest('[data-terminal-id]')?.getAttribute('data-terminal-id') === id &&
        !document.querySelector('[data-testid="prompt-target-map"]')
    }, { id, number })
  }

  async setTargetModifier(modifier) {
    await this.openSettings('shortcuts')
    const selector = this.page.getByTestId('prompt-input-target-modifier')
    if (await selector.inputValue() !== (modifier ?? '')) {
      await selector.selectOption(modifier ?? '')
      await this.page.getByTestId('prompt-input-save').click()
      await this.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-status"]')?.dataset.state === 'saved')
    }
    assert.equal((await this.page.evaluate(() => window.electronAPI.settings.load())).promptInput.targetModifier, modifier)
    await this.page.getByTestId('sidebar-settings-button').click()
    await this.page.locator('.settings-container').waitFor({ state: 'hidden' })
    this.targetModifier = modifier
  }

  async chord(key, { keyboard = this.keyboard, digit } = {}) {
    const mark = await this.eventMark()
    await keyboard.press(LEADER)
    if (digit) await keyboard.press(`${this.targetModifier ? `${this.targetModifier}+` : ''}Digit${digit}`)
    await keyboard.press(key)
    return mark
  }

  expect(ids, bytes) { for (const id of ids) { assert(this.receivers.has(id), `No byte oracle for ${id}`); this.receivers.get(id).append(bytes) } }

  async checkBytes() { return Promise.all([...this.receivers.values()].map(receiver => receiver.check())) }

  async history(tabId = MAIN_TAB) {
    const state = await this.page.evaluate(() => window.electronAPI.appState.load())
    return state.tabs.find(tab => tab.id === tabId).localPrompts
  }

  async snapshot(origin = false) {
    const snapshot = await this.page.evaluate(origin => (origin ? window.__pisAckOwner : window.__onwardPromptNotebookDebug).getLiveDraftSnapshot(), origin)
    assert(snapshot && Number.isInteger(snapshot.revision), 'Read a real editor-local revision, never a debounced parent preview')
    return snapshot
  }

  async holdAck() {
    await this.page.evaluate(() => {
      window.__pisAckOwner = window.__onwardPromptNotebookDebug
      window.__pisAckOwner.setInputAckHeld(true)
    })
  }

  async releaseAck() {
    await this.page.evaluate(() => window.__pisAckOwner?.setInputAckHeld(false))
  }

  async holdDraftSync(held) {
    await this.page.evaluate(held => window.__onwardPromptNotebookDebug.setDraftSyncHeld(held), held)
    assert.equal(await this.page.evaluate(() => window.__onwardPromptNotebookDebug.isDraftSyncHeld()), held)
  }

  async ackWaiting() {
    await this.page.waitForFunction(() => window.__pisAckOwner.isInputAckWaiting() && window.__pisAckOwner.isInputBusy())
  }

  async ackSettled() {
    await this.page.waitForFunction(() => !window.__pisAckOwner.isInputAckWaiting() && !window.__pisAckOwner.isInputBusy())
  }

  async capturedHistory(snapshot, previousCount) {
    const history = await eventually('Originating Tab records captured history exactly once', () => this.history(), entries => entries.length === previousCount + 1)
    const matching = history.filter(entry => entry.content === snapshot.content)
    assert.equal(matching.length, 1, 'Exactly one entry records the immutable sent content')
    const entry = matching[0]
    assert.equal(entry.title, snapshot.title.trim(), 'History records the captured title, not the later title')
    assert.equal(entry.color ?? null, snapshot.color ?? null)
    assert.equal(entry.sendHistory.length, 1)
    const record = entry.sendHistory[0]
    assert.equal(record.taskId, TASKS[0])
    assert.equal(record.inputActionId, 'queue')
    assert.equal(record.inputTerminalKey, 'Tab')
    assert.equal(record.inputResult.ok, true)
    assert.equal(record.inputResult.contentDelivered, true)
    return entry.id
  }

  async sent(mark, ids, bytes, content, previousCount) {
    const dispatch = await this.eventAfter(mark, 'dispatch')
    assert.equal(dispatch.tabId, MAIN_TAB)
    assert.equal((await this.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 1, 'One physical chord dispatches once')
    this.expect(ids, bytes)
    await this.checkBytes()
    await this.idle()
    if (content !== undefined) {
      await this.page.waitForFunction(selector => document.querySelector(selector)?.textContent === '',
        '.prompt-notebook:has(.prompt-sender[data-tab-id="pis-main-tab"]) .prompt-editor-content')
      const history = await eventually('Captured snapshot saved once', () => this.history(), entries => entries.length === previousCount + 1)
      const matching = history.filter(entry => entry.content === content)
      assert.equal(matching.length, 1, 'History contains the exact sent snapshot once')
      assert.equal(matching[0].sendHistory.length, ids.length, 'One history entry accounts for every target')
    }
    return dispatch
  }

  async guestNativeFocus() {
    return this.page.evaluate(() => window.electronAPI.debug.getInputFocus())
  }

  async repeat(id, action) {
    return this.case(id, async () => {
      const trials = []
      for (let trial = 0; trial < TRIALS; trial += 1) {
        assert(!this.cancelled)
        trials.push(await action(trial))
      }
      assert.equal(trials.length, TRIALS)
      return { trials }
    })
  }

  async finish(error) {
    await boundedCleanup(this.keyboard?.releaseAll()).catch(cleanupError => { error ??= cleanupError })
    await boundedCleanup(this.page?.evaluate(() => window.__onwardPromptInputShortcutsDebug?.setDispatchHeld(false))).catch(() => {})
    await boundedCleanup(this.page?.evaluate(() => window.__onwardPromptNotebookDebug?.setDraftSyncHeld(false))).catch(() => {})
    await boundedCleanup(this.releaseAck()).catch(() => {})
    await Promise.allSettled(this.guestSessions.map(session => boundedCleanup(session.close())))
    const cleanup = await Promise.allSettled([...this.receivers.values()].map(async receiver => {
      if (receiver.started) await receiver.command('stop', {}, 1500)
    }))
    for (const result of cleanup) if (result.status === 'rejected') error ??= result.reason
    if (this.scratch) {
      await cp(path.join(this.scratch, 'receivers'), path.join(this.artifacts, 'receivers'), { recursive: true })
        .catch(copyError => { if (copyError.code !== 'ENOENT') error ??= copyError })
    }
    await this.writeCoverage().catch(reportError => { error ??= reportError })
    this.group = `${SUITE}-${this.testGroup}`
    return super.finish(error)
  }
}

// Playwright's page list need not include Electron webview targets. Attach the
// guest through a Playwright-owned CDP session for geometry/focus/event probes.
// All keyboard ingress still uses host IPC, addressed to the focused WebContents.
class GuestKeyboard {
  constructor(session, targetSessionId, keyboard) {
    this.session = session
    this.targetSessionId = targetSessionId
    this.keyboard = keyboard
    this.pending = new Map()
    this.sequence = 0
    this.listener = packet => {
      if (packet.sessionId !== this.targetSessionId) return
      const message = JSON.parse(packet.message)
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    }
    session.on('Target.receivedMessageFromTarget', this.listener)
  }

  static async attach(harness) {
    const session = await harness.browser.newBrowserCDPSession()
    try {
      const targets = await session.send('Target.getTargets')
      const candidates = targets.targetInfos.filter(info => ['webview', 'page', 'other'].includes(info.type) && info.url.includes('guest-input.html'))
      const target = candidates.find(info => info.type === 'webview') ?? candidates[0]
      assert(target, `OpenBrowser must expose its real webview target: ${JSON.stringify(targets.targetInfos.map(info => ({ type: info.type, url: info.url })))}`)
      const attached = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
      return new GuestKeyboard(session, attached.sessionId, harness.keyboard)
    } catch (error) { await session.detach(); throw error }
  }

  async send(method, params) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Guest CDP ${method} acknowledgement timed out`)) }, 6000)
      this.pending.set(id, { resolve, reject, timer })
      this.session.send('Target.sendMessageToTarget', { sessionId: this.targetSessionId, message: JSON.stringify({ id, method, params }) })
        .catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error) })
    })
  }

  press(stroke) { return this.keyboard.press(stroke) }
  down(code) { return this.keyboard.down(code) }
  up(code) { return this.keyboard.up(code) }

  async read(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!result.exceptionDetails, `Guest probe failed: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result.value
  }

  async close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Guest CDP closed')) }
    this.pending.clear()
    this.session.off('Target.receivedMessageFromTarget', this.listener)
    await this.session.detach()
  }
}

async function startup(h) {
  await h.case('PIK-00-isolated-startup-real-pty-oracles', async () => {
    await h.boot()
    const settings = await h.page.evaluate(() => window.electronAPI.settings.load())
    assert.equal(settings.promptInput.leader, 'Control+X')
    assert.equal(settings.promptInput.targetModifier, null, 'Existing settings retain direct digits')
    assert.equal(settings.promptInput.timeoutMs, 1500)
    assert.equal(await h.sender().locator('[data-action-id="queue"]').count(), 0, 'Hidden action has no button')
    const state = await h.page.evaluate(() => window.electronAPI.appState.load())
    assert(state.tabs.find(tab => tab.id === MAIN_TAB).terminals.some(terminal => terminal.id === PARKED_TASK), 'Fixture really contains a parked Task')
    assert.equal(await h.sender().locator(`[data-terminal-id="${PARKED_TASK}"]`).count(), 0, 'Parked Task is outside the selector')
    return { receivers: [...h.receivers.keys()], bytes: await h.checkBytes(), screenshot: await h.screenshot('startup') }
  })
}

async function caretContinuity(h, fixture) {
  const target = (await h.taskOrder())[2]
  const history = await h.history()
  const selection = await h.selectedIds()
  const outcomes = []
  for (const [action, selectText] of [['KeyE', true], ['Escape', false]]) {
    await h.seed(fixture.content)
    // Establish a precise user selection once; never repair it after native input.
    await h.editor().evaluate((editor, { text, selectText }) => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const offset = node.data.indexOf(text)
        if (offset < 0) continue
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + (selectText ? text.length : 0))
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        const prefix = document.createRange()
        prefix.selectNodeContents(editor)
        prefix.setEnd(node, offset)
        editor.__pikCaret = { start: prefix.toString().length,
          end: prefix.toString().length + (selectText ? text.length : 0) }
        return
      }
      throw new Error('The committed caret fixture selection must exist in the live editor')
    }, { text: fixture.selection, selectText })
    const draft = await h.snapshot()
    await h.rememberFocus()
    try {
      const mark = await h.chord(action, { digit: 3 })
      if (action === 'KeyE') await h.sent(mark, [target], '\r')
      else {
        await h.eventAfter(mark, 'cancel', 'escape')
        assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
        await h.checkBytes()
      }
      await h.leaderState(false)
      await h.focusPreserved()
      assert.deepEqual(await h.snapshot(), draft, 'Key-only delivery and cancellation retain the full draft revision')
      assert.deepEqual(await h.history(), history)
      assert.deepEqual(await h.selectedIds(), selection)
      const caret = await h.editor().evaluate(editor => {
        const current = window.getSelection(), previous = editor.__pikCaret
        if (current.rangeCount !== 1 || !editor.contains(current.anchorNode) || !editor.contains(current.focusNode)) {
          return { retained: false, selected: current.toString() }
        }
        const prefix = document.createRange()
        prefix.selectNodeContents(editor)
        prefix.setEnd(current.anchorNode, current.anchorOffset)
        const start = prefix.toString().length
        prefix.setEnd(current.focusNode, current.focusOffset)
        return { retained: start === previous.start && prefix.toString().length === previous.end, selected: current.toString() }
      })
      assert.deepEqual(caret, { retained: true, selected: selectText ? fixture.selection : '' })
      await h.keyboard.press('KeyZ')
      const offset = fixture.content.indexOf(fixture.selection)
      const expected = fixture.content.slice(0, offset) + fixture.replacement +
        fixture.content.slice(offset + (selectText ? fixture.selection.length : 0))
      await eventually('Native typing resumes at the untouched caret or selection', () => h.editor().innerText(), value => value === expected)
      await h.checkBytes()
      assert.deepEqual(await h.history(), history)
      outcomes.push({ action, selectedText: selectText, typedAtOriginalPosition: true })
    } finally {
      await h.keyboard.releaseAll()
      await h.editor().evaluate(editor => { delete editor.__pikCaret })
    }
  }
  return outcomes
}

async function core(h) {
  for (const [id, surface] of [['PIK-01-prompt-focus-queue-exact-bytes', 'prompt'], ['PIK-02-terminal-focus-queue-exact-bytes', 'terminal']]) {
    await h.repeat(id, async trial => {
      const content = `${surface}-queue-${trial}`
      const count = (await h.history()).length
      await h.seed(content)
      if (surface === 'terminal') await h.focusTerminal(TASKS[0])
      await h.rememberFocus()
      const mark = await h.chord('KeyQ')
      await h.sent(mark, [TASKS[0]], `${content}\t`, content, count)
      await h.focusPreserved()
      return { content, focus: surface, historyDelta: 1 }
    })
  }

  await h.repeat('PIK-03-normal-keys-and-double-leader-native-pass', async trial => {
    await h.seed('')
    await h.keyboard.press('KeyZ')
    await h.page.waitForFunction(() => document.querySelector('.prompt-notebook:has(.prompt-sender[data-tab-id="pis-main-tab"]) .prompt-editor-content')?.textContent === 'z')
    assert.equal(await h.editor().innerText(), 'z')
    await h.focusTerminal(TASKS[0])
    const mark = await h.eventMark()
    await h.keyboard.press('KeyZ')
    await h.keyboard.press(LEADER)
    await h.keyboard.press(LEADER)
    await h.eventAfter(mark, 'passthrough')
    h.expect([TASKS[0]], 'z\x18')
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
    return { trial, rawHex: '7a18' }
  })

  await h.repeat('PIK-04-escape-and-unknown-consumed-without-leak', async trial => {
    await h.seed(`cancel-${trial}`)
    await h.focusTerminal(TASKS[0])
    const count = (await h.history()).length
    for (const [key, reason] of [['Escape', 'escape'], ['KeyZ', 'unmatched']]) {
      const mark = await h.chord(key)
      await h.eventAfter(mark, 'cancel', reason)
      assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
    }
    await h.checkBytes()
    assert.equal((await h.history()).length, count)
    assert.equal(await h.editor().innerText(), `cancel-${trial}`)
    return { trial, reasons: ['escape', 'unmatched'] }
  })

  await h.repeat('PIK-05a-held-leader-and-action-dispatch-once', async trial => {
    const content = `repeat-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    const mark = await h.eventMark()
    try {
      await h.keyboard.down('Control')
      await h.keyboard.down('KeyX')
      await h.keyboard.down('KeyX')
      await h.keyboard.up('KeyX')
      await h.keyboard.up('Control')
      await h.keyboard.down('KeyQ')
      await h.keyboard.down('KeyQ')
      await h.keyboard.up('KeyQ')
    } finally { await h.keyboard.releaseAll() }
    await h.sent(mark, [TASKS[0]], `${content}\t`, content, count)
    return { trial, dispatches: 1 }
  })

  await h.setTargetModifier('Alt')
  await h.repeat('PIK-05b-timeout-cancels-then-native-key-passes', async trial => {
    await h.seed(`timeout-${trial}`)
    await h.focusTerminal(TASKS[0])
    const draft = await h.snapshot()
    const history = await h.history()
    const selection = await h.selectedIds()
    const mark = await h.eventMark()
    try {
      await h.keyboard.press(LEADER)
      await h.eventAfter(mark, 'state')
      await h.keyboard.down('Alt')
      await h.choosingTargets(await h.taskOrder())
      await h.eventAfter(mark, 'cancel', 'timeout')
      await h.leaderState(false)
    } finally { await h.keyboard.releaseAll() }
    await h.keyboard.press('KeyQ')
    h.expect([TASKS[0]], 'q')
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
    assert.deepEqual(await h.snapshot(), draft)
    assert.deepEqual(await h.history(), history)
    assert.deepEqual(await h.selectedIds(), selection)
    return { trial, configuredTimeoutMs: 1500, heldSelectorCleared: true }
  })
  await h.setTargetModifier(null)

  await h.repeat('PIK-06-numeric-target-overrides-manual-and-is-one-shot', async trial => {
    await h.select([TASKS[1]])
    const content = `numeric-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    const mark = await h.chord('KeyQ', { digit: 3 })
    const event = await h.sent(mark, [TASKS[2]], `${content}\t`, content, count)
    assert.equal(event.targetId, TASKS[2])
    const next = await h.chord('KeyE')
    await h.sent(next, [TASKS[1]], '\r')
    assert.equal((await h.history()).length, count + 1)
    return { trial, explicitTarget: TASKS[2], followingDefaultTarget: TASKS[1] }
  })

  await h.repeat('PIK-07-manual-multiple-targets-and-active-fallback', async trial => {
    await h.select([TASKS[1], TASKS[3]])
    const content = `manual-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    await h.sent(await h.chord('KeyQ'), [TASKS[1], TASKS[3]], `${content}\t`, content, count)
    await h.select([])
    await h.focusTerminal(TASKS[0])
    await h.sent(await h.chord('KeyE'), [TASKS[0]], '\r')
    return { trial, manualTargets: 2, activeFallback: TASKS[0] }
  })

  await h.repeat('PIK-08-all-visible-only-and-explicit-all-conflict', async trial => {
    await h.select([TASKS[1]])
    const content = `all-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    await h.sent(await h.chord('KeyA'), TASKS, `${content}\r`, content, count)
    await h.seed(`conflict-${trial}`)
    const conflict = await h.chord('KeyA', { digit: 3 })
    await h.eventAfter(conflict, 'cancel', 'target-conflict')
    const notice = h.page.locator('.prompt-input-global-notice')
    await notice.waitFor({ state: 'visible' })
    const firstText = await notice.locator('span').innerText()
    await notice.getByRole('button').click()
    await notice.waitFor({ state: 'detached' })
    await h.eventAfter(await h.chord('KeyA', { digit: 3 }), 'cancel', 'target-conflict')
    await notice.waitFor({ state: 'visible' })
    assert.equal(await notice.locator('span').innerText(), firstText, 'An identical new error is visible after dismissing the previous occurrence')
    const unavailable = await h.eventMark()
    await h.keyboard.press(LEADER)
    await h.keyboard.press('Digit5')
    await h.eventAfter(unavailable, 'cancel', 'target-unavailable')
    await h.checkBytes()
    assert.equal((await h.history()).length, count + 1)
    assert.equal(await h.editor().innerText(), `conflict-${trial}`)
    return { trial, recipients: TASKS, excluded: [PARKED_TASK, OTHER_TASK] }
  })

  await h.repeat('PIK-09-real-drag-cancels-blocks-and-fresh-digit-uses-new-slot', async trial => {
    await h.select([])
    const content = `drag-modal-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    const cells = h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-terminal-id]')
    const order = await h.taskOrder()
    assert.equal(order.length, 4)
    const capturedId = order[2]
    const expectedOrder = [order[2], order[0], order[1], order[3]]
    const newSlotTarget = expectedOrder[2]
    assert.notEqual(newSlotTarget, capturedId, 'The same digit must identify a different Task after the real drop')
    const source = await cells.nth(2).locator('.terminal-grid-header').boundingBox()
    const sourceCell = await cells.nth(2).boundingBox()
    const destination = await cells.nth(0).boundingBox()
    assert(source && sourceCell && destination)
    const press = { x: source.x + source.width - 12, y: source.y + source.height / 2 }
    const mark = await h.eventMark()
    await h.keyboard.press(LEADER)
    await h.keyboard.press('Digit3')
    await eventually('Native digit captures the pre-drag target', () => h.eventsSince(mark),
      events => events.some(event => event.kind === 'state' && event.active && event.targetId === capturedId))
    await h.leaderState(true)
    await h.page.mouse.move(press.x, press.y)
    await h.page.mouse.down()
    let cancellation
    try {
      await h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid.is-rearranging').waitFor({ state: 'visible' })
      cancellation = await h.eventAfter(mark, 'cancel')
      // Moving pointer ownership can cancel before the modal registers. Both
      // paths must leave the old sequence dead by long-press mode entry.
      assert(['context-changed', 'blocked'].includes(cancellation.reason), 'Real drag entry cancels pending input, never merely waits for its timeout')
      await h.leaderState(false)
      // The legacy global grid debug object can belong to a hidden Tab. The
      // visible DOM above is the authoritative modal oracle for this gesture.
      await h.page.waitForFunction(() => document.activeElement === document.body)
      // The modal deliberately blurs the terminal. Verify that ownership before
      // sending printable native keys, so the oracle never receives fixture noise.
      const blockedMark = await h.chord('KeyQ', { digit: 3 })
      await h.checkBytes()
      assert.equal((await h.eventsSince(blockedMark)).filter(event => event.kind === 'state' || event.kind === 'dispatch').length, 0,
        'Native input cannot arm or dispatch while the drag modal is active')
      assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
      assert.equal((await h.history()).length, count)
      assert.equal(await h.editor().innerText(), content)
      // Preserve the grab offset so the ghost centre lands at the destination
      // centre, rather than depending on the header's height or blank width.
      await h.page.mouse.move(press.x + destination.x - sourceCell.x, press.y + destination.y - sourceCell.y, { steps: 2 })
      await h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-slot-index="0"].is-drop-target').waitFor({ state: 'visible' })
      await h.page.mouse.up()
      await h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid.is-rearranging').waitFor({ state: 'hidden' })
      await h.waitTaskOrder(expectedOrder)
    } finally { await h.page.mouse.up() }
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0, 'Finishing the drop cannot revive the canceled sequence')
    await h.editor().focus()
    const snapshot = await h.snapshot()
    const dispatched = await h.sent(await h.chord('KeyQ', { digit: 3 }), [newSlotTarget], `${content}\t`, content, count)
    assert.equal(dispatched.targetId, newSlotTarget, 'A fresh digit resolves the new occupant, never the canceled pre-drag ID')
    const evidence = {
      kind: 'real-drag', trial, capturedId, targetId: newSlotTarget, canceled: cancellation.reason,
      order, expectedOrder, sentRevision: snapshot.revision, generation: dispatched.generation
    }
    h.reorderEvidence.push(evidence)
    return evidence
  })

  await h.repeat('PIK-35-captured-id-survives-nonmodal-appstate-reorder', async trial => {
    await h.select([])
    const content = `captured-reorder-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    const order = await h.taskOrder()
    assert.equal(order.length, 4)
    const targetId = order[2]
    const expectedOrder = [order[2], order[0], order[1], order[3]]
    assert.notEqual(expectedOrder[2], targetId)
    const snapshot = await h.snapshot()
    await h.rememberFocus()
    const mark = await h.eventMark()
    await h.keyboard.press(LEADER)
    await h.keyboard.press('Digit3')
    const selected = (await eventually('Native digit captures the stable Task ID', () => h.eventsSince(mark),
      events => events.some(event => event.kind === 'state' && event.active && event.targetId === targetId)))
      .find(event => event.kind === 'state' && event.targetId === targetId)
    assert.equal(selected.tabId, MAIN_TAB)
    assert(Number.isSafeInteger(selected.generation), 'The native capture acknowledges the current Tab generation')
    await h.leaderState(true)
    await h.page.waitForFunction(targetId => window.__onwardPromptInputShortcutsDebug?.getLeaderState()?.targetId === targetId, targetId)
    await h.selectedTarget(targetId, 3)
    const reordered = await h.page.evaluate(() => ({
      contextFromMs: Date.now(), accepted: window.__onwardAppDebug.reorderActiveTabTasksForAutotest(2, 0)
    }))
    assert.equal(reordered.accepted, true,
      'The hook must call real AppState.reorderTerminals, without fabricating a shortcut callback')
    await h.waitTaskOrder(expectedOrder)
    await h.focusPreserved()
    assert.equal(await h.page.evaluate(() => window.__onwardAppDebug.getActiveTabId()), selected.tabId)
    assert.equal(await h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid.is-rearranging').count(), 0)
    assert.equal(await h.page.evaluate(() => window.__onwardPromptInputShortcutsDebug.getLeaderState()?.active), true, 'A non-modal reorder retains the armed owner')
    assert.equal(await h.page.evaluate(() => window.__onwardPromptInputShortcutsDebug.getLeaderState()?.targetId), targetId,
      'The renderer retains the captured ID after normal context propagation')
    await h.selectedTarget(targetId, 1)
    const title = await h.task(targetId).locator('.terminal-grid-title').innerText()
    assert((await h.page.getByTestId('prompt-leader-indicator').getAttribute('aria-label')).includes(title),
      'The visible selected-recipient label follows the moved Task as well as its new slot number')
    const pendingEvents = await h.eventsSince(mark)
    assert(pendingEvents.every(event => event.tabId === selected.tabId && event.generation === selected.generation), 'Pending native state retains the original Tab and generation')
    assert.equal(pendingEvents.filter(event => event.kind !== 'state').length, 0, 'No cancellation or action may precede the continuation')
    assert.deepEqual(await h.snapshot(), snapshot)
    const contextThroughMs = await h.page.evaluate(() => Date.now())
    // Deliberately send only the continuation: another digit or Leader here
    // would recapture the new slot and stop testing stable identity.
    await h.keyboard.press('KeyQ')
    const dispatched = await h.sent(mark, [targetId], `${content}\t`, content, count)
    assert.equal(dispatched.targetId, targetId, 'Strict receiver bytes belong to the old captured ID now in slot 1, not the new slot-3 occupant')
    assert.equal(dispatched.generation, selected.generation)
    await h.focusPreserved()
    const evidence = {
      kind: 'state-update', trial, targetId, newSlotTarget: expectedOrder[2], order, expectedOrder,
      sentRevision: snapshot.revision, generation: dispatched.generation,
      contextFromMs: reordered.contextFromMs, contextThroughMs
    }
    h.reorderEvidence.push(evidence)
    return evidence
  })

  await h.repeat('PIK-10-hidden-latest-native-newline-never-selected-history', async trial => {
    await h.select([])
    const historyItem = h.notebook().locator('[data-prompt-id="pis-history-sentinel"]').first()
    await historyItem.click()
    const prefix = `hidden-current-${trial}`
    const content = `${prefix}-native-final\nlast native line`
    const count = (await h.history()).length
    await h.seed(prefix)
    await h.page.waitForFunction(prefix => window.__onwardPromptNotebookDebug.getEditorContent() === prefix, prefix)
    await h.holdDraftSync(true)
    await h.holdAck()
    try {
      await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
      await h.page.keyboard.type('-native-final')
      await h.page.keyboard.press('Enter')
      await h.page.keyboard.type('last native line')
      assert.equal(await h.editor().innerText(), content, 'Trusted final characters and Enter really changed the live DOM')
      assert.equal(await h.page.evaluate(() => window.__onwardPromptNotebookDebug.getEditorContent()), prefix)
      await h.page.evaluate(() => {
        window.__pisProbe.captureDraftDispatch = true
        window.__pisProbe.draftAtDispatch = null
      })
      await h.page.getByTitle('Prompt notebook', { exact: true }).click()
      await h.editor().waitFor({ state: 'hidden' })
      await h.focusTerminal(TASKS[0])
      await h.rememberFocus()
      const mark = await h.chord('KeyQ')
      await h.eventAfter(mark, 'dispatch')
      await h.ackWaiting()
      const atDispatch = await h.page.evaluate(() => window.__pisProbe.draftAtDispatch)
      assert.equal(atDispatch.syncHeld, true)
      assert.equal(atDispatch.parent, prefix, 'Parent is provably stale at the actual dispatch callback')
      assert.notEqual(atDispatch.parent, atDispatch.domText, 'Even the hidden DOM text differs from the still-stale parent')
      assert.equal(atDispatch.live.content, content, 'Dispatch sees the same newline-preserving text that trusted input created')
      h.expect([TASKS[0]], `\x1b[200~${prefix}-native-final\rlast native line\x1b[201~\t`)
      await h.checkBytes()
      assert.equal(await h.page.evaluate(() => window.__onwardPromptNotebookDebug.getEditorContent()), prefix,
        'Parent stays stale while the real child already holds all sent bytes')
      assert.equal((await h.history()).length, count)
      await h.focusPreserved()
      await h.holdDraftSync(false)
      await h.releaseAck()
      await h.ackSettled()
      await h.capturedHistory(atDispatch.live, count)
      await h.checkBytes()
      await h.focusPreserved()
      assert.equal(await h.editor().textContent(), '')
      assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 1)
      return { trial, nativeNewline: true, parentStaleAtDispatch: true, parentStaleAfterRealPtyDelivery: true, sentRevision: atDispatch.live.revision }
    } finally {
      await h.page.evaluate(() => { window.__pisProbe.captureDraftDispatch = false })
      await h.holdDraftSync(false)
      await h.releaseAck()
      await h.showPrompt()
    }
  })

  await h.repeat('PIK-11-empty-text-rejects-every-byte-and-history', async trial => {
    await h.select([])
    const count = (await h.history()).length
    for (const key of ['KeyQ', 'Enter', 'KeyA', 'KeyS']) {
      await h.seed('   ')
      await h.eventAfter(await h.chord(key), 'dispatch')
      await h.sender().locator('.prompt-sender-notice[role="alert"]').waitFor({ state: 'visible' })
      await h.checkBytes()
      assert.equal((await h.history()).length, count)
      assert.equal(await h.editor().innerText(), '   ')
    }
    return { trial, rejectedActions: 4 }
  })

  await h.setTargetModifier('Alt')
  const caretFixture = await json(path.join(h.workspace, 'caret-draft.json'))
  await h.repeat('PIK-12-key-only-retains-draft-and-raw-control-c', async trial => {
    const content = `unsent-key-only-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    await h.sent(await h.chord('KeyE'), [TASKS[0]], '\r')
    await h.sent(await h.chord('KeyC'), [TASKS[0]], '\x03')
    assert.equal(await h.editor().innerText(), content)
    assert.equal((await h.history()).length, count)
    assert.equal((await h.receivers.get(TASKS[0]).command('snapshot')).stopped, false, 'Ctrl+C is data and never terminates the oracle')
    const caret = await caretContinuity(h, caretFixture)
    return { trial, rawHex: '0d03', draftRetained: true, caret }
  })

  await h.repeat('PIK-13-native-ime-composition-never-dispatches', async trial => {
    await h.seed('')
    const history = await h.history()
    const compositions = await h.page.evaluate(() => window.__pisProbe.compositionStarts)
    const mark = await h.eventMark()
    await h.keyboard.press(LEADER)
    try {
      await h.keyboard.down('Alt')
      await h.choosingTargets(await h.taskOrder())
      await h.hostCdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
      const cancellation = await h.eventAfter(mark, 'cancel')
      assert(['blocked', 'ime'].includes(cancellation.reason), 'Composition cancels the pending selector before its timeout')
      await h.leaderState(false)
      assert.equal(await h.page.evaluate(() => window.__pisProbe.compositionStarts), compositions + 1, 'Native IME composition really started')
      await h.keyboard.up('Alt')
      await h.keyboard.press(LEADER)
      await h.keyboard.press('KeyQ')
    } finally {
      await h.keyboard.releaseAll()
      await h.hostCdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    }
    await h.hostCdp.send('Input.insertText', { text: '\u4f60' })
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
    assert.deepEqual(await h.history(), history)
    await h.leaderState(false)
    return { trial, compositionObserved: true, armedSelectorCanceled: true }
  })

  await h.setTargetModifier('Alt')
  await h.repeat('PIK-14-twenty-sequences-per-round-no-loss-or-duplication', async trial => {
    const content = `stress-draft-${trial}`
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    const count = (await h.history()).length
    const mark = await h.eventMark()
    const target = (await h.taskOrder())[2]
    for (let sequence = 0; sequence < SEQUENCES_PER_ROUND; sequence += 1) {
      const start = await h.chord('KeyE', { digit: 3 })
      await h.eventAfter(start, 'dispatch')
      await h.idle()
      h.expect([target], '\r')
    }
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, SEQUENCES_PER_ROUND)
    assert.equal(await h.editor().innerText(), content)
    assert.equal((await h.history()).length, count)
    await h.leaderState(false)
    return { trial, trustedSequences: SEQUENCES_PER_ROUND }
  })
  await h.setTargetModifier(null)
}

async function heldTargets(h) {
  const assertCanceledInput = async (mark, retained, history, selectedId) => {
    await h.leaderState(false)
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
    await h.keyboard.releaseAll()
    await h.keyboard.press('KeyQ')
    h.expect([TASKS[0]], 'q')
    await h.checkBytes()
    assert.deepEqual(await h.snapshot(), retained)
    assert.deepEqual(await h.history(), history)
    assert.deepEqual(await h.selectedIds(), [selectedId])
    await h.focusPreserved()
  }
  for (const modifier of ['Alt', 'Control', 'Shift']) {
    await h.setTargetModifier(modifier)
    await h.repeat(`PIK-36-${modifier}-target-cue-and-one-shot`, async trial => {
      const order = await h.taskOrder()
      await h.select([order[1]])
      const content = `held-${modifier}-${trial}`
      await h.seed(content)
      const count = (await h.history()).length
      if (trial % 2) {
        await h.page.getByTitle('Prompt notebook', { exact: true }).click()
        await h.editor().waitFor({ state: 'hidden' })
      }
      await h.focusTerminal(TASKS[0])
      await h.rememberFocus()
      const mark = await h.eventMark()
      try {
        await h.keyboard.press(LEADER)
        await h.leaderState(true)
        await h.keyboard.down(modifier)
        await h.choosingTargets(order)
        await h.keyboard.press('Digit2')
        await h.keyboard.press('Digit3')
        await h.selectedTarget(order[2], 3)
        await h.keyboard.up(modifier)
        if (trial === 0) await h.screenshot(`leader-${modifier}-selected`)
        await h.checkBytes()
        await h.keyboard.press('KeyQ')
        await h.sent(mark, [order[2]], `${content}\t`, content, count)
        await h.leaderState(false)
        await h.focusPreserved()
        await h.sent(await h.chord('KeyE'), [order[1]], '\r')
        await h.keyboard.press(LEADER)
        await h.keyboard.down(modifier)
        await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-leader-indicator"]')?.dataset.selecting === 'true')
        await h.keyboard.up(modifier)
        await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-leader-indicator"]')?.dataset.selecting === 'false')
        assert.equal(await h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) [data-testid="prompt-task-target-badge"]').count(), 0)
        await h.keyboard.press('Escape')
        await h.leaderState(false)
        if (modifier === 'Alt') {
          const modifiedContent = `held-action-${trial}`
          await h.seed(modifiedContent)
          await h.focusTerminal(TASKS[0])
          await h.rememberFocus()
          const modifiedCount = (await h.history()).length
          const modifiedMark = await h.eventMark()
          await h.keyboard.press(LEADER)
          await h.keyboard.down('Alt')
          await h.keyboard.press('Digit3')
          await h.selectedTarget(order[2], 3)
          // Keep Alt physically held through the action, not just its digit.
          await h.keyboard.press('KeyQ')
          const dispatched = await h.sent(modifiedMark, [order[2]], `${modifiedContent}\t`, modifiedContent, modifiedCount)
          assert.equal(dispatched.actionId, 'heldAltQueue')
          await h.leaderState(false)
          await h.focusPreserved()
          await h.keyboard.up('Alt')
          await h.focusPreserved()
        }

        await h.seed(`held-mismatch-${modifier}-${trial}`)
        await h.focusTerminal(TASKS[0])
        await h.rememberFocus()
        const retained = await h.snapshot()
        const history = await h.history()
        const mismatch = await h.eventMark()
        await h.keyboard.press(LEADER)
        await h.keyboard.down(modifier)
        await h.keyboard.press('Digit3')
        if (modifier === 'Alt') await h.keyboard.down('Shift')
        await h.keyboard.press('KeyQ')
        await h.eventAfter(mismatch, 'cancel', 'unmatched')
        await assertCanceledInput(mismatch, retained, history, order[1])

        const escape = await h.eventMark()
        await h.keyboard.press(LEADER)
        await h.keyboard.down(modifier)
        await h.choosingTargets(order)
        await h.keyboard.press('Escape')
        const canceled = await h.eventAfter(escape, 'cancel')
        assert(['escape', 'unmatched'].includes(canceled.reason), 'Escape cancels even while the selector modifier remains physically held')
        await assertCanceledInput(escape, retained, history, order[1])
      } finally { await h.keyboard.releaseAll(); await h.showPrompt() }
      return { trial, modifier, target: order[2], followingManualTarget: order[1] }
    })
  }
  await h.select([])
  await h.setTargetModifier(null)
}

async function eightTargetPressure(h) {
  await h.parkLayout(8)
  const ids = [...TASKS, ...h.extraTargets]
  await h.waitTasks(ids)
  for (const id of h.extraTargets) await h.startReceiver(id)
  await h.setTargetModifier('Alt')
  await h.select([])
  try {
    await Promise.all(ids.map(id => h.receivers.get(id).command('pressure', { enabled: true })))
    await h.repeat('PIK-37-eight-task-targeting-under-real-pty-output', async trial => {
      const prefix = `eight-task-pressure-${trial}`
      const suffix = '-native-typed'
      const content = prefix + suffix
      const digit = trial % 2 ? 8 : 7
      const target = (await h.taskOrder())[digit - 1]
      await h.seed(prefix)
      await h.rememberFocus()
      const count = (await h.history()).length
      const before = await Promise.all(ids.map(async id => ({ id, ...(await h.receivers.get(id).command('snapshot')) })))
      assert(before.every(value => Number.isInteger(value.outputTick)), 'Every receiver exposes its actual output counter')
      await h.page.keyboard.type(suffix)
      assert.equal(await h.editor().innerText(), content, 'Ordinary trusted typing must land intact under all eight PTY streams')
      const mark = await h.eventMark()
      await h.keyboard.press(LEADER)
      await h.keyboard.down('Alt')
      await h.choosingTargets(await h.taskOrder())
      await h.keyboard.press(`Digit${digit}`)
      await h.selectedTarget(target, digit)
      await h.keyboard.up('Alt')
      await h.keyboard.press('KeyQ')
      const after = await Promise.all(ids.map(async id => ({ id, ...(await h.receivers.get(id).command('snapshot')) })))
      const output = after.map((value, index) => ({ id: value.id, before: before[index].outputTick, after: value.outputTick }))
      assert(output.every(value => value.after > value.before), `All eight Tasks must advance during each interaction: ${JSON.stringify(output)}`)
      await h.sent(mark, [target], `${content}\t`, content, count)
      const rendered = await eventually('Fresh per-trial PTY tick markers reach every addressed terminal buffer',
        () => h.page.evaluate(ids => ids.map(id => {
          // Buffer snapshots expose physical rows, including soft wraps and trimmed row-end spaces.
          const text = (window.__onwardTerminalDebug.getTailText(id, 80) ?? '').replace(/\s/g, '')
          const pattern = new RegExp(`pressure${id}(\\d+)line\\d+`, 'g')
          return { id, ticks: [...text.matchAll(pattern)].map(match => Number(match[1])) }
        }), ids),
        values => values.every((value, index) => value.ticks.some(tick => tick >= before[index].outputTick)))
      await h.focusPreserved()
      await h.leaderState(false)
      assert.deepEqual(await h.selectedIds(), [])
      return { trial, digit, target, typedSuffix: suffix, output,
        rendered: rendered.map(value => ({ id: value.id, newestTick: Math.max(...value.ticks) })) }
    })
  } finally {
    await h.keyboard.releaseAll()
    await Promise.all(ids.map(id => h.receivers.get(id).command('pressure', { enabled: false })))
  }
  await h.parkLayout(4)
  await h.setTargetModifier(null)
}

// Electron sendInputEvent targets the top-level widget, not a focused OOPIF.
// Chromium CDP resolves the focused widget; native codes keep its browser-side
// before-input-event route enabled. Limit this adapter to the HTML guest probe.
// https://github.com/electron/electron/blob/v43.2.0/shell/browser/api/electron_api_web_contents.cc#L3784-L3813
// https://github.com/chromium/chromium/blob/150.0.7871.129/content/browser/devtools/protocol/input_handler.cc#L1255-L1273
class HtmlFrameKeyboard extends NativeShortcutKeyboard {
  constructor(harness) {
    super(harness.page)
    this.harness = harness
  }

  async send(input) {
    const keys = {
      Control: { code: 'ControlLeft', key: 'Control', windowsVirtualKeyCode: 17 },
      3: { code: 'Digit3', key: '3', windowsVirtualKeyCode: 51 },
      Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
      x: { code: 'KeyX', key: 'x', windowsVirtualKeyCode: 88 },
      q: { code: 'KeyQ', key: 'q', windowsVirtualKeyCode: 81 },
      z: { code: 'KeyZ', key: 'z', windowsVirtualKeyCode: 90 }
    }
    const nativeCodes = {
      darwin: { Control: 59, Escape: 53, x: 7, q: 12, z: 6, 3: 20 },
      win32: { Control: 17, Escape: 27, x: 88, q: 81, z: 90, 3: 51 },
      linux: { Control: 37, Escape: 9, x: 53, q: 24, z: 52, 3: 12 }
    }
    const key = keys[input.keyCode]
    const nativeVirtualKeyCode = nativeCodes[process.platform]?.[input.keyCode]
    assert(key && nativeVirtualKeyCode, `Unsupported HTML native probe key/platform: ${input.keyCode}/${process.platform}`)
    assert(['keyDown', 'char', 'keyUp'].includes(input.type))
    assert(input.modifiers.every(modifier => ['control', 'isautorepeat'].includes(modifier)))
    const ownership = await Promise.all([
      this.page.evaluate(() => document.hasFocus() && document.activeElement === document.querySelector('.project-editor-html-preview-frame')),
      guestRead(this.harness, 'html', `document.hasFocus() && document.activeElement?.id === 'guest-input'`)
    ])
    assert.deepEqual(ownership, [true, true], 'Native CDP may only address the already-focused owned HTML input')
    await this.harness.hostCdp.send('Input.dispatchKeyEvent', {
      ...key, nativeVirtualKeyCode,
      type: input.type === 'keyDown' ? 'rawKeyDown' : input.type,
      modifiers: input.modifiers.includes('control') ? 2 : 0,
      autoRepeat: input.modifiers.includes('isautorepeat'),
      location: input.keyCode === 'Control' ? 1 : 0,
      ...(input.type === 'char' ? { text: input.keyCode, unmodifiedText: input.keyCode } : {})
    })
  }

  close() { return this.releaseAll() }
}

async function guestRead(h, surface, script) {
  if (surface === 'html') {
    const value = await h.page.evaluate(script => window.__onwardProjectEditorDebug.evaluateHtmlPreviewForTest(script), script)
    assert.equal(value?.success, true, `HTML iframe readout: ${value?.error}`)
    return value.value
  }
  if (h.browserGuest) return h.browserGuest.read(script)
  return h.task(TASKS[0]).locator('webview.browser-panel-webview')
    .evaluate((view, script) => view.executeJavaScript(script), script)
}

async function guestFocus(h, surface) {
  await h.page.bringToFront()
  if (surface === 'html') {
    await h.page.frameLocator('.project-editor-html-preview-frame').locator('#guest-input').click()
  } else {
    const view = h.task(TASKS[0]).locator('webview.browser-panel-webview')
    const bounds = await view.boundingBox()
    const inner = await guestRead(h, surface, `(() => { const r = document.querySelector('#guest-input').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, viewportWidth: innerWidth }; })()`)
    assert(bounds && inner && h.browserGuest)
    // Host viewport emulation and the native webview can use different CSS
    // scales. Address the owned guest widget in its own coordinate system.
    await view.focus()
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await h.browserGuest.send('Input.dispatchMouseEvent', {
        type, x: inner.x, y: inner.y,
        ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 })
      })
    }
    await h.log('GUEST_POINTER_COORDINATES', { hostWidth: bounds.width, guestWidth: inner.viewportWidth, x: inner.x, y: inner.y })
  }
  // The host click and the guest read use independent renderer channels. Wait
  // for the one click's focus acknowledgement; never retry the input gesture.
  await eventually('Real mouse click focuses the guest input',
    () => guestRead(h, surface, `document.hasFocus() && document.activeElement?.id === 'guest-input'`), value => value === true)
  const native = await h.guestNativeFocus()
  await h.log('GUEST_NATIVE_FOCUS', { surface, phase: 'prepared', ...native })
  assert.equal(native?.windowFocused, true, 'The guest trial starts in the real native key window')
}

async function exerciseGuestQueue(h, surface, trial, keyboard) {
  const content = `${surface}-guest-${trial}`
  const count = (await h.history()).length
  await h.seed(content)
  await guestFocus(h, surface)
  const initial = await guestRead(h, surface, `({ value: document.querySelector('#guest-input').value, count: window.pisGuest.events.length })`)
  await keyboard.press('KeyZ')
  const before = await eventually('One native printable character reaches the guest',
    () => guestRead(h, surface, `({ value: document.querySelector('#guest-input').value, count: window.pisGuest.events.length, events: window.pisGuest.events.slice(${initial.count}) })`),
    value => value.value === `${initial.value}z` && value.events.some(event => event.type === 'keyup' && event.code === 'KeyZ'))
  assert.equal(before.value, `${initial.value}z`, 'A non-leader physical key inserts exactly one character')
  assert.deepEqual(before.events.map(event => ({ type: event.type, code: event.code, trusted: event.trusted })), [
    { type: 'keydown', code: 'KeyZ', trusted: true },
    { type: 'keyup', code: 'KeyZ', trusted: true }
  ], 'Ordinary input proves trusted native down/up reached the real guest')
  await h.rememberFocus()
  const mapping = await h.page.locator('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-terminal-id]')
    .evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.terminalId, title: node.querySelector('.terminal-grid-title').textContent })))
  assert.deepEqual(mapping.map(value => value.id), TASKS)
  const targetMark = await h.eventMark()
  await keyboard.press(LEADER)
  await keyboard.down('Control')
  if (surface === 'html') {
    const map = h.page.getByTestId('prompt-target-map')
    await map.waitFor({ state: 'visible' })
    const presented = await map.evaluate(node => ({
      items: [...node.children].map(item => ({ number: item.querySelector('b').textContent,
        title: item.querySelector('span').textContent })),
      pointerTransparent: getComputedStyle(node).pointerEvents === 'none' && [...node.children].every(item => {
        const rect = item.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight &&
          hit !== null && !node.contains(hit)
      })
    }))
    assert.deepEqual(presented.items, mapping.map((value, index) => ({ number: String(index + 1), title: value.title })),
      'Covered-grid numbers and names identify the same ordered recipients as the actual Task headers')
    assert.equal(presented.pointerTransparent, true, 'Recipient labels fit the viewport without intercepting the covered reader')
    await h.focusPreserved()
    assert.equal(await guestRead(h, surface, 'document.activeElement?.id'), 'guest-input')
  }
  await keyboard.press('Digit3')
  await h.page.getByTestId('prompt-target-map').waitFor({ state: 'detached' })
  await keyboard.up('Control')
  await keyboard.press('KeyQ')
  await h.sent(targetMark, [TASKS[2]], `${content}\t`, content, count)
  await h.leaderState(false)
  await h.focusPreserved()
  const native = await h.guestNativeFocus()
  await h.log('GUEST_NATIVE_FOCUS', { surface, trial, phase: 'after-send', ...native })
  assert.equal(native?.windowFocused, true, 'Sending retains the native window owner as well as the guest DOM focus')
  const after = await guestRead(h, surface, `({ value: document.querySelector('#guest-input').value, focused: document.hasFocus() && document.activeElement?.id === 'guest-input', events: window.pisGuest.events.slice(${before.count}) })`)
  assert.equal(after.value, before.value)
  assert.equal(after.focused, true)
  assert.equal(after.events.filter(event => !['ControlLeft', 'ControlRight'].includes(event.code)).length, 0)
  return { before, content }
}

async function guests(h) {
  await h.setTargetModifier('Control')
  // Playwright normally emulates page focus even when the native app is not
  // key. These ownership assertions must observe real focus instead.
  await h.hostCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await h.select([TASKS[0]])
  await h.focusTerminal(TASKS[0])
  await h.task(TASKS[0]).locator('[data-terminal-dropdown-trigger]').click()
  await h.page.locator('[data-terminal-dropdown-action="editor"]').click()
  await h.page.waitForFunction(() => window.__onwardProjectEditorDebug?.isOpen())
  await h.page.evaluate(() => window.__onwardProjectEditorDebug.openFileByPathAsUser('guest-input.html'))
  await h.page.waitForFunction(() => window.__onwardProjectEditorDebug?.getHtmlReaderState()?.ready === true)

  for (const surface of ['html', 'browser']) {
    let keyboard = h.keyboard
    if (surface === 'html') {
      keyboard = new HtmlFrameKeyboard(h)
      h.guestSessions.push(keyboard)
    } else {
      // The legacy global grid hook may belong to the hidden Tab. Close the
      // visible fixture through the real editor action before opening Browser.
      await h.page.getByRole('button', { name: 'Return to Terminal (ESC)', exact: true }).click()
      await h.task(TASKS[0]).locator('[data-terminal-dropdown-trigger]').click()
      await h.page.getByRole('menuitem', { name: 'Open Browser', exact: true }).click()
      await h.task(TASKS[0]).getByText('Enter a URL or local file path to start browsing', { exact: true }).waitFor({ state: 'visible' })
      const input = h.task(TASKS[0]).locator('.browser-panel-url-input')
      await input.fill(path.join(h.workspace, 'guest-input.html'))
      await input.press('Enter')
      await eventually('OpenBrowser fixture loaded', () => guestRead(h, surface, `Boolean(window.pisGuest && document.querySelector('#guest-input'))`), Boolean, 15000)
      keyboard = await GuestKeyboard.attach(h)
      h.browserGuest = keyboard
      h.guestSessions.push(keyboard)
    }
    const id = surface === 'html' ? 'PIK-15-html-iframe-focus-and-consumed-keys' : 'PIK-16-openbrowser-guest-focus-and-consumed-keys'
    await h.repeat(id, async trial => {
      const { before, content } = await exerciseGuestQueue(h, surface, trial, keyboard)

      const beforePass = await guestRead(h, surface, 'window.pisGuest.events.length')
      const pass = await h.eventMark()
      await keyboard.press(LEADER)
      await keyboard.press(LEADER)
      await h.eventAfter(pass, 'passthrough')
      const passed = await guestRead(h, surface, `window.pisGuest.events.slice(${beforePass})`)
      assert.equal(passed.filter(event => event.type === 'keydown' && event.code === 'KeyX' && event.control && event.trusted).length, 1,
        'Only the second physical leader reaches the guest natively')
      for (const [key, reason] of [['Escape', 'escape'], ['KeyZ', 'unmatched']]) {
        const previous = await guestRead(h, surface, 'window.pisGuest.events.length')
        const valueBefore = await guestRead(h, surface, `document.querySelector('#guest-input').value`)
        await h.eventAfter(await h.chord(key, { keyboard }), 'cancel', reason)
        const events = await guestRead(h, surface, `window.pisGuest.events.slice(${previous})`)
        assert.equal(events.filter(event => !['ControlLeft', 'ControlRight'].includes(event.code)).length, 0, `${reason} keys never leak into the guest`)
        assert.equal(await guestRead(h, surface, `document.querySelector('#guest-input').value`), valueBefore, `${reason} consumes the char event as well as keydown/up`)
      }
      await h.checkBytes()
      return {
        trial, guest: surface, rawBytes: Buffer.byteLength(`${content}\t`), focusPreserved: true,
        nativeIngress: surface === 'html' ? 'cdp-focused-widget-native-codes' : 'electron-focused-webcontents',
        platform: process.platform, ordinaryNativeEvents: before.events
      }
    })
    await h.screenshot(`${surface}-guest`)
  }
}

async function additionalBoundaries(h) {
  await h.page.evaluate(() => window.__onwardBrowserPanelDebug?.closeKeepAlive())
  await h.select([])
  await h.repeat('PIK-18-physical-letter-and-digit-code-under-nonlatin-key', async trial => {
    const content = `physical-code-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    const order = await h.sender().locator('.prompt-sender-terminal').evaluateAll(nodes => nodes.map(node => node.dataset.terminalId))
    const mark = await h.eventMark()
    await h.keyboard.press(LEADER)
    const keys = [physicalShortcutKey('Digit3', '\u2116'), physicalShortcutKey('KeyQ', '\u0439')]
    for (const key of keys) {
      try {
        await h.hostCdp.send('Input.dispatchKeyEvent', { ...key, type: 'rawKeyDown' })
        await h.hostCdp.send('Input.dispatchKeyEvent', { ...key, type: 'char', text: key.key, unmodifiedText: key.key })
      } finally {
        await h.hostCdp.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' })
      }
    }
    const event = await h.sent(mark, [order[2]], `${content}\t`, content, count)
    assert.equal(event.targetId, order[2])
    return { trial, keys, platform: process.platform, target: order[2] }
  })

  await h.repeat('PIK-19-no-bracketed-paste-rejects-before-any-byte', async trial => {
    const receiver = h.receivers.get(TASKS[0])
    await receiver.bracketedPaste(false)
    try {
      const content = `unsafe-${trial}\nsecond line`
      const count = (await h.history()).length
      await h.seed(`unsafe-${trial}`)
      await h.page.keyboard.press('Enter')
      await h.page.keyboard.type('second line')
      await h.focusTerminal(TASKS[0])
      await h.eventAfter(await h.chord('KeyQ'), 'dispatch')
      await h.sender().locator('.prompt-sender-notice[role="alert"]').waitFor({ state: 'visible' })
      await h.checkBytes()
      assert.equal((await h.history()).length, count)
      assert.equal(await h.editor().innerText(), content)
      return { trial, retained: true, bytes: 0 }
    } finally { await receiver.bracketedPaste(true) }
  })

  await h.setTargetModifier('Alt')
  await h.repeat('PIK-20-tab-change-cancels-pending-chord', async trial => {
    await h.select([TASKS[1]])
    await h.seed(`tab-cancel-${trial}`)
    const draft = await h.snapshot()
    const history = await h.history()
    const mark = await h.eventMark()
    try {
      await h.keyboard.press(LEADER)
      await h.eventAfter(mark, 'state')
      await h.keyboard.down('Alt')
      const order = await h.taskOrder()
      await h.choosingTargets(order)
      await h.keyboard.press('Digit3')
      await h.selectedTarget(order[2], 3)
      await h.switchTab(OTHER_TAB)
      await h.eventAfter(mark, 'cancel', 'tab-changed')
      await h.leaderState(false)
    } finally { await h.keyboard.releaseAll() }
    await h.focusTerminal(OTHER_TASK)
    await h.keyboard.press('Digit3')
    await h.keyboard.press('KeyQ')
    h.expect([OTHER_TASK], '3q')
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
    await h.switchTab(MAIN_TAB)
    await h.showPrompt()
    assert.equal(await h.editor().innerText(), `tab-cancel-${trial}`)
    assert.deepEqual(await h.snapshot(), draft)
    assert.deepEqual(await h.history(), history)
    assert.deepEqual(await h.selectedIds(), [TASKS[1]], 'Tab cancellation preserves the origin\'s manual recipient selection')
    await h.leaderState(false)
    return { trial, originDraftRetained: true, selectedCueCleared: true }
  })
  await h.setTargetModifier(null)

  await h.repeat('PIK-21-control-content-rejected-before-any-byte', async trial => {
    await h.showPrompt()
    await h.select([])
    const count = (await h.history()).length
    for (const control of ['\x03', '\x1b', '\x7f']) {
      const content = `control-${trial}-${control}-suffix`
      // Browsers can filter pasted controls before insertion. Seed this invalid
      // payload through the existing draft setter; invocation is still physical.
      await h.page.evaluate(content => window.__onwardPromptEditorContentControl.setContent(content), content)
      assert.equal(await h.editor().textContent(), content)
      await h.focusTerminal(TASKS[0])
      await h.eventAfter(await h.chord('KeyQ'), 'dispatch')
      await h.sender().locator('.prompt-sender-notice[role="alert"]').waitFor({ state: 'visible' })
      await h.checkBytes()
      assert.equal((await h.history()).length, count)
      assert.equal(await h.editor().textContent(), content)
    }
    return { trial, rejectedControlHex: ['03', '1b', '7f'] }
  })

  await h.repeat('PIK-22-settings-recorder-cancels-and-suspends-leader', async trial => {
    await h.select([TASKS[0]])
    await h.seed(`recording-${trial}`)
    await h.openSettings('shortcuts')
    const section = h.page.getByTestId('prompt-input-settings')
    const recorder = section.getByTestId('prompt-input-leader')
    await recorder.waitFor({ state: 'visible' })
    await section.focus()
    const mark = await h.eventMark()
    await h.keyboard.press(LEADER)
    await h.eventAfter(mark, 'state')
    await recorder.click()
    const canceled = await h.eventAfter(mark, 'cancel')
    assert(['recording', 'blocked', 'context-changed'].includes(canceled.reason), 'Recorder entry cancels the pending leader before accepting input')
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-leader"]')?.getAttribute('data-recording') === 'ready')
    await h.keyboard.press(LEADER)
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-leader"]')?.getAttribute('data-recording') === 'idle')
    await h.keyboard.press('KeyQ')
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)

    await h.page.getByTestId('prompt-input-action-select').selectOption('queue')
    const actionRecorder = h.page.getByTestId('prompt-input-action-queue-shortcut')
    await actionRecorder.click()
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-action-queue-shortcut"]')?.getAttribute('data-recording') === 'ready')
    const saveStroke = process.platform === 'darwin' ? 'Meta+KeyS' : 'Control+KeyS'
    await h.keyboard.press(saveStroke)
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-action-queue-shortcut"]')?.getAttribute('data-recording') === 'idle')

    const source = await readFile(path.join(h.workspace, 'sample.ts'), 'utf8')
    await h.task(TASKS[0]).locator('[data-terminal-dropdown-trigger]').click()
    await h.page.locator('[data-terminal-dropdown-action="editor"]').click()
    await h.page.waitForFunction(() => window.__onwardProjectEditorDebug?.isOpen())
    await h.page.evaluate(() => window.__onwardProjectEditorDebug.openFileByPathAsUser('sample.ts'))
    await h.page.waitForFunction(() => window.__onwardProjectEditorDebug.getEditorLineCount() > 0)
    const edited = `${source}\n// Unsaved preview isolation probe ${trial}\n`
    assert.equal(await h.page.evaluate(content => window.__onwardProjectEditorDebug.setEditorContent(content), edited), true)
    await h.page.waitForFunction(content => window.__onwardProjectEditorDebug.getEditorContent() === content, edited)
    await h.openSettings('shortcuts')
    const zone = h.page.getByTestId('prompt-input-preview-test')
    const focusPreview = async () => {
      await zone.focus()
      await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-preview-test"]')?.getAttribute('data-phase') === 'ready')
    }
    const resumed = async () => {
      await section.focus()
      const dispatch = await h.eventAfter(await h.chord('KeyE'), 'dispatch')
      assert.equal(dispatch.actionId, 'execute')
      h.expect([TASKS[0]], '\r')
      await h.checkBytes()
    }
    const previewMark = await h.eventMark()
    await focusPreview()
    await h.keyboard.press(LEADER)
    await h.keyboard.press(saveStroke)
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-preview-test"]')?.getAttribute('data-action-id') === 'queue')
    await h.keyboard.press(LEADER)
    await h.keyboard.press('Escape')
    assert.equal(await zone.getAttribute('data-result'), 'cancel')
    assert.equal(await h.page.evaluate(() => window.__onwardProjectEditorDebug.isOpen()), true)
    assert.equal(await h.page.evaluate(() => window.__onwardProjectEditorDebug.getDialogState()), null, 'Preview Escape cannot request closing the dirty editor')
    assert.equal(await h.page.evaluate(() => window.__onwardProjectEditorDebug.getEditorContent()), edited)
    assert.equal(await readFile(path.join(h.workspace, 'sample.ts'), 'utf8'), source, 'Preview cannot save the dirty file')
    await h.keyboard.press(LEADER)
    await h.keyboard.press('KeyQ')
    await h.checkBytes()
    assert.equal((await h.eventsSince(previewMark)).filter(event => event.kind === 'dispatch').length, 0, 'Native preview keys never route to Task stdin')
    await resumed()

    await focusPreview()
    await recorder.click()
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-leader"]')?.getAttribute('data-recording') === 'ready')
    await h.keyboard.press(LEADER)
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-leader"]')?.getAttribute('data-recording') === 'idle')
    await focusPreview()
    await resumed()

    await focusPreview()
    await h.page.getByTestId('prompt-input-expand').click()
    assert.equal(await zone.count(), 0)
    await resumed()
    await h.page.getByTestId('prompt-input-expand').click()
    await focusPreview()
    await h.openSettings('general')
    await h.page.locator('.settings-close-btn').focus()
    const restored = await h.eventAfter(await h.chord('KeyE'), 'dispatch')
    assert.equal(restored.actionId, 'execute')
    h.expect([TASKS[0]], '\r')
    await h.checkBytes()
    await h.page.getByRole('button', { name: 'Return to Terminal (ESC)', exact: true }).click()
    await h.page.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await h.page.waitForFunction(() => !window.__onwardProjectEditorDebug.isOpen())
    await h.page.getByTestId('sidebar-settings-button').click()
    await h.showPrompt()
    assert.equal(await h.editor().innerText(), `recording-${trial}`)
    return { trial, recordedLeaderWasNotDispatched: true, nativePreviewIsolated: true,
      dirtyFilePreserved: true, sameProcessResumePaths: ['blur', 'recorder-handoff', 'collapse', 'unmount'] }
  })

  await h.repeat('PIK-23-settings-save-cancels-pending-sequence', async trial => {
    await h.openSettings('shortcuts')
    const section = h.page.getByTestId('prompt-input-settings')
    const timeout = section.getByTestId('prompt-input-timeout')
    const save = section.getByTestId('prompt-input-save')
    await timeout.fill(String(1600 + trial * 100))
    // Keep pointer ownership on the button. Disabling it during the save may
    // still blur it; either documented cancellation wins, but none may revive.
    await save.focus()
    const mark = await h.eventMark()
    await h.keyboard.press(LEADER)
    await h.eventAfter(mark, 'state')
    await save.click()
    const canceled = await h.eventAfter(mark, 'cancel')
    assert(['settings-changed', 'context-changed'].includes(canceled.reason))
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-status"]')?.getAttribute('data-state') === 'saved')
    await h.keyboard.press('KeyQ')
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0)
    assert.equal((await h.page.evaluate(() => window.electronAPI.settings.load())).promptInput.timeoutMs, 1600 + trial * 100)
    await timeout.fill('1500')
    await save.click()
    await h.page.waitForFunction(() => document.querySelector('[data-testid="prompt-input-status"]')?.getAttribute('data-state') === 'saved')
    await h.page.getByTestId('sidebar-settings-button').click()
    await h.showPrompt()
    return { trial, reason: canceled.reason, timeoutRestored: 1500 }
  })
}

async function delayedAcknowledgements(h) {
  await h.select([])
  const scenarios = [
    ['PIK-24-delayed-ack-preserves-newer-content', 'content'],
    ['PIK-25-delayed-ack-preserves-edit-undo-aba', 'aba'],
    ['PIK-26-delayed-ack-preserves-title-edit', 'title'],
    ['PIK-27-delayed-ack-stays-with-originating-tab', 'tab'],
    ['PIK-28-busy-second-keyboard-action-visible-no-second-bytes', 'busy']
  ]
  for (const [id, scenario] of scenarios) {
    await h.repeat(id, async trial => {
      const content = `ack-${scenario}-${trial}`
      await h.switchTab(MAIN_TAB)
      await h.seed(content)
      await h.title().fill(`captured-${scenario}-${trial}`)
      await h.focusTerminal(TASKS[0])
      const count = (await h.history()).length
      const captured = await h.snapshot()
      assert.equal(captured.content, content)
      await h.holdAck()
      let otherDraft
      let otherHistory
      let retained
      let dispatches
      try {
        const first = await h.chord('KeyQ')
        const event = await h.eventAfter(first, 'dispatch')
        assert.equal(event.tabId, MAIN_TAB)
        assert.equal(event.actionId, 'queue')
        await h.ackWaiting()
        h.expect([TASKS[0]], `${content}\t`)
        await h.checkBytes()
        assert.equal((await h.history()).length, count, 'The barrier holds after real child bytes and before history/clear')
        assert.deepEqual(await h.snapshot(true), captured, 'Holding completion does not mutate the captured draft')

        if (scenario === 'busy') {
          const second = await h.chord('KeyQ')
          await h.eventAfter(second, 'dispatch')
          const notice = h.sender().locator('.prompt-sender-notice[role="alert"]')
          await notice.waitFor({ state: 'visible' })
          assert.equal(await notice.innerText(), 'An input action is still sending. Please wait.')
          await h.ackWaiting()
          await h.checkBytes()
          assert.equal((await h.history()).length, count, 'A rejected second invocation cannot record history')
          assert.deepEqual(await h.snapshot(true), captured)
          if (trial === 0) await h.screenshot('busy-second-keyboard-action')
        } else if (scenario === 'title') {
          await h.title().fill(`newer-title-${trial}`)
          retained = await h.snapshot(true)
          assert.equal(retained.title, `newer-title-${trial}`)
          assert.equal(retained.content, captured.content)
        } else {
          await h.editor().click()
          await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
          await h.page.keyboard.type('-newer-edit')
          const edited = await h.snapshot(true)
          assert.equal(edited.content, `${content}-newer-edit`)
          assert(edited.revision > captured.revision, 'A real newer edit has a newer revision')
          if (scenario === 'aba') {
            await h.page.keyboard.press('ControlOrMeta+KeyZ')
            retained = await h.snapshot(true)
            assert.equal(retained.content, captured.content, 'Native undo returns content to A')
            assert(retained.revision > edited.revision, 'A to B to A must not reuse the first revision')
          } else {
            retained = edited
          }
        }

        if (scenario === 'tab') {
          await h.switchTab(OTHER_TAB)
          await h.showPrompt(OTHER_TAB)
          otherDraft = await h.snapshot()
          otherHistory = await h.history(OTHER_TAB)
          await h.editor(OTHER_TAB).fill(`different-tab-newer-${trial}`)
          await h.title(OTHER_TAB).fill(`different-tab-title-${trial}`)
          const otherBeforeAck = await h.snapshot()
          await h.ackWaiting()
          await h.releaseAck()
          await h.ackSettled()
          assert.equal(await h.page.evaluate(() => window.__onwardAppDebug.getActiveTabId()), OTHER_TAB)
          assert.deepEqual(await h.snapshot(), otherBeforeAck, 'Origin completion never mutates the current different Tab')
          assert.deepEqual(await h.history(OTHER_TAB), otherHistory, 'Origin history never migrates to the new active Tab')
          assert.deepEqual(await h.snapshot(true), retained, 'The hidden originating newer draft survives')
        } else {
          await h.releaseAck()
          await h.ackSettled()
        }

        const historyId = await h.capturedHistory(captured, count)
        await h.checkBytes()
        if (scenario === 'busy') {
          assert.equal(await h.editor().innerText(), '', 'Only the accepted first invocation clears its unchanged revision')
          assert.equal(await h.title().inputValue(), '')
        } else {
          assert(retained.revision > captured.revision)
          assert.equal(retained.sourceId, captured.sourceId, 'Newer edits retain their source identity')
          assert.equal(retained.color, captured.color)
          assert.deepEqual(await h.snapshot(true), retained, 'Completion preserves the entire newer editor snapshot')
          await eventually('Newer originating draft persists to its own Tab', () => h.page.evaluate(() => window.electronAPI.appState.load()), state => {
            const draft = state.tabs.find(tab => tab.id === MAIN_TAB)?.editorDraft
            return draft?.content === retained.content && draft?.title === retained.title
          })
        }
        dispatches = (await h.eventsSince(first)).filter(value => value.kind === 'dispatch').length
        assert.equal(dispatches, scenario === 'busy' ? 2 : 1, 'The second busy invocation is genuine native keyboard dispatch')
        h.ackEvidence.push({ id, trial, historyId, sentRevision: captured.revision, retainedRevision: retained?.revision, dispatches })
      } finally {
        await h.releaseAck()
        if (otherDraft) {
          await h.switchTab(OTHER_TAB)
          await h.showPrompt(OTHER_TAB)
          await h.editor(OTHER_TAB).fill(otherDraft.content)
          await h.title(OTHER_TAB).fill(otherDraft.title)
        }
        await h.switchTab(MAIN_TAB)
        await h.showPrompt()
      }
      assert.equal((await h.history()).length, count + 1, 'Later UI activity cannot duplicate captured history')
      return { trial, scenario, dispatches, sentRevision: captured.revision, retainedRevision: retained?.revision, rawBytes: Buffer.byteLength(`${content}\t`) }
    })
  }
}

async function staleDestinations(h) {
  await h.setTargetModifier('Alt')
  for (const [id, manual] of [
    ['PIK-29-stale-explicit-target-rejects-and-reselect-recovers', false],
    ['PIK-33-stale-manual-target-rejects-and-reselect-recovers', true]
  ]) {
    await h.repeat(id, async trial => {
      await h.parkLayout(4)
      await h.select([])
      const order = await h.sender().locator('.prompt-sender-terminal').evaluateAll(nodes => nodes.map(node => node.dataset.terminalId))
      assert.equal(order.length, 4)
      const lostId = order[3]
      const activeId = order[0]
      const recoveryId = order[1]
      assert.notEqual(recoveryId, activeId, 'Recovery must select a destination other than the valid active fallback')
      if (!manual) {
        await h.select([recoveryId])
        const content = `pending-target-loss-${trial}`
        await h.seed(content)
        const draft = await h.snapshot()
        const history = await h.history()
        await h.rememberFocus()
        const mark = await h.eventMark()
        try {
          await h.keyboard.press(LEADER)
          await h.keyboard.down('Alt')
          await h.keyboard.press('Digit4')
          await h.selectedTarget(lostId, 4)
          await h.parkLayout(2)
          await h.eventAfter(mark, 'cancel', 'target-unavailable')
          await h.leaderState(false)
          await h.focusPreserved()
          await h.checkBytes()
          assert.deepEqual(await h.snapshot(), draft)
          assert.deepEqual(await h.selectedIds(), [recoveryId])
          await h.keyboard.releaseAll()
          await h.keyboard.press('KeyQ')
          await eventually('A continuation after recipient loss is ordinary Prompt text', () => h.editor().innerText(), value => value === `${content}q`)
          await h.checkBytes()
          assert.equal((await h.eventsSince(mark)).filter(event => event.kind === 'dispatch').length, 0,
            'Recipient loss cancels before an action; neither manual nor active fallback receives it')
          assert.deepEqual(await h.history(), history)
          await h.focusPreserved()
        } finally {
          await h.keyboard.releaseAll()
          await h.parkLayout(4)
          await h.select([])
        }
      }
      if (manual) await h.select([lostId])
      const content = `lost-${manual ? 'manual' : 'explicit'}-${trial}`
      await h.seed(content)
      await h.focusTerminal(activeId)
      await h.editor().focus()
      const snapshot = await h.snapshot()
      const count = (await h.history()).length
      let rejectedDispatches = 0
      try {
        if (!manual) {
          // Hold only the renderer delivery of a dispatch already recognized by
          // main from trusted keys. The real Leader state still reaches the UI.
          await h.holdShortcutDispatch(true)
          const mark = await h.chord('KeyQ', { digit: 4 })
          const event = await h.eventAfter(mark, 'dispatch')
          assert.equal(event.targetId, lostId)
          assert.equal(event.actionId, 'queue')
          await h.shortcutDispatchWaiting()
          rejectedDispatches += 1
          await h.checkBytes()
        }
        await h.rememberFocus()
        await h.parkLayout(2)
        await h.focusPreserved()
        assert.equal(await h.sender().locator(`[data-terminal-id="${lostId}"]`).count(), 0)
        const state = await h.page.evaluate(() => window.electronAPI.appState.load())
        const tab = state.tabs.find(tab => tab.id === MAIN_TAB)
        assert(tab.terminals.some(terminal => terminal.id === lostId), 'The selected ID is genuinely parked, not replaced with a fabricated missing ID')
        assert.equal(tab.activeTerminalId, activeId, 'A valid active fallback remains available throughout the rejection')
        if (manual) {
          assert.deepEqual(await h.selectedIds(), [lostId], 'Layout changes must retain stale selection until an explicit user gesture')
          for (const key of ['KeyQ', 'KeyE']) {
            const event = await h.eventAfter(await h.chord(key), 'dispatch')
            assert.equal(event.tabId, MAIN_TAB)
            rejectedDispatches += 1
            const notice = h.sender().locator('.prompt-sender-notice[role="alert"]')
            await notice.waitFor({ state: 'visible' })
            assert.equal(await notice.innerText(), 'The selected Task is no longer visible or available. Nothing was sent.')
            await h.checkBytes()
          }
        } else {
          await h.holdShortcutDispatch(false)
          const notice = h.sender().locator('.prompt-sender-notice[role="alert"]')
          await notice.waitFor({ state: 'visible' })
          assert.equal(await notice.innerText(), 'The selected Task is no longer visible or available. Nothing was sent.')
          await h.checkBytes()
        }
        assert.equal((await h.history()).length, count)
        assert.deepEqual(await h.snapshot(), snapshot, 'Unavailable destinations retain the entire originating draft')
        assert.equal(await h.page.evaluate(() => window.__onwardPromptNotebookDebug.isInputBusy()), false)
        if (trial === 0) await h.screenshot(manual ? 'stale-manual-target' : 'stale-explicit-target')

        // A real card gesture both removes stale membership and selects the new
        // target. A direct debug selection setter would miss that recovery path.
        await h.select([recoveryId])
        assert.deepEqual(await h.selectedIds(), [recoveryId])
        await h.editor().focus()
        await h.sent(await h.chord('KeyQ'), [recoveryId], `${content}\t`, content, count)
        assert.deepEqual(await h.selectedIds(), [recoveryId], 'Successful recovery keeps the new manual selection')
        const evidence = { id, trial, lostId, activeId, recoveryId, rejectedDispatches }
        h.targetLossEvidence.push(evidence)
        return evidence
      } finally {
        await h.holdShortcutDispatch(false)
        await h.parkLayout(4)
        await h.select([])
      }
    })
  }
  await h.setTargetModifier(null)
}

async function staleGeneration(h) {
  await h.repeat('PIK-34-delayed-real-dispatch-rejects-old-tab-generation', async trial => {
    await h.switchTab(MAIN_TAB)
    await h.select([])
    const content = `old-generation-${trial}`
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    await h.editor().focus()
    const snapshot = await h.snapshot()
    const count = (await h.history()).length
    await h.holdShortcutDispatch(true)
    try {
      const oldMark = await h.chord('KeyQ')
      const old = await h.eventAfter(oldMark, 'dispatch')
      assert.equal(old.tabId, MAIN_TAB)
      assert(Number.isSafeInteger(old.generation), 'The old generation is emitted by main after actual native key recognition')
      await h.shortcutDispatchWaiting()
      await h.checkBytes()
      assert.equal((await h.history()).length, count)

      await h.switchTab(OTHER_TAB)
      await h.showPrompt(OTHER_TAB)
      await h.editor(OTHER_TAB).focus()
      const middleMark = await h.eventMark()
      await h.keyboard.press(LEADER)
      const middle = await h.eventAfter(middleMark, 'state')
      assert.equal(middle.tabId, OTHER_TAB)
      assert(middle.generation > old.generation)
      await h.keyboard.press('Escape')
      await h.eventAfter(middleMark, 'cancel', 'escape')

      await h.switchTab(MAIN_TAB)
      await h.showPrompt()
      await h.editor().focus()
      const freshMark = await h.eventMark()
      await h.keyboard.press(LEADER)
      const fresh = await h.eventAfter(freshMark, 'state')
      assert.equal(fresh.tabId, MAIN_TAB)
      assert(fresh.generation > middle.generation, 'A to B to A cannot reuse A\'s previous generation')
      await h.leaderState(true)
      await h.holdShortcutDispatch(false)
      await h.checkBytes()
      assert.equal((await h.history()).length, count, 'An old real callback cannot send after returning to the same Tab ID')
      assert.deepEqual(await h.snapshot(), snapshot)
      assert.equal(await h.page.evaluate(() => window.__onwardPromptInputShortcutsDebug.getLeaderState()?.active), true, 'Rejecting an old callback must preserve the fresh armed owner')
      await h.keyboard.press('KeyQ')
      const delivered = await h.sent(freshMark, [TASKS[0]], `${content}\t`, content, count)
      assert.equal(delivered.generation, fresh.generation)
      const evidence = { trial, oldGeneration: old.generation, middleGeneration: middle.generation, freshGeneration: fresh.generation }
      h.generationEvidence.push(evidence)
      return evidence
    } finally {
      await h.holdShortcutDispatch(false)
      await h.switchTab(MAIN_TAB)
    }
  })
}

async function lateContinuations(h) {
  h.lateContinuationEvidence = []
  await h.setTargetModifier('Alt')
  try {
    await h.repeat('PIK-38-local-cancel-rejects-real-late-continuations', async trial => {
      const order = await h.taskOrder()
      await h.select([order[1]])
      const content = `late-continuation-${trial}`
      await h.seed(content)
      const snapshot = await h.snapshot()
      const history = await h.history()
      const selection = await h.selectedIds()
      const mark = await h.eventMark()
      await h.page.evaluate(() => {
        const api = window.__onwardPromptInputShortcutsDebug
        if (!api?.setContinuationsHeld || !api.getHeldContinuationCount) throw new Error('The real continuation barrier is required')
        api.setContinuationsHeld(true)
      })
      try {
        await h.keyboard.press(LEADER)
        const arm = await h.eventAfter(mark, 'state')
        await h.leaderState(true)
        assert.equal(arm.selecting, undefined, 'Initial native arm is never held')
        assert(Number.isSafeInteger(arm.generation))
        await h.keyboard.down('Alt')
        await h.keyboard.up('Alt')
        await h.keyboard.down('Alt')
        await h.keyboard.press('Digit3')
        await h.keyboard.up('Alt')
        await h.keyboard.press('KeyQ')
        const dispatch = await h.eventAfter(mark, 'dispatch')
        await h.page.waitForFunction(() => window.__onwardPromptInputShortcutsDebug.getHeldContinuationCount() === 5)
        const native = await h.eventsSince(mark)
        assert(native.every(event => event.tabId === MAIN_TAB && event.generation === arm.generation))
        assert.deepEqual(native.map(event => [event.kind, event.selecting ?? null, event.targetId ?? null]), [
          ['state', null, null], ['state', true, null], ['state', false, null], ['state', true, null],
          ['state', false, order[2]], ['dispatch', null, order[2]]
        ], 'The held callbacks are real main-process states and dispatch, including both selector transitions')
        assert.equal(dispatch.actionId, 'queue')
        await h.leaderState(true)
        await h.checkBytes()
        const fromMs = await h.page.evaluate(() => Date.now())
        await h.title().focus()
        await h.leaderState(false)
        await h.rememberFocus()
        const released = await h.page.evaluate(async () => {
          const api = window.__onwardPromptInputShortcutsDebug
          api.setContinuationsHeld(false)
          // This ordinary IPC ACK also drains the preceding diagnostic sends.
          await window.electronAPI.settings.load()
          return { held: api.getHeldContinuationCount(), state: api.getLeaderState(), throughMs: Date.now() }
        })
        assert.equal(released.held, 0)
        assert.equal(released.state, null)
        await h.leaderState(false)
        await h.checkBytes()
        assert.deepEqual(await h.snapshot(), snapshot)
        assert.deepEqual(await h.history(), history)
        assert.deepEqual(await h.selectedIds(), selection)
        await h.focusPreserved()
        const freshMark = await h.chord('KeyQ', { digit: 3 })
        const fresh = await h.sent(freshMark, [order[2]], `${content}\t`, content, history.length)
        assert.equal(fresh.generation, arm.generation, 'Recovery and rejection share the same Tab activation')
        assert.equal(fresh.targetId, order[2])
        await h.leaderState(false)
        await h.focusPreserved()
        assert.deepEqual(await h.selectedIds(), selection)
        const evidence = { trial, fromMs, throughMs: released.throughMs, generation: arm.generation,
          sentRevision: snapshot.revision, targetId: order[2], heldStates: 4 }
        h.lateContinuationEvidence.push(evidence)
        return evidence
      } finally {
        try { await h.keyboard.releaseAll() }
        finally { await h.page.evaluate(() => window.__onwardPromptInputShortcutsDebug?.setContinuationsHeld(false)) }
      }
    })
  } finally {
    await h.setTargetModifier(null)
  }
}

async function renameGeometryTab(h, id, title) {
  const ids = await h.page.evaluate(() => window.__onwardAppDebug.getTabIds())
  const index = ids.indexOf(id)
  assert(index >= 0, 'Only a fixture-owned Tab may be renamed')
  const tab = h.page.locator('.tab-list .tab-item').nth(index)
  await tab.locator('.tab-name').dblclick()
  await tab.locator('.tab-name-input').fill(title ?? '')
  await tab.locator('.tab-name-input').press('Enter')
  await tab.locator('.tab-name-input').waitFor({ state: 'detached' })
  if (title) assert.equal(await tab.locator('.tab-name').innerText(), `Tab ${index + 1}: ${title}`)
}

async function cueGeometry(h, expectedLabel, narrow) {
  const measured = await h.page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
    const list = document.querySelector('.tab-list')
    const cue = document.querySelector('[data-testid="prompt-leader-indicator"]')
    return {
      viewport: innerWidth, bar: rect('.tab-bar'), left: rect('.tab-bar-left'), center: rect('.tab-bar-center'),
      right: rect('.tab-bar-right'), slot: rect('.prompt-leader-slot'), cue: cue.getBoundingClientRect().toJSON(),
      list: list.getBoundingClientRect().toJSON(), add: rect('.tab-add-btn'),
      scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, label: cue.getAttribute('aria-label'),
      tabs: [...list.querySelectorAll('.tab-item')].map(node => node.getBoundingClientRect().toJSON()),
      hit: document.elementFromPoint(cue.getBoundingClientRect().x + 8, cue.getBoundingClientRect().y + 8)
        ?.closest('[data-testid="prompt-leader-indicator"]') === cue
    }
  })
  const { bar, left, center, right, slot, cue, list, add } = measured
  assert.equal(measured.label, expectedLabel)
  assert.equal(measured.tabs.length, 6)
  assert(right.width >= 68 && slot.width >= 68, 'The outer flex region reserves the entire cue slot')
  assert(cue.width === 60 && cue.height === 22 && measured.hit, 'The actual keycap remains visible and unobscured')
  for (const bounds of [center, slot, cue, list, add]) {
    assert(bounds.width > 0 && bounds.left >= bar.left - 0.5 && bounds.right <= bar.right + 0.5 && bounds.right <= measured.viewport + 0.5,
      'Every visible bar surface fits the real viewport')
  }
  assert(left.right <= center.left + 0.5 && center.right <= right.left + 0.5, 'Window controls, center and cue region do not overlap')
  assert(list.right <= add.left + 0.5 && add.right <= slot.left + 0.5, 'The Tab viewport and add button remain separate from the cue')
  assert(cue.left >= slot.left && cue.right <= slot.right && cue.top >= bar.top && cue.bottom <= bar.bottom)
  for (const tab of measured.tabs) {
    const visibleLeft = Math.max(tab.left, list.left), visibleRight = Math.min(tab.right, list.right)
    if (visibleRight > visibleLeft) assert(visibleRight <= cue.left, 'Clipped, visible Tabs cannot cover the cue')
  }
  if (narrow) assert(measured.scrollWidth > measured.clientWidth, 'Crowded Tabs use the existing horizontal scroll viewport')
  return measured
}

async function crowdedTabGeometry(h) {
  const fixture = await json(path.join(h.workspace, 'crowded-tabs.json'))
  const initialTabCount = await h.page.evaluate(() => window.__onwardAppDebug.getTabIds().length)
  const viewport = h.page.viewportSize()
  const setLanguage = async language => {
    await h.openSettings('general')
    await h.page.getByTestId('settings-language-select').selectOption(language)
    await eventually('geometry locale is acknowledged', () => h.page.evaluate(() => window.electronAPI.settings.load()), settings => settings.language === language)
    await h.page.getByTestId('sidebar-settings-button').click()
    await h.page.locator('.settings-container').waitFor({ state: 'hidden' })
  }
  try {
    await h.setTargetModifier('Alt')
    for (let count = initialTabCount; count < fixture.titles.length; count++) {
      assert.equal(await h.page.evaluate(() => window.__onwardAppDebug.createTab()), 'pending')
      await h.page.waitForFunction(count => window.__onwardAppDebug.getTabIds().length === count + 1, count)
    }
    const ids = await h.page.evaluate(() => window.__onwardAppDebug.getTabIds())
    assert.equal(ids.length, 6)
    for (const [index, id] of ids.entries()) await renameGeometryTab(h, id, fixture.titles[index])
    await h.switchTab(MAIN_TAB)
    await h.seed(fixture.draft)
    const draft = await h.snapshot()
    const history = await h.history()
    const order = await h.taskOrder()
    const title = await h.task(order[2]).locator('.terminal-grid-title').innerText()
    await h.repeat('PIK-39-bilingual-crowded-tab-cue-geometry', async trial => {
      const measurements = []
      for (const [language, copy] of Object.entries(fixture.copy)) {
        await setLanguage(language)
        for (const width of fixture.widths) {
          await h.page.setViewportSize({ width, height: viewport.height })
          await h.page.waitForFunction(width => innerWidth === width, width)
          await h.editor().focus()
          await h.rememberFocus()
          const mark = await h.eventMark()
          try {
            await h.keyboard.press(LEADER)
            await h.keyboard.down('Alt')
            await h.choosingTargets(order)
            const choosing = await cueGeometry(h, copy.choosing.replace('{count}', String(order.length)), width === fixture.widths[0])
            await h.keyboard.press('Digit3')
            await h.selectedTarget(order[2], 3)
            const selected = await cueGeometry(h, copy.selected.replace('{name}', title), width === fixture.widths[0])
            assert.deepEqual(selected.slot, choosing.slot, 'Choosing and selected keycaps occupy the same reserved slot')
            await h.keyboard.up('Alt')
            await h.keyboard.press('Escape')
            await h.eventAfter(mark, 'cancel', 'escape')
            await h.leaderState(false)
            await h.focusPreserved()
            measurements.push({ language, width, choosing, selected })
          } finally { await h.keyboard.releaseAll() }
        }
      }
      await h.checkBytes()
      assert.deepEqual(await h.snapshot(), draft)
      assert.deepEqual(await h.history(), history)
      assert.equal(measurements.length, 4)
      return { trial, measurements }
    })
  } finally {
    await h.keyboard.releaseAll()
    await h.page.evaluate(() => window.electronAPI.promptInput.cancel('geometry-cleanup'))
    await h.page.setViewportSize(viewport)
  }
}

async function nativeWindowBoundaries(h) {
  const id = 'PIK-30-native-window-blur-cancels-without-revival'
  await h.setTargetModifier('Alt')
  await h.repeat(id, async trial => {
    const content = `native-blur-${trial}`
    const count = (await h.history()).length
    await h.seed(content)
    await h.focusTerminal(TASKS[0])
    const mark = await h.eventMark()
    await h.keyboard.press(LEADER)
    await h.eventAfter(mark, 'state')
    try {
      await h.keyboard.down('Alt')
      await h.choosingTargets(await h.taskOrder())
      assert.equal(await h.page.evaluate(() => window.electronAPI.debug.blurWindow()), true, 'The real owned BrowserWindow must blur')
      const canceled = await h.eventAfter(mark, 'cancel')
      assert(['blur', 'contents-blur'].includes(canceled.reason), 'Native owner-window blur really canceled the Leader')
      await h.leaderState(false)
    } finally {
      assert(await h.page.evaluate(() => window.electronAPI.debug.focusWindow()), 'Refocus only the owned app through its debug IPC')
      await h.page.bringToFront()
      await h.keyboard.releaseAll()
    }
    await h.focusTerminal(TASKS[0])
    await h.keyboard.press('Digit3')
    await h.keyboard.press('KeyQ')
    h.expect([TASKS[0]], '3q')
    await h.checkBytes()
    assert.equal((await h.eventsSince(mark)).filter(value => value.kind === 'dispatch').length, 0)
    assert.equal((await h.history()).length, count)
    assert.equal(await h.editor().innerText(), content)
    await h.sent(await h.chord('KeyE'), [TASKS[0]], '\r')
    await h.leaderState(false)
    return { trial, canceled: true, heldSelectorCleared: true, freshSequenceWorks: true }
  })
  await h.setTargetModifier(null)
}

async function readers(h) {
  await h.setTargetModifier('Alt')
  await h.select([TASKS[0]])
  await h.focusTerminal(TASKS[0])
  await h.task(TASKS[0]).locator('[data-terminal-dropdown-trigger]').click()
  await h.page.locator('[data-terminal-dropdown-action="editor"]').click()
  await h.page.waitForFunction(() => window.__onwardProjectEditorDebug?.isOpen())
  for (const surface of ['pdf', 'epub']) {
    const id = surface === 'pdf' ? 'PIK-31-pdf-iframe-native-owner-and-consumed-keys' : 'PIK-32-epub-iframe-native-owner-and-consumed-keys'
    // Reader startup owns a distinct committed binary fixture cost. This group
    // is deliberately independent of the user/ACK/stress group and its deadline.
    await h.page.evaluate(file => window.__onwardProjectEditorDebug.openFileByPathAsUser(file), `reader.${surface}`)
    await h.page.waitForFunction(surface => {
      const api = window.__onwardProjectEditorDebug
      return (surface === 'pdf' ? api.getPdfReaderState() : api.getEpubReaderState())?.stateReady === true
    }, surface, { timeout: 20000 })
    const epub = surface === 'epub'
    const frameSelector = epub ? '.project-editor-epub-content .epub-view iframe:visible' : '.project-editor-pdf-reader-iframe'
    const frame = epub ? h.page.frameLocator(frameSelector) : h.page.frameLocator(frameSelector).first()
    const body = frame.locator('body')
    // EPUB chapter scripts are disabled. A callback created by body.evaluate
    // belongs to that sandboxed realm and Chromium refuses to run it on input.
    // Observe its real Document from the same-origin host realm, as epub.js does.
    // PDF keeps its working in-frame observer; neither path creates key events.
    const probeNode = epub ? h.page.locator(frameSelector) : body
    let frameEvidence
    if (epub) {
      await probeNode.waitFor({ state: 'visible' })
      assert.equal(await probeNode.count(), 1, 'Observe the displayed chapter, not an arbitrary first preloaded iframe')
      frameEvidence = await probeNode.evaluate(iframe => ({
        id: iframe.id, sandbox: iframe.getAttribute('sandbox'),
        sameOrigin: iframe.sandbox.contains('allow-same-origin'), scriptsAllowed: iframe.sandbox.contains('allow-scripts'),
        heading: iframe.contentDocument?.querySelector('h1')?.textContent?.trim(),
        fixtureLoaded: iframe.contentDocument?.body?.textContent?.includes('Onward Autotest EPUB chapter 1.') === true
      }))
      assert.equal(frameEvidence.sameOrigin, true)
      assert.equal(frameEvidence.scriptsAllowed, false, 'Keep the production chapter sandbox intact')
      assert.equal(frameEvidence.heading, 'Chapter 1')
      assert.equal(frameEvidence.fixtureLoaded, true, 'The observer attaches to the rendered committed EPUB fixture')
    }
    await probeNode.evaluate((node, epub) => {
      const doc = epub ? node.contentDocument : node.ownerDocument
      if (!doc?.body) throw new Error('Reader document is not loaded')
      const probe = { doc, events: [] }
      probe.listener = event => probe.events.push({ type: event.type, code: event.code, control: event.ctrlKey, trusted: event.isTrusted })
      node.__pikReaderProbe = probe
      for (const type of ['keydown', 'keyup']) doc.addEventListener(type, probe.listener, true)
    }, epub)
    try {
      await h.repeat(id, async trial => {
        const content = `${surface}-native-frame-${trial}`
        const count = (await h.history()).length
        await h.seed(content)
        if (surface === 'pdf') await frame.locator('#searchInput').click()
        else await frame.getByRole('heading', { name: 'Chapter 1', exact: true }).click()
        await probeNode.evaluate(node => {
          const probe = node.__pikReaderProbe
          probe.owner = probe.doc.activeElement
          probe.events.length = 0
        })
        const read = () => probeNode.evaluate((node, epub) => {
          const doc = epub ? node.contentDocument : node.ownerDocument
          const probe = node.__pikReaderProbe
          const hostOwnsFrame = !epub || node.ownerDocument.activeElement === node
          return {
            focused: node.isConnected && doc === probe.doc && hostOwnsFrame && doc.hasFocus() && doc.activeElement === probe.owner,
            hostOwnsFrame, documentCurrent: doc === probe.doc, ownerTag: probe.owner?.tagName,
            value: probe.owner?.value ?? null, events: [...probe.events]
          }
        }, epub)
        assert.equal((await read()).focused, true, 'A trusted click places keyboard ownership inside the actual reader frame')
        const initial = await read()
        await h.keyboard.press('KeyZ')
        const native = await eventually('Native input reaches the reader frame', read,
          value => value.events.some(event => event.type === 'keyup' && event.code === 'KeyZ' && event.trusted) &&
            (initial.value === null || value.value === `${initial.value}z`))
        assert(native.events.some(event => event.type === 'keydown' && event.code === 'KeyZ' && event.trusted), 'Ordinary trusted input reaches the loaded reader frame')
        const mark = native.events.length
        await h.rememberFocus()
        await h.sent(await h.chord('KeyQ', { digit: 3 }), [TASKS[2]], `${content}\t`, content, count)
        await h.leaderState(false)
        await h.focusPreserved()
        const sent = await read()
        assert(sent.focused)
        assert.equal(sent.value, native.value, 'The Prompt action never inserts keys into the reader input')
        assert.equal(sent.events.slice(mark).filter(event => ['KeyX', 'Digit3', 'KeyQ'].includes(event.code)).length, 0)

        await h.keyboard.press('Digit3')
        const freshDigit = await eventually('A fresh consumed-digit key delivers one trusted down/up pair to the reader', read,
          value => value.events.slice(sent.events.length).some(event => event.type === 'keyup' && event.code === 'Digit3' && event.trusted) &&
            (sent.value === null || value.value === `${sent.value}3`))
        assert(freshDigit.focused)
        assert.deepEqual(freshDigit.events.slice(sent.events.length).filter(event => event.code === 'Digit3').map(event => ({ type: event.type, trusted: event.trusted })),
          [{ type: 'keydown', trusted: true }, { type: 'keyup', trusted: true }])
        await h.checkBytes()

        const pass = await h.eventMark()
        const beforePass = freshDigit.events.length
        await h.keyboard.press(LEADER)
        await h.keyboard.press(LEADER)
        await h.eventAfter(pass, 'passthrough')
        const passed = (await read()).events.slice(beforePass)
        assert.equal(passed.filter(event => event.type === 'keydown' && event.code === 'KeyX' && event.control && event.trusted).length, 1)
        for (const [key, reason] of [['Escape', 'escape'], ['KeyZ', 'unmatched']]) {
          const before = await read()
          await h.eventAfter(await h.chord(key), 'cancel', reason)
          const after = await read()
          assert(after.focused)
          assert.equal(after.events.slice(before.events.length).filter(event => !['ControlLeft', 'ControlRight'].includes(event.code)).length, 0)
          assert.equal(after.value, before.value, `${reason} must not leak a printable char into the reader`)
          assert(await h.page.evaluate(() => window.__onwardProjectEditorDebug.isOpen()), 'Consumed Escape cannot close the reader')
        }
        await h.checkBytes()
        return {
          trial, surface, trustedNativeOwner: true, rawBytes: Buffer.byteLength(`${content}\t`),
          observerRealm: epub ? 'same-origin-host' : 'reader-frame', frameEvidence
        }
      })
      await h.screenshot(`${surface}-native-frame`)
    } finally {
      await probeNode.evaluate(node => {
        const probe = node.__pikReaderProbe
        for (const type of ['keydown', 'keyup']) probe.doc.removeEventListener(type, probe.listener, true)
        delete node.__pikReaderProbe
      }).catch(() => {})
    }
  }
}

async function retainNativeTrace(h) {
  const status = await h.page.evaluate(() => window.electronAPI.debug.flushPerfTrace())
  assert(status.filePath, 'Real main/renderer trace must be available')
  assertTracePath(status.filePath)
  const directory = path.dirname(status.filePath)
  const suffix = path.basename(status.filePath).match(/-\d+\.jsonl$/)?.[0]
  const candidates = suffix ? (await readdir(directory)).filter(name => name.endsWith(suffix)).map(name => path.join(directory, name)) : [status.filePath]
  const files = []
  for (const filename of candidates) if ((await stat(filename)).mtimeMs >= Date.parse(h.startedAt)) files.push(filename)
  assert(files.includes(status.filePath), 'Trace chunk belongs to this launch, never to an older reused process ID')
  const retainedFiles = []
  const retainedDirectory = path.join(h.artifacts, 'perf')
  await mkdir(retainedDirectory, { recursive: true })
  const events = []
  for (const filename of files) {
    const text = await readFile(filename, 'utf8')
    const retainedFile = path.join(retainedDirectory, path.basename(filename))
    await writeFile(retainedFile, text)
    retainedFiles.push(retainedFile)
    if (filename.endsWith('.jsonl')) events.push(...text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)))
    else events.push(...JSON.parse(text).traceEvents)
  }
  return { files, retainedFiles, events }
}

async function traces(h) {
  await h.case('PIK-17-trace-send-receive-and-final-byte-ledger', async () => {
    const { files, retainedFiles, events } = await retainNativeTrace(h)
    const required = [
      'main:prompt-shortcut.state-changed', 'renderer:prompt-shortcut.state-changed',
      'renderer:prompt-shortcut.present-leader',
      'renderer:prompt-input.ipc', 'main:prompt-input.send-sequence',
      'renderer:prompt-input.dispatch-action', 'renderer:prompt-input.settle-draft',
      ...(h.testGroup === 'user' ? ['renderer:task-reorder.mode-enter', 'renderer:task-reorder.commit', 'renderer:task-reorder.mode-exit'] : [])
    ]
    const counts = Object.fromEntries(required.map(name => [name, events.filter(event => event.name === name).length]))
    for (const [name, count] of Object.entries(counts)) assert(count > 0, `Missing diagnostic boundary: ${name}`)
    assert(events.some(event => event.name === 'main:prompt-shortcut.state-changed' && event.args?.stage === 'event-send' && event.args?.kind === 'dispatch'), 'Main really sent shortcut IPC')
    assert(events.some(event => event.name === 'renderer:prompt-shortcut.state-changed' && event.args?.phase === 'receive' && event.args?.kind === 'dispatch'), 'Renderer really received shortcut IPC')
    for (const stage of h.testGroup === 'boundaries' ? ['send', 'receive', 'reject'] : ['send', 'receive']) {
      assert(events.some(event => event.name === 'renderer:prompt-input.ipc' && event.args?.channel === 'prompt-input:send' && event.args?.stage === stage),
        `Real send IPC ${stage} boundary is visible`)
    }
    assert(events.some(event => event.name === 'main:prompt-input.send-sequence' && event.ph === 'X' && event.args?.stage === 'transaction-complete'), 'PTY transaction emits a duration span')
    const transactions = events.filter(event => event.name === 'main:prompt-input.send-sequence' && event.args?.stage === 'transaction-complete')
    let extraTargetsVisible = false
    for (const event of [...events].sort((left, right) => left.ts - right.ts)) {
      if (event.name === 'main:prompt-shortcut.state-changed' && event.args?.stage === 'context-received') {
        extraTargetsVisible = event.args.tabId === MAIN_TAB && event.args.visibleCount === 8
      }
      if (event.name === 'main:prompt-input.send-sequence' && event.args?.stage === 'transaction-complete') {
        assert(TASKS.includes(event.args.terminalId) || (extraTargetsVisible && h.extraTargets.includes(event.args.terminalId)),
          'No action reaches parked or inactive-Tab targets; extra receivers are valid only during the eight-Task context')
      }
    }
    if (h.testGroup === 'user') {
      assert.equal(transactions.filter(event => h.extraTargets.includes(event.args.terminalId)).length, TRIALS,
        'The eight-Task stress trials deliver exactly once each')
      assert.equal(h.reorderEvidence.filter(evidence => evidence.kind === 'real-drag').length, TRIALS)
      assert.equal(h.reorderEvidence.filter(evidence => evidence.kind === 'state-update').length, TRIALS)
      assert.equal(events.filter(event => event.name === 'renderer:task-reorder.mode-enter' && event.args?.trigger === 'long-press').length, TRIALS)
      assert.equal(events.filter(event => event.name === 'renderer:task-reorder.commit' && event.args?.fromIndex === 2 && event.args.toIndex === 0).length, TRIALS)
      assert.equal(events.filter(event => event.name === 'renderer:task-reorder.mode-exit' && event.args?.reason === 'drop').length, TRIALS)
      assert(events.filter(event => event.name === 'renderer:prompt-shortcut.state-changed' && event.args?.phase === 'modal-state' && event.args.blocked === true).length >= TRIALS,
        'Each real drag exposes its modal block to the renderer')
      assert(events.filter(event => event.name === 'main:prompt-shortcut.state-changed' && event.args?.stage === 'context-received' && event.args.blocked === true).length >= TRIALS,
        'The modal block crosses the real main-process context boundary')
      for (const evidence of h.reorderEvidence) {
        if (evidence.kind === 'state-update') {
          // Main stamps these events with epoch milliseconds. Check the closed
          // reorder window after the run, rather than polling a live trace file.
          const propagated = events.filter(event => event.ts >= evidence.contextFromMs * 1000 && event.ts < (evidence.contextThroughMs + 1) * 1000)
          for (const phase of ['context-send', 'context-ack']) {
            assert(propagated.some(event => event.name === 'renderer:prompt-shortcut.state-changed' && event.args?.phase === phase &&
              event.args.tabId === MAIN_TAB && event.args.generation === evidence.generation),
            `PIK-35 trial ${evidence.trial} observes normal ${phase} for the unchanged Tab/generation before continuation`)
          }
          assert(propagated.some(event => event.name === 'main:prompt-shortcut.state-changed' && event.args?.stage === 'context-received' &&
            event.args.tabId === MAIN_TAB && event.args.generation === evidence.generation && event.args.visibleCount === 4 && event.args.blocked === false),
          'The reordered visible context reaches main normally before the captured-ID continuation')
        }
        assert.equal(events.filter(event => event.name === 'renderer:prompt-input.dispatch-action' && event.args?.phase === 'send' &&
          event.args.tabId === MAIN_TAB && event.args.actionId === 'queue' && event.args.revision === evidence.sentRevision).length, 1,
        'Each post-drag or captured-ID trial has exactly one real send, including the five added PIK-35 sends')
        assert.equal(events.filter(event => event.name === 'renderer:prompt-input.settle-draft' && event.args?.phase === 'history-recorded' &&
          event.args.tabId === MAIN_TAB && event.args.revision === evidence.sentRevision).length, 1)
        assert(events.some(event => event.name === 'main:prompt-shortcut.state-changed' && event.args?.stage === 'event-send' &&
          event.args.kind === 'dispatch' && event.args.actionId === 'queue' && event.args.tabId === MAIN_TAB &&
          event.args.generation === evidence.generation && event.args.targetId === evidence.targetId),
        'Main dispatch carries the same explicit Task ID proved by the byte ledger')
      }
    }
    if (h.testGroup === 'boundaries') {
      assert.equal(h.lateContinuationEvidence.length, TRIALS)
      for (const evidence of h.lateContinuationEvidence) {
        const rejected = events.filter(event => event.name === 'renderer:prompt-shortcut.state-changed' &&
          event.ts >= evidence.fromMs * 1000 && event.ts < (evidence.throughMs + 1) * 1000)
        assert.equal(rejected.filter(event => event.args?.reason === 'stale-owner-state').length, evidence.heldStates,
          'Every held selector/target continuation reaches the existing owner rejection')
        assert.equal(rejected.filter(event => event.args?.reason === 'stale-owner-dispatch').length, 1)
        assert(rejected.some(event => event.args?.phase === 'owner-cancel-send' && event.args.reason === 'context-changed'))
        assert(!rejected.some(event => event.args?.phase === 'view-published' && event.args.active), 'Late states never republish an active cue')
        assert.equal(events.filter(event => event.name === 'renderer:prompt-input.dispatch-action' && event.args?.phase === 'send' &&
          event.args.tabId === MAIN_TAB && event.args.revision === evidence.sentRevision).length, 1, 'Only the fresh recovery may send this revision')
      }
      assert.equal(h.ackEvidence.length, 5 * TRIALS)
      for (const evidence of h.ackEvidence) {
        const recorded = events.filter(event => event.name === 'renderer:prompt-input.settle-draft' && event.args?.phase === 'history-recorded' &&
          event.args.tabId === MAIN_TAB && event.args.revision === evidence.sentRevision)
        assert.equal(recorded.length, 1, `Captured history trace is exactly once: ${evidence.id}/${evidence.trial}`)
        if (evidence.retainedRevision !== undefined) {
          assert(events.some(event => event.name === 'renderer:prompt-input.settle-draft' && event.args?.phase === 'clear-skipped' &&
            event.args.tabId === MAIN_TAB && event.args.sentRevision === evidence.sentRevision && event.args.currentRevision === evidence.retainedRevision),
          'Newer revision preservation has a diagnostic breadcrumb')
        }
      }
      assert.equal(events.filter(event => event.name === 'renderer:prompt-input.dispatch-action' && event.args?.phase === 'rejected' && event.args?.reason === 'in-flight').length,
        TRIALS, 'Every busy second keyboard dispatch has one visible-rejection breadcrumb')
      assert.equal(h.targetLossEvidence.length, 2 * TRIALS)
      assert(events.filter(event => event.name === 'renderer:prompt-input.dispatch-action' && event.args?.phase === 'rejected' && event.args?.reason === 'target-unavailable').length >= 3 * TRIALS,
        'Every stale explicit/manual text/key-only dispatch exposes its target rejection')
      assert.equal(h.generationEvidence.length, TRIALS)
      for (const evidence of h.generationEvidence) {
        assert(events.some(event => event.name === 'renderer:prompt-shortcut.state-changed' && event.args?.phase === 'rejected' && event.args.reason === 'stale-generation' &&
          event.args.tabId === MAIN_TAB && event.args.generation === evidence.oldGeneration && event.args.currentGeneration === evidence.freshGeneration),
        'The real delayed callback reaches the renderer generation guard, not merely an inactive-Tab or missing-owner guard')
      }
    }
    const bytes = await h.checkBytes()
    const other = await eventually('Other Tab fixture draft remains intact', () => h.page.evaluate(() => window.electronAPI.appState.load()),
      state => state.tabs.find(tab => tab.id === OTHER_TAB).editorDraft?.content === 'PIS_OTHER_TAB_DRAFT_MUST_SURVIVE')
    assert.equal(other.tabs.find(tab => tab.id === OTHER_TAB).editorDraft.content, 'PIS_OTHER_TAB_DRAFT_MUST_SURVIVE')
    await writeFile(path.join(h.artifacts, 'trace-coverage.json'), JSON.stringify({
      files: retainedFiles, sourceFiles: files, counts, bytes, ackEvidence: h.ackEvidence, targetLossEvidence: h.targetLossEvidence,
      generationEvidence: h.generationEvidence, reorderEvidence: h.reorderEvidence,
      lateContinuationEvidence: h.lateContinuationEvidence
    }, null, 2))
    return { files: retainedFiles, counts, bytes }
  })
}

async function runShortcutCases(h) {
  await startup(h)
  assert(!h.cancelled, 'Runner canceled during application startup')
  if (h.testGroup === 'user') {
    await core(h)
    await heldTargets(h)
    await eightTargetPressure(h)
    // Last scenario: leaves disposable Tabs/settings changed. Only trace/byte
    // auditing and harness teardown may follow; receiver/profile cleanup is shared.
    await crowdedTabGeometry(h)
  } else if (h.testGroup === 'guests') {
    await guests(h)
  } else if (h.testGroup === 'boundaries') {
    await additionalBoundaries(h)
    await delayedAcknowledgements(h)
    await staleDestinations(h)
    await staleGeneration(h)
    await nativeWindowBoundaries(h)
    await lateContinuations(h)
  } else {
    await readers(h)
  }
  await traces(h)
}

const options = args(process.argv.slice(2))
if (options.help) {
  console.log(`Usage: node test/autotest/prompt-input-shortcuts-driver.mjs --app-bin <packaged-dev-executable> [--log-file <repo/traces/path>] [--group ${GROUPS.join('|')}]`)
} else {
  const h = new ShortcutHarness(options)
  let failure
  let rejectAbort
  const abort = new Promise((_, reject) => { rejectAbort = reject })
  void abort.catch(() => {})
  const interrupt = signal => {
    h.cancelled = true
    failure ??= new Error(`Runner interrupted: ${signal}`)
    rejectAbort(failure)
  }
  const sigint = () => interrupt('SIGINT')
  const sigterm = () => interrupt('SIGTERM')
  process.once('SIGINT', sigint)
  process.once('SIGTERM', sigterm)
  const deadline = setTimeout(() => interrupt(`work deadline ${WORK_DEADLINE_MS}ms`), WORK_DEADLINE_MS)
  try {
    await h.initialize()
    await Promise.race([runShortcutCases(h), abort])
    assert.equal(h.results.length, GROUP_CASE_COUNTS[h.testGroup], 'A complete group must execute every mandatory case')
    assert(h.results.every(result => result.status === 'PASS'), 'No mandatory shortcut boundary may be skipped')
  } catch (error) {
    failure ??= error
    if (h.page) await h.screenshot('failure').catch(() => {})
    if (h.page) {
      try {
        const { retainedFiles } = await retainNativeTrace(h)
        await h.log('FAILURE_TRACE_RETAINED', { files: retainedFiles })
      } catch (traceError) {
        await h.log('FAILURE_TRACE_UNAVAILABLE', { error: String(traceError) }).catch(() => {})
      }
    }
  } finally {
    clearTimeout(deadline)
    try { process.exitCode = await h.finish(failure) } catch (error) { console.error(error); process.exitCode = 1 }
    process.removeListener('SIGINT', sigint)
    process.removeListener('SIGTERM', sigterm)
  }
}
