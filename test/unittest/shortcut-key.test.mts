/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { shortcutKeyFromCode, windowShortcutKey } from '../../src/utils/shortcut-key.ts'

test('shifted digits keep the same physical identity as the recorder', () => {
  for (let digit = 0; digit <= 9; digit++) {
    const code = `Digit${digit}`
    for (const key of [String(digit), ')!@#$%^&*('[digit], 'é']) {
      assert.equal(windowShortcutKey({ code, key }), shortcutKeyFromCode(code))
      assert.equal(windowShortcutKey({ code, key }), String(digit))
    }
  }
})

test('letters retain physical identity across case and Option/layout characters', () => {
  for (const key of ['a', 'A', 'å', 'Å']) {
    assert.equal(windowShortcutKey({ code: 'KeyA', key }), 'A')
  }
})

test('named and punctuation keys use the recorder aliases', () => {
  for (const [code, key, expected] of [
    ['ArrowUp', 'ArrowUp', 'Up'], ['ArrowDown', 'ArrowDown', 'Down'],
    ['ArrowLeft', 'ArrowLeft', 'Left'], ['ArrowRight', 'ArrowRight', 'Right'],
    ['Space', ' ', 'Space'], ['Equal', '+', '='], ['Minus', '_', '-'],
    ['Slash', '?', '/'], ['BracketLeft', '{', '['], ['Backslash', '|', '\\'],
    ['Enter', 'Enter', 'Enter'], ['F12', 'F12', 'F12'], ['F24', 'F24', 'F24']
  ]) {
    assert.equal(shortcutKeyFromCode(code), expected)
    assert.equal(windowShortcutKey({ code, key }), expected)
  }
})

test('unsupported or absent codes preserve legacy dispatch without broadening recording', () => {
  for (const code of [undefined, '', 'Unidentified', 'Numpad1', 'ControlLeft', '__proto__']) {
    assert.equal(shortcutKeyFromCode(code), null)
    assert.equal(windowShortcutKey({ code, key: 'a' }), 'A')
    assert.equal(windowShortcutKey({ code, key: '!' }), '!')
    assert.equal(windowShortcutKey({ code, key: 'ArrowUp' }), 'ArrowUp')
  }
})
