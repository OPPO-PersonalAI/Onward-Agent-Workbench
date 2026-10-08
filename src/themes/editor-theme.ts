/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { editor } from 'monaco-editor'
import { registerCustomCSSVariableTheme } from '@pierre/diffs'
import type { ResolvedTheme } from '../types/theme'
import { perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
import { performanceTrace } from '../utils/performance-trace'

export const ACTIVE_EDITOR_THEME = 'onward-active'
export const ACTIVE_PIERRE_THEME = 'onward-css-variables'

// One immutable highlighter theme keeps tokenization caches reusable across palette edits.
// Pierre's public registration API uses the --diffs- prefix for Shiki CSS variables.
try {
  registerCustomCSSVariableTheme(ACTIVE_PIERRE_THEME, {}, false)
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EDITOR_APPLY, { reason: 'pierre-registered' })
} catch (error) {
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EDITOR_APPLY, { reason: 'pierre-registration-failed' })
  throw error
}

let appliedEditorTheme: ResolvedTheme['editor'] | null = null

export function applyEditorTheme(theme: ResolvedTheme): void {
  const startedAt = performance.now()
  const definition = {
    base: theme.editor.base,
    inherit: theme.editor.inherit,
    rules: theme.editor.rules.map(rule => ({ ...rule })),
    colors: { ...theme.editor.colors }
  }
  try {
    editor.defineTheme(ACTIVE_EDITOR_THEME, definition)
    editor.setTheme(ACTIVE_EDITOR_THEME)
    appliedEditorTheme = definition
  } catch (error) {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EDITOR_APPLY, { reason: 'editor-failed', durationMs: performance.now() - startedAt })
    throw error
  }
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EDITOR_APPLY, {
    themeIdHash: performanceTrace.summarizeText('theme', theme.id).themeHash,
    kind: theme.kind,
    colorCount: Object.keys(definition.colors).length,
    ruleCount: definition.rules.length,
    durationMs: performance.now() - startedAt
  })
}

/** Snapshot of the exact public Monaco definition, never a reference to live theme state. */
export function getAppliedEditorTheme(): ResolvedTheme['editor'] | null {
  return appliedEditorTheme && {
    ...appliedEditorTheme,
    colors: { ...appliedEditorTheme.colors },
    rules: appliedEditorTheme.rules.map(rule => ({ ...rule }))
  }
}

/** Map resolved semantic roles to Pierre's public host CSS-variable interface. */
export function buildPierreThemeStyle(theme: ResolvedTheme): Record<string, string> {
  const colors = theme.colors
  const editorColors = theme.editor.colors
  const background = editorColors['editor.background']
  const foreground = editorColors['editor.foreground']
  const addition = colors['--diff-add-text']
  const deletion = colors['--diff-delete-text']
  const selection = editorColors['editor.selectionBackground']
  const style: Record<string, string> = {
    colorScheme: theme.kind,
    '--diffs-background': background,
    '--diffs-foreground': foreground,
    '--diffs-token-comment': colors['--syntax-comment'],
    '--diffs-token-keyword': colors['--syntax-keyword'],
    '--diffs-token-string': colors['--syntax-string'],
    '--diffs-token-string-expression': colors['--syntax-string'],
    '--diffs-token-constant': colors['--syntax-number'],
    '--diffs-token-function': colors['--syntax-function'],
    '--diffs-token-parameter': colors['--syntax-variable'],
    '--diffs-token-punctuation': colors['--syntax-operator'],
    '--diffs-token-link': colors['--accent'],
    '--diffs-token-inserted': addition,
    '--diffs-token-deleted': deletion,
    '--diffs-token-changed': colors['--warning'],
    '--diffs-bg-buffer-override': colors['--bg-2'],
    '--diffs-bg-hover-override': colors['--bg-2'],
    '--diffs-bg-context-override': editorColors['diffEditor.unchangedCodeBackground'] ?? background,
    '--diffs-bg-separator-override': colors['--bg-2'],
    '--diffs-fg-number-override': editorColors['editorLineNumber.foreground'] ?? colors['--text-3'],
    '--diffs-fg-number-addition-override': addition,
    '--diffs-fg-number-deletion-override': deletion,
    '--diffs-addition-color-override': addition,
    '--diffs-deletion-color-override': deletion,
    '--diffs-modified-color-override': colors['--accent'],
    '--diffs-bg-addition-override': editorColors['diffEditor.insertedLineBackground'] ?? colors['--diff-add-bg'],
    '--diffs-bg-deletion-override': editorColors['diffEditor.removedLineBackground'] ?? colors['--diff-delete-bg'],
    '--diffs-bg-addition-number-override': editorColors['diffEditorGutter.insertedLineBackground'] ?? colors['--diff-add-bg'],
    '--diffs-bg-deletion-number-override': editorColors['diffEditorGutter.removedLineBackground'] ?? colors['--diff-delete-bg'],
    '--diffs-bg-addition-emphasis-override': editorColors['diffEditor.insertedTextBackground'] ?? colors['--diff-add-bg'],
    '--diffs-bg-deletion-emphasis-override': editorColors['diffEditor.removedTextBackground'] ?? colors['--diff-delete-bg'],
    '--diffs-bg-selection-override': selection,
    '--diffs-bg-selection-number-override': selection
  }
  for (const name of ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
    'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite']) {
    const key = (name[0].toLowerCase() + name.slice(1)) as keyof ResolvedTheme['terminal']
    const value = theme.terminal[key]
    if (typeof value === 'string') style[`--diffs-ansi-${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`] = value
  }
  return style
}
