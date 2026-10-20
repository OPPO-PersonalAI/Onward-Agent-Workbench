/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITheme } from '@xterm/xterm'

/**
 * Theme CSS variable mapping
 * Corresponds to 12 themable variables in :root
 */
export interface ThemeColors {
  [name: string]: string
  '--bg-0': string
  '--bg-1': string
  '--bg-2': string
  '--panel': string
  '--border': string
  '--border-strong': string
  '--text-1': string
  '--text-2': string
  '--text-3': string
  '--accent': string
  '--accent-strong': string
  '--shadow-1': string
}

/** 6 preset theme IDs */
export type PresetThemeId = 'graphite' | 'starlight' | 'pine' | 'umber' | 'amethyst' | 'glacier'

/** Default theme complete definition */
export interface ThemePreset {
  id: PresetThemeId
  name: string
  description: string
  colors: ThemeColors
}

/** Original settings retained by the Classic theme. */
export interface LegacyThemeSettings {
  mode: 'preset' | 'custom'
  presetId: PresetThemeId
  custom: {
    accent: string
  } | null
}

export interface ThemeTokenRule {
  scope?: string | string[]
  settings: {
    foreground?: string
    background?: string
    fontStyle?: string
  }
}

export interface ThemeDefinition {
  id: string
  name: string
  kind: 'light' | 'dark'
  colors: Record<string, string>
  tokenColors?: ThemeTokenRule[]
  source?: string
  unsupported?: string[]
}

export interface ThemeTimeRange {
  id: string
  themeId: string
  start: number
  end: number
  /** Local start weekdays, Sunday = 0. End is exclusive. */
  days: number[]
  enabled: boolean
}

export interface ThemeSchedule {
  fallbackThemeId: string
  ranges: ThemeTimeRange[]
  temporary: { themeId: string; startsAt: number; until: number } | null
}

export interface ThemeScheduleClock {
  now: number
  sequence: number
}

export interface ThemeSettings {
  version: 4
  mode: 'system' | 'manual' | 'schedule'
  themeId: string
  lightThemeId: string
  darkThemeId: string
  classic: LegacyThemeSettings
  overrides: Record<string, Record<string, string>>
  imported: ThemeDefinition[]
  schedule: ThemeSchedule
}

export interface ResolvedTheme {
  id: string
  name: string
  kind: 'light' | 'dark'
  colors: ThemeColors
  terminal: ITheme
  editor: {
    base: 'vs' | 'vs-dark'
    inherit: boolean
    rules: Array<{ token: string; foreground?: string; fontStyle?: string }>
    colors: Record<string, string>
  }
  isClassic: boolean
}
