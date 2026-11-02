// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { ThemeUiHarness, REPO_ROOT, eventually, replaceFixtureCommand, saveSettingsPage } from './themes-ui-driver-support.mjs'
import { inventoryTraceFiles, selectNewTraceFiles, validateTraceFiles } from './trace-self-check-files.mjs'

const [appBin, logFile] = process.argv.slice(2)
assert(appBin, 'Pass the packaged development executable')
const h = new ThemeUiHarness({ appBin, logFile, group: 'cli-shortcut-compatibility' })
const TRIALS = 5
const require = createRequire(import.meta.url)
let clipboardWriter, clipboardExit
async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error }
}
function shellCommand(kind, values) {
  assert(values.every(value => !/[\r\n]/.test(value)))
  if (kind === 'powershell') return `& ${values.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`
  if (kind === 'cmd') {
    assert(values.every(value => !/["%!]/.test(value)))
    return values.map(value => `"${value}"`).join(' ')
  }
  assert.equal(kind, 'posix')
  return values.map(value => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ')
}
class Receiver {
  constructor(id) { this.id = id; this.directory = path.join(h.scratch, id); this.expected = ''; this.sequence = 0 }
  async start() {
    await mkdir(this.directory)
    const { shellKind } = await h.page.evaluate(id => window.electronAPI.terminal.getInputCapabilities(id), this.id)
    const command = shellCommand(shellKind, [process.execPath, path.join(h.workspace, 'raw-stdin.mjs'), this.directory])
      + (shellKind === 'cmd' ? ' & exit' : '; exit')
    assert.equal(await h.page.evaluate(({ id, command }) => window.electronAPI.terminal.write(id, `${command}\r`), { id: this.id, command }), true)
    await eventually('raw PTY receiver ready', () => json(path.join(this.directory, 'status.json')), state => state?.ready, 20000)
  }
  async command(operation, extra = {}) {
    const id = ++this.sequence, destination = path.join(this.directory, 'command.json')
    await writeFile(`${destination}.next`, JSON.stringify({ id, operation, ...extra }))
    await replaceFixtureCommand(`${destination}.next`, destination)
    await eventually('receiver command acknowledged', () => json(path.join(this.directory, 'status.json')), state => state?.commandId === id)
  }
  async check() {
    const expected = Buffer.from(this.expected)
    await eventually('expected stdin bytes arrived', () => readFile(path.join(this.directory, 'stdin.bin')), bytes => bytes.length >= expected.length)
    await this.command('snapshot')
    const actual = await readFile(path.join(this.directory, 'stdin.bin'))
    assert.equal(actual.toString('hex'), expected.toString('hex'), 'Exact child stdin; no newline normalization or extra release')
  }
  async output(data, flags) {
    this.expected += `\x1b[?${flags}u`
    await this.command('output', { data: `${data}\x1b[?u` })
    await this.check()
  }
  async focus() { await h.page.locator(`.terminal-grid-cell[data-terminal-id="${this.id}"] .xterm-helper-textarea`).focus() }
  async key(stroke, bytes) { await this.focus(); await h.page.keyboard.press(stroke); this.expected += bytes; await this.check() }
}
async function run() {
  const traceDir = path.join(REPO_ROOT, 'traces/perf')
  await mkdir(traceDir, { recursive: true })
  const before = inventoryTraceFiles(traceDir)
  await cp(path.join(REPO_ROOT, 'test/autotest/fixtures/prompt-input-shortcuts/raw-stdin.mjs'), path.join(h.workspace, 'raw-stdin.mjs'))
  const stateFile = path.join(h.userData, 'app-state.json')
  await cp(path.join(REPO_ROOT, 'test/autotest/fixtures/prompt-input-shortcuts/app-state.json'), stateFile)
  const seed = await json(stateFile)
  seed.tabs = seed.tabs.slice(0, 1)
  seed.tabs[0].layoutMode = { kind: 'preset', count: 2 }
  seed.tabs[0].terminals = seed.tabs[0].terminals.slice(0, 2)
  for (const terminal of seed.tabs[0].terminals) terminal.lastCwd = h.workspace
  await writeFile(stateFile, JSON.stringify(seed))
  await h.start()
  await h.case('CLI-UI01-option-preference-save-discard-bilingual', async () => {
    await h.openSettings('general')
    const option = h.page.getByTestId('settings-terminal-option-meta')
    for (const locale of ['en', 'zh-CN']) {
      await h.page.getByTestId('settings-language-select').selectOption(locale)
      await saveSettingsPage(h.page)
      for (let trial = 0; trial < TRIALS; trial++) {
        await option.check()
        assert.equal((await h.page.evaluate(() => window.electronAPI.settings.load())).terminalMacOptionIsMeta, false)
        await h.page.getByTestId('settings-discard').click()
        assert.equal(await option.isChecked(), false)
        await option.check()
        await saveSettingsPage(h.page)
        assert.equal((await h.diskSettings()).terminalMacOptionIsMeta, true)
        await option.uncheck()
        await saveSettingsPage(h.page)
      }
      for (const width of [300, 600]) {
        await h.page.evaluate(width => window.__onwardSettingsDebug.setPanelWidth(width), width)
        await option.scrollIntoViewIfNeeded()
        const bounds = await option.locator('..').evaluate(node => {
          const rect = node.getBoundingClientRect()
          return { width: rect.width, right: rect.right, viewport: innerWidth, overflow: node.scrollWidth > node.clientWidth }
        })
        assert(bounds.width > 0 && bounds.right <= bounds.viewport && !bounds.overflow)
      }
      await h.screenshot(`keyboard-settings-${locale}`)
    }
    await h.page.getByTestId('settings-language-select').selectOption('en')
    await saveSettingsPage(h.page)
  })
  await h.page.locator('.settings-close-btn').click()
  const ids = await h.page.locator('.terminal-grid-cell[data-terminal-id]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.terminalId))])
  assert(ids.length >= 2, 'Independent real PTY destinations required')
  const a = new Receiver(ids[0]), b = new Receiver(ids[1])
  await a.start(); await b.start()
  await h.case('CLI-UI02-negotiation-isolation-and-legacy-five-trials', async () => {
    const fixtureRoot = path.join(REPO_ROOT, 'test/autotest/fixtures/cli-shortcut-compatibility')
    const repairs = await json(path.join(fixtureRoot, 'repairs.json'))
    const contracts = await json(path.join(fixtureRoot, 'contracts.json'))
    for (let trial = 0; trial < TRIALS; trial++) {
      await a.output('\x1b[>1u', 1)
      for (const contract of contracts.cases) {
        const repair = repairs.cases[contract.id]
        if (repair?.keyboardFlags !== 1 || repair.macOptionIsMeta && process.platform === 'darwin') continue
        assert.equal(contract.strokes.length, 1)
        await a.key(contract.strokes[0].replace(/\+(Up|Down)$/, '+Arrow$1'), repair.expect.sequence)
      }
      await b.key('Shift+Enter', '\r')
      await a.output('\x1b[?1049h', 0)
      await a.output('\x1b[>7u', 7)
      await a.key('Control+Shift+A', '\x1b[97:65;6u\x1b[97:65;6:3u')
      await a.output('\x1b[<u\x1b[?1049l', 1)
      await a.output('\x1b[<u', 0)
      await a.key('Control+c', '\x03')
    }
  })
  await h.case('CLI-UI03-repeat-release-and-pressure-five-trials', async () => {
    await a.output('\x1b[>2u', 2)
    for (let trial = 0; trial < TRIALS; trial++) {
      await a.key('Control+c', '\x03\x1b[99;5:3u')
      await a.key('Shift+Enter', '\x1b[13;2u\x1b[13;2:3u')
    }
    await a.output('\x1b[<u', 0)
    await a.output('\x1b[>3u', 3)
    for (let trial = 0; trial < TRIALS; trial++) {
      await a.focus()
      await h.page.keyboard.down('Control')
      await h.page.keyboard.down('c')
      await h.page.keyboard.down('c')
      await h.page.keyboard.up('Control')
      await h.page.keyboard.up('c')
      a.expected += '\x1b[99;5u\x1b[99;5:2u\x1b[99;1:3u'
      for (let index = 0; index < 20; index++) await h.page.keyboard.press('Shift+Enter')
      a.expected += '\x1b[13;2u\x1b[13;2:3u'.repeat(20)
      await a.check(); await b.check()
    }
    await a.output('\x1b[<u', 0)
  })
  await h.case('CLI-UI04-keyboard-context-native-paste-five-trials', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const text = `paste-${trial}\nnext`
      await h.page.evaluate(text => window.electronAPI.clipboard.writeText(text), text)
      await a.key(process.platform === 'darwin' ? 'Meta+v' : 'Control+v', `\x1b[200~paste-${trial}\rnext\x1b[201~`)
      await h.page.locator(`.terminal-grid-cell[data-terminal-id="${a.id}"] .xterm-screen`).click({ button: 'right' })
      await h.page.locator('.terminal-context-menu').getByText('Paste', { exact: true }).click()
      a.expected += `\x1b[200~paste-${trial}\rnext\x1b[201~`
      await a.check()
      await a.focus()
      await h.page.evaluate(() => {
        const data = new DataTransfer()
        data.setData('text/plain', 'native')
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
      })
      a.expected += '\x1b[200~native\x1b[201~'
      await a.check(); await b.check()
    }
    const image = path.join(h.workspace, 'clipboard.png')
    await cp(path.join(REPO_ROOT, 'test/autotest/fixtures/cli-shortcut-compatibility/clipboard.png'), image)
    const helper = path.join(REPO_ROOT, 'test/autotest/cli-write-clipboard.cjs')
    const helperEnv = { ...process.env }
    delete helperEnv.ELECTRON_RUN_AS_NODE
    const writer = spawn(require('electron'), [helper, image, `--user-data-dir=${path.join(h.scratch, 'clipboard-writer')}`],
      { cwd: h.workspace, env: helperEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let diagnostic = ''
    writer.stderr.on('data', chunk => { diagnostic += chunk.toString() })
    const exited = new Promise(resolve => {
      writer.once('exit', (code, signal) => resolve({ code, signal }))
      writer.once('error', error => resolve({ error: String(error) }))
    })
    clipboardWriter = writer
    clipboardExit = exited
    try {
      await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error(`Clipboard helper startup: ${diagnostic}`)), 15000)
        writer.once('error', error => { clearTimeout(timer); reject(error) })
        writer.once('exit', () => { clearTimeout(timer); reject(new Error(`Clipboard helper exited: ${diagnostic}`)) })
        writer.stdout.on('data', chunk => {
          output += chunk.toString()
          if (output.includes('CLIPBOARD_READY')) { clearTimeout(timer); resolve() }
        })
      })
      assert.deepEqual(await h.page.evaluate(() => window.electronAPI.clipboard.readTerminal()), { kind: 'image' })
      await h.page.bringToFront()
      for (let trial = 0; trial < TRIALS; trial++) {
        await a.key(process.platform === 'darwin' ? 'Meta+v' : 'Control+v', '\x16')
        await h.page.locator(`.terminal-grid-cell[data-terminal-id="${a.id}"] .xterm-screen`).click({ button: 'right' })
        await h.page.locator('.terminal-context-menu').getByText('Paste', { exact: true }).click()
        a.expected += '\x16'
        await a.check(); await b.check()
        await a.focus()
        await h.page.evaluate(() => document.activeElement.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true, cancelable: true, clipboardData: new DataTransfer()
        })))
        a.expected += '\x16'
        await a.check()
      }
    } finally {
      writer.stdin.end()
      const result = await exited
      clipboardWriter = undefined
      clipboardExit = undefined
      assert.deepEqual(result, { code: 0, signal: null }, diagnostic)
    }
    await h.page.evaluate(() => window.electronAPI.clipboard.writeText(''))
  })
  await h.case('CLI-UI05-ris-recovery-and-clean-exit', async () => {
    await a.output('\x1b[>7u\x1bc', 0)
    await a.key('Shift+Enter', '\r')
    await a.command('stop'); await b.command('stop')
    await h.page.waitForFunction(ids => ids.every(id => window.__onwardTerminalDebug.getSessionState(id)?.status === 'idle'), [a.id, b.id])
    await h.openSettings('general')
    await h.page.getByTestId('settings-terminal-option-meta').check()
    await saveSettingsPage(h.page)
    await h.stop(true)
    await h.start()
    await h.openSettings('general')
    assert.equal(await h.page.getByTestId('settings-terminal-option-meta').isChecked(), true)
    await h.stop(true)
  })
  await h.case('CLI-UI06-diagnostic-trace-evidence', async () => {
    const { events } = validateTraceFiles(selectNewTraceFiles(traceDir, before))
    for (const name of ['renderer:terminal.keyboard-protocol', 'renderer:terminal.keyboard-batch',
      'renderer:terminal.clipboard', 'main:terminal.clipboard-read', 'renderer:terminal.keyboard-settings']) {
      assert(events.some(event => event.name === name), `Missing trace: ${name}`)
    }
    assert(events.some(event => event.name === 'renderer:terminal.keyboard-settings'
      && event.args?.reason === 'applied' && event.args?.macOptionIsMeta === true), 'Saved preference reaches live sessions')
    for (const reason of ['installed', 'query-replied', 'mode-command', 'buffer-switched', 'ris', 'pty-exited']) {
      assert(events.some(event => event.name === 'renderer:terminal.keyboard-protocol' && event.args?.reason === reason), reason)
    }
    for (const entry of ['keyboard', 'context', 'native']) {
      if (process.platform === 'darwin' && entry === 'keyboard') continue
      assert(events.some(event => event.name === 'renderer:terminal.clipboard'
        && event.args?.entry === entry && event.args?.reason === 'image'), `Image trigger trace: ${entry}`)
    }
    const trace = path.join(traceDir, 'cli-shortcut-compatibility-validation.json')
    await writeFile(trace, JSON.stringify({ traceEvents: events }))
    return { events: events.length, trace }
  })
}
let failure, rejectAbort, signalError
const abort = new Promise((_, reject) => { rejectAbort = reject })
void abort.catch(() => {})
const interrupted = signal => { h.cancelled = true; signalError ??= new Error(signal); rejectAbort(signalError) }
const onSigint = () => interrupted('SIGINT'), onSigterm = () => interrupted('SIGTERM')
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)
const deadline = setTimeout(() => interrupted('210s work deadline'), 210000)
try { await h.initialize(); await Promise.race([run(), abort]) }
catch (error) { failure = error; if (h.page) await h.screenshot('failure').catch(() => {}) }
finally {
  clearTimeout(deadline)
  if (clipboardWriter) {
    clipboardWriter.stdin.end()
    await clipboardExit
  }
  process.exitCode = await h.finish(failure ?? signalError)
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}
