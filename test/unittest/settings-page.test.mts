/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isSettingsPageCommit, mergeSettingsPage, settingsValuesEqual, settingsDraftShortcutConflict } from '../../src/utils/settings-page.ts'
import { createDefaultPromptInputSettings } from '../../src/utils/prompt-input.ts'
import type { SettingsState } from '../../src/types/settings'

test('SP-U01: dirty compares values, independent of object key order', () => {
  assert.equal(settingsValuesEqual({ a: 1, b: [null, 'x'] }, { b: [null, 'x'], a: 1 }), true)
  assert.equal(settingsValuesEqual({ a: [1, 2] }, { a: [2, 1] }), false)
  assert.equal(settingsValuesEqual({ a: undefined }, {}), false)
})

test('SP-U02: page commit rejects missing and unrelated fields', () => {
  const general = {
    language: 'en',
    promptPanelPosition: 'left',
    telemetryConsent: false,
    performanceDiagnosticsEnabled: false,
    terminalMacOptionIsMeta: false
  }
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: general }), true)
  assert.equal(isSettingsPageCommit({ page: 'about', baseline: {}, draft: {} }), false)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, settingsPanelWidth: 600 } }), false)
  assert.equal(isSettingsPageCommit({ page: 'shortcuts', baseline: {}, draft: {} }), false)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, telemetryConsent: 'yes' } }), false)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, terminalMacOptionIsMeta: true } }), true)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, terminalMacOptionIsMeta: 'yes' } }), false)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, promptPanelPosition: 'bottom' } }), true)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, promptPanelPosition: 'right' } }), true)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, promptPanelPosition: 'top' } }), false)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, promptPanelPosition: null } }), false)
  assert.equal(isSettingsPageCommit({ page: 'general', baseline: general, draft: { ...general, promptPanelPosition: 123 } }), false)
})

test('SP-U03: unrelated concurrent page fields merge without losing live values', () => {
  const baseline = {
    language: 'en' as const,
    promptPanelPosition: 'left' as const,
    telemetryConsent: false,
    performanceDiagnosticsEnabled: false
  }
  assert.deepEqual(mergeSettingsPage({ ...baseline, telemetryConsent: true }, baseline, { ...baseline, language: 'zh-CN' }), {
    success: true,
    values: {
      language: 'zh-CN',
      promptPanelPosition: 'left',
      telemetryConsent: true,
      performanceDiagnosticsEnabled: false
    }
  })
  assert.deepEqual(
    mergeSettingsPage({ ...baseline, language: 'zh-CN' }, baseline, { ...baseline, promptPanelPosition: 'bottom' }),
    {
      success: true,
      values: {
        language: 'zh-CN',
        promptPanelPosition: 'bottom',
        telemetryConsent: false,
        performanceDiagnosticsEnabled: false
      }
    }
  )
})

test('SP-U04: diverging edits conflict, identical concurrent edits succeed', () => {
  assert.deepEqual(mergeSettingsPage({ gitDiffFontSize: 18 }, { gitDiffFontSize: 12 }, { gitDiffFontSize: 20 }), { success: false })
  assert.deepEqual(mergeSettingsPage({ gitDiffFontSize: 20 }, { gitDiffFontSize: 12 }, { gitDiffFontSize: 20 }), {
    success: true, values: { gitDiffFontSize: 20 }
  })
})

test('SP-U05: per-Task font fields merge, removed edited Tasks conflict', () => {
  const task = { terminalId: 'task-a', fontSize: 14, fontFamily: null, gitDiffFontSize: null }
  const baseline = { terminalStyles: { 'task-a': task } }
  const draft = { terminalStyles: { 'task-a': { ...task, fontSize: 18 } } }
  assert.deepEqual(mergeSettingsPage({ terminalStyles: { 'task-a': { ...task, fontFamily: 'monospace' } } }, baseline, draft), {
    success: true, values: { terminalStyles: { 'task-a': { ...task, fontFamily: 'monospace', fontSize: 18 } } }
  })
  assert.deepEqual(mergeSettingsPage({ terminalStyles: {} }, baseline, draft), { success: false })
})

for (const platform of ['darwin', 'win32', 'linux']) test(`SP-U06-${platform}: shortcut validation uses the composed page draft`, () => {
  const settings = { shortcuts: { activateAndFocusPrompt: 'Control+F10', focusPromptEditor: 'Control+F11' },
    promptInput: { ...createDefaultPromptInputSettings(), leader: 'Control+Space', targetModifier: 'Alt', actions: [
      { id: 'hidden', name: 'Hidden action', visible: false, includePrompt: false, terminalKey: 'Enter', target: 'default', shortcut: 'F12' }
    ] } } as SettingsState
  assert.equal(settingsDraftShortcutConflict(settings, 'Control+S', platform, 'activateAndFocusPrompt'), 'promptEditSave')
  assert.equal(settingsDraftShortcutConflict(settings, 'F12', platform, 'activateAndFocusPrompt'), 'promptInputAction')
  assert.equal(settingsDraftShortcutConflict(settings, 'Alt+1', platform, 'activateAndFocusPrompt'), 'promptInputTarget')
  assert.equal(settingsDraftShortcutConflict(settings, 'Control+Space', platform, 'focusTerminal1'), 'promptInputLeader')
  assert.equal(settingsDraftShortcutConflict(settings, 'F12', platform, 'focusTerminal1'), null, 'Window-local shortcuts may reuse action keys')
  assert.equal(settingsDraftShortcutConflict(settings, 'Control+F10', platform, 'activateAndFocusPrompt'), null)
})
