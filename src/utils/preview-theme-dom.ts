/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildPreviewPalette } from './preview-theme'
import { perfTraceDiagnostic } from './perf-trace'
import { PERF_TRACE_EVENT } from './perf-trace-names'

export const PREVIEW_THEME_APPLIED_EVENT = 'onward:theme-applied'

export function readPreviewPalette() {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const palette = buildPreviewPalette(name => style.getPropertyValue(name), root.dataset.themeKind === 'light' ? 'light' : 'dark')
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, {
    surface: 'preview-palette', kind: palette.kind, reason: 'read', revision: root.dataset.themeRevision?.slice(0, 128) ?? ''
  })
  return palette
}
