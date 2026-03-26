/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThemeColors, ThemeSettings } from '../types/theme'
import { getThemePreset } from '../constants/themes'
import { generateCustomTheme } from './theme-generator'

/** All themeable CSS variable names */
const THEME_VARS: (keyof ThemeColors)[] = [
  '--bg-0', '--bg-1', '--bg-2', '--panel',
  '--border', '--border-strong',
  '--text-1', '--text-2', '--text-3',
  '--accent', '--accent-strong', '--shadow-1'
]

/**
 * Apply theme color to document.documentElement.style
 */
export function applyTheme(colors: ThemeColors): void {
  const style = document.documentElement.style
  for (const varName of THEME_VARS) {
    style.setProperty(varName, colors[varName])
  }
}

/**
 * Parse out actual ThemeColors based on theme settings
 * - preset mode: search from preset table
 * - custom mode: automatically generated with generateCustomTheme
 */
export function resolveThemeColors(settings: ThemeSettings): ThemeColors {
  if (settings.mode === 'custom' && settings.custom) {
    return generateCustomTheme(settings.custom.accent)
  }

  const preset = getThemePreset(settings.presetId)
  if (preset) {
    return preset.colors
  }

  // fallback: starry sky blue
  const starlight = getThemePreset('starlight')!
  return starlight.colors
}
