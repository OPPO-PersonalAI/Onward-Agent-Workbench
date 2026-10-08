/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThemeColors, ThemeSettings, ResolvedTheme } from '../types/theme'
import { resolveTheme } from '../themes/theme-engine'
import { applyEditorTheme } from '../themes/editor-theme'
import { PERF_TRACE_EVENT } from './perf-trace-names'
import { perfTraceDiagnostic } from './perf-trace'

/** All themeable CSS variable names */
let appliedVariables = new Set<string>()
let revision = 0
let paintFrame = 0

/**
 * Apply theme color to document.documentElement.style
 */
export function applyTheme(colors: ThemeColors): void {
  const style = document.documentElement.style
  for (const name of appliedVariables) {
    if (!(name in colors)) style.removeProperty(name)
  }
  for (const [name, value] of Object.entries(colors)) style.setProperty(name, value)
  appliedVariables = new Set(Object.keys(colors))
}

/** Resolve root tokens using the active named theme and current system appearance. */
export function resolveThemeColors(settings: ThemeSettings): ThemeColors {
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_APPLY, { reason: 'legacy-resolve', mode: settings.mode })
  return resolveTheme(settings, typeof window === 'undefined' || window.matchMedia('(prefers-color-scheme: dark)').matches).colors
}

/** Apply one resolved snapshot; notification occurs only after every root token is ready. */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  const start = performance.now()
  applyTheme(theme.colors)
  applyEditorTheme(theme)
  const root = document.documentElement
  const currentRevision = ++revision
  root.dataset.theme = theme.id
  root.dataset.themeKind = theme.kind
  root.dataset.themeRevision = String(currentRevision)
  root.style.colorScheme = theme.kind
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_APPLY, { reason: 'dispatch', revision: currentRevision, kind: theme.kind })
  window.dispatchEvent(new CustomEvent('onward:theme-applied', {
    detail: { id: theme.id, kind: theme.kind, revision: currentRevision }
  }))
  if (paintFrame) {
    cancelAnimationFrame(paintFrame)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_APPLY, { reason: 'paint-coalesced', revision: currentRevision - 1 })
  }
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_APPLY, {
      reason: 'painted', themeId: theme.id, kind: theme.kind, revision: currentRevision,
      durationMs: performance.now() - start
    })
  })
}
