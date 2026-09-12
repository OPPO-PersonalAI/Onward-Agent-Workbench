/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type ColorMode = 'light' | 'dark' | 'system'
export type ThemeKind = 'light' | 'dark'
export type BuiltinThemeId =
  | 'graphite' | 'starlight' | 'pine' | 'umber' | 'amethyst' | 'glacier' | 'onward-light'

export type ThemeRef =
  | { source: 'builtin'; id: BuiltinThemeId }
  | { source: 'legacy-custom'; accent: string }
  | { source: 'pack'; packId: string; themeId: string }

export type TerminalPalettePreference =
  | { source: 'application' }
  | { source: 'independent'; paletteId: 'vscode-dark' }

export interface AppearanceSettingsV1 {
  schemaVersion: 1
  colorMode: ColorMode
  lightTheme: ThemeRef
  darkTheme: ThemeRef
  terminal: TerminalPalettePreference
}

export interface LocalePackSettingsV1 {
  schemaVersion: 1
  activePackByLocale: Partial<Record<'en' | 'zh-CN', string>>
}

export const DEFAULT_LOCALE_PACK_SETTINGS: LocalePackSettingsV1 = {
  schemaVersion: 1,
  activePackByLocale: {}
}

export function normalizeLocalePackSettings(value: unknown): LocalePackSettingsV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.activePackByLocale)) {
    return { schemaVersion: 1, activePackByLocale: {} }
  }
  const activePackByLocale: LocalePackSettingsV1['activePackByLocale'] = {}
  for (const locale of ['en', 'zh-CN'] as const) {
    const packId = value.activePackByLocale[locale]
    if (typeof packId === 'string' && SAFE_RESOURCE_ID.test(packId)) activePackByLocale[locale] = packId
  }
  return { schemaVersion: 1, activePackByLocale }
}

export interface LegacyThemeSettings {
  mode: 'preset' | 'custom'
  presetId: Exclude<BuiltinThemeId, 'onward-light'>
  custom: { accent: string } | null
}

export interface NormalizedAppearanceResult {
  appearance: AppearanceSettingsV1
  diagnostics: string[]
}

export interface ResolvedAppearanceDescriptor {
  kind: ThemeKind
  requestedTheme: ThemeRef
  terminalFollowsApplication: boolean
}

const BUILTIN_IDS = new Set<BuiltinThemeId>([
  'graphite', 'starlight', 'pine', 'umber', 'amethyst', 'glacier', 'onward-light'
])
const DARK_BUILTIN_IDS = new Set<Exclude<BuiltinThemeId, 'onward-light'>>([
  'graphite', 'starlight', 'pine', 'umber', 'amethyst', 'glacier'
])
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const SAFE_RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export const DEFAULT_APPEARANCE: AppearanceSettingsV1 = {
  schemaVersion: 1,
  colorMode: 'dark',
  lightTheme: { source: 'builtin', id: 'onward-light' },
  darkTheme: { source: 'builtin', id: 'graphite' },
  terminal: { source: 'application' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeThemeRef(value: unknown, kind: ThemeKind, fallback: ThemeRef, diagnostics: string[]): ThemeRef {
  if (!isRecord(value) || typeof value.source !== 'string') {
    diagnostics.push(`${kind}Theme was invalid and fell back to the built-in theme.`)
    return fallback
  }
  if (value.source === 'builtin' && typeof value.id === 'string' && BUILTIN_IDS.has(value.id as BuiltinThemeId)) {
    if (kind === 'light' && value.id !== 'onward-light') {
      diagnostics.push('A dark built-in theme cannot be used in the light slot.')
      return fallback
    }
    if (kind === 'dark' && !DARK_BUILTIN_IDS.has(value.id as Exclude<BuiltinThemeId, 'onward-light'>)) {
      diagnostics.push('A light built-in theme cannot be used in the dark slot.')
      return fallback
    }
    return { source: 'builtin', id: value.id as BuiltinThemeId }
  }
  if (value.source === 'legacy-custom' && kind === 'dark' && typeof value.accent === 'string' && HEX_COLOR.test(value.accent)) {
    return { source: 'legacy-custom', accent: value.accent.toLowerCase() }
  }
  if (value.source === 'pack' && typeof value.packId === 'string' && typeof value.themeId === 'string' &&
    SAFE_RESOURCE_ID.test(value.packId) && SAFE_RESOURCE_ID.test(value.themeId)) {
    return { source: 'pack', packId: value.packId, themeId: value.themeId }
  }
  diagnostics.push(`${kind}Theme was invalid and fell back to the built-in theme.`)
  return fallback
}

function migrateLegacyTheme(legacyTheme: LegacyThemeSettings | undefined, existingUser: boolean): AppearanceSettingsV1 {
  const defaultDark = existingUser ? 'starlight' : 'graphite'
  const darkTheme: ThemeRef = legacyTheme?.mode === 'custom' && legacyTheme.custom && HEX_COLOR.test(legacyTheme.custom.accent)
    ? { source: 'legacy-custom', accent: legacyTheme.custom.accent.toLowerCase() }
    : { source: 'builtin', id: legacyTheme?.presetId ?? defaultDark }
  return {
    schemaVersion: 1,
    colorMode: 'dark',
    lightTheme: { source: 'builtin', id: 'onward-light' },
    darkTheme,
    terminal: existingUser ? { source: 'independent', paletteId: 'vscode-dark' } : { source: 'application' }
  }
}

export function normalizeAppearance(
  value: unknown,
  legacyTheme: LegacyThemeSettings | undefined,
  options: { existingUser: boolean }
): NormalizedAppearanceResult {
  const diagnostics: string[] = []
  if (!isRecord(value) || value.schemaVersion !== 1) {
    if (value !== undefined) diagnostics.push('appearance was missing or unsupported and was migrated from legacy theme settings.')
    return { appearance: migrateLegacyTheme(legacyTheme, options.existingUser), diagnostics }
  }
  const colorMode: ColorMode = value.colorMode === 'light' || value.colorMode === 'dark' || value.colorMode === 'system'
    ? value.colorMode
    : 'dark'
  if (colorMode !== value.colorMode) diagnostics.push('colorMode was invalid and fell back to dark.')
  const lightTheme = normalizeThemeRef(value.lightTheme, 'light', DEFAULT_APPEARANCE.lightTheme, diagnostics)
  const darkTheme = normalizeThemeRef(value.darkTheme, 'dark', DEFAULT_APPEARANCE.darkTheme, diagnostics)
  const terminal: TerminalPalettePreference = isRecord(value.terminal) && value.terminal.source === 'independent' && value.terminal.paletteId === 'vscode-dark'
    ? { source: 'independent', paletteId: 'vscode-dark' }
    : { source: 'application' }
  if (!isRecord(value.terminal) || (value.terminal.source !== 'application' && terminal.source !== 'independent')) {
    diagnostics.push('terminal palette preference was invalid and now follows the application.')
  }
  return { appearance: { schemaVersion: 1, colorMode, lightTheme, darkTheme, terminal }, diagnostics }
}

export function resolveAppearanceTheme(appearance: AppearanceSettingsV1, kind: ThemeKind): ThemeRef {
  return JSON.parse(JSON.stringify(kind === 'light' ? appearance.lightTheme : appearance.darkTheme)) as ThemeRef
}

export function resolveAppearanceDescriptor(
  appearance: AppearanceSettingsV1,
  systemPrefersDark: boolean
): ResolvedAppearanceDescriptor {
  const kind: ThemeKind = appearance.colorMode === 'light' || (appearance.colorMode === 'system' && !systemPrefersDark)
    ? 'light'
    : 'dark'
  return {
    kind,
    requestedTheme: resolveAppearanceTheme(appearance, kind),
    terminalFollowsApplication: appearance.terminal.source === 'application'
  }
}
