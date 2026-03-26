/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThemePreset, PresetThemeId, ThemeSettings } from '../types/theme'

/**
 * Six preset themes
 * The background color has a faint tone of the same hue as the accent color, creating a unified visual atmosphere
 */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Steady and focused neutral gray',
    colors: {
      '--bg-0': '#101012',
      '--bg-1': '#161618',
      '--bg-2': '#1c1c1f',
      '--panel': '#212124',
      '--border': '#2c2c30',
      '--border-strong': '#38383d',
      '--text-1': '#e8e8ec',
      '--text-2': '#b4b4bc',
      '--text-3': '#8a8a94',
      '--accent': '#8b8f98',
      '--accent-strong': '#7a7e86',
      '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.4)'
    }
  },
  {
    id: 'starlight',
    name: 'Starlight',
    description: 'Classic blue tones',
    colors: {
      '--bg-0': '#0f1115',
      '--bg-1': '#141821',
      '--bg-2': '#1b202b',
      '--panel': '#1f2430',
      '--border': '#2a303c',
      '--border-strong': '#343b48',
      '--text-1': '#e6e9ef',
      '--text-2': '#b8c0cc',
      '--text-3': '#8a93a3',
      '--accent': '#3b82f6',
      '--accent-strong': '#2563eb',
      '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.35)'
    }
  },
  {
    id: 'pine',
    name: 'Pine',
    description: 'Natural and calm for long sessions',
    colors: {
      '--bg-0': '#0e1210',
      '--bg-1': '#131a16',
      '--bg-2': '#1a221d',
      '--panel': '#1e2923',
      '--border': '#283630',
      '--border-strong': '#32413a',
      '--text-1': '#e4ece8',
      '--text-2': '#b4c4bc',
      '--text-3': '#859a90',
      '--accent': '#22c55e',
      '--accent-strong': '#16a34a',
      '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.38)'
    }
  },
  {
    id: 'umber',
    name: 'Umber',
    description: 'Warm amber glow with soft contrast',
    colors: {
      '--bg-0': '#12100d',
      '--bg-1': '#1a1612',
      '--bg-2': '#221e19',
      '--panel': '#28231d',
      '--border': '#362f27',
      '--border-strong': '#433a31',
      '--text-1': '#ede8e2',
      '--text-2': '#c8bfb4',
      '--text-3': '#9e9386',
      '--accent': '#d97706',
      '--accent-strong': '#b45309',
      '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.38)'
    }
  },
  {
    id: 'amethyst',
    name: 'Amethyst',
    description: 'Elegant and vivid violet',
    colors: {
      '--bg-0': '#110f15',
      '--bg-1': '#17141e',
      '--bg-2': '#1e1b28',
      '--panel': '#24202f',
      '--border': '#302b3c',
      '--border-strong': '#3c3648',
      '--text-1': '#eae6f0',
      '--text-2': '#c0b8cc',
      '--text-3': '#918aa0',
      '--accent': '#a855f7',
      '--accent-strong': '#9333ea',
      '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.38)'
    }
  },
  {
    id: 'glacier',
    name: 'Glacier',
    description: 'Cool and crisp cyan',
    colors: {
      '--bg-0': '#0e1213',
      '--bg-1': '#131a1b',
      '--bg-2': '#192223',
      '--panel': '#1e2829',
      '--border': '#283536',
      '--border-strong': '#324142',
      '--text-1': '#e4ecec',
      '--text-2': '#b4c6c6',
      '--text-3': '#859c9c',
      '--accent': '#14b8a6',
      '--accent-strong': '#0d9488',
      '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.38)'
    }
  }
]

/** Default theme settings (graphite gray for new users) */
export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: 'preset',
  presetId: 'graphite',
  custom: null
}

/** Migrate user default theme (maintain existing blue experience) */
export const MIGRATION_THEME_SETTINGS: ThemeSettings = {
  mode: 'preset',
  presetId: 'starlight',
  custom: null
}

/** Find a preset theme by ID */
export function getThemePreset(id: PresetThemeId): ThemePreset | undefined {
  return THEME_PRESETS.find(t => t.id === id)
}

/** The set of all valid default IDs */
export const PRESET_IDS: ReadonlySet<string> = new Set(THEME_PRESETS.map(t => t.id))
