/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPreviewPalette, buildPdfThemeVars, buildPdfViewerStrings, buildMermaidTheme, buildEpubThemeCss, shouldApplyMermaidResult } from '../../src/utils/preview-theme.ts'
import { createTranslator } from '../../src/i18n/core.ts'
import { readFileSync } from 'node:fs'

const lightTokens: Record<string, string> = {
  '--bg-0': '#ffffff', '--bg-1': '#f8f8f8', '--bg-2': '#eeeeee',
  '--panel': '#fafafa', '--text-1': '#202020', '--text-2': '#454545',
  '--text-3': '#606060', '--border': '#cccccc', '--border-strong': '#999999',
  '--accent': '#005fcc', '--preview-code-bg': '#f0f0f0', '--shadow-1': 'none'
}

test('reader and compare dictionaries cover the real PDF viewer contract in both supported languages', () => {
  const viewer = readFileSync(new URL('../../resources/pdfjs/app/viewer.js', import.meta.url), 'utf8')
  const defaults = viewer.match(/const I18N_DEFAULTS = \{([\s\S]*?)\n\};/)?.[1]
  assert.ok(defaults, 'Read the actual embedded viewer dictionary')
  const fields = [...defaults.matchAll(/^  (\w+):/gm)].map(match => match[1]).sort()
  for (const locale of ['en', 'zh-CN'] as const) {
    const strings = buildPdfViewerStrings(createTranslator(locale))
    assert.deepEqual(Object.keys(strings).sort(), fields, 'Every viewer field must be localized by both hosts')
    assert.ok(Object.values(strings).every(value => value && !value.startsWith('projectEditor.')))
    assert.notEqual(strings.colorToggleOn, strings.colorToggleOff)
    assert.notEqual(strings.colorToggleTitleOn, strings.colorToggleTitleOff)
  }
  const en = buildPdfViewerStrings(createTranslator('en'))
  const zh = buildPdfViewerStrings(createTranslator('zh-CN'))
  for (const field of fields) assert.notEqual(en[field], zh[field], `${field} has both translations`)
})

test('reader palette maps canonical app tokens without requiring legacy aliases', () => {
  const palette = buildPreviewPalette(name => lightTokens[name] ?? '', 'light')
  assert.equal(palette.background, '#ffffff')
  assert.equal(palette.foreground, '#202020')
  assert.equal(palette.muted, '#606060')
  assert.equal(palette.elevated, '#eeeeee')
  assert.equal(palette.code, '#f0f0f0')
  const pdf = buildPdfThemeVars(palette)
  assert.equal(pdf['--onward-pdf-text'], '#202020')
  assert.equal(pdf['--onward-pdf-bg'], '#ffffff')
  assert.equal(pdf['--onward-pdf-line'], '#cccccc')
  assert.equal(pdf['--onward-pdf-panel-elevated'], '#eeeeee')
  assert.ok(Object.values(pdf).every(value => value.trim().length > 0))
  assert.ok(!Object.keys(pdf).some(key => /invert|enhancement|filter/.test(key)))
})

test('missing or whitespace tokens use appearance-appropriate readable defaults', () => {
  const light = buildPreviewPalette(() => '  ', 'light')
  const dark = buildPreviewPalette(() => '', 'dark')
  assert.equal(light.background, '#ffffff')
  assert.equal(light.foreground, '#202020')
  assert.equal(dark.background, '#101012')
  assert.equal(dark.foreground, '#e8e8ec')
})

test('Mermaid theme changes same-ID draft colors without depending on the preset ID', () => {
  const first = buildPreviewPalette(name => lightTokens[name] ?? '', 'light')
  const second = buildPreviewPalette(name => name === '--accent' ? '#884400' : lightTokens[name] ?? '', 'light')
  const a = buildMermaidTheme(first)
  const b = buildMermaidTheme(second)
  assert.equal(a.theme, 'base')
  assert.equal(a.themeVariables.darkMode, false)
  assert.equal(a.themeVariables.primaryTextColor, '#202020')
  assert.equal(a.themeVariables.primaryBorderColor, '#005fcc')
  assert.notDeepEqual(a, b)
  assert.equal(buildMermaidTheme(buildPreviewPalette(() => '', 'dark')).themeVariables.darkMode, true)
})

test('Mermaid never commits a canceled, detached, superseded, or content-replaced result', () => {
  const valid = { canceled: false, connected: true, currentGeneration: 4, generation: 4, source: 'graph TD; A-->B', currentSource: 'graph TD; A-->B' }
  assert.equal(shouldApplyMermaidResult(valid), true)
  for (const patch of [{ canceled: true }, { connected: false }, { currentGeneration: 5 }, { currentSource: 'graph TD; A-->C' }]) {
    assert.equal(shouldApplyMermaidResult({ ...valid, ...patch }), false)
  }
})

test('EPUB replacement stylesheet preserves reading typography and never changes image colors or font zoom', () => {
  const css = buildEpubThemeCss(buildPreviewPalette(name => lightTokens[name] ?? '', 'light'))
  assert.match(css, /html, body\s*\{[^}]*color: #202020/s)
  assert.match(css, /a\s*\{[^}]*color: #005fcc/s)
  assert.match(css, /blockquote\s*\{[^}]*color: #606060/s)
  assert.match(css, /code\s*\{[^}]*background: #f0f0f0/s)
  assert.ok(!/font-size|filter:|!important/.test(css))
  assert.match(css, /img\s*\{ max-width: 100%; height: auto; \}/)
})
