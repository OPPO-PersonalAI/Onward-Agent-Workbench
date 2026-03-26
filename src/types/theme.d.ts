/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Theme system type definitions

/**
 * Theme CSS variable mapping
 * Corresponds to 12 themable variables in :root
 */
export interface ThemeColors {
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

/** User persistent theme settings */
export interface ThemeSettings {
  mode: 'preset' | 'custom'
  presetId: PresetThemeId
  custom: {
    accent: string
  } | null
}
