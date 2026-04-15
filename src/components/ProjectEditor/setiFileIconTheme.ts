/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seti UI file icons (VS Code theme-seti family via seti-icons).
 * Per-extension colors use Seti semantics mapped to theme-aware / fixed readable hues
 * so icons stay distinguishable on dark backgrounds (never near-black on black).
 */

import DOMPurify from 'dompurify'
import { themeIcons } from 'seti-icons'
import type { ThemeColors, ThemeSettings } from '../../types/theme'
import { DEFAULT_THEME_SETTINGS } from '../../constants/themes'
import { resolveThemeColors } from '../../utils/theme-applier'

const SETI_SVG_SANITIZE_CACHE = new Map<string, string>()

/** Sanitize Seti SVG markup once per distinct string (icons repeat across the tree). */
export function sanitizeSetiSvgOnce(svg: string): string {
  let safe = SETI_SVG_SANITIZE_CACHE.get(svg)
  if (!safe) {
    const purified = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    // Seti paths often omit fill; without this, SVG uses initial fill black regardless of CSS color on the wrapper.
    const trimmed = purified.trim()
    safe = /^<svg\b/i.test(trimmed) && !/\bfill\s*=/i.test(trimmed.match(/^<svg[^>]*>/i)?.[0] ?? '')
      ? trimmed.replace(/^<svg\b/i, '<svg fill="currentColor" ')
      : trimmed
    SETI_SVG_SANITIZE_CACHE.set(svg, safe)
  }
  return safe
}

/**
 * Map Seti semantic slots onto readable colors. Slots tied to `ThemeColors` follow the
 * active UI theme; saturated slots stay in a safe luminance range for dark panels.
 */
export function buildSetiThemeFromAppColors(colors: ThemeColors) {
  return {
    blue: colors['--accent'],
    grey: colors['--text-2'],
    'grey-light': colors['--text-2'],
    green: '#4ade80',
    orange: '#fb923c',
    pink: '#f472b6',
    purple: '#c084fc',
    red: '#f87171',
    white: colors['--text-1'],
    yellow: '#facc15',
    ignore: colors['--text-3']
  }
}

export function createThemedSetiFileIconResolver(theme: ThemeSettings | null | undefined) {
  const resolved = resolveThemeColors(theme ?? DEFAULT_THEME_SETTINGS)
  return themeIcons(buildSetiThemeFromAppColors(resolved))
}
