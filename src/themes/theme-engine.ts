/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITheme } from '@xterm/xterm'
import type { LegacyThemeSettings, ResolvedTheme, ThemeColors, ThemeDefinition, ThemeSettings, ThemeTokenRule } from '../types/theme'
import { DEFAULT_THEME_SETTINGS, getThemePreset, PRESET_IDS } from '../constants/themes.ts'
import { generateCustomTheme } from '../utils/theme-generator.ts'
import { ANSI_COLOR_NAMES, BUILTIN_THEMES, CLASSIC_TERMINAL_THEME, CLASSIC_THEME_ID } from './theme-presets.ts'
import { normalizeThemeSchedule, resolveThemeSchedule } from './theme-schedule.ts'

export { FEATURED_THEME_IDS } from './theme-presets.ts'

export const THEME_LIMITS = Object.freeze({ imported: 32, colors: 512, tokenRules: 512, scopesPerRule: 32, tasks: 2048, unsupported: 100 })
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map(theme => theme.id))
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const EMPTY_RECORD: Record<string, unknown> = Object.freeze({})

export interface NormalizeThemeOptions {
  existing?: boolean
  /** Persisted settings predate schema v2; only a falsy legacy theme used Starlight. */
  legacyPreV2?: boolean
  terminalStyles?: Record<string, unknown>
  globalTerminalStyle?: unknown
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_RECORD
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : EMPTY_RECORD
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
}

function safeKey(key: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key) && !key.split(/[.:]/).some(part => UNSAFE_KEYS.has(part))
}

function entries(value: unknown, limit: number): Array<[string, unknown]> {
  const result: Array<[string, unknown]> = []
  const object = record(value)
  let visited = 0
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue
    if (visited++ >= limit) break
    if (safeKey(key)) result.push([key, object[key]])
  }
  return result
}

/** Only portable VS Code hex colors are accepted; CSS expressions have no place in persisted palettes. */
export function isThemeColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
}

function color(value: unknown): string | undefined {
  if (!isThemeColor(value)) return undefined
  const hex = value.toLowerCase()
  return hex.length <= 5 ? '#' + hex.slice(1).split('').map(char => char + char).join('') : hex
}

function colorMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, raw] of entries(value, THEME_LIMITS.colors)) {
    const normalized = color(raw)
    if (normalized) result[key] = normalized
  }
  return result
}

function tokenRules(value: unknown): ThemeTokenRule[] {
  if (!Array.isArray(value)) return []
  const result: ThemeTokenRule[] = []
  for (const raw of value.slice(0, THEME_LIMITS.tokenRules)) {
    const rule = record(raw)
    const settings = record(rule.settings)
    const normalized: ThemeTokenRule = { settings: {} }
    if (typeof rule.scope === 'string' && rule.scope.length <= 512) normalized.scope = rule.scope
    else if (Array.isArray(rule.scope)) normalized.scope = rule.scope.slice(0, THEME_LIMITS.scopesPerRule)
      .filter((scope): scope is string => typeof scope === 'string' && scope.length <= 512)
    else if (rule.scope !== undefined) continue
    const foreground = color(settings.foreground)
    const background = color(settings.background)
    if (foreground) normalized.settings.foreground = foreground
    if (background) normalized.settings.background = background
    if (typeof settings.fontStyle === 'string' && settings.fontStyle.length <= 80) {
      normalized.settings.fontStyle = settings.fontStyle.split(/\s+/).filter(style => ['italic', 'bold', 'underline', 'strikethrough'].includes(style)).join(' ')
    }
    if (Object.keys(normalized.settings).length) result.push(normalized)
  }
  return result
}

/** Sanitize one imported definition. Builtin IDs are reserved and cannot be replaced by a file import. */
export function normalizeThemeDefinition(raw: unknown): ThemeDefinition | null {
  const input = record(raw)
  if (typeof input.id !== 'string' || !safeKey(input.id) || BUILTIN_IDS.has(input.id)) return null
  if (input.kind !== 'light' && input.kind !== 'dark') return null
  if (typeof input.name !== 'string' || !input.name.trim()) return null
  const result: ThemeDefinition = {
    id: input.id, name: input.name.trim().slice(0, 128), kind: input.kind, colors: colorMap(input.colors)
  }
  if (Array.isArray(input.tokenColors)) result.tokenColors = tokenRules(input.tokenColors)
  if (typeof input.source === 'string') result.source = input.source.slice(0, 512)
  const unsupported = Array.isArray(input.unsupported)
    ? input.unsupported.slice(0, THEME_LIMITS.unsupported).filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 256)) : []
  const adaptation = adaptThemeTokenRules(result.tokenColors ?? [], result.kind)
  if (unsupported.length || adaptation.unsupported.length) {
    result.unsupported = [...new Set([...unsupported, ...adaptation.unsupported])].slice(0, THEME_LIMITS.unsupported)
  }
  return result
}

function classicSettings(raw: unknown, fallback: LegacyThemeSettings['presetId'] = 'graphite'): LegacyThemeSettings {
  const input = record(raw)
  const accent = record(input.custom).accent
  // The original Classic validator accepted six-digit hex only, including during migration.
  const custom = typeof accent === 'string' && /^#[\da-f]{6}$/i.test(accent) ? { accent: accent.toLowerCase() } : null
  return {
    mode: input.mode === 'custom' && custom ? 'custom' : 'preset',
    presetId: typeof input.presetId === 'string' && PRESET_IDS.has(input.presetId)
      ? input.presetId as LegacyThemeSettings['presetId'] : fallback,
    custom
  }
}

function freshSettings(): ThemeSettings {
  return { ...DEFAULT_THEME_SETTINGS, classic: { ...DEFAULT_THEME_SETTINGS.classic }, overrides: {}, imported: [],
    schedule: { fallbackThemeId: 'dark-modern', ranges: [], temporary: null } }
}

/** Pure, one-way schema migration. Any explicit version prevents old style fields from being imported again. */
export function normalizeThemeSettings(raw: unknown, options: NormalizeThemeOptions = {}): ThemeSettings {
  const input = record(raw)
  const result = freshSettings()
  const legacy = !Object.prototype.hasOwnProperty.call(input, 'version') &&
    (input.mode === 'preset' || input.mode === 'custom' || options.existing === true || options.legacyPreV2 === true)
  if (legacy) {
    result.mode = 'manual'
    result.themeId = CLASSIC_THEME_ID
    result.classic = classicSettings(raw, options.legacyPreV2 === true && !raw ? 'starlight' : 'graphite')
    const global = record(options.globalTerminalStyle)
    const foreground = color(global.foregroundColor)
    const background = color(global.backgroundColor)
    if (foreground || background) result.overrides[CLASSIC_THEME_ID] = {
      ...(foreground ? { 'terminal.foreground': foreground } : {}),
      ...(background ? { 'terminal.background': background } : {})
    }
    // Per-Task colors were retired in v3; legacy global colors become theme colors.
    return result
  }

  result.classic = classicSettings(input.classic)
  const seen = new Set(BUILTIN_IDS)
  if (Array.isArray(input.imported)) {
    for (const rawTheme of input.imported.slice(0, THEME_LIMITS.imported)) {
      const theme = normalizeThemeDefinition(rawTheme)
      if (theme && !seen.has(theme.id)) {
        result.imported.push(theme)
        seen.add(theme.id)
      }
    }
  }
  const available = [...BUILTIN_THEMES, ...result.imported]
  const selected = (value: unknown, fallback: string, kind?: ThemeDefinition['kind']) =>
    typeof value === 'string' && available.some(t => t.id === value && (!kind || t.kind === kind)) ? value : fallback
  result.mode = input.mode === 'manual' ? 'manual' : input.mode === 'schedule' ? 'schedule' : 'system'
  result.themeId = selected(input.themeId, 'dark-modern')
  result.lightThemeId = selected(input.lightThemeId, 'light-modern', 'light')
  result.darkThemeId = selected(input.darkThemeId, 'dark-modern', 'dark')
  result.schedule = normalizeThemeSchedule(input.schedule, result.themeId, seen)
  for (const [id, values] of entries(input.overrides, BUILTIN_THEMES.length + THEME_LIMITS.imported)) {
    if (!seen.has(id)) continue
    const colors = colorMap(values)
    if (Object.keys(colors).length) result.overrides[id] = colors
  }
  return result
}

function availableThemes(settings: ThemeSettings): ThemeDefinition[] {
  const ids = new Set(BUILTIN_IDS)
  const result = [...BUILTIN_THEMES]
  for (const theme of (Array.isArray(settings.imported) ? settings.imported : []).slice(0, THEME_LIMITS.imported)) {
    if (!theme || typeof theme.id !== 'string' || !safeKey(theme.id) || ids.has(theme.id)) continue
    if (theme.kind !== 'light' && theme.kind !== 'dark') continue
    result.push(theme)
    ids.add(theme.id)
  }
  return result
}

export function getAvailableThemes(settings: ThemeSettings): ThemeDefinition[] {
  return availableThemes(settings).map(theme => ({
    ...theme, colors: { ...theme.colors },
    ...(theme.tokenColors ? { tokenColors: theme.tokenColors.map(rule => ({
      ...rule, ...(Array.isArray(rule.scope) ? { scope: [...rule.scope] } : {}), settings: { ...rule.settings }
    })) } : {}),
    ...(theme.unsupported ? { unsupported: [...theme.unsupported] } : {})
  }))
}

export function getAvailableThemeIds(settings: ThemeSettings): ReadonlySet<string> {
  return new Set(availableThemes(settings).map(theme => theme.id))
}

export function getActiveThemeId(settings: ThemeSettings, systemDark: boolean, now = Date.now()): string {
  if (settings.mode === 'schedule') {
    const ids = getAvailableThemeIds(settings)
    const id = resolveThemeSchedule(settings.schedule, now, ids, false).themeId
    return ids.has(id) ? id : 'dark-modern'
  }
  const kind = systemDark ? 'dark' : 'light'
  const id = settings.mode === 'manual' ? settings.themeId : systemDark ? settings.darkThemeId : settings.lightThemeId
  return availableThemes(settings).some(theme => theme.id === id && (settings.mode === 'manual' || theme.kind === kind))
    ? id : settings.mode === 'manual' || systemDark ? 'dark-modern' : 'light-modern'
}

const TOKEN_SCOPES: Array<[string, string]> = [
  ['comment', 'comment'], ['keyword.operator', 'operator'], ['keyword', 'keyword'],
  ['storage.type', 'type'], ['storage', 'keyword'], ['string', 'string'],
  ['constant.numeric', 'number'], ['constant.language', 'keyword'], ['constant.character', 'string.escape'],
  ['entity.name.function', 'function'], ['support.function', 'function'], ['entity.name.type', 'type'],
  ['entity.name.class', 'type'], ['support.type', 'type'], ['support.class', 'type'],
  ['variable', 'variable'], ['entity.other.attribute-name', 'attribute.name'], ['entity.name.tag', 'tag'],
  ['punctuation', 'delimiter'], ['invalid', 'invalid']
]

const SYNTAX_DEFAULTS = {
  dark: { comment: '#8b949e', keyword: '#c586c0', string: '#ce9178', number: '#b5cea8', function: '#dcdcaa', type: '#4ec9b0', variable: '#9cdcfe', operator: '#d4d4d4' },
  light: { comment: '#586069', keyword: '#af00db', string: '#a31515', number: '#098658', function: '#795e26', type: '#267f99', variable: '#001080', operator: '#24292f' }
}

/** Common-category approximation, not TextMate matching: collapsed scopes and unsupported styling are reported. */
export function adaptThemeTokenRules(raw: ThemeTokenRule[], kind: ThemeDefinition['kind']): {
  rules: ResolvedTheme['editor']['rules']; syntax: Record<string, string>; unsupported: string[]
} {
  const mapped = new Map<string, ResolvedTheme['editor']['rules'][number]>()
  const priorities = new Map<string, { foreground: number; fontStyle: number }>()
  const sources = new Map<string, string>()
  const syntax: Record<string, string> = Object.fromEntries(Object.entries(SYNTAX_DEFAULTS[kind]).map(([token, value]) => [`--syntax-${token}`, value]))
  const unsupported = new Set<string>()
  const report = (message: string) => { if (unsupported.size < THEME_LIMITS.unsupported) unsupported.add(message.slice(0, 256)) }
  for (const rule of tokenRules(raw)) {
    // A missing or blank scope defines the default style. Empty entries inside a scope list do not.
    const defaultScope = rule.scope === undefined || (typeof rule.scope === 'string' && !rule.scope.trim())
    const scopes = defaultScope ? [''] : (Array.isArray(rule.scope) ? rule.scope : [rule.scope!])
      .flatMap(scope => scope.split(',')).slice(0, THEME_LIMITS.scopesPerRule).map(scope => scope.trim()).filter(Boolean)
    for (const scope of scopes) {
      const mapping = scope === '' ? ['', ''] : TOKEN_SCOPES.find(([prefix]) => scope === prefix || scope.startsWith(prefix + '.'))
      if (!mapping || /[\s|&>*()]/.test(scope)) { report(scope); continue }
      const [prefix, token] = mapping
      if (scope !== prefix) report(`approximation: ${scope} -> ${token}`)
      const previousScope = sources.get(token)
      if (previousScope !== undefined && previousScope !== scope) report(`approximation: ${previousScope} / ${scope} -> ${token}`)
      sources.set(token, scope)
      // Specificity is a per-property heuristic after collapsing scopes; equal specificity remains last-wins.
      const specificity = scope ? scope.split('.').length : 0
      const priority = priorities.get(token) ?? { foreground: -1, fontStyle: -1 }
      const foreground = rule.settings.foreground
      if (rule.settings.background) report(`background: ${scope || '(default)'}`)
      if (foreground && foreground.length === 9) report(`alpha: ${scope || '(default)'}`)
      const next = { ...(mapped.get(token) ?? { token }) }
      if (foreground && specificity >= priority.foreground) {
        next.foreground = foreground.slice(1, 7)
        priority.foreground = specificity
        if (`--syntax-${token}` in syntax) syntax[`--syntax-${token}`] = foreground.slice(0, 7)
      }
      if (rule.settings.fontStyle !== undefined && specificity >= priority.fontStyle) {
        next.fontStyle = rule.settings.fontStyle
        priority.fontStyle = specificity
      }
      priorities.set(token, priority)
      mapped.set(token, next)
    }
  }
  return { rules: [...mapped.values()], syntax, unsupported: [...unsupported] }
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
}

function mix(a: string, b: string, amount: number): string {
  const left = rgb(a)
  const right = rgb(b)
  return '#' + left.map((value, i) => Math.round(value * (1 - amount) + right[i] * amount).toString(16).padStart(2, '0')).join('')
}

function opaque(value: string, background: string): string {
  const normalized = color(value) ?? background
  if (normalized.length !== 9) return normalized
  const alpha = parseInt(normalized.slice(7), 16) / 255
  return mix(background, normalized, alpha)
}

function luminance(value: string): number {
  const c = rgb(value).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}

function readable(value: string, backgrounds: string[], dark: boolean): string {
  const passes = (candidate: string) => backgrounds.every(background => {
    const a = luminance(candidate)
    const b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5
  })
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(value, dark ? '#ffffff' : '#000000', step / 20)
    if (passes(candidate)) return candidate
  }
  return dark ? '#ffffff' : '#000000'
}

/** Bounded palette resolution only; callers own persistence, scheduling and DOM/xterm/Monaco commits. */
export function resolveTheme(settings: ThemeSettings, systemDark: boolean, now = Date.now()): ResolvedTheme {
  const id = getActiveThemeId(settings, systemDark, now)
  const definition = availableThemes(settings).find(theme => theme.id === id)!
  const dark = definition.kind === 'dark'
  const fallback = BUILTIN_THEMES.find(theme => theme.id === (dark ? 'dark-modern' : 'light-modern'))!
  const defined = colorMap(definition.colors)
  const adapted = adaptThemeTokenRules(definition.tokenColors ?? [], definition.kind)
  const defaultToken = adapted.rules.find(rule => rule.token === '')
  const base = { ...fallback.colors, ...defined }
  // Monaco's unscoped rule supplies the default text color, including for sparse imports.
  if (defaultToken?.foreground) base['editor.foreground'] = '#' + defaultToken.foreground
  // Sparse imports inherit their own editor surfaces before falling back to a builtin palette.
  const inherited = (key: string, parent: string) => {
    if (!defined[key]) base[key] = base[parent]
  }
  inherited('foreground', 'editor.foreground')
  inherited('sideBar.background', 'editor.background')
  inherited('panel.background', 'sideBar.background')
  inherited('terminal.background', 'editor.background')
  inherited('terminal.foreground', 'editor.foreground')
  inherited('terminalCursor.foreground', 'terminal.foreground')
  inherited('terminalCursor.background', 'terminal.background')
  inherited('terminal.selectionBackground', 'editor.selectionBackground')
  inherited('terminal.selectionForeground', 'terminal.foreground')
  const overrides = colorMap(own(record(settings.overrides), id))
  const palette = { ...base, ...overrides }
  const isClassic = id === CLASSIC_THEME_ID
  const classic = classicSettings(settings.classic)
  const legacyColors = classic.mode === 'custom' && classic.custom
    ? generateCustomTheme(classic.custom.accent) : getThemePreset(classic.presetId)!.colors
  const rootBackground = dark ? '#1f1f1f' : '#ffffff'
  const editorBackground = opaque(palette['editor.background'], rootBackground)
  const editorForeground = opaque(palette['editor.foreground'], editorBackground)
  // Monaco applies token rules after editor colors. Keep its default in sync with
  // the resolved override without discarding unscoped font styles or style resets.
  if (defaultToken?.foreground) defaultToken.foreground = editorForeground.slice(1)
  const background = opaque(palette['onward.background'] ?? (isClassic ? legacyColors['--bg-0'] : palette['editor.background']), rootBackground)
  const surface = opaque(palette['sideBar.background'], background)
  const panel = opaque(palette['panel.background'], background)
  const raised = mix(background, dark ? '#ffffff' : '#000000', dark ? 0.04 : 0.025)
  const foreground = opaque(palette['onward.foreground'] ?? palette.foreground ?? editorForeground, background)
  const accent = opaque(
    overrides['onward.accent'] ?? overrides['textLink.foreground'] ?? overrides.focusBorder ??
    defined['onward.accent'] ?? defined['textLink.foreground'] ?? defined.focusBorder ?? fallback.colors['textLink.foreground'],
    background
  )
  const backgrounds = [background, surface, panel, raised]
  const colors: ThemeColors = isClassic ? { ...legacyColors } : {
    '--bg-0': background, '--bg-1': surface, '--bg-2': raised, '--panel': panel,
    '--border': palette['panel.border'], '--border-strong': mix(palette['panel.border'], foreground, 0.25),
    '--text-1': readable(foreground, backgrounds, dark),
    '--text-2': readable(mix(foreground, background, 0.12), backgrounds, dark),
    '--text-3': readable(mix(foreground, background, 0.27), backgrounds, dark),
    '--accent': accent, '--accent-strong': mix(accent, dark ? '#ffffff' : '#000000', 0.14),
    '--shadow-1': dark ? '0 6px 18px rgba(0, 0, 0, 0.35)' : '0 6px 18px rgba(0, 0, 0, 0.12)'
  }
  if (overrides['onward.background']) colors['--bg-0'] = background
  if (overrides['onward.foreground']) colors['--text-1'] = foreground
  if (overrides['onward.accent']) {
    colors['--accent'] = accent
    colors['--accent-strong'] = mix(accent, dark ? '#ffffff' : '#000000', 0.14)
  }
  if (overrides['panel.border']) colors['--border'] = overrides['panel.border']
  const success = dark ? '#73c991' : '#18743a'
  const warning = dark ? '#e5c07b' : '#805500'
  const danger = dark ? '#f48771' : '#c42b35'
  const diffAddBackground = palette['diffEditor.insertedTextBackground'] ?? `${success}26`
  const diffDeleteBackground = palette['diffEditor.removedTextBackground'] ?? `${danger}26`
  // Diff text is painted over a tinted surface, not the untouched editor backdrop.
  const diffText = (foreground: string, tint: string) => isClassic ? foreground
    : readable(foreground, backgrounds.map(background => opaque(tint, background)), dark)
  Object.assign(colors, adapted.syntax, {
    '--editor-bg': editorBackground, '--editor-fg': editorForeground,
    '--preview-code-bg': editorBackground,
    '--diff-add-text': diffText(success, diffAddBackground), '--diff-delete-text': diffText(danger, diffDeleteBackground),
    '--diff-add-bg': diffAddBackground,
    '--diff-delete-bg': diffDeleteBackground,
    '--success': success, '--warning': warning, '--danger': danger,
    '--background': colors['--bg-0'], '--text': colors['--text-1'], '--muted': colors['--text-3'],
    '--icon-foreground': colors['--text-2'], '--icon-muted': colors['--text-3'], '--icon-accent': colors['--accent'],
    '--selection-bg': palette['editor.selectionBackground'], '--selection-fg': colors['--text-1']
  })
  if (isClassic) Object.assign(colors, {
    '--preview-code-bg': '#141821',
    '--syntax-comment': '#8b949e', '--syntax-keyword': '#ff7b72',
    '--syntax-string': '#a5d6ff', '--syntax-number': '#79c0ff',
    '--syntax-function': '#d2a8ff', '--syntax-type': '#ff7b72',
    '--syntax-variable': '#79c0ff', '--syntax-operator': '#c9d1d9'
  })
  const terminal: ITheme = isClassic ? { ...CLASSIC_TERMINAL_THEME } : {
    background: palette['terminal.background'] ?? editorBackground,
    foreground: palette['terminal.foreground'] ?? editorForeground,
    cursor: palette['terminalCursor.foreground'] ?? editorForeground,
    cursorAccent: palette['terminalCursor.background'] ?? editorBackground,
    selectionBackground: palette['terminal.selectionBackground'] ?? palette['editor.selectionBackground'],
    selectionForeground: palette['terminal.selectionForeground'] ?? editorForeground,
    selectionInactiveBackground: palette['terminal.inactiveSelectionBackground'] ?? palette['terminal.selectionBackground']
  }
  const terminalKeys: Record<string, keyof ITheme> = {
    'terminal.background': 'background', 'terminal.foreground': 'foreground',
    'terminalCursor.foreground': 'cursor', 'terminalCursor.background': 'cursorAccent',
    'terminal.selectionBackground': 'selectionBackground', 'terminal.selectionForeground': 'selectionForeground',
    'terminal.inactiveSelectionBackground': 'selectionInactiveBackground'
  }
  for (const name of ANSI_COLOR_NAMES) terminalKeys[`terminal.ansi${name}`] = (name[0].toLowerCase() + name.slice(1)) as keyof ITheme
  for (const [key, terminalKey] of Object.entries(terminalKeys)) {
    const value = isClassic ? overrides[key] : palette[key]
    if (value) (terminal as Record<string, unknown>)[terminalKey] = value
  }
  const editorColors: Record<string, string> = {}
  for (const [key, value] of Object.entries(palette)) {
    if (key === 'foreground' || key === 'focusBorder' || /^(editor|editorCursor|editorLineNumber|editorGutter|editorWhitespace|editorIndentGuide|editorOverviewRuler|editorWidget|editorSuggestWidget|diffEditor|diffEditorGutter|diffEditorOverview|scrollbarSlider|list|input|peekView)\./.test(key)) editorColors[key] = value
  }
  editorColors['editor.background'] = editorBackground
  editorColors['editor.foreground'] = editorForeground
  return {
    id, name: definition.name, kind: definition.kind, colors, terminal,
    editor: { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: adapted.rules, colors: editorColors }, isClassic
  }
}
