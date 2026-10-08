/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ThemeSettings } from '../types/theme'
import { getAvailableThemes, normalizeThemeSettings, resolveTheme, isThemeColor, THEME_LIMITS } from './theme-engine.ts'
import { ANSI_COLOR_NAMES } from './theme-presets.ts'

/** Self-contained VS Code colors; no source paths, settings, includes or Task identifiers. */
export function createThemeExport(raw: ThemeSettings, themeId: string): { filename: string; text: string } {
  const settings = normalizeThemeSettings(raw)
  const definition = getAvailableThemes(settings).find(theme => theme.id === themeId)
  if (!definition) throw new Error('invalid-theme')
  const resolved = resolveTheme({ ...settings, mode: 'manual', themeId }, false)
  const overrides = settings.overrides[themeId] ?? {}
  const colors = { ...definition.colors, ...overrides, ...resolved.editor.colors }
  const assign = (token: string, value: unknown) => { if (isThemeColor(value)) colors[token] = value }
  assign('foreground', resolved.colors['--text-1'])
  assign('sideBar.background', resolved.colors['--bg-1'])
  assign('panel.background', resolved.colors['--panel'])
  assign('panel.border', resolved.colors['--border'])
  assign('textLink.foreground', resolved.colors['--accent'])
  assign('focusBorder', resolved.colors['--accent'])
  // VS Code has no independent Onward canvas token. Map it to surrounding chrome,
  // preserving explicitly customized editor/terminal surfaces instead of overwriting them.
  const canvas = overrides['onward.background'] ?? definition.colors['onward.background']
  if (canvas) for (const key of ['sideBar.background', 'panel.background', 'activityBar.background', 'titleBar.activeBackground']) assign(key, canvas)
  const terminalKeys = {
    'terminal.background': 'background', 'terminal.foreground': 'foreground',
    'terminalCursor.foreground': 'cursor', 'terminalCursor.background': 'cursorAccent',
    'terminal.selectionBackground': 'selectionBackground', 'terminal.selectionForeground': 'selectionForeground',
    'terminal.inactiveSelectionBackground': 'selectionInactiveBackground',
    ...Object.fromEntries(ANSI_COLOR_NAMES.map(name => [`terminal.ansi${name}`, name[0].toLowerCase() + name.slice(1)]))
  }
  for (const [token, key] of Object.entries(terminalKeys)) assign(token, (resolved.terminal as Record<string, unknown>)[key])
  const tokenColors = (definition.tokenColors ?? []).map(rule => ({
    ...rule,
    settings: {
      ...rule.settings,
      // An unscoped foreground must not undo the user's editor foreground override.
      ...(rule.scope === undefined || (typeof rule.scope === 'string' && !rule.scope.trim())
        ? { foreground: resolved.editor.colors['editor.foreground'] } : {})
    }
  }))
  const portableColors = Object.fromEntries(Object.entries(colors)
    .filter(([key, value]) => !key.startsWith('onward.') && isThemeColor(value)).sort(([a], [b]) => a.localeCompare(b)))
  if (Object.keys(portableColors).length > THEME_LIMITS.colors) throw new Error('size-limit')
  const text = JSON.stringify({
    $schema: 'vscode://schemas/color-theme', name: definition.name, type: definition.kind,
    colors: portableColors, tokenColors
  }, null, 2) + '\n'
  // Keep exports within the importer's per-document byte ceiling; never truncate rules.
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('size-limit')
  const cleaned = definition.name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'theme'
  const stem = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(cleaned) ? `theme-${cleaned}` : cleaned
  return { filename: `${stem}-color-theme.json`, text }
}
