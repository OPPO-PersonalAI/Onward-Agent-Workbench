/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const COMPILED = new Map()
const PLATFORMS = ['darwin', 'win32', 'linux']
const rejected = { ok: false, phase: 'content', contentDelivered: false, reason: 'invalid-input' }
const payload = (content, terminalKey = 'Enter', includePrompt = true) => ({ content, terminalKey, includePrompt })

/** Load the actual IPC handlers, controller, PTY manager and shared contracts. */
function harness(t, platform) {
  const handlers = new Map()
  const traces = []
  const timers = new Map()
  const records = new Map()
  const owned = new Set(['owned'])
  const env = {}
  const nativeContents = new Map()
  let focusedContents = null
  let now = 1000
  let nextTimer = 0
  class Clock extends Date { static now() { return now } }
  const forbidden = () => { throw new Error('Unit test crossed a native or filesystem boundary') }
  const app = Object.assign(new EventEmitter(), { getPath: forbidden })
  const trace = {
    record: (name, data) => traces.push({ name, data }),
    recordComplete: (name, _start, data) => traces.push({ name, data, phase: 'X' }),
    nowUs: () => now * 1000, summarizeText: () => ({}), markTaskRunning() {}, markTaskIdle() {}
  }
  const boundaries = new Map([
    ['electron', { app, webContents: {
      getFocusedWebContents: () => focusedContents,
      fromId: id => nativeContents.get(id)
    }, ipcMain: {
      handle(name, callback) { assert(!handlers.has(name)); handlers.set(name, callback) },
      removeHandler: name => handlers.delete(name)
    } }],
    ['node-pty', { spawn: forbidden }], ['path', path],
    ['os', { platform: () => platform, homedir: forbidden, tmpdir: forbidden }],
    ['child_process', { execFileSync: forbidden }],
    ['fs', { existsSync: forbidden, mkdirSync: forbidden, writeFileSync: forbidden }],
    [path.join(ROOT, 'electron/main/performance-trace.ts'), { performanceTrace: trace }],
    [path.join(ROOT, 'electron/main/api-server.ts'), { getApiPort: forbidden }],
    ...['terminal-env', 'terminal-cwd-validation', 'powershell-inline-integration', 'process-table', 'quit-activity'].map(name => [path.join(ROOT, `electron/main/${name}.ts`), {}])
  ])
  const modules = new Map()
  function load(filename) {
    if (boundaries.has(filename)) return boundaries.get(filename)
    if (modules.has(filename)) return modules.get(filename).exports
    if (!COMPILED.has(filename)) COMPILED.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText)
    const module = { exports: {} }
    modules.set(filename, module)
    const require = specifier => {
      if (boundaries.has(specifier)) return boundaries.get(specifier)
      assert(specifier.startsWith('.'), `Unexpected native dependency: ${specifier}`)
      const resolved = path.resolve(path.dirname(filename), specifier)
      return load(existsSync(resolved) ? resolved : `${resolved}.ts`)
    }
    new Function('require', 'module', 'exports', 'process', 'Date', 'setTimeout', 'clearTimeout', 'console', COMPILED.get(filename))(
      require, module, module.exports, { platform, env }, Clock,
      (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id },
      id => timers.delete(id), { ...console, warn() {} }
    )
    return module.exports
  }
  const { ptyManager: manager, scanPromptBracketedPasteMode } = load(path.join(ROOT, 'electron/main/pty-manager.ts'))
  const { promptInputShortcuts: controller } = load(path.join(ROOT, 'electron/main/prompt-input-shortcuts.ts'))
  const { IPC } = load(path.join(ROOT, 'electron/shared/ipc-channels.ts'))
  const core = load(path.join(ROOT, 'src/utils/prompt-input.ts'))
  const api = load(path.join(ROOT, 'electron/main/prompt-input-handlers.ts'))
  const contents = Object.assign(new EventEmitter(), {
    id: 1, mainFrame: {}, sent: [], inputs: [], ignoreMenu: false, destroyed: false,
    isDestroyed() { return this.destroyed }, send(channel, event) { this.sent.push({ channel, event }) },
    isFocused() { return focusedContents === this }, sendInputEvent(input) { this.inputs.push(input) },
    setIgnoreMenuShortcuts(value) { this.ignoreMenu = value }
  })
  focusedContents = contents
  nativeContents.set(contents.id, contents)
  const window = Object.assign(new EventEmitter(), {
    id: 7, webContents: contents, destroyed: false,
    isDestroyed() { return this.destroyed }, isFocused: () => true
  })
  const settings = core.createDefaultPromptInputSettings()
  settings.leader = 'Control+Space'
  controller.init(window, settings, id => owned.has(id) && manager.hasLiveTerminal(id))
  const context = { tabId: 'tab', visibleTerminalIds: ['owned'], activeTerminalId: 'owned', blocked: false }
  const event = { sender: contents, senderFrame: contents.mainFrame }
  api.registerPromptInputHandlers(window, id => owned.has(id) && manager.hasLiveTerminal(id), id => records.get(id)?.bracketed === true)
  function add(id, bracketed = true) {
    const writes = []
    const record = {
      pty: { write(value) { record.beforeWrite?.(value); writes.push(Buffer.from(value, 'utf8')) }, kill() {} },
      writes, bracketed, externalDisposables: [], exitDisposable: { dispose() {} },
      exitPromise: new Promise(() => {}), exited: false, disposed: false,
      writeQueue: Promise.resolve(), queuedWrites: 0, inputWaits: new Set()
    }
    records.set(id, record)
    manager.instances.set(id, record)
    return record
  }
  const receiver = add('owned')
  add('foreign')
  const invoke = async (channel, args = [], sender = event) => handlers.get(channel)(sender, ...args)
  async function settle(promise) {
    let done = false
    let value
    let failure
    promise.then(result => { value = result; done = true }, error => { failure = error; done = true })
    for (let turn = 0; turn < 100 && !done; turn += 1) {
      for (let microtask = 0; microtask < 16; microtask += 1) await Promise.resolve()
      if (done) break
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (next) { timers.delete(next[0]); now = next[1].at; next[1].callback() }
    }
    assert(done, 'Real handler/transaction must settle under deterministic time')
    if (failure) throw failure
    return value
  }
  const send = (value, id = 'owned', sender = event) => settle(invoke(IPC.PROMPT_INPUT_SEND, [id, value], sender))
  t.after(() => {
    api.cleanupPromptInputHandlers()
    manager.disposeAll()
    assert.equal(handlers.size, 0)
    assert.equal(timers.size, 0)
    assert.equal(contents.eventNames().length, 0)
    assert.equal(window.eventNames().length, 0)
    assert.equal(contents.ignoreMenu, false)
    assert.equal(app.eventNames().length, 0)
    for (const record of records.values()) {
      assert.equal(record.queuedWrites, 0)
      assert.equal(record.inputWaits.size, 0)
    }
  })
  return { api, manager, controller, receiver, records, event, window, contents, owned, context, env, nativeContents,
    IPC, invoke, send, settle, timers, traces, scanPromptBracketedPasteMode, bytes: () => Buffer.concat(receiver.writes) }
}

for (const platform of PLATFORMS) {
  test(`PIH-U01 ${platform}: guest/subframe/foreign/dead target sends reject before any bytes`, async t => {
    const h = harness(t, platform)
    for (const sender of [{ sender: {}, senderFrame: h.event.senderFrame }, { sender: h.contents, senderFrame: {} }]) {
      assert.deepEqual(await h.send(payload('valid'), 'owned', sender), rejected)
    }
    assert.equal((await h.send(payload('valid'), 'foreign')).reason, 'unavailable')
    assert.equal((await h.send(payload('valid'), 'missing')).reason, 'unavailable')
    h.receiver.exited = true
    assert.equal((await h.send(payload('valid'))).reason, 'unavailable')
    h.receiver.exited = false
    for (const id of ['', 'x'.repeat(129), 1, null]) assert.deepEqual(await h.send(payload('valid'), id), rejected)
    h.window.destroyed = true
    assert.deepEqual(await h.send(payload('valid')), rejected)
    assert.equal(h.bytes().length, 0)
    assert.equal(Buffer.concat(h.records.get('foreign').writes).length, 0)
  })

  test(`PIH-U02 ${platform}: blank Prompt and malformed payloads reject content AND suffix`, async t => {
    const h = harness(t, platform)
    for (const value of [null, [], {}, payload('', 'Enter'), payload(' \t\n\r\u00a0\u3000', 'Tab'),
      payload('valid', 'Unknown'), payload('valid', 'None', false),
      { ...payload('valid'), content: null }, { ...payload('valid'), includePrompt: 1 }]) {
      assert.deepEqual(await h.send(value), rejected)
      assert.equal(h.bytes().length, 0)
      assert.equal(h.timers.size, 0)
    }
    assert.deepEqual(await h.manager.sendPromptInput('owned', payload(' \r\n '), () => true), rejected,
      'A direct main caller cannot bypass the same text policy')
  })

  test(`PIH-U03 ${platform}: C0/DEL/C1 and paste-frame escapes are rejected without partial writes`, async t => {
    const h = harness(t, platform)
    const controls = [...Array.from({ length: 32 }, (_, value) => value).filter(value => ![9, 10, 13].includes(value)),
      ...Array.from({ length: 33 }, (_, value) => value + 127)]
    for (const code of controls) {
      const content = `before${String.fromCharCode(code)}after`
      assert.deepEqual(await h.send(payload(content)), rejected, `U+${code.toString(16)}`)
      assert.deepEqual(await h.manager.sendPromptInput('owned', payload(content), () => true), rejected)
    }
    for (const content of ['draft\x1b[201~\rexecute', 'draft\x1b[200~', 'draft\u009b201~\nexecute']) {
      assert.deepEqual(await h.send(payload(content, 'Tab')), rejected)
    }
    assert.equal(h.bytes().length, 0)
    assert.equal(h.timers.size, 0)
  })

  test(`PIH-U04 ${platform}: text separators stay exact; key-only ignores any current draft`, async t => {
    const h = harness(t, platform)
    const content = ' left\tright\r\nnext\nlast\rend '
    assert.deepEqual(await h.send(payload(content, 'Tab')), { ok: true, phase: 'complete', contentDelivered: true })
    assert.deepEqual(h.bytes(), Buffer.from('\x1b[200~ left\tright\rnext\rlast\rend \x1b[201~\t'))
    const before = h.bytes()
    for (const ignored of ['', ' \r\n\t', '\x1b[201~\rdo-not-send']) {
      assert.deepEqual(await h.send(payload(ignored, 'Enter', false)), { ok: true, phase: 'complete', contentDelivered: false })
    }
    assert.deepEqual(h.bytes(), Buffer.concat([before, Buffer.from('\r\r\r')]))
  })

  test(`PIH-U05 ${platform}: source validation precedes context changes and suspension ACK is applied`, async t => {
    const h = harness(t, platform)
    const outsider = { sender: {}, senderFrame: h.event.senderFrame }
    await assert.rejects(h.invoke(h.IPC.PROMPT_INPUT_SET_CONTEXT, [h.context], outsider))
    await assert.rejects(h.invoke(h.IPC.PROMPT_INPUT_SET_CONTEXT, [{ ...h.context, visibleTerminalIds: ['owned', 'owned'] }]))
    await h.invoke(h.IPC.PROMPT_INPUT_SET_CONTEXT, [h.context])
    await assert.rejects(h.invoke(h.IPC.PROMPT_INPUT_SUSPEND, [true], outsider))
    await assert.rejects(h.invoke(h.IPC.PROMPT_INPUT_SUSPEND, ['true']))
    await assert.rejects(h.invoke(h.IPC.PROMPT_INPUT_SUSPEND, [true, 'true']))
    await h.invoke(h.IPC.PROMPT_INPUT_SUSPEND, [true])
    assert.equal(h.contents.ignoreMenu, true, 'The acknowledged suspend already suppresses native menus')
    let prevented = false
    assert.equal(h.controller.route(h.contents, { preventDefault() { prevented = true } }, { type: 'keyDown', key: ' ', code: 'Space', control: true }), true)
    assert.equal(prevented, false, 'The recorder still receives the original physical input')
    assert.equal(h.contents.sent.length, 0, 'Recording cannot arm or dispatch a Leader')
    await h.invoke(h.IPC.PROMPT_INPUT_SUSPEND, [true, true])
    assert.equal(h.contents.ignoreMenu, false, 'Text-entry dialogs keep native editing menus')
    assert.equal(h.controller.route(h.contents, { preventDefault() { prevented = true } }, { type: 'keyDown', key: 'a', code: 'KeyA', meta: platform === 'darwin', control: platform !== 'darwin' }), true)
    assert.equal(prevented, false)
    assert.equal(h.contents.sent.length, 0, 'Native editing still skips Onward shortcut dispatch')
    await h.invoke(h.IPC.PROMPT_INPUT_SUSPEND, [false])
    assert.equal(h.contents.ignoreMenu, false)
    h.controller.route(h.contents, { preventDefault() {} }, { type: 'keyDown', key: ' ', code: 'Space', control: true })
    await assert.rejects(h.invoke(h.IPC.PROMPT_INPUT_CANCEL, [null]))
    await h.invoke(h.IPC.PROMPT_INPUT_CANCEL, ['private caller text'])
    assert.equal(h.contents.sent.at(-1).event.reason, 'renderer-cancel')
    assert.equal(h.timers.size, 0)
    assert(!JSON.stringify(h.traces).includes('private caller text'))
    h.controller.route(h.contents, { preventDefault() {} }, { type: 'keyUp', key: ' ', code: 'Space', control: true })
    h.controller.route(h.contents, { preventDefault() {} }, { type: 'keyDown', key: ' ', code: 'Space', control: true })
    await h.invoke(h.IPC.PROMPT_INPUT_CANCEL, ['focus-changed'])
    assert.equal(h.contents.sent.at(-1).event.reason, 'focus-changed')
  })

  test(`PIH-U06 ${platform}: unavailable multiline writes nothing; key failure retains content-delivery evidence`, async t => {
    const h = harness(t, platform)
    h.receiver.bracketed = false
    assert.deepEqual(await h.send(payload('first\nlast')), {
      ok: false, phase: 'content', contentDelivered: false, reason: 'unsafe-multiline-send'
    })
    assert.equal(h.bytes().length, 0)
    h.receiver.beforeWrite = value => { if (value === '\r') throw new Error('Injected suffix failure') }
    const draft = 'private-draft-not-in-trace'
    assert.deepEqual(await h.send(payload(draft)), { ok: false, phase: 'key', contentDelivered: true, reason: 'write-failed' })
    assert.deepEqual(h.bytes(), Buffer.from(draft))
    assert(!JSON.stringify(h.traces).includes(draft))
    assert(h.traces.some(({ phase, data }) => phase === 'X' && data.stage === 'transaction-complete' && data.contentDelivered === true && data.ok === false))
  })

  test(`PIH-U09 ${platform}: invalid generations reject at IPC without replacing or cancelling the armed context`, async t => {
    const h = harness(t, platform)
    await h.invoke(h.IPC.PROMPT_INPUT_SET_CONTEXT, [{ ...h.context, generation: 0 }])
    h.controller.route(h.contents, { preventDefault() {} }, { type: 'keyDown', key: ' ', code: 'Space', control: true })
    h.controller.route(h.contents, { preventDefault() {} }, { type: 'keyUp', key: ' ', code: 'Space', control: true })
    const armed = h.contents.sent.at(-1).event
    assert.equal(armed.kind, 'state')
    assert.equal(armed.generation, 0)
    for (const generation of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
      await assert.rejects(h.invoke(h.IPC.PROMPT_INPUT_SET_CONTEXT, [{ ...h.context, generation }]), /Invalid prompt shortcut request/)
      assert.equal(h.contents.sent.at(-1).event, armed)
      assert.equal(h.timers.size, 1)
      assert.deepEqual(h.traces.at(-1).data, { stage: 'ipc-received', operation: 'set-context', accepted: false })
    }
    await h.invoke(h.IPC.PROMPT_INPUT_SET_CONTEXT, [{ ...h.context, generation: Number.MAX_SAFE_INTEGER }])
    assert.deepEqual(h.contents.sent.at(-1).event, {
      kind: 'cancel', tabId: 'tab', generation: 0, active: false, reason: 'generation-changed'
    })
    assert.equal(h.timers.size, 0)
    h.controller.route(h.contents, { preventDefault() {} }, { type: 'keyDown', key: ' ', code: 'Space', control: true })
    assert.equal(h.contents.sent.at(-1).event.generation, Number.MAX_SAFE_INTEGER)
    await h.invoke(h.IPC.PROMPT_INPUT_CANCEL, ['escape'])
    assert.equal(h.contents.sent.at(-1).event.generation, Number.MAX_SAFE_INTEGER)
  })

  test(`PIH-U10 ${platform}: native key IPC rejects production, guest, subframe and unowned targets`, async t => {
    const h = harness(t, platform)
    const input = { type: 'keyDown', keyCode: 'F6' }
    const invoke = (id, sender = h.event) => h.invoke(h.IPC.DEBUG_SEND_INPUT_EVENT, [input, id], sender)
    assert.equal(await invoke(), false)
    h.env.ONWARD_AUTOTEST = '1'
    assert.equal(await invoke(undefined, { sender: {}, senderFrame: {} }), false)
    assert.equal(await invoke(undefined, { sender: h.contents, senderFrame: {} }), false)
    for (const id of [null, -1, 0, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, 999]) assert.equal(await invoke(id), false)
    const foreign = { id: 999, isDestroyed: () => false, isFocused: () => true,
      sendInputEvent() { assert.fail('An unowned target must never receive input') } }
    h.nativeContents.set(foreign.id, foreign)
    assert.equal(await invoke(foreign.id), false)
    assert.deepEqual(h.contents.inputs, [])
    assert.equal(await invoke(), true)
    assert.equal(await invoke(h.contents.id), true)
    assert.deepEqual(h.contents.inputs, [input, input])
    h.window.destroyed = true
    assert.equal(await invoke(), false)
  })

  test(`PIH-U11 ${platform}: focus readouts are trusted-autotest-only and do not activate or inject input`, async t => {
    const h = harness(t, platform)
    const inspect = (sender = h.event) => h.invoke(h.IPC.DEBUG_GET_INPUT_FOCUS, [], sender)
    assert.equal(await inspect(), null)
    h.env.ONWARD_AUTOTEST = '1'
    assert.equal(await inspect({ sender: {}, senderFrame: {} }), null)
    assert.equal(await inspect({ sender: h.contents, senderFrame: {} }), null)
    assert.deepEqual(await inspect(), { windowFocused: true, contentsFocused: true, focusedContentsId: 1 })
    h.window.isFocused = () => false
    assert.deepEqual(await inspect(), { windowFocused: false, contentsFocused: true, focusedContentsId: 1 })
    assert.deepEqual(h.contents.inputs, [])
    h.window.destroyed = true
    assert.equal(await inspect(), null)
  })

}

test('PIH-U07: IPC size bound counts UTF-16 code units, does not truncate or claim encoded bytes', t => {
  const h = harness(t, 'darwin')
  const maximum = 8 * 1024 * 1024
  const text = 'é'.repeat(maximum)
  assert.equal(text.length, maximum)
  assert.equal(Buffer.byteLength(text, 'utf8'), maximum * 2)
  assert.equal(h.api.isPromptInputPayload(payload(text, 'None')), true)
  assert.equal(h.api.isPromptInputPayload(payload(text + 'x', 'None')), false)
  assert.equal(h.api.isPromptInputPayload(payload('😀'.repeat(maximum / 2), 'None')), true)
})

test('PIH-U08: actual capability scanner preserves stream order, split modes, resets and bounded tails', t => {
  const { scanPromptBracketedPasteMode: scan } = harness(t, 'darwin')
  let state = scan(false, '', '\x1b[?20')
  assert.equal(state.enabled, false)
  state = scan(state.enabled, state.carry, '04h')
  assert.equal(state.enabled, true)
  assert.equal(scan(true, '', '\x1b[?2004l\x1b[?2004h').enabled, true)
  assert.equal(scan(false, '', '\x1b[?2004h\x1b[?2004l').enabled, false)
  assert.equal(scan(false, '', '\x1b[?1;2004h').enabled, true)
  assert.equal(scan(true, '', '\x1bc').enabled, false)
  assert.equal(scan(true, '', '\x1b[!p').enabled, false)
  state = scan(true, '', '\x1b[?200')
  assert.equal(scan(state.enabled, state.carry, '4l').enabled, false)
  assert.equal(scan(false, '', '\x1b[?12004h').enabled, false)
  state = scan(false, '', 'x'.repeat(10000))
  assert(state.carry.length <= 64)
  assert.equal(scan(state.enabled, state.carry, '\x1b[?2004h').enabled, true)
})

test('PIH-U16: real preload focus bridge gates zero-argument IPC behind autotest mode', async () => {
  const filename = path.join(ROOT, 'electron/preload/index.ts')
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  let expression
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'getInputFocus') expression = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert(expression, 'The actual preload bridge must exist')
  const output = ts.transpileModule(`const bridge = ${expression.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls = []
  const reply = Promise.resolve({ windowFocused: true })
  const load = enabled => new Function('debugAutotestEnabled', 'ipcRenderer', 'IPC', `${output}\nreturn bridge`)(
    enabled, { invoke: (...args) => { calls.push(args); return reply } }, { DEBUG_GET_INPUT_FOCUS: 'focus' })
  assert.equal(await load(false)(), null)
  assert.deepEqual(calls, [])
  const bridge = load(true)
  assert.equal(bridge(), reply)
  assert.deepEqual(calls, [['focus']])
})
