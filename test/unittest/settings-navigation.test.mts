/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslator, SUPPORTED_LOCALES } from '../../src/i18n/core.ts'
import { resizedSettingsWidth } from '../../src/components/Settings/settings-panel-width.ts'
import {
  nextSettingsTab, PAGE_LABELS, searchSettings, SETTINGS_PAGES, SETTINGS_SEARCH_ENTRIES
} from '../../src/components/Settings/settings-navigation.ts'

test('SN-01: every category and indexed control has real English and Chinese translations', () => {
  assert.deepEqual(SETTINGS_PAGES, ['general', 'appearance', 'fonts', 'shortcuts', 'about'])
  assert.equal(new Set(SETTINGS_SEARCH_ENTRIES.map(entry => entry.target)).size, SETTINGS_SEARCH_ENTRIES.length)
  for (const { value: locale } of SUPPORTED_LOCALES) {
    const translate = createTranslator(locale)
    for (const page of SETTINGS_PAGES) {
      assert.ok(SETTINGS_SEARCH_ENTRIES.some(entry => entry.page === page), `${page} must be searchable in ${locale}`)
      assert.notEqual(translate(PAGE_LABELS[page]), PAGE_LABELS[page])
    }
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      for (const key of [entry.label, ...(entry.keywords ?? [])]) {
        assert.ok(translate(key).trim(), `${locale}: ${key}`)
        assert.notEqual(translate(key), key, `${locale}: ${key} cannot fall back to the raw key`)
      }
      assert.ok(searchSettings(translate(entry.label), translate).some(result => result.target === entry.target),
        `${locale}: ${entry.target} must be discoverable by its actual label`)
    }
  }
})

test('SN-02: search finds labels, category words and theme export/import keywords in English', () => {
  const translate = createTranslator('en')
  const cases = [
    ['language', ['language']], ['GENERAL language', ['language']],
    ['  ExPoRt\tTHEME  ', ['themes']], ['import', ['themes']], ['system', ['themes']],
    ['performance', ['diagnostics']], ['anonymous', ['privacy']],
    ['fonts', ['terminal-font-size', 'editor-font-size', 'font-family']],
    ['fonts project', ['editor-font-size']], ['global shortcuts', ['globalShortcuts']],
    ['about check', ['updates']], ['research preview', ['updates']],
    ['themes language', []], ['unmatched-control-name', []]
  ] as const
  for (const [query, expected] of cases) {
    assert.deepEqual(searchSettings(query, translate).map(entry => entry.target), expected, query)
  }
})

test('SN-03: Chinese search uses real localized labels and requires every whitespace-separated word', () => {
  const translate = createTranslator('zh-CN')
  const cases = [
    ['语言', ['language']], ['常规 语言', ['language']], ['导出', ['themes']], ['导入', ['themes']],
    ['诊断', ['diagnostics']], ['匿名', ['privacy']],
    ['字体', ['terminal-font-size', 'editor-font-size', 'font-family']],
    ['终端 字体', ['terminal-font-size']], ['project 字体', ['editor-font-size']],
    ['全局 快捷键', ['globalShortcuts']], ['检查 更新', ['updates']], ['关于 更新', ['updates']],
    ['主题 语言', []], ['不存在的设置', []]
  ] as const
  for (const [query, expected] of cases) {
    assert.deepEqual(searchSettings(query, translate).map(entry => entry.target), expected, query)
  }
})

test('SN-04: empty queries return no results and repeated bilingual searches do not mutate the index', () => {
  const before = structuredClone(SETTINGS_SEARCH_ENTRIES)
  for (let trial = 0; trial < 5; trial++) {
    for (const { value: locale } of SUPPORTED_LOCALES) {
      const translate = createTranslator(locale)
      for (const query of ['', ' ', '\t\r\n', '\u3000']) assert.deepEqual(searchSettings(query, translate), [])
      const result = searchSettings(translate(PAGE_LABELS.shortcuts), translate)
      assert.deepEqual(result.map(entry => entry.target), ['prompt-input', 'globalShortcuts', 'windowShortcuts', 'terminalActions', 'terminalFocus', 'tabSwitch'])
      result.pop()
      assert.equal(searchSettings(translate(PAGE_LABELS.shortcuts), translate).length, 6)
    }
  }
  assert.deepEqual(SETTINGS_SEARCH_ENTRIES, before)
})

test('SN-05: vertical category keys wrap at boundaries and Home/End select endpoints', () => {
  const down = [1, 2, 3, 4, 0]
  const up = [4, 0, 1, 2, 3]
  for (let current = 0; current < SETTINGS_PAGES.length; current++) {
    assert.equal(nextSettingsTab(current, 'ArrowDown'), down[current])
    assert.equal(nextSettingsTab(current, 'ArrowUp'), up[current])
    assert.equal(nextSettingsTab(current, 'Home'), 0)
    assert.equal(nextSettingsTab(current, 'End'), 4)
    for (const key of ['Tab', 'Escape', 'Enter', ' ', 'ArrowLeft', 'ArrowRight', 'PageDown', 'a', '']) {
      assert.equal(nextSettingsTab(current, key), null, `${key} must remain available to other handlers`)
    }
  }
  let current = 0
  for (let step = 0; step < 25; step++) current = nextSettingsTab(current, 'ArrowDown')!
  assert.equal(current, 0, 'Repeated complete cycles must retain the original category')
  for (let step = 0; step < 25; step++) current = nextSettingsTab(current, 'ArrowUp')!
  assert.equal(current, 0)
})

test('SN-06: individual shortcut labels locate their owning category in both languages', () => {
  for (const { value: locale } of SUPPORTED_LOCALES) {
    const translate = createTranslator(locale)
    for (const [label, target] of [
      ['settings.shortcut.viewGitDiff', 'terminalActions'],
      ['settings.shortcut.focusPromptEditor', 'windowShortcuts'],
      ['settings.shortcut.changeWorkDir', 'terminalActions']
    ] as const) {
      assert(searchSettings(translate(label), translate).some(result => result.page === 'shortcuts' && result.target === target))
    }
    for (const [key, target, count] of [
      ['settings.shortcut.focusTask', 'terminalFocus', 8], ['settings.shortcut.switchTab', 'tabSwitch', 6]
    ] as const) {
      for (let index = 1; index <= count; index++) {
        assert(searchSettings(translate(key, { index }), translate).some(result => result.target === target))
      }
      assert(!searchSettings(translate(key, { index: count + 1 }), translate).some(result => result.target === target))
    }
  }
})

test('SN-07: a left-anchored panel resizes from its initial width without cumulative drift', () => {
  for (const start of [300, 400, 499, 500, 600]) {
    for (const target of [300, 400, 499, 500, 600]) assert.equal(resizedSettingsWidth(start, target - start), target)
    assert.equal(resizedSettingsWidth(start, -1000), 300)
    assert.equal(resizedSettingsWidth(start, 1000), 600)
  }
})
