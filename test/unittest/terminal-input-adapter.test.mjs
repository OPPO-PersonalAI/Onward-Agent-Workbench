/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness, loadProductionModule, keyEvent, PLATFORMS } from '../autotest/cli-shortcut-compatibility-support.mjs'
const { TerminalKeyboardProtocol, encodeTerminalKey, KEYBOARD_STACK_LIMIT } = loadProductionModule('src/terminal/terminal-keyboard-protocol.ts')
const { terminalClipboardPayload, hasClipboardImage } = loadProductionModule('src/terminal/terminal-clipboard.ts')

test('TKP-U01: bounded independent keyboard stacks support push/pop/set/query and mask unsupported capabilities', () => {
  const protocol = new TerminalKeyboardProtocol()
  assert.equal(protocol.command('?', [0]), '\x1b[?0u')
  protocol.command('>', [31])
  assert.equal(protocol.command('?', [0]), '\x1b[?7u')
  protocol.command('=', [2, 3])
  assert.equal(protocol.flags, 5)
  protocol.command('=', [2, 2])
  assert.equal(protocol.flags, 7)
  protocol.command('=', [2, 1])
  assert.equal(protocol.flags, 2)
  protocol.buffer = 'alternate'
  assert.equal(protocol.flags, 0)
  protocol.command('>', [1])
  protocol.buffer = 'normal'
  assert.equal(protocol.flags, 2)
  for (const params of [[[1, 2]], [-1], [NaN], [Infinity], [1, 99]]) protocol.command('=', params)
  assert.equal(protocol.flags, 2)
  for (let trial = 0; trial < 5; trial++) {
    for (let index = 0; index < 1000; index++) protocol.command('>', [index & 7])
    assert.equal(protocol.depth, KEYBOARD_STACK_LIMIT)
    protocol.command('<', [1000000])
    assert.equal(protocol.flags, 0)
    assert.equal(protocol.depth, 1)
  }
  protocol.reset()
  protocol.buffer = 'alternate'
  assert.equal(protocol.flags, 0)
})

test('TKP-U02: event types, alternate keys and recovery keys have exact protocol encodings', () => {
  for (const platform of PLATFORMS) {
    assert.equal(encodeTerminalKey(keyEvent('Control+C'), 1, platform), '\x1b[99;5u')
    assert.equal(encodeTerminalKey(keyEvent('Control+C'), 2, platform), '\x03')
    assert.equal(encodeTerminalKey(keyEvent('Control+C', 'keyup'), 2, platform), '\x1b[99;5:3u')
    assert.equal(encodeTerminalKey({ ...keyEvent('Control+C'), repeat: true }, 2, platform), '\x1b[99;5:2u')
    assert.equal(encodeTerminalKey(keyEvent('Shift+Enter'), 2, platform), '\x1b[13;2u')
    assert.equal(encodeTerminalKey(keyEvent('Escape'), 2, platform), '\x1b')
    assert.equal(encodeTerminalKey(keyEvent('Escape', 'keyup'), 2, platform), '\x1b[27;1:3u')
    assert.equal(encodeTerminalKey({ ...keyEvent('Control+C'), repeat: true }, 3, platform), '\x1b[99;5:2u')
    assert.equal(encodeTerminalKey(keyEvent('Control+C', 'keyup'), 3, platform), '\x1b[99;5:3u')
    assert.equal(encodeTerminalKey(keyEvent('c', 'keyup'), 3, platform, false, true), '\x1b[99;1:3u')
    assert.equal(encodeTerminalKey(keyEvent('Control+Shift+A'), 5, platform), '\x1b[97:65;6u')
    assert.equal(encodeTerminalKey({ ...keyEvent('Control+A'), key: '\u0444' }, 5, platform), '\x1b[1092::97;5u')
    assert.equal(encodeTerminalKey(keyEvent('a'), 3, platform), null)
    assert.equal(encodeTerminalKey(keyEvent('Control+A'), 4, platform), null)
    for (const key of ['Enter', 'Tab', 'Backspace']) {
      assert.equal(encodeTerminalKey(keyEvent(key), 3, platform), null)
      assert.equal(encodeTerminalKey(keyEvent(key, 'keyup'), 3, platform), '')
    }
    assert.equal(encodeTerminalKey(keyEvent('Escape'), 1, platform), '\x1b[27u')
    assert.equal(encodeTerminalKey(keyEvent('F3'), 1, platform), '\x1b[13~')
    assert.equal(encodeTerminalKey({ ...keyEvent('Enter'), code: 'NumpadEnter', location: 3 }, 1, platform), '\x1b[57414u')
  }
})

test('TKP-U03: composition, dead keys, AltGr, native Command and opt-in Option preserve their ownership', () => {
  for (const platform of PLATFORMS) for (const extra of [
    { isComposing: true }, { keyCode: 229 }, { key: 'Dead' }, { key: 'Process' },
    { getModifierState: value => value === 'AltGraph' }
  ]) assert.equal(encodeTerminalKey({ ...keyEvent('Control+Alt+B'), ...extra }, 7, platform), null)
  assert.equal(encodeTerminalKey(keyEvent('Alt+B'), 1, 'darwin'), null)
  assert.equal(encodeTerminalKey({ ...keyEvent('Alt+B'), key: '\u222b' }, 1, 'darwin', true), '\x1b[98;3u')
  assert.equal(encodeTerminalKey(keyEvent('Meta+V'), 7, 'darwin', true), null)
  assert.equal(encodeTerminalKey(keyEvent('Control+Alt+B'), 1, 'win32'), '\x1b[98;7u')
})

test('TKP-U04: clipboard metadata prioritizes images without decoding or reading text', () => {
  for (const format of ['image/png', 'image/jpeg', 'image/bmp', 'public.tiff', 'PNG', 'CF_DIB', 'DeviceIndependentBitmap']) {
    assert.equal(hasClipboardImage([format]), true)
    assert.deepEqual(terminalClipboardPayload(['text/plain', format], () => { throw new Error('Unexpected text read') }), { kind: 'image' })
  }
  for (const format of ['text/html', 'text/plain', 'image/not-supported', 'Files']) assert.equal(hasClipboardImage([format]), false)
  assert.deepEqual(terminalClipboardPayload(['text/plain'], () => 'text'), { kind: 'text', text: 'text' })
  assert.deepEqual(terminalClipboardPayload([], () => ''), { kind: 'empty' })
})

test('TKP-U05: five negotiation cycles preserve session isolation, legacy recovery, counters and listeners', async () => {
  for (const platform of PLATFORMS) {
    const h = createHarness(platform), other = createHarness(platform)
    try {
      for (let trial = 0; trial < 5; trial++) {
        h.csiHandlers.get('>')([3])
        const before = h.result().hex
        await h.press('Shift+Enter')
        assert.equal(h.result().hex.slice(before.length), Buffer.from('\x1b[13;2u\x1b[13;2:3u').toString('hex'))
        h.switchBuffer('alternate')
        assert.equal(h.inputAdapter.protocol.flags, 0)
        h.switchBuffer('normal')
        h.csiHandlers.get('<')([1])
        assert.equal(h.inputAdapter.protocol.flags, 0)
        await h.press('Control+C')
        assert(h.result().hex.endsWith('03'))
        assert.equal(other.result().hex, '')
      }
      h.csiHandlers.get('>')([1])
      assert.equal(h.escHandlers.get('c')(), false, 'RIS also reaches xterm')
      assert.equal(h.inputAdapter.protocol.flags, 0)
      h.advance(1000)
      const batches = h.traces.filter(event => event.name === 'renderer:terminal.keyboard-batch')
      assert.equal(batches.length, 1)
      assert.equal(batches[0].encoded, 5)
      assert.equal(batches[0].releases, 5)
      assert.equal(batches[0].legacy, 5)
    } finally { h.dispose(); other.dispose() }
  }
})

test('TKP-U06: asynchronous paste is ordered, canceled after reset/dispose, and recovers after read rejection', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const h = createHarness('win32')
    try {
      let resolveFirst
      h.inputAdapter.services.readClipboard = () => new Promise(resolve => { resolveFirst = resolve })
      const first = h.inputAdapter.paste('keyboard')
      const second = h.inputAdapter.paste('native', { kind: 'text', text: 'second' })
      resolveFirst({ kind: 'text', text: 'first' })
      await Promise.all([first, second])
      assert.equal(Buffer.from(h.result().hex, 'hex').toString(), 'firstsecond')
      const before = h.result().hex
      const pending = h.inputAdapter.paste('context')
      h.inputAdapter.reset()
      await h.inputAdapter.paste('context', { kind: 'empty' })
      resolveFirst({ kind: 'image' })
      await pending
      assert.equal(h.result().hex, before)
      h.inputAdapter.services.readClipboard = () => Promise.reject(new Error('Unavailable'))
      await h.inputAdapter.paste('keyboard')
      h.inputAdapter.services.readClipboard = () => { throw new Error('Synchronous failure') }
      await h.inputAdapter.paste('keyboard')
      await h.inputAdapter.paste('context', { kind: 'image' })
      assert.equal(h.result().hex, `${before}16`)
      assert(h.traces.some(event => event.reason === 'canceled'))
      assert(h.traces.some(event => event.reason === 'unavailable'))
      h.inputAdapter.services.readClipboard = () => new Promise(resolve => { resolveFirst = resolve })
      const disposed = h.inputAdapter.paste('context')
      h.inputAdapter.dispose()
      resolveFirst({ kind: 'text', text: 'must-not-arrive' })
      await disposed
      assert.equal(h.result().hex, `${before}16`)
    } finally { h.dispose() }
  }
})

test('TKP-U07: native empty payload falls back to metadata and release retains the pressed physical identity', async () => {
  const h = createHarness('win32', { keyboardFlags: 3, clipboard: 'image' })
  try {
    h.domHandlers.get('paste')({ preventDefault() {}, stopImmediatePropagation() {}, clipboardData: { types: [], files: [], getData: () => '' } })
    await h.inputAdapter.pending
    assert.equal(Buffer.from(h.result().hex, 'hex').toString(), '\x1b[118;5u\x1b[118;5:3u')
    h.inputAdapter.handleKey(keyEvent('Control+Shift+1'))
    h.inputAdapter.handleKey(keyEvent('1', 'keyup'))
    assert(Buffer.from(h.result().hex, 'hex').toString().endsWith('\x1b[49;6u\x1b[49;1:3u'),
      'The shifted symbol must not become a different physical key on release')
    const before = h.traces.length
    h.inputAdapter.dispose()
    const after = h.traces.length
    h.inputAdapter.dispose()
    assert(after > before)
    assert.equal(h.traces.length, after)
  } finally { h.dispose() }
})
