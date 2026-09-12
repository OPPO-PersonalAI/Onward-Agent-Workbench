/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_APPEARANCE, resolveAppearanceDescriptor, type AppearanceSettingsV1, type ThemeKind, type ThemeRef } from '../../electron/shared/appearance-schema'
import type { ThemeColors, ThemeSettings } from '../types/theme'
import { getThemePreset } from '../constants/themes'
import { generateCustomTheme } from '../utils/theme-generator'
import type { ThemeName } from './terminal-themes'

export interface ResolvedAppearance {
  kind: ThemeKind
  colors: ThemeColors
  monacoTheme: 'vs' | 'vs-dark'
  pierreTheme: 'pierre-light' | 'pierre-dark'
  terminalTheme: ThemeName
  fallbackReason: 'missing' | 'invalid' | 'wrong-kind' | null
}

function builtinColors(id: string): ThemeColors | null {
  return getThemePreset(id as Parameters<typeof getThemePreset>[0])?.colors ?? null
}

function resolveThemeColors(ref: ThemeRef, kind: ThemeKind): { colors: ThemeColors; fallbackReason: ResolvedAppearance['fallbackReason'] } {
  if (ref.source === 'builtin') {
    const colors = builtinColors(ref.id)
    if (colors) return { colors, fallbackReason: null }
  }
  if (ref.source === 'legacy-custom' && kind === 'dark') {
    return { colors: generateCustomTheme(ref.accent), fallbackReason: null }
  }
  const fallbackId = kind === 'light' ? 'onward-light' : 'graphite'
  return {
    colors: builtinColors(fallbackId)!,
    fallbackReason: ref.source === 'pack' ? 'missing' : 'invalid'
  }
}

export function resolveAppearanceKind(colorMode: AppearanceSettingsV1['colorMode'], systemPrefersDark: boolean): ThemeKind {
  return resolveAppearanceDescriptor({
    ...DEFAULT_APPEARANCE,
    colorMode
  }, systemPrefersDark).kind
}

export function resolveAppearance(
  appearance: AppearanceSettingsV1,
  systemPrefersDark: boolean,
  packTheme?: { packId: string; themeId: string; kind: ThemeKind; colors: ThemeColors } | null
): ResolvedAppearance {
  const descriptor = resolveAppearanceDescriptor(appearance, systemPrefersDark)
  const { kind } = descriptor
  const resolved = descriptor.requestedTheme.source === 'pack' &&
    packTheme?.packId === descriptor.requestedTheme.packId &&
    packTheme.themeId === descriptor.requestedTheme.themeId &&
    packTheme.kind === kind
    ? { colors: packTheme.colors, fallbackReason: null }
    : resolveThemeColors(descriptor.requestedTheme, kind)
  return {
    kind,
    colors: resolved.colors,
    monacoTheme: kind === 'light' ? 'vs' : 'vs-dark',
    pierreTheme: kind === 'light' ? 'pierre-light' : 'pierre-dark',
    terminalTheme: descriptor.terminalFollowsApplication && kind === 'light' ? 'onward-light' : 'vscode-dark',
    fallbackReason: resolved.fallbackReason
  }
}

export function legacyThemeRef(theme: ThemeSettings): ThemeRef {
  if (theme.mode === 'custom' && theme.custom) return { source: 'legacy-custom', accent: theme.custom.accent }
  return { source: 'builtin', id: theme.presetId === 'onward-light' ? 'graphite' : theme.presetId }
}
