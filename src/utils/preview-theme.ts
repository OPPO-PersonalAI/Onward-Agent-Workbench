/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranslationKey } from '../i18n/core'

/** Shared viewer dictionary for the reader and both Git comparison panes. */
export function buildPdfViewerStrings(t: (key: TranslationKey) => string): Record<string, string> {
  const fields = [
    'prevPage', 'nextPage', 'zoomOut', 'zoomIn', 'zoom', 'fitWidth', 'fitPage',
    'searchPlaceholder', 'prevMatch', 'nextMatch', 'colorToggleOn', 'colorToggleOff',
    'colorToggleTitleOn', 'colorToggleTitleOff', 'close', 'cancel', 'confirm',
    'passwordTitle', 'passwordPrompt', 'passwordIncorrect', 'emptyState',
    'errorInvalid', 'errorMissing', 'errorPassword', 'errorUnexpected', 'errorGeneric'
  ] as const
  return Object.fromEntries(fields.map(field => [field, t(`projectEditor.pdfReader.${field}`)]))
}

export interface PreviewPalette {
  kind: 'light' | 'dark'
  background: string
  foreground: string
  muted: string
  accent: string
  panel: string
  elevated: string
  border: string
  code: string
  shadow: string
}

export function buildPreviewPalette(read: (name: string) => string, kind: 'light' | 'dark'): PreviewPalette {
  const light = kind === 'light'
  const value = (name: string, fallback: string) => read(name).trim() || fallback
  return {
    kind,
    background: value('--bg-0', light ? '#ffffff' : '#101012'),
    foreground: value('--text-1', light ? '#202020' : '#e8e8ec'),
    muted: value('--text-3', light ? '#606060' : '#8a8a94'),
    accent: value('--accent', light ? '#005fcc' : '#8b8f98'),
    panel: value('--panel', light ? '#fafafa' : '#212124'),
    elevated: value('--bg-2', light ? '#eeeeee' : '#1c1c1f'),
    border: value('--border', light ? '#cccccc' : '#2c2c30'),
    code: value('--preview-code-bg', light ? '#f0f0f0' : '#141821'),
    shadow: value('--shadow-1', '0 6px 18px rgba(0, 0, 0, 0.25)')
  }
}

export function buildPdfThemeVars(palette: PreviewPalette): Record<string, string> {
  return {
    '--onward-pdf-bg': palette.background,
    '--onward-pdf-panel': palette.panel,
    '--onward-pdf-panel-elevated': palette.elevated,
    '--onward-pdf-line': palette.border,
    '--onward-pdf-text': palette.foreground,
    '--onward-pdf-muted': palette.muted,
    '--onward-pdf-accent': palette.accent,
    '--onward-pdf-shadow': palette.shadow,
    '--onward-pdf-page-tint': palette.panel
  }
}

export function buildMermaidTheme(palette: PreviewPalette) {
  return {
    startOnLoad: false,
    theme: 'base' as const,
    themeVariables: {
      darkMode: palette.kind === 'dark',
      background: palette.elevated,
      mainBkg: palette.panel,
      primaryColor: palette.panel,
      secondaryColor: palette.elevated,
      tertiaryColor: palette.background,
      primaryBorderColor: palette.accent,
      secondaryBorderColor: palette.border,
      tertiaryBorderColor: palette.border,
      nodeBorder: palette.accent,
      lineColor: palette.muted,
      textColor: palette.foreground,
      primaryTextColor: palette.foreground,
      secondaryTextColor: palette.foreground,
      tertiaryTextColor: palette.foreground,
      edgeLabelBackground: palette.elevated,
      clusterBkg: palette.elevated,
      clusterBorder: palette.border,
      actorBkg: palette.panel,
      actorTextColor: palette.foreground,
      actorBorder: palette.accent,
      signalColor: palette.foreground,
      signalTextColor: palette.foreground,
      labelBoxBkgColor: palette.panel,
      labelBoxBorderColor: palette.border,
      labelTextColor: palette.foreground,
      loopTextColor: palette.foreground,
      noteBkgColor: palette.elevated,
      noteTextColor: palette.foreground,
      noteBorderColor: palette.border
    },
    fontFamily: "'IBM Plex Mono', 'Fira Code', 'Source Code Pro', monospace"
  }
}

export function buildEpubThemeCss(palette: PreviewPalette): string {
  return `
html, body { background: ${palette.background}; color: ${palette.foreground}; font-family: "IBM Plex Sans", "Noto Sans SC", "Segoe UI", -apple-system, sans-serif; }
a { color: ${palette.accent}; }
a:hover { color: ${palette.accent}; text-decoration: underline; }
img { max-width: 100%; height: auto; }
code { background: ${palette.code}; color: ${palette.foreground}; border-radius: 4px; padding: 0 4px; }
blockquote { border-left: 3px solid ${palette.accent}; color: ${palette.muted}; padding-left: 10px; margin: 8px 0; }
`
}

export function shouldApplyMermaidResult(state: {
  canceled: boolean
  connected: boolean
  generation: number
  currentGeneration: number
  source: string
  currentSource: string
}): boolean {
  return !state.canceled && state.connected && state.generation === state.currentGeneration && state.source === state.currentSource
}
