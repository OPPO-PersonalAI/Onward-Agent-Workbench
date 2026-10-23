/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatPromptInputFailureDetails, formatPromptShortcutLabel,
  getPromptInputActionLabel, getPromptTerminalKeyLabel
} from '../../src/utils/prompt-input-labels.ts'
import { createDefaultPromptInputSettings, PROMPT_TERMINAL_KEYS, type PromptInputResult } from '../../src/utils/prompt-input.ts'
import { en, zhCN } from '../../src/i18n/prompt-input.ts'
import { promptInputRuntimeEn, promptInputRuntimeZhCN } from '../../src/i18n/prompt-input-runtime.ts'

type Translate = Parameters<typeof getPromptInputActionLabel>[1]
function translator(locale: 'en' | 'zh-CN'): Translate {
  const dictionary: Record<string, string> = locale === 'en'
    ? { ...en, ...promptInputRuntimeEn } : { ...zhCN, ...promptInputRuntimeZhCN }
  return (key, params) => {
    assert.equal(typeof dictionary[key], 'string', `Missing ${locale} translation: ${key}`)
    return dictionary[key].replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      assert.notEqual(params?.[name], undefined, `Missing ${key} parameter: ${name}`)
      return String(params![name])
    })
  }
}

test('PIL-U01: portable shortcuts display the actual host modifier, including punctuation and Plus', () => {
  const cases: Array<[string, string, string, string]> = [
    ['CommandOrControl+X', '⌘X', 'Ctrl+X', 'Ctrl+X'],
    ['CmdOrCtrl+Shift+return', '⌘⇧Enter', 'Ctrl+Shift+Enter', 'Ctrl+Shift+Enter'],
    ['Control+X', 'CtrlX', 'Ctrl+X', 'Ctrl+X'],
    ['Command+X', '⌘X', 'Win+X', 'Super+X'],
    ['Shift+Option+Command+Q', '⌘⌥⇧Q', 'Win+Alt+Shift+Q', 'Super+Alt+Shift+Q'],
    ['CommandOrControl++', '⌘+', 'Ctrl++', 'Ctrl++'],
    ['+', '+', '+', '+'],
    ['Plus', '+', '+', '+'],
    ['Control+=', 'Ctrl=', 'Ctrl+=', 'Ctrl+='],
    ['Shift+/', '⇧/', 'Shift+/', 'Shift+/'],
    [';', ';', ';', ';'],
    ['esc', 'Escape', 'Escape', 'Escape'],
    ['F24', 'F24', 'F24', 'F24']
  ]
  for (const [platform, column] of [['darwin', 1], ['win32', 2], ['linux', 3]] as const) {
    for (const row of cases) assert.equal(formatPromptShortcutLabel(row[0], platform), row[column], `${platform}: ${row[0]}`)
    for (const invalid of ['', 'Control', 'Ctrl+', 'NoSuchKey', 'Ctrl+Q+E', '__proto__']) {
      assert.equal(formatPromptShortcutLabel(invalid, platform), '', `${platform}: ${invalid}`)
    }
  }
})

test('PIL-U02: presets localize, while user names override presets in either language', () => {
  const defaults = createDefaultPromptInputSettings().actions
  const expected = {
    en: ['Send & execute', 'Execute', 'Send', 'Send all & execute', 'Queue'],
    'zh-CN': ['\u53d1\u9001\u5e76\u6267\u884c', '\u6267\u884c', '\u53d1\u9001', '\u5168\u90e8\u53d1\u9001\u5e76\u6267\u884c', '\u6392\u961f']
  }
  for (const locale of ['en', 'zh-CN'] as const) {
    const t = translator(locale)
    assert.deepEqual(defaults.map(action => getPromptInputActionLabel(action, t)), expected[locale])
    assert.equal(getPromptInputActionLabel({ ...defaults[4], name: '  My queue \ud83e\uddea  ' }, t), 'My queue \ud83e\uddea')
    assert.equal(getPromptInputActionLabel({ ...defaults[4], name: '  ' }, t), expected[locale][4])
    assert.equal(getPromptInputActionLabel({ ...defaults[4], preset: undefined, name: '' }, t),
      locale === 'en' ? 'Custom action' : '\u81ea\u5b9a\u4e49\u52a8\u4f5c')
  }
})

test('PIL-U03: every supported terminal suffix has a localized label independent from its trigger', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const t = translator(locale)
    for (const key of PROMPT_TERMINAL_KEYS) {
      const label = getPromptTerminalKeyLabel(key, t)
      assert(label.length > 0)
      assert(!label.includes('{{'))
      if (key.startsWith('Control+')) assert.equal(label, `Ctrl+${key.slice(8)}`)
    }
    assert.equal(getPromptTerminalKeyLabel('None', t), locale === 'en' ? 'None' : '\u65e0')
    assert.equal(getPromptTerminalKeyLabel('Tab', t), locale === 'en' ? 'Tab' : 'Tab\uff08\u5236\u8868\uff09')
  }
})

test('PIL-U04: notices identify each failed Task and distinguish content, key-only and suffix failures', () => {
  const targets: Array<{ taskName: string; result: PromptInputResult }> = [
    { taskName: 'Success', result: { ok: true, phase: 'complete', contentDelivered: true } },
    { taskName: 'Build', result: { ok: false, phase: 'content', contentDelivered: false, reason: 'unavailable' } },
    { taskName: 'Tests', result: { ok: false, phase: 'key', contentDelivered: false, reason: 'write-failed' } },
    { taskName: 'Queue', result: { ok: false, phase: 'key', contentDelivered: true, reason: 'write-failed' } },
    { taskName: 'Unknown', result: { ok: false, phase: 'content', contentDelivered: false } }
  ]
  const original = structuredClone(targets)
  assert.equal(formatPromptInputFailureDetails(targets, translator('en')), [
    'Build — Text not sent: Task unavailable.',
    'Tests — Key not sent: terminal write failed.',
    'Queue — Text sent; key failed: terminal write failed.',
    'Unknown — Text not sent: delivery failed.'
  ].join('\n'))
  const zh = formatPromptInputFailureDetails(targets, translator('zh-CN'))
  assert.equal(zh.split('\n').length, 4)
  assert(zh.includes('Build — \u6587\u672c\u672a\u53d1\u9001\uff1a\u4efb\u52a1\u4e0d\u53ef\u7528\u3002'))
  assert(zh.includes('Tests — \u6309\u952e\u672a\u53d1\u9001\uff1a\u7ec8\u7aef\u5199\u5165\u5931\u8d25\u3002'))
  assert(zh.includes('Queue — \u6587\u672c\u5df2\u53d1\u9001\uff0c\u6309\u952e\u5931\u8d25\uff1a\u7ec8\u7aef\u5199\u5165\u5931\u8d25\u3002'))
  assert(!zh.includes('Success'))
  assert.deepEqual(targets, original)
})

test('PIL-U05: all failure reasons localize without leaking translation keys', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const t = translator(locale)
    for (const reason of ['invalid-input', 'unavailable', 'unsafe-multiline-send', 'write-failed', undefined] as const) {
      const detail = formatPromptInputFailureDetails([{ taskName: 'Target', result: { ok: false, phase: 'content', contentDelivered: false, reason } }], t)
      assert(detail.startsWith('Target — '))
      assert(!detail.includes('promptInput.'))
      assert(!detail.includes('{{'))
    }
    assert.equal(formatPromptInputFailureDetails([], t), '')
    assert.equal(formatPromptInputFailureDetails([{ taskName: 'Success', result: { ok: true, phase: 'complete', contentDelivered: false } }], t), '')
  }
})

test('PIL-U06: many failures and hostile labels produce bounded one-line-per-Task notices', () => {
  const result: PromptInputResult = { ok: false, phase: 'content', contentDelivered: false, reason: 'invalid-input' }
  const targets = Array.from({ length: 1000 }, (_, index) => ({ taskName: `Task ${index}`, result }))
  targets[0].taskName = 'A'.repeat(2000)
  targets[1].taskName = '  Build\r\n\tTask  '
  targets[2].taskName = '\n \t'
  for (const locale of ['en', 'zh-CN'] as const) {
    const lines = formatPromptInputFailureDetails(targets, translator(locale)).split('\n')
    assert.equal(lines.length, 9)
    assert(lines[0].startsWith(`${'A'.repeat(80)}… — `))
    assert(lines[1].startsWith('Build Task — '))
    assert(lines[2].startsWith(locale === 'en' ? 'Task 3 — ' : '\u4efb\u52a1 3 — '))
    assert.equal(lines[8], locale === 'en' ? '992 more Tasks failed.' : '\u53e6\u6709 992 \u4e2a\u4efb\u52a1\u53d1\u9001\u5931\u8d25\u3002')
    assert(lines.every(line => line.length < 200))
  }
})
