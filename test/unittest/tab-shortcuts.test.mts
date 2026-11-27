/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyShortcutDraftUpdate,
  buildWindowShortcutLookup,
  clearDormantSwitchTabDraft,
  extractDynamicSwitchTabEntries,
  listActiveSwitchTabKeys,
  listDormantSwitchTabEntries,
  parseSwitchTabShortcutKey,
  switchTabShortcutKey
} from '../../src/utils/tab-shortcuts.ts'
import { isReservedShortcut, normalizeAccelerator } from '../../electron/main/reserved-shortcuts.ts'

test('TSC-U01: parseSwitchTabShortcutKey accepts unbounded positive integers and rejects malformed keys', () => {
  assert.equal(parseSwitchTabShortcutKey('switchTab1'), 1)
  assert.equal(parseSwitchTabShortcutKey('switchTab6'), 6)
  assert.equal(parseSwitchTabShortcutKey('switchTab7'), 7)
  assert.equal(parseSwitchTabShortcutKey('switchTab42'), 42)
  assert.equal(parseSwitchTabShortcutKey('switchTab999'), 999)

  for (const invalid of ['switchTab0', 'switchTab01', 'switchTab-1', 'switchTab', 'switchTab1a', 'focusTerminal1', 'switchPrevTab']) {
    assert.equal(parseSwitchTabShortcutKey(invalid), null, invalid)
  }
})

test('TSC-U02: switchTabShortcutKey and listActiveSwitchTabKeys enforce minimum 1 and scale without cap', () => {
  assert.equal(switchTabShortcutKey(1), 'switchTab1')
  assert.equal(switchTabShortcutKey(18), 'switchTab18')
  assert.throws(() => switchTabShortcutKey(0))
  assert.throws(() => switchTabShortcutKey(-2))
  assert.throws(() => switchTabShortcutKey(1.5))

  assert.deepEqual(listActiveSwitchTabKeys(0), ['switchTab1'])
  assert.deepEqual(listActiveSwitchTabKeys(1), ['switchTab1'])
  const keys12 = listActiveSwitchTabKeys(12)
  assert.equal(keys12.length, 12)
  assert.equal(keys12[0], 'switchTab1')
  assert.equal(keys12[11], 'switchTab12')
})

test('TSC-U03: listDormantSwitchTabEntries returns ascending bindings beyond open tab count', () => {
  const shortcuts = {
    switchTab1: 'Alt+1',
    switchTab3: 'Alt+3',
    switchTab12: 'Alt+Q',
    switchTab7: 'Alt+7',
    switchTab8: null,
    switchTab9: '   ',
    switchPrevTab: 'Alt+['
  }
  assert.deepEqual(listDormantSwitchTabEntries(shortcuts, 4), [
    { key: 'switchTab7', index: 7, accelerator: 'Alt+7' },
    { key: 'switchTab12', index: 12, accelerator: 'Alt+Q' }
  ])
  assert.deepEqual(listDormantSwitchTabEntries(shortcuts, 12), [])
  assert.deepEqual(listDormantSwitchTabEntries(shortcuts, 2), [
    { key: 'switchTab3', index: 3, accelerator: 'Alt+3' },
    { key: 'switchTab7', index: 7, accelerator: 'Alt+7' },
    { key: 'switchTab12', index: 12, accelerator: 'Alt+Q' }
  ])
})

test('TSC-U04: applyShortcutDraftUpdate keeps legacy 1..6 null slots and prunes cleared dynamic 7+ slots', () => {
  const base: Record<string, string | null | undefined> = {
    switchTab1: 'Alt+1',
    switchTab6: 'Alt+6'
  }
  const with7 = applyShortcutDraftUpdate(base, 'switchTab7', 'Alt+7')
  assert.equal(with7.switchTab7, 'Alt+7')

  const cleared7 = applyShortcutDraftUpdate(with7, 'switchTab7', null)
  assert.equal(Object.hasOwn(cleared7, 'switchTab7'), false)

  const cleared6 = applyShortcutDraftUpdate(cleared7, 'switchTab6', null)
  assert.equal(Object.hasOwn(cleared6, 'switchTab6'), true)
  assert.equal(cleared6.switchTab6, null)
})

test('TSC-U05: clearDormantSwitchTabDraft removes dormant bindings without disturbing active slots', () => {
  const draft: Record<string, string | null | undefined> = {
    switchTab1: 'Alt+1',
    switchTab2: 'Alt+2',
    switchTab5: 'Alt+5',
    switchTab9: 'Alt+9',
    switchTab14: 'Alt+E',
    switchPrevTab: 'Alt+['
  }
  const cleaned = clearDormantSwitchTabDraft(draft, 3)
  assert.equal(cleaned.switchTab1, 'Alt+1')
  assert.equal(cleaned.switchTab2, 'Alt+2')
  assert.equal(cleaned.switchTab5, null)
  assert.equal(Object.hasOwn(cleaned, 'switchTab9'), false)
  assert.equal(Object.hasOwn(cleaned, 'switchTab14'), false)
  assert.equal(cleaned.switchPrevTab, 'Alt+[')
})

test('TSC-U06: extractDynamicSwitchTabEntries validates, filters reserved keys, and sorts 7+ entries', () => {
  const validate = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    const trimmed = value.trim()
    return isReservedShortcut(trimmed) ? null : trimmed
  }
  const extracted = extractDynamicSwitchTabEntries({
    switchTab1: 'Alt+1',
    switchTab6: 'Alt+6',
    switchTab15: 'Alt+E',
    switchTab7: 'Alt+7',
    switchTab8: 'CommandOrControl+S',
    switchTab9: null,
    switchTab0: 'Alt+0',
    switchTab10: '  Alt+0  '
  }, validate)
  assert.deepEqual(Object.entries(extracted), [
    ['switchTab7', 'Alt+7'],
    ['switchTab10', 'Alt+0'],
    ['switchTab15', 'Alt+E']
  ])
})

test('TSC-U07: buildWindowShortcutLookup resolves dynamic switchTab N, nav shortcuts, and Ctrl/Control aliases in O(1)', () => {
  const lookup = buildWindowShortcutLookup({
    focusTerminal1: 'Alt+F1',
    switchTab1: 'Alt+Shift+1',
    switchTab7: 'Ctrl+7',
    switchTab25: 'Alt+Shift+Q',
    switchPrevTab: 'Alt+[',
    switchNextTab: 'Alt+]',
    switchLastTab: 'Alt+9',
    searchTabs: 'Ctrl+Shift+A',
    viewGitDiff: 'Alt+G'
  }, normalizeAccelerator)

  assert.deepEqual(lookup.get(normalizeAccelerator('Alt+F1')), { type: 'focusTerminal', index: 1 })
  assert.deepEqual(lookup.get(normalizeAccelerator('Alt+Shift+1')), { type: 'switchTab', index: 1 })
  assert.deepEqual(lookup.get(normalizeAccelerator('Control+7')), { type: 'switchTab', index: 7 })
  assert.deepEqual(lookup.get(normalizeAccelerator('Alt+Shift+Q')), { type: 'switchTab', index: 25 })
  assert.deepEqual(lookup.get(normalizeAccelerator('Alt+[')), { type: 'switchPrevTab' })
  assert.deepEqual(lookup.get(normalizeAccelerator('Alt+]')), { type: 'switchNextTab' })
  assert.deepEqual(lookup.get(normalizeAccelerator('Alt+9')), { type: 'switchLastTab' })
  assert.deepEqual(lookup.get(normalizeAccelerator('Control+Shift+A')), { type: 'searchTabs' })
  assert.deepEqual(lookup.get(normalizeAccelerator('Alt+G')), { type: 'viewGitDiff' })
  assert.equal(lookup.get(normalizeAccelerator('Alt+Z')), undefined)
})
