/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seti UI file icons (VS Code theme-seti family via seti-icons).
 * Per-extension colors follow live semantic tokens, including System changes
 * and draft edits that do not invalidate a React settings memo.
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
 * CSS references let existing file rows update without regenerating their SVGs.
 */
export function buildSetiThemeFromAppColors(colors: ThemeColors) {
  return {
    blue: `var(--accent, ${colors['--accent']})`,
    grey: `var(--text-2, ${colors['--text-2']})`,
    'grey-light': `var(--text-2, ${colors['--text-2']})`,
    green: 'var(--syntax-string, #4ade80)',
    orange: 'var(--syntax-number, #fb923c)',
    pink: 'var(--syntax-keyword, #f472b6)',
    purple: 'var(--syntax-function, #c084fc)',
    red: 'var(--danger, #f87171)',
    white: `var(--text-1, ${colors['--text-1']})`,
    yellow: 'var(--warning, #facc15)',
    ignore: `var(--text-3, ${colors['--text-3']})`
  }
}

export function createThemedSetiFileIconResolver(theme: ThemeSettings | null | undefined) {
  const resolved = resolveThemeColors(theme ?? DEFAULT_THEME_SETTINGS)
  return themeIcons(buildSetiThemeFromAppColors(resolved))
}
