/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as support from '../autotest/themes-ui-driver-support.mjs'
import * as keyboard from '../autotest/native-shortcut-keyboard.mjs'

// Load the actual driver definitions without executing its app-launch entry.
const source = readFileSync(new URL('../autotest/prompt-input-shortcuts-driver.mjs', import.meta.url), 'utf8')
const entry = '\nconst options = args(process.argv.slice(2))\n'
assert.equal(source.split(entry).length, 2)
const compiled = ts.transpileModule(source.split(entry)[0], {
  fileName: 'prompt-input-shortcuts-driver.ts',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText

function harness(platform) {
  const calls = []
  const nativeRequests = []
  const dispatches = []
  let nativeFocused = true
  const forbidden = () => { throw new Error('Unit driver crossed a filesystem/process boundary') }
  const modules = new Map([
    ['node:assert/strict', assert], ['node:path', path], ['node:os', { tmpdir: forbidden }],
    ['node:fs/promises', new Proxy({}, { get: () => forbidden })],
    ['./themes-ui-driver-support.mjs', support], ['./native-shortcut-keyboard.mjs', keyboard]
  ])
  const require = name => { assert(modules.has(name), `Unexpected test dependency: ${name}`); return modules.get(name) }
  const exports = {}
  const { ShortcutHarness, HtmlFrameKeyboard, guestFocus, runShortcutCases, setRunners } = new Function('require', 'module', 'exports', 'process',
    `${compiled}\nreturn { ShortcutHarness, HtmlFrameKeyboard, guestFocus, runShortcutCases,
      setRunners(value) { startup = value.startup; guests = value.guests; traces = value.traces } }`)(
    require, { exports }, exports, { platform, pid: 1 })
  const h = new ShortcutHarness({ group: 'guests', appBin: process.execPath })
  const frame = {}
  const document = { hasFocus: () => true, activeElement: frame, querySelector: () => frame }
  const window = {
    electronAPI: { debug: { getInputFocus(...args) {
      calls.push('native-focus')
      nativeRequests.push(args)
      return { windowFocused: nativeFocused, contentsFocused: nativeFocused, focusedContentsId: nativeFocused ? 1 : null }
    } } },
    __onwardProjectEditorDebug: { evaluateHtmlPreviewForTest() { return { success: true, value: true } } }
  }
  h.page = {
    evaluate: async (callback, ...args) => runInNewContext(`(${callback.toString()})(...args)`, { window, document, args }),
    bringToFront: async () => { calls.push('bring-to-front') },
    frameLocator: () => ({ locator: () => ({ click: async () => { calls.push('click') } }) }),
    waitForFunction: async () => {}
  }
  h.hostCdp = { send: async (method, payload) => {
    assert.equal(method, 'Input.dispatchKeyEvent')
    dispatches.push(structuredClone(payload))
  } }
  h.log = async () => {}
  h.eventAfter = async () => ({ tabId: 'pis-main-tab', kind: 'dispatch' })
  h.eventsSince = async () => [{ kind: 'dispatch' }]
  h.expect = () => {}
  h.checkBytes = async () => {}
  h.idle = async () => {}
  h.history = async () => [{ content: 'fixture', sendHistory: [{}] }]
  return {
    h, keyboard: new HtmlFrameKeyboard(h), guestFocus, runShortcutCases, setRunners, calls, nativeRequests, dispatches,
    setFocused: value => { nativeFocused = value }
  }
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`PIKD-01 ${platform}: guest keyboard sends the ten native messages with only the two boundary focus reads`, async () => {
    const unit = harness(platform)
    const { h } = unit
    await unit.guestFocus(h, 'html')
    await unit.keyboard.press('KeyZ')
    await unit.keyboard.press('Control+KeyX')
    await unit.keyboard.press('KeyQ')
    await h.sent(0, ['pis-task-1'], 'fixture\t', 'fixture', 0)
    await h.guestNativeFocus()
    assert.deepEqual(unit.nativeRequests, [[], []])
    assert.equal(unit.calls.filter(call => call === 'click').length, 1)
    assert.equal(unit.calls.filter(call => call === 'bring-to-front').length, 1)
    assert.equal(unit.dispatches.length, 10)
    assert.equal(unit.keyboard.held.size, 0)
    assert.deepEqual(unit.dispatches.map(event => [event.type, event.code]), [
      ['rawKeyDown', 'KeyZ'], ['char', 'KeyZ'], ['keyUp', 'KeyZ'],
      ['rawKeyDown', 'ControlLeft'], ['rawKeyDown', 'KeyX'], ['keyUp', 'KeyX'], ['keyUp', 'ControlLeft'],
      ['rawKeyDown', 'KeyQ'], ['char', 'KeyQ'], ['keyUp', 'KeyQ']
    ])
  })
}

test('PIKD-02: guest focus readout returns the basic native ownership result', async () => {
  const unit = harness('darwin')
  await unit.guestFocus(unit.h, 'html')
  await unit.keyboard.press('KeyZ')
  assert.deepEqual(await unit.h.guestNativeFocus(), { windowFocused: true, contentsFocused: true, focusedContentsId: 1 })
  assert.deepEqual(unit.nativeRequests, [[], []])
})

test('PIKD-03: guest preparation rejects missing native ownership before keyboard dispatch', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const unit = harness(platform)
    unit.setFocused(false)
    await assert.rejects(unit.guestFocus(unit.h, 'html'), /guest trial starts in the real native key window/)
    assert.equal(unit.nativeRequests.length, 1)
    assert.equal(unit.dispatches.length, 0)
  }
})

test('PIKD-04: five deferred-start cancellations never enter guest setup or overlap cleanup', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const unit = harness('darwin')
    const calls = []
    let release, enter
    const pending = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { enter = resolve })
    unit.setRunners({
      startup: async () => { calls.push('startup'); enter(); await pending },
      guests: async () => { calls.push('guest-setup') }, traces: async () => { calls.push('trace-audit') }
    })
    const running = unit.runShortcutCases(unit.h)
    await reached
    unit.h.cancelled = true
    calls.push('cleanup-started')
    release()
    await assert.rejects(running, /Runner canceled during application startup/)
    assert.deepEqual(calls, ['startup', 'cleanup-started'])
  }
  const unit = harness('darwin')
  const calls = []
  unit.setRunners({ startup: async () => { calls.push('startup') }, guests: async () => { calls.push('guests') }, traces: async () => { calls.push('traces') } })
  await unit.runShortcutCases(unit.h)
  assert.deepEqual(calls, ['startup', 'guests', 'traces'])
})
