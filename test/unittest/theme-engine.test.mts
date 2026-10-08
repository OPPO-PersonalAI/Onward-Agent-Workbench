/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenTheme } from 'monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js'
import { TokenMetadata } from 'monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js'
import { vs, vs_dark } from 'monaco-editor/esm/vs/editor/standalone/common/themes.js'
import { DEFAULT_THEME_SETTINGS, MIGRATION_THEME_SETTINGS, THEME_PRESETS } from '../../src/constants/themes.ts'
import { generateCustomTheme } from '../../src/utils/theme-generator.ts'
import {
  adaptThemeTokenRules, getActiveThemeId, getAvailableThemes, isThemeColor,
  normalizeThemeDefinition, normalizeThemeSettings, resolveTheme, THEME_LIMITS
} from '../../src/themes/theme-engine.ts'
import { FEATURED_THEME_IDS } from '../../src/themes/theme-presets.ts'

function manual(themeId: string) {
  return normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId })
}

test('THEME-U-21 Classic keeps the legacy Markdown code surface while modern themes own theirs', () => {
  const classic = resolveTheme(manual('onward-classic'), true)
  assert.equal(classic.colors['--preview-code-bg'], '#141821')
  assert.equal(classic.colors['--syntax-string'], '#a5d6ff')
  assert.equal(classic.colors['--syntax-keyword'], '#ff7b72')
  assert.notEqual(resolveTheme(manual('light-modern'), false).colors['--preview-code-bg'], '#141821')
})

test('THEME-U-22 imported Diff gutter and overview colors reach the actual editor definition', () => {
  const state = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: 'import-diff', imported: [{
    id: 'import-diff', name: 'Diff palette', kind: 'light', colors: {
      'diffEditorGutter.insertedLineBackground': '#12345678',
      'diffEditorOverview.removedForeground': '#ab1234'
    }
  }] })
  const palette = resolveTheme(state, false)
  assert.equal(palette.editor.colors['diffEditorGutter.insertedLineBackground'], '#12345678')
  assert.equal(palette.editor.colors['diffEditorOverview.removedForeground'], '#ab1234')
})

function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const channels = color.slice(1, 7).match(/../g)!.map(v => parseInt(v, 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('THEME-U-28 inserted/deleted text stays readable on its alpha-composited Diff surfaces', () => {
  for (const id of ['dark-modern', 'light-modern']) {
    const { colors } = resolveTheme(manual(id), false)
    for (const kind of ['add', 'delete']) {
      const tint = colors[`--diff-${kind}-bg`]
      const alpha = parseInt(tint.slice(7, 9), 16) / 255
      for (const token of ['--bg-0', '--bg-1', '--bg-2', '--panel']) {
        const background = '#' + [1, 3, 5].map(offset => Math.round(
          parseInt(tint.slice(offset, offset + 2), 16) * alpha +
          parseInt(colors[token].slice(offset, offset + 2), 16) * (1 - alpha)
        ).toString(16).padStart(2, '0')).join('')
        assert.ok(contrast(colors[`--diff-${kind}-text`], background) >= 4.5, `${id} ${kind} over ${token}`)
      }
    }
    assert.notEqual(colors['--diff-add-text'], colors['--diff-delete-text'], 'Both semantic colors remain distinguishable')
  }
})

test('THEME-U-01 new users follow system; only missing pre-v2 themes migrate to Classic Starlight', () => {
  assert.deepEqual(normalizeThemeSettings(undefined), DEFAULT_THEME_SETTINGS)
  assert.deepEqual(normalizeThemeSettings(undefined, { existing: true, legacyPreV2: true }), MIGRATION_THEME_SETTINGS)
  assert.deepEqual(DEFAULT_THEME_SETTINGS.classic, { mode: 'preset', presetId: 'graphite', custom: null })
  assert.equal(getActiveThemeId(DEFAULT_THEME_SETTINGS, false), 'light-modern')
  assert.equal(getActiveThemeId(DEFAULT_THEME_SETTINGS, true), 'dark-modern')
  assert.equal(resolveTheme(DEFAULT_THEME_SETTINGS, false).kind, 'light')
  assert.equal(resolveTheme(DEFAULT_THEME_SETTINGS, true).editor.base, 'vs-dark')
  const dracula = manual('dracula')
  assert.equal(getActiveThemeId(dracula, false), 'dracula')
  assert.equal(getActiveThemeId(dracula, true), 'dracula')
})

test('THEME-U-02 every legacy preset and custom generator retain all original CSS values', () => {
  for (const preset of THEME_PRESETS) {
    const settings = normalizeThemeSettings({ mode: 'preset', presetId: preset.id, custom: null })
    assert.equal(settings.themeId, 'onward-classic')
    assert.equal(settings.classic.presetId, preset.id)
    const resolved = resolveTheme(settings, false)
    assert.equal(resolved.isClassic, true)
    for (const [key, value] of Object.entries(preset.colors)) assert.equal(resolved.colors[key], value, `${preset.id} ${key}`)
    assert.equal(resolved.terminal.background, '#1e1e1e')
    assert.equal(resolved.terminal.foreground, '#cccccc')
    assert.equal(resolved.terminal.cursor, '#ffffff')
    assert.equal(resolved.terminal.selectionBackground, '#264f78')
  }
  const custom = normalizeThemeSettings({ mode: 'custom', presetId: 'pine', custom: { accent: '#ab12cd' } })
  for (const [key, value] of Object.entries(generateCustomTheme('#ab12cd'))) {
    assert.equal(resolveTheme(custom, true).colors[key], value, key)
  }
})

test('THEME-U-03 migration retains legacy global theme colors and discards every per-Task color', () => {
  const migrated = normalizeThemeSettings(undefined, {
    existing: true,
    globalTerminalStyle: { foregroundColor: '#123456', backgroundColor: '#abcdef', fontSize: 20 },
    terminalStyles: {
      nullColors: { foregroundColor: null, backgroundColor: null },
      partial: { foregroundColor: '#fedcba', backgroundColor: null },
      fontOnly: { fontSize: 16 },
      absent: null,
      empty: {},
      explicit: { foregroundColor: '#abcdef', backgroundColor: '#010203' }
    }
  })
  assert.deepEqual(migrated.overrides['onward-classic'], {
    'terminal.foreground': '#123456', 'terminal.background': '#abcdef'
  })
  assert.equal(migrated.version, 3)
  assert.equal(Object.hasOwn(migrated, 'taskOverrides'), false)
  const resolved = resolveTheme(migrated, true)
  assert.equal(resolved.terminal.foreground, '#123456')
  assert.equal(resolved.terminal.background, '#abcdef')
})

test('THEME-U-04 normalization is idempotent and never reimports stale legacy colors into versioned themes', () => {
  const options = { existing: true, legacyPreV2: true, globalTerminalStyle: { backgroundColor: '#112233' } }
  for (const raw of [undefined, {}, null, { mode: 'custom', custom: { accent: '#ff0033' } }, { version: 2 }, { version: 3 }, { version: 99 }]) {
    const first = normalizeThemeSettings(raw, options)
    assert.equal(first.version, 3)
    assert.deepEqual(normalizeThemeSettings(first, options), first)
    assert.deepEqual(normalizeThemeSettings(JSON.parse(JSON.stringify(first)), options), first)
  }
  const v2 = normalizeThemeSettings({ version: 2 }, options)
  assert.equal(v2.mode, 'system')
  assert.deepEqual(v2.overrides, {})
  assert.deepEqual(normalizeThemeSettings({ version: 99 }, options).overrides, {})
})

test('THEME-U-05 missing, wrong-kind, prototype and builtin-collision IDs fall back safely', () => {
  const settings = normalizeThemeSettings({
    ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: 'missing', lightThemeId: 'dracula', darkThemeId: 'github-light',
    imported: [
      { id: 'dracula', name: 'Spoof', kind: 'light', colors: { 'editor.background': '#ffffff' } },
      { id: '__proto__', name: 'Unsafe', kind: 'dark', colors: {} },
      { id: 'mine', name: 'Mine', kind: 'light', colors: { 'editor.background': '#fafafa' } },
      { id: 'mine', name: 'Duplicate', kind: 'dark', colors: {} }
    ]
  })
  assert.equal(settings.themeId, 'dark-modern')
  assert.equal(settings.lightThemeId, 'light-modern')
  assert.equal(settings.darkThemeId, 'dark-modern')
  assert.deepEqual(settings.imported.map(t => t.id), ['mine'])
  assert.equal(getAvailableThemes(settings).filter(t => t.id === 'dracula').length, 1)
  assert.equal(resolveTheme({ ...settings, themeId: 'toString' }, false).id, 'dark-modern')
  assert.equal(normalizeThemeDefinition({ id: 'light-modern', name: 'Spoof', kind: 'dark', colors: {} }), null)
})

test('THEME-U-06 per-theme overrides preserve independent workbench/editor/terminal colors and alpha', () => {
  const settings = normalizeThemeSettings({
    ...manual('dracula'), overrides: {
      dracula: {
        'onward.background': '#112233', 'onward.foreground': '#aabbcc', 'onward.accent': '#123abc',
        'editor.background': '#223344', 'editor.foreground': '#ddeeff',
        'terminal.background': '#334455', 'terminal.foreground': '#eeffee',
        'terminal.selectionBackground': '#abcd', 'terminal.selectionForeground': '#12345678',
        'terminalCursor.foreground': '#ffffff', 'terminalCursor.background': '#000000',
        'terminal.ansiRed': '#ff0101', 'panel.border': '#987654', 'editor.selectionBackground': '#12345680'
      }, nord: { 'terminal.background': '#ffffff' }
    }
  })
  const result = resolveTheme(settings, false)
  assert.equal(result.id, 'dracula')
  assert.equal(result.colors['--bg-0'], '#112233')
  assert.equal(result.colors['--text-1'], '#aabbcc')
  assert.equal(result.colors['--accent'], '#123abc')
  assert.equal(result.colors['--editor-bg'], '#223344')
  assert.equal(result.editor.colors['editor.foreground'], '#ddeeff')
  assert.equal(result.editor.colors['editor.selectionBackground'], '#12345680')
  assert.equal(result.terminal.background, '#334455')
  assert.equal(result.terminal.foreground, '#eeffee')
  assert.equal(result.terminal.selectionBackground, '#aabbccdd')
  assert.equal(result.terminal.selectionForeground, '#12345678')
  assert.equal(result.terminal.cursorAccent, '#000000')
  assert.equal(result.terminal.red, '#ff0101')
  assert.equal(result.colors['--border'], '#987654')
})

test('THEME-U-07 color validation is portable and does not accept CSS injection or context-dependent values', () => {
  for (const value of ['#123', '#1234', '#123456', '#aBcDeF80']) assert.equal(isThemeColor(value), true)
  for (const value of [null, 0, '#12', '#12345', '#gggggg', '#123456;', 'red', 'var(--x)', 'url(x)', 'inherit', 'transparent', ' #ffffff']) {
    assert.equal(isThemeColor(value), false, String(value))
  }
})

test('THEME-U-08 imports and theme overrides are bounded and pollution-free; retired Task overrides are discarded', () => {
  const poisoned = JSON.parse('{"__proto__":{"polluted":true},"constructor":"#ffffff","editor.background":"#fff","editor.foreground":"url(https://x)","bad;key":"#000"}')
  const settings = normalizeThemeSettings({
    ...manual('dark-modern'), imported: Array.from({ length: THEME_LIMITS.imported + 10 }, (_, i) => ({
      id: `theme-${i}`, name: `Theme ${i}`, kind: 'dark', colors: poisoned,
      tokenColors: Array.from({ length: THEME_LIMITS.tokenRules + 10 }, () => ({ scope: 'comment', settings: { foreground: '#abcdef' } }))
    })),
    overrides: JSON.parse('{"__proto__":{"terminal.background":"#ffffff"},"dark-modern":{"constructor":"#ffffff","terminal.background":"#123456","--bad":"#fff"}}'),
    taskOverrides: { 'dark-modern': {
      okay: { foregroundColor: '#abc', backgroundColor: null, fontSize: 25, command: 'bad' },
      bad: { foregroundColor: 'url(x)' }
    } }
  })
  assert.equal(settings.imported.length, THEME_LIMITS.imported)
  assert.equal(settings.imported[0].tokenColors!.length, THEME_LIMITS.tokenRules)
  assert.deepEqual(settings.imported[0].colors, { 'editor.background': '#ffffff' })
  assert.deepEqual(settings.overrides, { 'dark-modern': { 'terminal.background': '#123456' } })
  assert.equal(Object.hasOwn(settings, 'taskOverrides'), false)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.deepEqual(normalizeThemeSettings(settings), settings)
})

test('THEME-U-29 v2 themes upgrade to v3 without losing named palettes, imports or theme-level overrides', () => {
  const old = {
    ...manual('dracula'), version: 2,
    lightThemeId: 'my-light', darkThemeId: 'nord',
    imported: [{ id: 'my-light', name: 'My Light', kind: 'light', colors: { 'editor.background': '#FAFAFA' } }],
    overrides: { dracula: { 'terminal.foreground': '#ABCDEF' }, 'my-light': { 'terminal.background': '#EEE' } },
    taskOverrides: { dracula: { a: { foregroundColor: '#112233' } }, 'my-light': { a: { backgroundColor: '#445566' } } }
  }
  const before = structuredClone(old)
  const migrated = normalizeThemeSettings(old, {
    existing: true, globalTerminalStyle: { foregroundColor: '#ff0000' },
    terminalStyles: { a: { backgroundColor: '#00ff00' } }
  })
  assert.equal(migrated.version, 3)
  assert.equal(migrated.themeId, 'dracula')
  assert.equal(migrated.lightThemeId, 'my-light')
  assert.equal(migrated.darkThemeId, 'nord')
  assert.deepEqual(migrated.overrides, {
    dracula: { 'terminal.foreground': '#abcdef' }, 'my-light': { 'terminal.background': '#eeeeee' }
  })
  assert.equal(migrated.imported[0].colors['editor.background'], '#fafafa')
  assert.equal(Object.hasOwn(migrated, 'taskOverrides'), false)
  assert.deepEqual(old, before)
  assert.deepEqual(normalizeThemeSettings(JSON.parse(JSON.stringify(migrated))), migrated)
})

test('THEME-U-09 every builtin has readable foreground levels, editor/terminal text and complete ANSI16', () => {
  const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
  const themes = getAvailableThemes(DEFAULT_THEME_SETTINGS)
  assert.equal(new Set(themes.map(t => t.id)).size, 11)
  assert.deepEqual(FEATURED_THEME_IDS, ['dark-modern', 'light-modern', 'dracula', 'one-dark-pro', 'nord', 'solarized-light'])
  for (const theme of themes) {
    const resolved = resolveTheme(manual(theme.id), false)
    assert.equal(resolved.id, theme.id)
    assert.equal(resolved.kind, theme.kind)
    for (const key of ansi) assert.ok(isThemeColor(resolved.terminal[key as keyof typeof resolved.terminal]), `${theme.id}: ANSI ${key}`)
    assert.ok(contrast(resolved.colors['--text-1'], resolved.colors['--bg-0']) >= 4.5, `${theme.id} text`)
    assert.ok(contrast(resolved.terminal.foreground!, resolved.terminal.background!) >= 4.5, `${theme.id} terminal`)
    assert.ok(contrast(resolved.colors['--editor-fg'], resolved.colors['--editor-bg']) >= 4.5, `${theme.id} editor`)
    if (!resolved.isClassic) {
      for (const surface of ['--bg-0', '--bg-1', '--bg-2', '--panel']) {
        for (const level of ['--text-1', '--text-2', '--text-3']) {
          assert.ok(contrast(resolved.colors[level], resolved.colors[surface]) >= 4.5, `${theme.id} ${level}/${surface}`)
        }
      }
    }
    for (const key of ['--syntax-comment', '--syntax-keyword', '--syntax-string', '--syntax-number', '--syntax-function',
      '--syntax-type', '--syntax-variable', '--syntax-operator', '--preview-code-bg', '--diff-add-text', '--diff-delete-bg',
      '--success', '--warning', '--danger', '--background', '--text', '--muted']) assert.ok(resolved.colors[key], `${theme.id} ${key}`)
  }
})

test('THEME-U-10 syntax adaptation maps common categories and reports unsupported selectors', () => {
  const adapted = adaptThemeTokenRules([
    { scope: 'comment', settings: { foreground: '#123456', fontStyle: 'italic' } },
    { scope: ['keyword.control', 'storage.type'], settings: { foreground: '#abcdef', fontStyle: 'bold' } },
    { scope: 'entity.name.function, support.function', settings: { foreground: '#22bb33' } },
    { scope: 'comment.line', settings: { foreground: '#223344', fontStyle: '' } },
    { scope: 'made.up.scope', settings: { foreground: '#000000' } },
    { scope: 'source.js meta.function', settings: { foreground: '#000000' } },
    { scope: 'string', settings: { foreground: '#11223380', background: '#ffffff' } }
  ], 'dark')
  assert.deepEqual(adapted.rules.find(r => r.token === 'comment'), { token: 'comment', foreground: '223344', fontStyle: '' })
  assert.equal(adapted.rules.find(r => r.token === 'keyword')?.foreground, 'abcdef')
  assert.equal(adapted.rules.find(r => r.token === 'type')?.foreground, 'abcdef')
  assert.equal(adapted.syntax['--syntax-function'], '#22bb33')
  assert.ok(adapted.unsupported.includes('made.up.scope'))
  assert.ok(adapted.unsupported.includes('source.js meta.function'))
  assert.ok(adapted.unsupported.some(v => v.includes('background')))
  assert.ok(adapted.unsupported.some(v => v.includes('alpha')))
  assert.ok(adapted.rules.every(r => !r.foreground || /^[\da-f]{6}$/i.test(r.foreground)))
})

test('THEME-U-11 imports resolve by stable identity, preserve syntax, and never mutate input or builtin palettes', () => {
  const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: 'my-light',
    imported: [{ id: 'my-light', name: 'My Light', kind: 'light', colors: { 'editor.background': '#ffffff', 'editor.foreground': '#222222' },
      tokenColors: [{ scope: 'string', settings: { foreground: '#123456' } }] }],
    overrides: { 'my-light': { 'terminal.background': '#efefef' } }
  })
  const before = JSON.stringify(settings)
  const a = resolveTheme(settings, true)
  assert.equal(a.id, 'my-light')
  assert.equal(a.editor.base, 'vs')
  assert.equal(a.editor.rules.find(r => r.token === 'string')?.foreground, '123456')
  a.colors['--bg-0'] = '#000000'
  a.terminal.background = '#000000'
  assert.equal(JSON.stringify(settings), before)
  assert.equal(resolveTheme(settings, true).terminal.background, '#efefef')
  const available = getAvailableThemes(settings)
  available[0].colors['editor.background'] = '#ff00ff'
  assert.notEqual(resolveTheme(manual(available[0].id), false).editor.colors['editor.background'], '#ff00ff')
})

test('THEME-U-12 sparse imports derive terminal and workbench from their own editor colors', () => {
  const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: 'sepia',
    imported: [{ id: 'sepia', name: 'Sepia', kind: 'light', colors: {
      'editor.background': '#efe5cf', 'editor.foreground': '#332211', 'editor.selectionBackground': '#c0a08080'
    } }]
  })
  const resolved = resolveTheme(settings, true)
  assert.equal(resolved.colors['--bg-0'], '#efe5cf')
  assert.equal(resolved.colors['--bg-1'], '#efe5cf')
  assert.equal(resolved.colors['--text-1'], '#332211')
  assert.equal(resolved.terminal.background, '#efe5cf')
  assert.equal(resolved.terminal.foreground, '#332211')
  assert.equal(resolved.terminal.cursor, '#332211')
  assert.equal(resolved.terminal.cursorAccent, '#efe5cf')
  assert.equal(resolved.terminal.selectionBackground, '#c0a08080')
})

test('THEME-U-13 builtin identities carry their distinctive palettes across all consumers', () => {
  const identities = [
    ['dark-modern', '#1f1f1f', '#c586c0', '#2472c8'],
    ['light-modern', '#ffffff', '#af00db', '#0451a5'],
    ['dracula', '#282a36', '#ff79c6', '#bd93f9'],
    ['one-dark-pro', '#282c34', '#c678dd', '#4aa5f0'],
    ['nord', '#2e3440', '#81a1c1', '#81a1c1'],
    ['solarized-light', '#fdf6e3', '#859900', '#268bd2'],
    ['solarized-dark', '#002b36', '#859900', '#268bd2'],
    ['github-light', '#ffffff', '#cf222e', '#0969da'],
    ['github-dark', '#0d1117', '#ff7b72', '#58a6ff'],
    ['monokai', '#272822', '#f92672', '#6a7ec8']
  ]
  for (const [id, background, keyword, blue] of identities) {
    const resolved = resolveTheme(manual(id), false)
    assert.equal(resolved.colors['--bg-0'], background, id)
    assert.equal(resolved.colors['--editor-bg'], background, id)
    assert.equal(resolved.terminal.background, background, id)
    assert.equal(resolved.terminal.blue, blue, id)
    assert.equal(resolved.colors['--syntax-keyword'], keyword, id)
    assert.equal(resolved.editor.rules.find(rule => rule.token === 'keyword')?.foreground, keyword.slice(1), id)
  }
})

test('THEME-U-14 hyphenated common scopes are supported; complex selectors remain diagnosed', () => {
  const adapted = adaptThemeTokenRules([
    { scope: 'entity.other.attribute-name.html', settings: { foreground: '#123456' } },
    { scope: 'string.quoted.double', settings: { foreground: '#654321' } },
    { scope: 'comment - comment.block', settings: { foreground: '#abcdef' } }
  ], 'light')
  assert.equal(adapted.rules.find(rule => rule.token === 'attribute.name')?.foreground, '123456')
  assert.equal(adapted.rules.find(rule => rule.token === 'string')?.foreground, '654321')
  assert.ok(adapted.unsupported.includes('comment - comment.block'))
  assert.ok(adapted.unsupported.some(message => message.startsWith('approximation:') && message.includes('string.quoted.double')))
})

test('THEME-U-15 Classic retains the entire original terminal palette, including inactive selection', () => {
  assert.deepEqual(resolveTheme(MIGRATION_THEME_SETTINGS, false).terminal, {
    background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#000000',
    selectionBackground: '#264f78', selectionForeground: '#ffffff', selectionInactiveBackground: '#3a3d41',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8',
    magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666',
    brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea',
    brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5'
  })
})

test('THEME-U-27 Markdown code keeps the intended editor backdrop for syntax contrast', () => {
  for (const id of ['dark-modern', 'light-modern']) {
    const theme = resolveTheme(manual(id), false)
    assert.equal(theme.colors['--preview-code-bg'], theme.editor.colors['editor.background'])
    const luminance = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const values = [theme.colors['--syntax-comment'], theme.colors['--preview-code-bg']].map(luminance)
    assert.ok((Math.max(...values) + 0.05) / (Math.min(...values) + 0.05) >= 4.5, `${id} comment remains readable`)
  }
})

test('THEME-U-16 independent historical migration table distinguishes schema versions and raw theme truthiness', () => {
  const cases = [
    { label: 'missing', raw: undefined, oldPreset: 'starlight', laterPreset: 'graphite' },
    { label: 'null', raw: null, oldPreset: 'starlight', laterPreset: 'graphite' },
    { label: 'false', raw: false, oldPreset: 'starlight', laterPreset: 'graphite' },
    { label: 'zero', raw: 0, oldPreset: 'starlight', laterPreset: 'graphite' },
    { label: 'empty string', raw: '', oldPreset: 'starlight', laterPreset: 'graphite' },
    { label: 'empty object', raw: {}, oldPreset: 'graphite', laterPreset: 'graphite' },
    { label: 'array', raw: [], oldPreset: 'graphite', laterPreset: 'graphite' },
    { label: 'truthy invalid string', raw: 'broken', oldPreset: 'graphite', laterPreset: 'graphite' },
    { label: 'invalid preset', raw: { mode: 'preset', presetId: 'missing' }, oldPreset: 'graphite', laterPreset: 'graphite' },
    { label: 'custom without accent', raw: { mode: 'custom' }, oldPreset: 'graphite', laterPreset: 'graphite' },
    { label: 'invalid custom preserves preset', raw: { mode: 'custom', presetId: 'pine', custom: { accent: 'bad' } }, oldPreset: 'pine', laterPreset: 'pine' },
    { label: 'legacy short hex was invalid', raw: { mode: 'custom', custom: { accent: '#abc' } }, oldPreset: 'graphite', laterPreset: 'graphite' },
    { label: 'legacy alpha hex was invalid', raw: { mode: 'custom', custom: { accent: '#11223380' } }, oldPreset: 'graphite', laterPreset: 'graphite' },
    { label: 'valid preset', raw: { mode: 'preset', presetId: 'umber' }, oldPreset: 'umber', laterPreset: 'umber' }
  ]
  // These are persisted settings-schema versions, not ThemeSettings.version.
  for (const version of [undefined, 0, 1, 2, 3, 4, 5, 6, 7]) {
    for (const row of cases) {
      const legacyPreV2 = (version ?? 0) < 2
      const options = { existing: true, legacyPreV2 }
      const result = normalizeThemeSettings(row.raw, options)
      const label = `${row.label}, settings v${version ?? 'absent'}`
      assert.equal(result.mode, 'manual', label)
      assert.equal(result.themeId, 'onward-classic', label)
      assert.deepEqual(result.classic, { mode: 'preset', presetId: legacyPreV2 ? row.oldPreset : row.laterPreset, custom: null }, label)
      assert.deepEqual(normalizeThemeSettings(result, options), result, `${label}: migration is one-way`)
    }
  }
  assert.equal(normalizeThemeSettings(undefined, { existing: true }).classic.presetId, 'graphite')
  for (const mode of ['preset', 'custom'] as const) {
    const result = normalizeThemeSettings({ mode, custom: { accent: '#Ab12Cd' } }, { existing: true, legacyPreV2: true })
    assert.deepEqual(result.classic, { mode, presetId: 'graphite', custom: { accent: '#ab12cd' } })
  }
  const current = normalizeThemeSettings({ version: 2 }, { existing: true, legacyPreV2: true })
  assert.equal(current.mode, 'system')
  assert.deepEqual(current.classic, { mode: 'preset', presetId: 'graphite', custom: null })
})

test('THEME-U-17 omitted and empty scopes preserve default token style and explicit style reset', () => {
  const adapted = adaptThemeTokenRules([
    { settings: { foreground: '#abcdef', fontStyle: 'italic bold' } },
    { scope: 'comment', settings: { foreground: '#123456', fontStyle: 'italic' } },
    { scope: '', settings: { fontStyle: '' } },
    { scope: '  ', settings: { foreground: '#fedcba' } }
  ], 'dark')
  assert.deepEqual(adapted.rules.find(rule => rule.token === ''), { token: '', foreground: 'fedcba', fontStyle: '' })
  assert.deepEqual(adapted.rules.find(rule => rule.token === 'comment'), { token: 'comment', foreground: '123456', fontStyle: 'italic' })
  assert.deepEqual(adapted.unsupported, [])
  const settings = normalizeThemeSettings({ ...manual('default-token'), imported: [{
    id: 'default-token', name: 'Default token', kind: 'dark', colors: {},
    tokenColors: [{ settings: { foreground: '#13579b', fontStyle: 'bold' } }, { scope: '', settings: { fontStyle: '' } }]
  }], themeId: 'default-token' })
  assert.deepEqual(resolveTheme(settings, false).editor.rules.find(rule => rule.token === ''), {
    token: '', foreground: '13579b', fontStyle: ''
  })
})

test('THEME-U-18 more-specific category colors survive later broad rules and report the lossy mapping', () => {
  const specific = { scope: 'comment.line', settings: { foreground: '#aabbcc' } }
  const broad = { scope: 'comment', settings: { foreground: '#112233', fontStyle: 'italic' } }
  for (const rules of [[specific, broad], [broad, specific]]) {
    const adapted = adaptThemeTokenRules(rules, 'dark')
    assert.deepEqual(adapted.rules.find(rule => rule.token === 'comment'), {
      token: 'comment', foreground: 'aabbcc', fontStyle: 'italic'
    })
    assert.equal(adapted.syntax['--syntax-comment'], '#aabbcc')
    assert.ok(adapted.unsupported.some(message => message.startsWith('approximation:') && message.includes('comment.line')))
    const imported = normalizeThemeDefinition({ id: 'collision', name: 'Collision', kind: 'dark', colors: {}, tokenColors: rules })!
    assert.deepEqual(imported.unsupported, adapted.unsupported)
    assert.deepEqual(normalizeThemeDefinition(imported), imported)
  }
})

test('THEME-U-19 specificity is per property; explicit resets win ties and cannot be overwritten by a broad style', () => {
  const adapted = adaptThemeTokenRules([
    { scope: 'comment.line', settings: { fontStyle: 'italic' } },
    { scope: 'comment.line', settings: { fontStyle: '' } },
    { scope: 'comment', settings: { foreground: '#445566', fontStyle: 'bold' } },
    { scope: 'comment.line', settings: { foreground: '#aabbcc' } },
    { scope: 'comment.line', settings: { foreground: '#ddeeff' } }
  ], 'dark')
  assert.deepEqual(adapted.rules.find(rule => rule.token === 'comment'), {
    token: 'comment', foreground: 'ddeeff', fontStyle: ''
  })
  assert.equal(adapted.syntax['--syntax-comment'], '#ddeeff')
  assert.ok(adapted.unsupported.some(message => message.startsWith('approximation:')))
})

test('THEME-U-20 supported common categories preserve foregrounds/styles and ignore empty entries in scope lists', () => {
  const adapted = adaptThemeTokenRules([
    { scope: 'comment', settings: { foreground: '#123456', fontStyle: 'italic' } },
    { scope: ['string', 'constant.numeric'], settings: { foreground: '#abcdef' } },
    { scope: ', keyword, , variable, ', settings: { foreground: '#fedcba', fontStyle: 'bold underline' } },
    { scope: 'keyword', settings: { fontStyle: '' } }
  ], 'light')
  assert.deepEqual(adapted.rules, [
    { token: 'comment', foreground: '123456', fontStyle: 'italic' },
    { token: 'string', foreground: 'abcdef' },
    { token: 'number', foreground: 'abcdef' },
    { token: 'keyword', foreground: 'fedcba', fontStyle: '' },
    { token: 'variable', foreground: 'fedcba', fontStyle: 'bold underline' }
  ])
  assert.equal(adapted.syntax['--syntax-keyword'], '#fedcba')
  assert.equal(adapted.rules.some(rule => rule.token === ''), false)
  assert.deepEqual(adapted.unsupported, [])
})

function matchMonacoToken(theme: ReturnType<typeof resolveTheme>, token = '') {
  // Use Monaco's real matcher with the same inheritance order as StandaloneTheme.tokenTheme.
  const builtin = theme.editor.base === 'vs' ? vs : vs_dark
  const matcher = TokenTheme.createFromRawTokenTheme([
    ...builtin.rules,
    { token: '', foreground: theme.editor.colors['editor.foreground'], background: theme.editor.colors['editor.background'] },
    ...theme.editor.rules
  ], [])
  const metadata = matcher.match(0, token)
  return {
    foreground: matcher.getColorMap()[TokenMetadata.getForeground(metadata)].toString(),
    fontStyle: TokenMetadata.getFontStyle(metadata)
  }
}

test('THEME-U-23 Monaco default-token foreground agrees with resolution before, during and after an override', () => {
  for (const kind of ['light', 'dark'] as const) {
    for (const scope of [undefined, '', '  ']) {
      const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: 'default-token', imported: [{
        id: 'default-token', name: 'Default token', kind,
        colors: { 'editor.background': '#ffffff', 'editor.foreground': '#333333' },
        tokenColors: [
          { ...(scope === undefined ? {} : { scope }), settings: { foreground: '#ff0000', fontStyle: 'italic bold' } },
          { scope: 'comment', settings: { foreground: '#008000', fontStyle: '' } }
        ]
      }] })
      const before = JSON.stringify(settings)
      for (const [override, expected] of [[undefined, '#ff0000'], ['#0000ff', '#0000ff'], ['#0000ff80', '#7f7fff'], [undefined, '#ff0000']] as const) {
        const resolved = resolveTheme({ ...settings, overrides: override ? { 'default-token': { 'editor.foreground': override } } : {} }, false)
        assert.equal(resolved.editor.colors['editor.foreground'], expected)
        assert.equal(resolved.colors['--editor-fg'], expected)
        assert.deepEqual(matchMonacoToken(resolved), { foreground: expected, fontStyle: 3 })
        assert.deepEqual(matchMonacoToken(resolved, 'comment'), { foreground: '#008000', fontStyle: 0 })
      }
      assert.equal(JSON.stringify(settings), before, 'Resolution must not rewrite the imported snapshot')
    }
  }
})

test('THEME-U-24 foreground overrides preserve default font-style resets and style-only defaults', () => {
  for (const foreground of [undefined, '#ff0000']) {
    const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: 'style-only', imported: [{
      id: 'style-only', name: 'Style-only default', kind: 'light', colors: {},
      tokenColors: [
        { settings: { ...(foreground ? { foreground } : {}), fontStyle: 'italic bold' } },
        { scope: '', settings: { fontStyle: '' } }
      ]
    }], overrides: { 'style-only': { 'editor.foreground': '#0000ff' } } })
    const resolved = resolveTheme(settings, false)
    assert.equal(resolved.editor.rules.find(rule => rule.token === '')?.fontStyle, '')
    assert.deepEqual(matchMonacoToken(resolved), { foreground: '#0000ff', fontStyle: 0 })
  }
})

test('THEME-U-25 sparse accents prefer explicit overrides and definitions before builtin fallbacks', () => {
  const cases: Array<{ defined: Record<string, string>; overrides: Record<string, string>; expected: string }> = [
    { defined: {}, overrides: {}, expected: '#005fb8' },
    { defined: { focusBorder: '#aa0000' }, overrides: {}, expected: '#aa0000' },
    { defined: { focusBorder: '#aa000080' }, overrides: {}, expected: '#d47f7f' },
    { defined: { focusBorder: '#aa0000', 'textLink.foreground': '#00aa00' }, overrides: {}, expected: '#00aa00' },
    { defined: { focusBorder: '#aa0000', 'onward.accent': '#0000aa' }, overrides: {}, expected: '#0000aa' },
    { defined: { 'onward.accent': '#0000aa', 'textLink.foreground': '#00aa00' }, overrides: { focusBorder: '#aa0000' }, expected: '#aa0000' },
    { defined: { focusBorder: '#aa0000' }, overrides: { focusBorder: '#123456', 'textLink.foreground': '#00aa00' }, expected: '#00aa00' },
    { defined: { focusBorder: '#aa0000' }, overrides: { 'textLink.foreground': '#00aa00', 'onward.accent': '#0000aa' }, expected: '#0000aa' }
  ]
  for (const row of cases) {
    const settings = normalizeThemeSettings({ ...DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: 'sparse', imported: [{
      id: 'sparse', name: 'Sparse light', kind: 'light', colors: { 'editor.background': '#ffffff', ...row.defined }
    }], overrides: { sparse: row.overrides } })
    const resolved = resolveTheme(settings, false)
    assert.equal(resolved.colors['--accent'], row.expected, JSON.stringify(row))
    assert.equal(resolved.editor.colors.focusBorder, row.overrides.focusBorder ?? row.defined.focusBorder ?? '#005fb8')
  }
})

test('THEME-U-26 Monaco receives global foreground and focusBorder without changing Classic accent ownership', () => {
  const settings = normalizeThemeSettings({ ...manual('light-modern'), overrides: {
    'light-modern': { foreground: '#123456', focusBorder: '#654321' },
    'onward-classic': { focusBorder: '#654321' }
  } })
  const resolved = resolveTheme(settings, false)
  assert.equal(resolved.editor.colors.foreground, '#123456')
  assert.equal(resolved.editor.colors.focusBorder, '#654321')
  assert.equal(resolved.colors['--accent'], '#654321')
  const classic = resolveTheme({ ...settings, themeId: 'onward-classic' }, false)
  assert.equal(classic.colors['--accent'], THEME_PRESETS.find(preset => preset.id === 'graphite')!.colors['--accent'])
  assert.equal(classic.editor.colors.focusBorder, '#654321')
})
