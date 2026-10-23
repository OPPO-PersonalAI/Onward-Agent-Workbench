/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeShortcutKeyboard, physicalShortcutKey } from '../autotest/native-shortcut-keyboard.mjs'

function recorder(accept = () => true, contentsId) {
  const events = []
  // This records the adapter contract only; Electron ingress and consumption
  // are proved separately by the PIK suites and their real child-byte ledgers.
  const page = { evaluate: async (_callback, request) => {
    events.push(structuredClone(request))
    return accept(request.input)
  } }
  return { keyboard: new NativeShortcutKeyboard(page, contentsId), events }
}

test('native printable input includes chars between down/up; control chords never inject text', async () => {
  const { keyboard, events } = recorder()
  await keyboard.press('KeyZ')
  assert.deepEqual(events.map(event => event.input), [
    { type: 'keyDown', keyCode: 'z', modifiers: [] },
    { type: 'char', keyCode: 'z', modifiers: [] },
    { type: 'keyUp', keyCode: 'z', modifiers: [] }
  ])
  events.length = 0
  await keyboard.press('Control+KeyX')
  assert.deepEqual(events.map(event => event.input), [
    { type: 'keyDown', keyCode: 'Control', modifiers: ['control'] },
    { type: 'keyDown', keyCode: 'x', modifiers: ['control'] },
    { type: 'keyUp', keyCode: 'x', modifiers: ['control'] },
    { type: 'keyUp', keyCode: 'Control', modifiers: [] }
  ])
  assert(events.every(event => event.contentsId === undefined), 'Default ingress must let main resolve the real focused host/guest')
  assert.equal(keyboard.held.size, 0)
})

test('a held modifier survives press and only a repeated down carries autorepeat', async () => {
  const { keyboard, events } = recorder()
  await keyboard.down('Control')
  await keyboard.down('KeyX')
  await keyboard.press('Control+KeyX')
  assert.deepEqual([...keyboard.held], ['Control', 'KeyX'], 'Press may not release a key owned by its caller')
  assert.deepEqual(events.map(event => event.input.modifiers), [
    ['control'], ['control'], ['control', 'isautorepeat']
  ])
  await keyboard.up('KeyX')
  await keyboard.up('Control')
  await keyboard.down('KeyQ')
  await keyboard.down('KeyQ')
  await keyboard.up('KeyQ')
  const q = events.map(event => event.input).filter(event => event.keyCode === 'q')
  assert.deepEqual(q.map(event => event.type), ['keyDown', 'char', 'keyDown', 'char', 'keyUp'])
  assert.deepEqual(q.map(event => event.modifiers), [[], [], ['isautorepeat'], ['isautorepeat'], []])
  assert.equal(keyboard.held.size, 0)
})

test('shifted text preserves physical key identity and guest addressing', async () => {
  const { keyboard, events } = recorder(() => true, 42)
  await keyboard.press('Shift+Digit3')
  assert(events.every(event => event.contentsId === 42))
  assert.deepEqual(events.filter(event => event.input.type === 'char').map(event => event.input), [
    { type: 'char', keyCode: '#', modifiers: ['shift'] }
  ])
  assert.equal(events.find(event => event.input.keyCode === '3').input.type, 'keyDown')
  assert.deepEqual(events.at(-1).input, { type: 'keyUp', keyCode: 'Shift', modifiers: [] })
})

test('rejected native ingress fails the stroke and unwinds both key and modifier', async () => {
  const { keyboard, events } = recorder(input => !(input.type === 'keyDown' && input.keyCode === 'x'))
  await assert.rejects(keyboard.press('Control+KeyX'), /Native ingress rejected keyDown\/x/)
  assert.deepEqual(events.slice(-2).map(event => event.input.keyCode), ['x', 'Control'])
  assert(events.slice(-2).every(event => event.input.type === 'keyUp'))
  assert.equal(keyboard.held.size, 0)
  const before = events.length
  for (const stroke of ['Unsupported', 'KeyQ+KeyX', 'Control+Control+KeyX']) {
    await assert.rejects(keyboard.press(stroke))
    assert.equal(events.length, before, 'Invalid strokes fail before any native input is sent')
  }
})

test('a char failure still releases the key and cleanup attempts every held release', async () => {
  let rejectChars = true
  let rejectXUp = false
  const { keyboard, events } = recorder(input => !(rejectChars && input.type === 'char') &&
    !(rejectXUp && input.type === 'keyUp' && input.keyCode === 'x'))
  await assert.rejects(keyboard.press('KeyZ'), /Native ingress rejected char\/z/)
  assert.equal(events.at(-1).input.type, 'keyUp')
  assert.equal(keyboard.held.size, 0)
  rejectChars = false
  await keyboard.down('Control')
  await keyboard.down('KeyX')
  rejectXUp = true
  await assert.rejects(keyboard.releaseAll(), AggregateError)
  assert.equal(events.at(-1).input.keyCode, 'Control', 'A failed key release may not strand the modifier')
  assert.deepEqual([...keyboard.held], ['KeyX'])
  rejectXUp = false
  await keyboard.releaseAll()
  assert.equal(keyboard.held.size, 0)
})

test('five rounds of twenty sequences do not leak modifier or repeat state', async () => {
  const { keyboard, events } = recorder()
  for (let round = 0; round < 5; round += 1) {
    for (let sequence = 0; sequence < 20; sequence += 1) {
      await keyboard.press('Control+KeyX')
      await keyboard.press('Digit3')
      await keyboard.press('KeyQ')
      assert.equal(keyboard.held.size, 0)
    }
  }
  assert.equal(events.filter(event => event.input.type === 'char').length, 200)
  assert(events.every(event => !event.input.modifiers.includes('isautorepeat')))
})

test('physical CDP fields use Apple virtual keys, Windows VKs and Linux XKB codes explicitly', () => {
  for (const [platform, digit, letter] of [['darwin', 20, 12], ['win32', 51, 81], ['linux', 12, 24]]) {
    for (const [code, key, native, windows] of [['Digit3', '\u2116', digit, 51], ['KeyQ', '\u0439', letter, 81]]) {
      assert.deepEqual(physicalShortcutKey(code, key, platform), {
        code, key, modifiers: 0, nativeVirtualKeyCode: native, windowsVirtualKeyCode: windows
      })
    }
  }
  assert.throws(() => physicalShortcutKey('KeyQ', 'q', 'unknown'), /Unsupported native key platform/)
  assert.throws(() => physicalShortcutKey('KeyZ', 'z', 'darwin'), /Unsupported physical shortcut key/)
})
