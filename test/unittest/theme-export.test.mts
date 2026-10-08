/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createThemeExport } from '../../src/themes/theme-export.ts'
import { normalizeThemeSettings, resolveTheme } from '../../src/themes/theme-engine.ts'
import { BUILTIN_THEMES, ANSI_COLOR_NAMES } from '../../src/themes/theme-presets.ts'
import { DEFAULT_THEME_SETTINGS } from '../../src/constants/themes.ts'
import { parseThemeImport } from '../../electron/main/theme-import-parser.ts'

const parse = (text: string) => parseThemeImport('export-color-theme.json', async () => ({ text, identity: 'export-color-theme.json' }))

test('TEX-01: every bundled palette exports a standalone VS Code theme with effective terminal/editor colors', async () => {
  for (const theme of BUILTIN_THEMES) {
    const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: theme.id })
    const before = resolveTheme(settings, false)
    const original = JSON.stringify(settings)
    const exported = createThemeExport(settings, theme.id)
    const json = JSON.parse(exported.text)
    assert.deepEqual(Object.keys(json), ['$schema', 'name', 'type', 'colors', 'tokenColors'])
    assert.equal(json.type, theme.kind)
    assert.equal(json.colors['editor.background'], before.editor.colors['editor.background'])
    assert.equal(json.colors['editor.foreground'], before.editor.colors['editor.foreground'])
    assert.equal(json.colors['terminal.background'], before.terminal.background)
    assert.equal(json.colors['terminal.foreground'], before.terminal.foreground)
    for (const name of ANSI_COLOR_NAMES) assert.equal(json.colors[`terminal.ansi${name}`], before.terminal[(name[0].toLowerCase() + name.slice(1)) as keyof typeof before.terminal])
    const [imported] = await parse(exported.text)
    const after = resolveTheme(normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, imported: [imported], mode: 'manual', themeId: imported.id }), false)
    for (const key of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) assert.equal(after.terminal[key], before.terminal[key], `${theme.id}: ${key}`)
    assert.equal(JSON.stringify(settings), original)
    assert(exported.filename.endsWith('-color-theme.json'))
  }
})

test('TEX-02: saved customization overrides imported syntax defaults without exporting settings or Onward-only tokens', async () => {
  const text = await readFile(new URL('../autotest/fixtures/themes-ui/acceptance-midnight.json', import.meta.url), 'utf8')
  const [imported] = await parse(text)
  const state = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, imported: [imported], overrides: {
    [imported.id]: { 'onward.background': '#123456', 'onward.foreground': '#fedcba', 'onward.accent': '#bb3377',
      'editor.background': '#172839', 'editor.foreground': '#f1e2d3', 'terminal.foreground': '#12abcd',
      'terminal.selectionBackground': '#12345680', 'terminal.ansiRed': '#ff1234' }
  } })
  const json = JSON.parse(createThemeExport(state, imported.id).text)
  assert.equal(json.colors['sideBar.background'], '#123456')
  assert.equal(json.colors['editor.background'], '#172839')
  assert.equal(json.colors['foreground'], '#fedcba')
  assert.equal(json.colors['focusBorder'], '#bb3377')
  assert.equal(json.colors['terminal.selectionBackground'], '#12345680')
  assert.equal(json.colors['terminal.ansiRed'], '#ff1234')
  assert.deepEqual(json.tokenColors, imported.tokenColors)
  assert(!Object.keys(json.colors).some(key => key.startsWith('onward.')))
  for (const key of ['include', 'source', 'imported', 'taskOverrides', 'overrides', 'fontSize', 'classic', 'themeId']) assert(!(key in json))
  const [roundtrip] = await parse(JSON.stringify(json))
  assert.equal(roundtrip.colors['editor.foreground'], '#f1e2d3')
})

test('TEX-03: unscoped token foreground cannot undo an explicit editor foreground on reimport', async () => {
  const theme = { id: 'import-default', name: 'Default style', kind: 'light', colors: { 'editor.foreground': '#112233' }, tokenColors: [
    { settings: { foreground: '#223344', fontStyle: 'italic' } },
    { scope: 'keyword', settings: { foreground: '#778899' } }
  ] }
  const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, imported: [theme], overrides: { [theme.id]: { 'editor.foreground': '#345678' } } })
  const [imported] = await parse(createThemeExport(settings, theme.id).text)
  const resolved = resolveTheme(normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, imported: [imported], mode: 'manual', themeId: imported.id }), false)
  assert.equal(resolved.editor.colors['editor.foreground'], '#345678')
  assert.equal(resolved.editor.rules.find(rule => rule.token === '')?.fontStyle, 'italic')
  assert.equal(resolved.editor.rules.find(rule => rule.token === 'keyword')?.foreground, '778899')
})

test('TEX-04: unknown identities reject and cross-platform filenames contain no reserved punctuation', () => {
  assert.throws(() => createThemeExport(DEFAULT_THEME_SETTINGS, 'missing'), /invalid-theme/)
  const theme = { id: 'import-filename', name: 'CON<>:"/\\|?* .', kind: 'dark', colors: {} }
  const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, imported: [theme] })
  const { filename } = createThemeExport(settings, theme.id)
  assert(!/[<>:"/\\|?*\u0000-\u001f]/.test(filename))
  assert(!/^(CON|NUL|PRN|AUX)\./i.test(filename))
  for (const name of ['CON.theme', 'nul.THEME', 'LPT1.dark', 'COM2', 'AUX.palette', 'COM¹.theme']) {
    const renamed = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, imported: [{ ...theme, name }] })
    assert(createThemeExport(renamed, theme.id).filename.startsWith('theme-'), name)
  }
})
