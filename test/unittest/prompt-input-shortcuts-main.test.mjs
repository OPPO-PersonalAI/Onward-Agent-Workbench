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

/** The real controller/core run unchanged; only time, native contents and trace IO are mocked. */
function harness(t, platform = 'darwin', configure = () => {}) {
  let now = 1000
  let nextTimer = 0
  let stringifyCalls = 0
  const timers = new Map()
  const traces = []
  const modules = new Map()
  const env = {}
  class Clock extends Date { static now() { return now } }
  const json = { ...JSON, stringify(...args) { stringifyCalls += 1; return JSON.stringify(...args) } }
  const tracePath = path.join(ROOT, 'electron/main/performance-trace.ts')
  function load(filename) {
    if (filename === tracePath) return { performanceTrace: { record: (name, data) => traces.push({ name, data }) } }
    if (modules.has(filename)) return modules.get(filename).exports
    if (!COMPILED.has(filename)) COMPILED.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText)
    const module = { exports: {} }
    modules.set(filename, module)
    const require = specifier => {
      assert(specifier.startsWith('.'), `Unexpected native dependency: ${specifier}`)
      const resolved = path.resolve(path.dirname(filename), specifier)
      return load(existsSync(resolved) ? resolved : `${resolved}.ts`)
    }
    new Function('require', 'module', 'exports', 'process', 'Date', 'JSON', 'setTimeout', 'clearTimeout', COMPILED.get(filename))(
      require, module, module.exports, { platform, env }, Clock, json,
      (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id },
      id => timers.delete(id)
    )
    return module.exports
  }
  class Contents extends EventEmitter {
    constructor(id) { super(); this.id = id; this.sent = []; this.inputs = []; this.focused = true; this.destroyed = false; this.ignoreMenu = false }
    isDestroyed() { return this.destroyed }
    isFocused() { return this.focused }
    send(channel, event) { this.sent.push({ channel, event }) }
    sendInputEvent(input) { this.inputs.push(input) }
    setIgnoreMenuShortcuts(value) { assert(!this.destroyed); this.ignoreMenu = value }
    destroy() { this.destroyed = true; this.emit('destroyed') }
  }
  const host = new Contents(1)
  const guest = new Contents(2)
  const html = new Contents(3)
  const window = Object.assign(new EventEmitter(), {
    webContents: host, focused: true, destroyed: false,
    isFocused() { return this.focused }, isDestroyed() { return this.destroyed }
  })
  const { PromptInputShortcuts, isPromptShortcutContext } = load(path.join(ROOT, 'electron/main/prompt-input-shortcuts.ts'))
  const core = load(path.join(ROOT, 'src/utils/prompt-input.ts'))
  const settings = core.createDefaultPromptInputSettings()
  settings.targetModifier = null
  settings.leader = 'Control+Space'
  configure(settings)
  const owned = new Set(['a', 'b'])
  const controller = new PromptInputShortcuts()
  controller.init(window, settings, id => owned.has(id))
  controller.attach(guest)
  controller.attach(html)
  const context = { tabId: 'tab', visibleTerminalIds: ['a', 'b'], activeTerminalId: 'a', blocked: false }
  controller.setContext(context)
  const contents = [host, guest, html]
  t.after(() => {
    controller.dispose()
    assert.equal(timers.size, 0, 'Leader timers must be released')
    assert.equal(window.eventNames().length, 0, 'Window listeners must be released')
    for (const source of contents) {
      assert.equal(source.eventNames().length, 0, `Contents ${source.id} listeners must be released`)
      if (!source.destroyed) assert.equal(source.ignoreMenu, false, `Contents ${source.id} menu suppression must be released`)
    }
  })
  function input(source, key, options = {}) {
    let prevented = false
    const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === ' ' ? 'Space' : key
    const skip = controller.route(source, { preventDefault() { prevented = true } }, {
      type: 'keyDown', key, code, isAutoRepeat: false, isComposing: false,
      control: false, meta: false, alt: false, shift: false, modifiers: [], ...options
    })
    return { skip, prevented }
  }
  const press = (source, key, options = {}) => {
    const result = input(source, key, options)
    input(source, key, { ...options, type: 'keyUp' })
    return result
  }
  const leader = source => press(source, ' ', { control: true })
  const events = () => host.sent.map(({ event }) => event)
  const last = () => events().at(-1)
  const elapse = (ms, deliver = true) => {
    now += ms
    if (!deliver) return
    for (const [id, timer] of timers) {
      if (timer.at > now) continue
      timers.delete(id)
      timer.callback()
    }
  }
  return { controller, host, guest, html, window, context, settings, owned, traces, timers, env,
    input, press, leader, events, last, elapse, isPromptShortcutContext, stringifyCalls: () => stringifyCalls }
}

for (const platform of PLATFORMS) {
  test(`PIMS-U22 ${platform}: held selector down/up is owned, publishes cues and sends exactly once on host and guests`, t => {
    const h = harness(t, platform, settings => { settings.targetModifier = 'Alt' })
    for (const source of [h.host, h.guest, h.html]) for (let trial = 0; trial < 5; trial++) {
      h.leader(source)
      const deadline = [...h.timers.values()][0].at
      assert.deepEqual(h.input(source, 'Alt', { alt: true }), { skip: true, prevented: false })
      assert.equal(h.last().selecting, true)
      assert.equal([...h.timers.values()][0].at, deadline)
      h.press(source, '2', { alt: true })
      assert.equal(h.last().targetId, 'b')
      assert.equal(h.last().selecting, false, 'Selection retires the map even if Chromium drops the release')
      h.input(source, '2', { alt: true, isAutoRepeat: true })
      assert.deepEqual(h.input(source, 'Alt', { type: 'keyUp', alt: true }), { skip: true, prevented: false })
      assert.equal(h.last().selecting, false)
      assert.equal(h.last().targetId, 'b')
      h.press(source, 'q')
      assert.equal(h.last().kind, 'dispatch')
      assert.equal(h.last().targetId, 'b')
      assert.equal(h.timers.size, 0)
    }
    assert.equal(h.events().filter(event => event.kind === 'dispatch').length, 15)
  })

  test(`PIMS-U23 ${platform}: modifier-only timeout, blur, AltGr and missing release cannot revive targeting`, t => {
    const h = harness(t, platform, settings => { settings.targetModifier = 'Alt' })
    h.leader(h.host)
    h.input(h.host, 'Alt', { alt: true })
    h.elapse(1500, false)
    h.input(h.host, 'Alt', { type: 'keyUp' })
    assert.equal(h.last().reason, 'timeout')
    assert.equal(h.timers.size, 0)
    h.leader(h.host)
    h.input(h.host, 'Alt', { alt: true })
    h.window.emit('blur')
    assert.equal(h.last().reason, 'blur')
    h.leader(h.host)
    h.press(h.host, '2')
    assert.equal(h.last().reason, 'unmatched', 'A missing Alt release must not turn bare 2 into a selector')
    h.leader(h.host)
    h.input(h.host, 'AltGraph', { alt: true, control: true })
    assert.equal(h.last().reason, 'altgr')
    h.leader(h.host)
    h.press(h.host, '2', { control: true, alt: true })
    assert.equal(h.last().reason, 'unmatched', 'Control+Alt never matches exact Alt targeting')
    assert.equal(h.events().filter(event => event.kind === 'dispatch').length, 0)
  })

  test(`PIMS-U24 ${platform}: Leader sharing the selector modifier and other modifier releases reconcile the cue`, t => {
    const h = harness(t, platform, settings => { settings.targetModifier = 'Control' })
    h.input(h.host, 'Control', { control: true })
    h.press(h.host, ' ', { control: true })
    assert.equal(Boolean(h.last().selecting), false, 'Leader modifiers cannot leave a cue stuck when their release is suppressed')
    h.input(h.host, 'Shift', { control: true, shift: true })
    assert.equal(Boolean(h.last().selecting), false)
    h.input(h.host, 'Shift', { type: 'keyUp', control: true, shift: true })
    assert.equal(h.last().selecting, true)
    h.press(h.host, '2', { control: true })
    h.input(h.host, 'Control', { type: 'keyUp', control: true })
    assert.equal(h.last().selecting, false)
    h.press(h.host, 'q')
    assert.equal(h.last().targetId, 'b')
  })

  test(`PIMS-U01 ${platform}: disabled Leader and unfocused window keep native input`, t => {
    const h = harness(t, platform, settings => { settings.leader = null })
    assert.deepEqual(h.leader(h.host), { skip: false, prevented: false })
    assert.equal(h.events().length, 0)
    h.controller.updateSettings({ ...h.settings, leader: 'Control+Space' })
    h.window.focused = false
    assert.deepEqual(h.leader(h.guest), { skip: false, prevented: false })
    assert.equal(h.events().length, 0)
  })

  test(`PIMS-U02 ${platform}: host, browser and HTML dispatch once, including hidden actions`, t => {
    const h = harness(t, platform, settings => { settings.actions.find(action => action.id === 'queue').visible = false })
    for (const source of [h.host, h.guest, h.html]) {
      for (let trial = 0; trial < 5; trial += 1) {
        assert.deepEqual(h.leader(source), { skip: true, prevented: true })
        assert.deepEqual(h.press(source, 'q'), { skip: true, prevented: true })
        assert.equal(h.last().kind, 'dispatch')
        assert.equal(h.last().actionId, 'queue')
        assert.equal(h.timers.size, 0)
      }
    }
    assert.equal(h.events().filter(event => event.kind === 'dispatch').length, 15)
    assert(h.traces.some(({ data }) => data.kind === 'dispatch' && data.contentsId === h.html.id))
  })

  test(`PIMS-U03 ${platform}: slot selection locks identity and never retargets on reorder/removal`, t => {
    const h = harness(t, platform)
    h.leader(h.host); h.press(h.host, '2')
    h.controller.setContext({ ...h.context, visibleTerminalIds: ['b', 'a'] })
    h.press(h.host, 'q')
    assert.equal(h.last().targetId, 'b')
    h.leader(h.host); h.press(h.host, '1')
    h.controller.setContext({ ...h.context, visibleTerminalIds: ['a'] })
    assert.equal(h.last().reason, 'target-unavailable')
    assert.deepEqual(h.press(h.host, 'q'), { skip: false, prevented: false })
    h.leader(h.host); h.press(h.host, '1'); h.press(h.host, 'a')
    assert.equal(h.last().reason, 'target-conflict')
    h.leader(h.host); h.press(h.host, '8')
    assert.equal(h.last().reason, 'target-unavailable')
    h.leader(h.host); h.press(h.host, '1'); h.owned.delete('a'); h.press(h.host, 'q')
    assert.equal(h.last().reason, 'target-unavailable')
  })

  test(`PIMS-U04 ${platform}: L L passes only the second physical stroke on its original owner`, t => {
    const h = harness(t, platform)
    for (const source of [h.host, h.guest, h.html]) {
      h.leader(source)
      assert.deepEqual(h.input(source, ' ', { control: true }), { skip: true, prevented: false })
      assert.equal(h.last().kind, 'passthrough')
      assert.equal(source.ignoreMenu, true)
      h.input(source, ' ', { type: 'keyUp', control: true })
      assert.equal(source.ignoreMenu, false)
    }
    assert.equal(h.events().filter(event => event.kind === 'passthrough').length, 3)
    assert.equal(h.events().filter(event => event.kind === 'dispatch').length, 0)
  })

  test(`PIMS-U05 ${platform}: a missing blur cannot transfer a chord to different contents`, t => {
    const h = harness(t, platform)
    for (const key of ['q', '2', ' ']) {
      h.leader(h.guest)
      assert.deepEqual(h.press(h.html, key, { control: key === ' ' }), { skip: false, prevented: false })
      assert.equal(h.last().reason, 'owner-changed')
      assert.equal(h.timers.size, 0)
      assert.deepEqual(h.press(h.guest, 'q'), { skip: false, prevented: false })
    }
    assert.equal(h.events().filter(event => ['dispatch', 'passthrough'].includes(event.kind)).length, 0)
    h.leader(h.html); h.press(h.html, 'q')
    assert.equal(h.last().kind, 'dispatch', 'A new physical Leader can arm the new owner')
  })

  test(`PIMS-U06 ${platform}: only top-level owner navigation cancels; reload drops old context`, t => {
    const h = harness(t, platform)
    for (const source of [h.guest, h.html]) {
      h.leader(source)
      source.emit('did-start-navigation', {}, 'https://example.test/frame', false, false)
      source.emit('did-start-navigation', {}, 'https://example.test/#anchor', true, true)
      assert.equal(h.last().kind, 'state')
      source.emit('did-start-navigation', {}, 'https://example.test/new-page', false, true)
      assert.equal(h.last().reason, 'owner-navigated')
      assert.equal(h.timers.size, 0)
      assert.deepEqual(h.press(source, 'q'), { skip: false, prevented: false })
    }
    h.leader(h.host)
    h.guest.emit('did-start-navigation', {}, 'https://example.test/background', false, true)
    h.press(h.host, 'q')
    assert.equal(h.last().kind, 'dispatch')
    h.leader(h.host)
    h.host.emit('did-start-navigation', {}, 'about:blank', false, true)
    assert.equal(h.last().reason, 'reload')
    assert.deepEqual(h.leader(h.host), { skip: false, prevented: false })
    h.controller.setContext(h.context)
    assert.equal(h.leader(h.host).prevented, true)
  })

  test(`PIMS-U07 ${platform}: escape/unmatched consume; modifier strokes do not extend timeout`, t => {
    const h = harness(t, platform)
    for (const key of ['Escape', '#', '漢']) {
      h.leader(h.host)
      assert.deepEqual(h.press(h.host, key), { skip: true, prevented: true })
      assert.equal(h.last().reason, key === 'Escape' ? 'escape' : 'unmatched')
    }
    h.leader(h.host)
    const deadline = [...h.timers.values()][0].at
    for (const key of ['Control', 'Meta', 'Alt', 'Shift']) {
      assert.deepEqual(h.press(h.host, key), { skip: false, prevented: false })
      assert.equal([...h.timers.values()][0].at, deadline)
    }
    h.elapse(1500)
    assert.equal(h.last().reason, 'timeout')
    assert.deepEqual(h.press(h.host, 'q'), { skip: false, prevented: false })
  })

  test(`PIMS-U08 ${platform}: held keys never dispatch twice, rearm or extend an expired sequence`, t => {
    const h = harness(t, platform)
    h.input(h.host, ' ', { control: true })
    h.elapse(1501, false)
    assert.equal(h.input(h.host, ' ', { control: true, isAutoRepeat: true }).prevented, true)
    assert.equal(h.last().reason, 'timeout', 'A delayed timer cannot hide expiry behind the repeat fast path')
    assert.equal(h.timers.size, 0)
    h.input(h.host, ' ', { type: 'keyUp', control: true })
    h.leader(h.host)
    h.input(h.host, 'q')
    for (let trial = 0; trial < 5; trial += 1) assert.equal(h.input(h.host, 'q', { isAutoRepeat: true }).prevented, true)
    assert.equal(h.events().filter(event => event.kind === 'dispatch').length, 1)
    h.input(h.host, 'q', { type: 'keyUp' })
  })

  test(`PIMS-U09 ${platform}: composition, legacy 229 and explicit AltGr never become action strokes`, t => {
    const h = harness(t, platform)
    for (const [key, extra, reason] of [
      ['Process', {}, 'ime'], ['Dead', {}, 'ime'], ['Unidentified', {}, 'ime'],
      ['q', { isComposing: true }, 'ime'], ['q', { keyCode: 229 }, 'ime'],
      ['AltGraph', {}, 'altgr'], ['q', { control: true, alt: true, modifiers: ['altgr'] }, 'altgr']
    ]) {
      h.leader(h.host)
      assert.deepEqual(h.press(h.host, key, extra), { skip: true, prevented: false })
      assert.equal(h.last().reason, reason)
      assert.equal(h.timers.size, 0)
    }
    assert.equal(h.events().filter(event => event.kind === 'dispatch').length, 0)
  })

  test(`PIMS-U10 ${platform}: recording, tab/block changes, blur and destruction leave no stale state`, t => {
    const h = harness(t, platform)
    h.leader(h.host); h.controller.suspend(true)
    assert.equal(h.last().reason, 'recording')
    for (const source of [h.host, h.guest, h.html]) {
      assert.equal(source.ignoreMenu, true)
      assert.deepEqual(h.press(source, 'q'), { skip: true, prevented: false })
    }
    h.window.emit('blur')
    assert.equal(h.host.ignoreMenu, false)
    h.leader(h.host); h.controller.setContext({ ...h.context, tabId: 'next' })
    assert.equal(h.last().reason, 'tab-changed')
    h.leader(h.host); h.controller.setContext({ ...h.context, tabId: 'next', blocked: true })
    assert.equal(h.last().reason, 'blocked')
    h.controller.setContext(h.context)
    h.leader(h.guest); h.guest.emit('blur'); assert.equal(h.last().reason, 'contents-blur')
    h.leader(h.html); h.html.destroy(); assert.equal(h.last().reason, 'contents-destroyed')
    h.leader(h.host); h.host.emit('render-process-gone'); assert.equal(h.last().reason, 'renderer-gone')
    assert.equal(h.timers.size, 0)
    assert.deepEqual(h.leader(h.host), { skip: false, prevented: false })
  })

  test(`PIMS-U21 ${platform}: text-input suspension preserves native menus while recorders retain raw keys`, t => {
    const h = harness(t, platform)
    for (let trial = 0; trial < 5; trial++) {
      h.controller.suspend(true, true)
      for (const source of [h.host, h.guest, h.html]) {
        assert.equal(source.ignoreMenu, false)
        for (const key of ['a', 'c', 'v', 'x', 'z', 'p']) {
          assert.deepEqual(h.press(source, key, { meta: platform === 'darwin', control: platform !== 'darwin' }), { skip: true, prevented: false })
        }
      }
      assert.equal(h.events().filter(event => event.kind === 'dispatch').length, 0)
      h.controller.suspend(true)
      for (const source of [h.host, h.guest, h.html]) assert.equal(source.ignoreMenu, true)
      h.window.emit('blur')
      for (const source of [h.host, h.guest, h.html]) assert.equal(source.ignoreMenu, false)
    }
  })

  test(`PIMS-U11 ${platform}: portable leader resolves locally; physical Control and Meta stay distinct`, t => {
    const h = harness(t, platform, settings => { settings.leader = 'CommandOrControl+Space' })
    const native = platform === 'darwin' ? { meta: true } : { control: true }
    const other = platform === 'darwin' ? { control: true } : { meta: true }
    assert.deepEqual(h.press(h.host, ' ', other), { skip: false, prevented: false })
    assert.equal(h.press(h.host, ' ', native).prevented, true)
    h.press(h.host, '中', { code: 'KeyQ' })
    assert.equal(h.last().actionId, 'queue')
    h.controller.updateSettings({ ...h.settings, leader: 'Control+Plus' })
    assert.equal(h.press(h.host, '+', { code: 'Equal', control: true }).prevented, true)
    h.press(h.host, 'q'); assert.equal(h.last().kind, 'dispatch')
  })

  test(`PIMS-U12 ${platform}: large action lists cause no ordinary-key serialization or trace spam`, t => {
    const h = harness(t, platform, settings => {
      settings.actions.push(...Array.from({ length: 1000 }, (_, index) => ({
        id: `custom-${index}`, name: `Custom ${index}`, visible: true,
        includePrompt: true, terminalKey: 'None', target: 'default', shortcut: null
      })))
    })
    const serialized = h.stringifyCalls()
    const traceCount = h.traces.length
    for (let index = 0; index < 1000; index += 1) assert.equal(h.press(h.host, 'r').skip, false)
    assert.equal(h.stringifyCalls(), serialized)
    assert.equal(h.traces.length, traceCount)
    h.leader(h.host)
    h.controller.updateSettings({ ...h.settings, timeoutMs: 500 })
    assert.equal(h.last().reason, 'settings-changed')
    h.leader(h.host); h.elapse(500); assert.equal(h.last().reason, 'timeout')
    h.controller.dispose(); h.controller.dispose()
  })

  test(`PIMS-U14 ${platform}: destruction during recording releases surviving menus and all listeners`, t => {
    const h = harness(t, platform)
    h.controller.suspend(true)
    h.host.destroy()
    assert.equal(h.guest.ignoreMenu, false)
    assert.equal(h.html.ignoreMenu, false)
    h.window.destroyed = true
    h.window.emit('closed')
    assert.equal(h.timers.size, 0)
    assert.equal(h.window.eventNames().length, 0)
  })

  test(`PIMS-U15 ${platform}: queued events keep A generation 1 after A to B to A generation 3`, t => {
    const h = harness(t, platform)
    h.controller.setContext({ ...h.context, tabId: 'A', generation: 1 })
    h.leader(h.host)
    h.press(h.host, 'q')
    const queued = h.events()
    assert.deepEqual(queued.map(event => [event.kind, event.tabId, event.generation]), [
      ['state', 'A', 1], ['dispatch', 'A', 1]
    ])
    h.leader(h.host)
    h.controller.setContext({ ...h.context, tabId: 'B', generation: 2 })
    const cancellation = h.last()
    assert.deepEqual(cancellation, { kind: 'cancel', tabId: 'A', generation: 1, active: false, reason: 'tab-changed' })
    h.controller.setContext({ ...h.context, tabId: 'A', generation: 3 })
    assert.equal(h.timers.size, 0)
    assert.deepEqual(h.press(h.host, 'q'), { skip: false, prevented: false })
    h.leader(h.host)
    h.press(h.host, 'q')
    assert.equal(h.last().generation, 3)
    assert.equal(h.last().kind, 'dispatch')
    assert(queued.every(event => event.generation === 1), 'Already queued events must retain their original visit identity')
    assert.equal(cancellation.generation, 1)
    assert.deepEqual(h.traces.filter(({ data }) => data.stage === 'context-received' && data.generation !== undefined)
      .map(({ data }) => data.generation), [1, 2, 3])
    assert(h.traces.some(({ data }) => data.stage === 'event-send' && data.kind === 'cancel' && data.generation === 1))
  })

  test(`PIMS-U16 ${platform}: generation changes cancel old chords while same-generation layout changes preserve them`, t => {
    const h = harness(t, platform)
    h.controller.setContext({ ...h.context, generation: 7 })
    h.leader(h.guest)
    h.press(h.guest, '2')
    const eventCount = h.events().length
    h.controller.setContext({ ...h.context, generation: 7, visibleTerminalIds: ['b', 'a'] })
    assert.equal(h.events().length, eventCount)
    assert.equal(h.timers.size, 1)
    h.press(h.guest, 'q')
    assert.equal(h.last().generation, 7)
    assert.equal(h.last().targetId, 'b')
    h.leader(h.html)
    h.controller.setContext({ ...h.context, generation: 8 })
    assert.deepEqual(h.last(), { kind: 'cancel', tabId: 'tab', generation: 7, active: false, reason: 'generation-changed' })
    assert.equal(h.timers.size, 0)
    assert.deepEqual(h.press(h.html, 'q'), { skip: false, prevented: false })
    h.leader(h.html)
    h.elapse(1500)
    assert.deepEqual(h.last(), { kind: 'cancel', tabId: 'tab', generation: 8, active: false, reason: 'timeout' })
  })

  test(`PIMS-U17 ${platform}: optional generations preserve legacy event shapes and stamp zero including passthrough`, t => {
    const h = harness(t, platform)
    h.leader(h.host); h.press(h.host, 'q')
    h.leader(h.host); h.press(h.host, 'Escape')
    h.leader(h.host); h.leader(h.host)
    assert.deepEqual([...new Set(h.events().map(event => event.kind))], ['state', 'dispatch', 'cancel', 'passthrough'])
    assert(h.events().every(event => !Object.hasOwn(event, 'generation')))
    h.leader(h.host)
    h.controller.setContext({ ...h.context, generation: 0 })
    assert.equal(h.last().reason, 'generation-changed')
    assert.equal(Object.hasOwn(h.last(), 'generation'), false, 'The cancelled legacy context must not acquire the new generation')
    const offset = h.events().length
    h.leader(h.host); h.press(h.host, 'q')
    h.leader(h.host); h.press(h.host, 'Escape')
    h.leader(h.host); h.leader(h.host)
    h.leader(h.host)
    h.controller.setContext(h.context)
    assert.equal(h.last().reason, 'generation-changed')
    assert(h.events().slice(offset).every(event => event.generation === 0))
    h.leader(h.host)
    assert.equal(Object.hasOwn(h.last(), 'generation'), false)
    h.press(h.host, 'q')
    assert.equal(Object.hasOwn(h.last(), 'generation'), false)
  })

  test(`PIMS-U18 ${platform}: native test ingress requires autotest mode and a live focused owned surface`, t => {
    const h = harness(t, platform)
    const input = { type: 'keyDown', keyCode: 'F6' }
    assert.equal(h.controller.sendInputEventForAutotest(h.host, input), false)
    h.env.ONWARD_AUTOTEST = '1'
    const foreign = { id: 999, isDestroyed: () => false, isFocused: () => true,
      sendInputEvent() { assert.fail('Foreign contents must never receive input') } }
    assert.equal(h.controller.sendInputEventForAutotest(foreign, input), false)
    h.window.focused = false
    assert.equal(h.controller.sendInputEventForAutotest(h.host, input), false)
    h.window.focused = true
    h.host.focused = false
    assert.equal(h.controller.sendInputEventForAutotest(h.host, input), false)
    h.host.focused = true
    for (const source of [h.host, h.guest, h.html]) {
      assert.equal(h.controller.sendInputEventForAutotest(source, input), true)
      assert.deepEqual(source.inputs, [input])
    }
    h.html.destroy()
    assert.equal(h.controller.sendInputEventForAutotest(h.html, input), false)
    h.controller.dispose()
    assert.equal(h.controller.sendInputEventForAutotest(h.host, input), false)
  })

  test(`PIMS-U19 ${platform}: native input preserves repeat/modifier flags and rejects unsupported DOM overrides`, t => {
    const h = harness(t, platform)
    h.env.ONWARD_AUTOTEST = '1'
    for (const type of ['keyDown', 'rawKeyDown', 'keyUp', 'char']) {
      const input = { type, keyCode: 'q', modifiers: ['control', 'shift', 'isautorepeat'] }
      assert.equal(h.controller.sendInputEventForAutotest(h.host, input), true)
      assert.deepEqual(h.host.inputs.at(-1), input)
      input.modifiers.push('alt')
      assert.deepEqual(h.host.inputs.at(-1).modifiers, ['control', 'shift', 'isautorepeat'])
    }
    const count = h.host.inputs.length
    for (const input of [null, [], {}, { type: 'mouseDown', keyCode: 'q' },
      { type: 'keyDown', keyCode: '' }, { type: 'keyDown', keyCode: 'x'.repeat(65) },
      { type: 'keyDown', keyCode: 'q', modifiers: 'control' },
      { type: 'keyDown', keyCode: 'q', modifiers: Array(17).fill('control') },
      { type: 'keyDown', keyCode: 'q', modifiers: ['unknown'] },
      { type: 'keyDown', keyCode: 'q', key: 'й', code: 'KeyQ' },
      { type: 'keyDown', keyCode: 'q', autoRepeat: true }]) {
      assert.equal(h.controller.sendInputEventForAutotest(h.host, input), false)
    }
    assert.equal(h.host.inputs.length, count)
    h.host.sendInputEvent = () => { throw new Error('Native conversion rejected') }
    assert.equal(h.controller.sendInputEventForAutotest(h.host, { type: 'keyDown', keyCode: 'F6' }), false)
  })

  test(`PIMS-U20 ${platform}: Chromium-suppressed releases never poison a fresh stroke or release another held key`, t => {
    const h = harness(t, platform, settings => { settings.leader = 'F6' })
    const consumed = { skip: true, prevented: true }
    const native = { skip: false, prevented: false }
    for (const source of [h.host, h.guest, h.html]) {
      for (let trial = 0; trial < 5; trial += 1) {
        for (const key of ['z', 'q']) {
          const label = `contents=${source.id}, trial=${trial}, key=${key}`
          // Keep F6 physically held; Chromium omits the consumed continuation's
          // release before Electron's hook, so do not use press() here.
          assert.deepEqual(h.input(source, 'F6'), consumed, label)
          assert.deepEqual(h.input(source, key), consumed, label)
          assert.equal(h.last().kind, key === 'z' ? 'cancel' : 'dispatch', label)
          if (key === 'z') assert.equal(h.last().reason, 'unmatched', label)
          else assert.equal(h.last().actionId, 'queue', label)
          const eventCount = h.events().length
          const traceCount = h.traces.length
          for (let repeat = 0; repeat < 5; repeat += 1) {
            assert.deepEqual(h.input(source, key, { isAutoRepeat: true }), consumed, label)
          }
          assert.equal(h.events().length, eventCount, `Held repeats cannot redispatch: ${label}`)
          assert.equal(h.traces.length, traceCount, `Held repeats cannot retire a release: ${label}`)

          // The old release never reached route(). A new physical press must
          // deliver its whole down/repeat/up cycle without losing F6's state.
          assert.deepEqual(h.input(source, key), native, label)
          assert.deepEqual(h.input(source, 'F6', { isAutoRepeat: true }), consumed, label)
          for (let repeat = 0; repeat < 5; repeat += 1) {
            assert.deepEqual(h.input(source, key, { isAutoRepeat: true }), native, label)
          }
          assert.deepEqual(h.input(source, key, { type: 'keyUp' }), native, label)
          assert.deepEqual(h.input(source, 'F6', { type: 'keyUp' }), consumed, label)
          assert.deepEqual(h.input(source, key), native, label)
          assert.deepEqual(h.input(source, key, { type: 'keyUp' }), native, label)
          assert.equal(h.events().length, eventCount, `Fresh ordinary input cannot redispatch: ${label}`)
          assert.equal(h.timers.size, 0, label)
          assert.deepEqual(h.traces.slice(traceCount), [{
            name: 'main:prompt-shortcut.state-changed',
            data: { stage: 'suppressed-release-retired', remainingCount: 1 }
          }], `Only a real retirement emits a count-only breadcrumb: ${label}`)
        }
      }
    }
  })
}

test('PIMS-U13: context bounds, ownership and copied snapshots protect target identity', t => {
  const h = harness(t)
  for (const invalid of [null, {}, { ...h.context, tabId: 'x'.repeat(129) },
    { ...h.context, blocked: 1 }, { ...h.context, visibleTerminalIds: Array(9).fill('a') },
    { ...h.context, visibleTerminalIds: ['a', 'a'] }, { ...h.context, activeTerminalId: 'foreign' }]) {
    assert.equal(h.isPromptShortcutContext(invalid), false)
  }
  assert.equal(h.isPromptShortcutContext(h.context), true)
  for (const generation of [undefined, 0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(h.isPromptShortcutContext({ ...h.context, generation }), true)
  }
  for (const generation of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true, {}, []]) {
    assert.equal(h.isPromptShortcutContext({ ...h.context, generation }), false)
  }
  const snapshot = { ...h.context, visibleTerminalIds: ['a', 'b'], extra: 'not retained' }
  h.controller.setContext(snapshot)
  snapshot.visibleTerminalIds.reverse()
  h.leader(h.host); h.press(h.host, '1'); h.press(h.host, 'q')
  assert.equal(h.last().targetId, 'a')
  assert.equal('extra' in h.controller.context, false)
  const foreign = Object.assign(new EventEmitter(), { id: 999 })
  assert.deepEqual(h.press(foreign, ' ', { control: true }), { skip: false, prevented: false })
})
