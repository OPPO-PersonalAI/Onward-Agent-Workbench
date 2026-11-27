/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatAcceleratorDisplay,
  formatShortcutModifierToken,
  SHORTCUT_DISPLAY_SEPARATOR,
  splitAcceleratorTokens
} from '../../src/utils/shortcut-display.ts'

test('SD-U01: separator is a single space and tokenizer preserves literal plus keys', () => {
  assert.equal(SHORTCUT_DISPLAY_SEPARATOR, ' ')
  assert.deepEqual(splitAcceleratorTokens(''), [])
  assert.deepEqual(splitAcceleratorTokens('   '), [])
  assert.deepEqual(splitAcceleratorTokens('+'), ['+'])
  assert.deepEqual(splitAcceleratorTokens('CommandOrControl+1'), ['CommandOrControl', '1'])
  assert.deepEqual(splitAcceleratorTokens('Ctrl+F'), ['Ctrl', 'F'])
  assert.deepEqual(splitAcceleratorTokens('CommandOrControl++'), ['CommandOrControl', '+'])
  assert.deepEqual(splitAcceleratorTokens('CommandOrControl+Shift++'), ['CommandOrControl', 'Shift', '+'])
  assert.deepEqual(splitAcceleratorTokens('CommandOrControl+-'), ['CommandOrControl', '-'])
  assert.deepEqual(splitAcceleratorTokens('CommandOrControl+Plus'), ['CommandOrControl', 'Plus'])
})

test('SD-U02: accelerator display separates every key with a space across darwin, win32, and linux', () => {
  const cases: Array<[string | null | undefined, string, string, string]> = [
    [null, '', '', ''],
    [undefined, '', '', ''],
    ['', '', '', ''],
    ['CommandOrControl+1', '⌘ 1', 'Ctrl 1', 'Ctrl 1'],
    ['Ctrl+F', 'Ctrl F', 'Ctrl F', 'Ctrl F'],
    ['Control+F', 'Ctrl F', 'Ctrl F', 'Ctrl F'],
    ['Ctrl+Alt+F8', 'Ctrl ⌥ F8', 'Ctrl Alt F8', 'Ctrl Alt F8'],
    ['CommandOrControl+Shift+S', '⌘ ⇧ S', 'Ctrl Shift S', 'Ctrl Shift S'],
    ['CommandOrControl+Shift+F', '⌘ ⇧ F', 'Ctrl Shift F', 'Ctrl Shift F'],
    ['Alt+Shift+1', '⌥ ⇧ 1', 'Alt Shift 1', 'Alt Shift 1'],
    ['Alt+1', '⌥ 1', 'Alt 1', 'Alt 1'],
    ['CommandOrControl++', '⌘ +', 'Ctrl +', 'Ctrl +'],
    ['CommandOrControl+Plus', '⌘ +', 'Ctrl +', 'Ctrl +'],
    ['CommandOrControl+-', '⌘ -', 'Ctrl -', 'Ctrl -'],
    ['CommandOrControl+0', '⌘ 0', 'Ctrl 0', 'Ctrl 0'],
    ['Meta+K', '⌘ K', 'Win K', 'Super K'],
    ['Command+K', '⌘ K', 'Win K', 'Super K'],
    ['Option+Space', '⌥ ␣', 'Alt ␣', 'Alt ␣'],
    ['Shift+Enter', '⇧ ↵', 'Shift ↵', 'Shift ↵'],
    ['Shift+Tab', '⇧ ⇥', 'Shift ⇥', 'Shift ⇥'],
    ['Alt+Left', '⌥ ←', 'Alt ←', 'Alt ←'],
    ['Alt+Right', '⌥ →', 'Alt →', 'Alt →'],
    ['F6', 'F6', 'F6', 'F6'],
    ['+', '+', '+', '+']
  ]

  for (const [platform, column] of [['darwin', 1], ['win32', 2], ['linux', 3]] as const) {
    for (const row of cases) {
      assert.equal(formatAcceleratorDisplay(row[0], platform), row[column], `${platform}: ${String(row[0])}`)
    }
  }
})

test('SD-U03: modifier token helper returns null for non-modifier keys', () => {
  assert.equal(formatShortcutModifierToken('1', 'darwin'), null)
  assert.equal(formatShortcutModifierToken('F8', 'win32'), null)
  assert.equal(formatShortcutModifierToken('CommandOrControl', 'darwin'), '⌘')
  assert.equal(formatShortcutModifierToken('CommandOrControl', 'win32'), 'Ctrl')
  assert.equal(formatShortcutModifierToken('CommandOrControl', 'linux'), 'Ctrl')
  assert.equal(formatShortcutModifierToken('Meta', 'darwin'), '⌘')
  assert.equal(formatShortcutModifierToken('Meta', 'win32'), 'Win')
  assert.equal(formatShortcutModifierToken('Meta', 'linux'), 'Super')
})
