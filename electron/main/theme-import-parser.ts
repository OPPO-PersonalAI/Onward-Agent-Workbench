/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { getNodeValue, parseTree, type ParseError } from 'jsonc-parser'
import type { ThemeDefinition, ThemeTokenRule } from '../../src/types/theme'
import { adaptThemeTokenRules, normalizeThemeDefinition, THEME_LIMITS } from '../../src/themes/theme-engine.ts'
import { ThemeImportError, THEME_IMPORT_LIMITS, importErrorCode, type ThemeImportLimits, type ThemeImportErrorCode } from './theme-import-types.ts'
import type { ThemeImportIoTrace } from './theme-import-trace.ts'

export type ThemeImportReader = (path: string, maxBytes: number) => Promise<{ text: string; identity: string }>

export interface ParseThemeImportOptions {
  package?: boolean
  limits?: Partial<ThemeImportLimits>
  io?: ThemeImportIoTrace
}

// These known color IDs are consumed by the workbench/terminal adapter or forwarded to Monaco.
// Unknown colors remain in the snapshot so later adapters can consume them.
export const THEME_IMPORT_SUPPORTED_COLORS: ReadonlySet<string> = new Set([
  'foreground', 'focusBorder', 'onward.background', 'onward.foreground', 'onward.accent',
  'editor.background', 'editor.foreground', 'editor.selectionBackground',
  'editor.selectionForeground', 'editor.inactiveSelectionBackground',
  'editor.lineHighlightBackground', 'editor.lineHighlightBorder',
  'editor.compositionBorder', 'editor.placeholder.foreground', 'editor.linkedEditingBackground',
  'editor.findMatchBackground', 'editor.findMatchForeground', 'editor.findMatchBorder',
  'editor.findMatchHighlightBackground', 'editor.findMatchHighlightForeground', 'editor.findMatchHighlightBorder',
  'editor.findRangeHighlightBackground', 'editor.findRangeHighlightBorder',
  'editor.hoverHighlightBackground', 'editor.foldBackground', 'editor.foldPlaceholderForeground',
  ...['rangeHighlight', 'selectionHighlight', 'symbolHighlight', 'wordHighlight', 'wordHighlightStrong', 'wordHighlightText']
    .flatMap(role => [`editor.${role}Background`, `editor.${role}Border`]),
  'editor.snippetTabstopHighlightBackground', 'editor.snippetTabstopHighlightBorder',
  'editor.snippetFinalTabstopHighlightBackground', 'editor.snippetFinalTabstopHighlightBorder',
  'editorCursor.foreground', 'editorCursor.background',
  'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editorLineNumber.dimmedForeground',
  'editorIndentGuide.background', 'editorIndentGuide.activeBackground',
  ...[1, 2, 3, 4, 5, 6].flatMap(level => [`editorIndentGuide.background${level}`, `editorIndentGuide.activeBackground${level}`]),
  'editorWhitespace.foreground', 'editorGutter.background', 'editorGutter.foldingControlForeground',
  'editorWidget.background', 'editorWidget.foreground', 'editorWidget.border', 'editorWidget.resizeBorder',
  'editorOverviewRuler.background', 'editorOverviewRuler.border',
  ...['bracketMatch', 'commonContent', 'currentContent', 'incomingContent', 'error', 'info', 'warning',
    'findMatch', 'rangeHighlight', 'selectionHighlight', 'wordHighlight', 'wordHighlightStrong', 'wordHighlightText']
    .map(role => `editorOverviewRuler.${role}Foreground`),
  'editorSuggestWidget.background', 'editorSuggestWidget.border', 'editorSuggestWidget.foreground',
  'editorSuggestWidget.highlightForeground', 'editorSuggestWidget.focusHighlightForeground',
  'editorSuggestWidget.selectedBackground', 'editorSuggestWidget.selectedForeground', 'editorSuggestWidget.selectedIconForeground',
  'diffEditor.insertedTextBackground', 'diffEditor.removedTextBackground',
  'diffEditor.insertedLineBackground', 'diffEditor.removedLineBackground',
  'diffEditor.insertedTextBorder', 'diffEditor.removedTextBorder', 'diffEditor.border', 'diffEditor.diagonalFill',
  'diffEditor.unchangedRegionBackground', 'diffEditor.unchangedRegionForeground', 'diffEditor.unchangedRegionShadow',
  'diffEditor.unchangedCodeBackground', 'diffEditor.move.border', 'diffEditor.moveActive.border',
  'diffEditorGutter.insertedLineBackground', 'diffEditorGutter.removedLineBackground',
  'diffEditorOverview.insertedForeground', 'diffEditorOverview.removedForeground',
  'sideBar.background', 'panel.background', 'panel.border',
  'input.background', 'input.foreground', 'input.border', 'input.placeholderForeground',
  'list.activeSelectionBackground', 'list.activeSelectionForeground',
  'list.inactiveSelectionBackground', 'list.inactiveSelectionForeground',
  'list.hoverBackground', 'list.hoverForeground', 'list.focusBackground', 'list.highlightForeground',
  'list.activeSelectionIconForeground', 'list.inactiveSelectionIconForeground',
  'list.deemphasizedForeground', 'list.invalidItemForeground', 'list.errorForeground', 'list.warningForeground',
  'list.dropBackground', 'list.dropBetweenBackground', 'list.filterMatchBackground', 'list.filterMatchBorder',
  'list.focusAndSelectionOutline', 'list.focusForeground', 'list.focusHighlightForeground', 'list.focusOutline',
  'list.inactiveFocusBackground', 'list.inactiveFocusOutline', 'peekView.border',
  'textLink.foreground',
  'scrollbarSlider.background', 'scrollbarSlider.hoverBackground', 'scrollbarSlider.activeBackground',
  'terminal.background', 'terminal.foreground', 'terminal.selectionBackground',
  'terminal.selectionForeground', 'terminal.inactiveSelectionBackground',
  'terminalCursor.foreground', 'terminalCursor.background',
  ...['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].flatMap(color => [
    `terminal.ansi${color}`, `terminal.ansiBright${color}`
  ])
])

const DOCUMENT_KEYS = new Set(['$schema', '$comment', 'name', 'type', 'include', 'colors', 'tokenColors', 'semanticTokenColors', 'semanticHighlighting'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeImportColor(value: unknown): string | null {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return null
  const hex = value.slice(1).toLowerCase()
  return '#' + (hex.length < 5 ? [...hex].map(character => character + character).join('') : hex)
}

export function resolveImportReference(from: string, reference: string): string {
  // Package paths use POSIX semantics on every host. Backslashes in manifests
  // are accepted, while drive-relative paths and URI schemes never are.
  const path = reference.replace(/\\/g, '/')
  if (!path || /[\u0000-\u001f:]/.test(path) || path.startsWith('/')) {
    throw new ThemeImportError('path-outside-root')
  }
  const normalized = posix.normalize(posix.join(posix.dirname(from), path))
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') throw new ThemeImportError('path-outside-root')
  return normalized
}

function parseDocument(text: string, code: 'invalid-theme' | 'invalid-package'): Record<string, unknown> {
  const errors: ParseError[] = []
  const tree = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) throw new ThemeImportError('invalid-json')
  // getNodeValue builds null-prototype dictionaries, unlike parse(), whose
  // assignment semantics can silently consume an imported __proto__ key.
  const value: unknown = tree ? getNodeValue(tree) : undefined
  if (!isRecord(value)) throw new ThemeImportError(code)
  return value
}

function parseTokenRules(value: unknown, unsupported: Set<string>): ThemeTokenRule[] {
  if (typeof value === 'string') {
    unsupported.add('tokenColors:external')
    return []
  }
  if (!Array.isArray(value)) throw new ThemeImportError('invalid-theme')
  if (value.length > THEME_LIMITS.tokenRules) throw new ThemeImportError('size-limit')
  const rules: ThemeTokenRule[] = []
  for (const rule of value) {
    if (!isRecord(rule) || !isRecord(rule.settings)) throw new ThemeImportError('invalid-theme')
    const scope = rule.scope
    if (scope !== undefined && typeof scope !== 'string' && !(Array.isArray(scope) && scope.every(item => typeof item === 'string'))) {
      throw new ThemeImportError('invalid-theme')
    }
    if (scope !== undefined) {
      const scopes = Array.isArray(scope) ? scope : [scope]
      if (scopes.some(item => item.length > 512) || scopes.flatMap(item => item.split(',')).length > THEME_LIMITS.scopesPerRule) {
        throw new ThemeImportError('size-limit')
      }
    }
    const settings: ThemeTokenRule['settings'] = {}
    for (const field of ['foreground', 'background'] as const) {
      if (!(field in rule.settings)) continue
      const color = normalizeImportColor(rule.settings[field])
      if (color) settings[field] = color
      else unsupported.add(`syntax:invalid-${field}`)
    }
    if ('fontStyle' in rule.settings) {
      const style = rule.settings.fontStyle
      if (typeof style === 'string' && style.trim().split(/\s+/).every(part => ['', 'bold', 'italic', 'underline', 'strikethrough'].includes(part))) {
        settings.fontStyle = [...new Set(style.trim().split(/\s+/))].sort().join(' ')
      } else unsupported.add('syntax:fontStyle')
    }
    for (const field of Object.keys(rule.settings)) {
      if (!['foreground', 'background', 'fontStyle'].includes(field)) unsupported.add(`syntax:settings.${field}`)
    }
    for (const field of Object.keys(rule)) {
      if (!['name', 'scope', 'settings'].includes(field)) unsupported.add(`syntax:rule.${field}`)
    }
    if (Object.keys(settings).length) rules.push({ ...(scope === undefined ? {} : { scope }), settings })
  }
  return rules
}

interface FlattenedTheme {
  name?: string
  kind?: 'light' | 'dark'
  colors: Record<string, string>
  tokenColors: ThemeTokenRule[]
  unsupported: Set<string>
}

function declaredKind(value: unknown): 'light' | 'dark' | undefined {
  if (value === 'light' || value === 'vs' || value === 'hc-light') return 'light'
  if (value === 'dark' || value === 'vs-dark' || value === 'hc-black') return 'dark'
  return undefined
}

function inferKind(colors: Record<string, string>): 'light' | 'dark' {
  const background = colors['editor.background'] ?? colors['terminal.background'] ?? '#1e1e1e'
  const rgb = [1, 3, 5].map(offset => {
    const value = parseInt(background.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.5 ? 'light' : 'dark'
}

function boundedReports(values: Iterable<string>): string[] {
  const sorted = [...new Set([...values].map(value => value.slice(0, 256)))].sort()
  return sorted.length >= THEME_LIMITS.unsupported
    ? [...new Set(['compatibility:report-truncated', ...sorted.filter(value => value !== 'compatibility:report-truncated').slice(0, THEME_LIMITS.unsupported - 1)])].sort()
    : sorted
}

export async function parseThemeImport(entry: string, reader: ThemeImportReader, options: ParseThemeImportOptions = {}): Promise<ThemeDefinition[]> {
  const limits = { ...THEME_IMPORT_LIMITS, ...options.limits }
  const io = options.io
  const startedAt = performance.now()
  let ok = false
  let count = 0
  let code: ThemeImportErrorCode | undefined
  io?.begin('parse-start')
  let totalBytes = 0

  async function read(path: string, kind: 'document-read' | 'manifest-read' | 'include-read'): Promise<{ text: string; identity: string }> {
    if (io) {
      io.stats.reads++
      if (kind === 'include-read') io.stats.includeReads++
      io.begin(kind)
    }
    try {
      const remaining = Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes)
      if (remaining < 0) throw new ThemeImportError('size-limit')
      const file = await reader(path, remaining)
      const size = Buffer.byteLength(file.text, 'utf8')
      totalBytes += size
      if (io) io.stats.bytes += size
      if (size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) throw new ThemeImportError('size-limit')
      return file
    } catch (error) {
      if (io) io.stats.readFailures++
      throw new ThemeImportError(importErrorCode(error))
    }
  }

  async function flatten(path: string, ancestors: Set<string>, depth: number): Promise<FlattenedTheme> {
    if (io) io.stats.depth = Math.max(io.stats.depth, depth)
    if (depth > limits.maxDepth) throw new ThemeImportError('include-depth-limit')
    const { text, identity } = await read(path, depth > 0 ? 'include-read' : 'document-read')
    if (ancestors.has(identity)) throw new ThemeImportError('include-cycle')
    const document = parseDocument(text, 'invalid-theme')
    const nextAncestors = new Set(ancestors).add(identity)
    let flattened: FlattenedTheme = { colors: {}, tokenColors: [], unsupported: new Set() }
    if ('include' in document) {
      if (typeof document.include !== 'string') throw new ThemeImportError('invalid-theme')
      flattened = await flatten(resolveImportReference(path, document.include), nextAncestors, depth + 1)
    }
    const unsupported = flattened.unsupported
    for (const key of Object.keys(document)) if (!DOCUMENT_KEYS.has(key)) unsupported.add(`property:${key}`)
    if ('semanticTokenColors' in document) unsupported.add('semanticTokenColors')
    if ('semanticHighlighting' in document) unsupported.add('semanticHighlighting')
    if (typeof document.name === 'string' && document.name.trim()) flattened.name = document.name.trim().slice(0, 256)
    if ('type' in document) {
      const kind = declaredKind(document.type)
      if (kind) flattened.kind = kind
      else unsupported.add('kind:unsupported')
    }
    if ('colors' in document) {
      if (!isRecord(document.colors)) throw new ThemeImportError('invalid-theme')
      for (const [key, value] of Object.entries(document.colors)) {
        const color = normalizeImportColor(value)
        if (!color) unsupported.add(`invalid-color:${key}`)
        else {
          // Define own properties explicitly: imported keys never invoke a
          // prototype setter, including a malicious __proto__ color key.
          Object.defineProperty(flattened.colors, key, { value: color, enumerable: true, configurable: true, writable: true })
          if (!THEME_IMPORT_SUPPORTED_COLORS.has(key)) unsupported.add(`workbench:${key}`)
        }
      }
    }
    if ('tokenColors' in document) flattened.tokenColors.push(...parseTokenRules(document.tokenColors, unsupported))
    if (Object.keys(flattened.colors).length > THEME_LIMITS.colors || flattened.tokenColors.length > THEME_LIMITS.tokenRules) {
      throw new ThemeImportError('size-limit')
    }
    return flattened
  }

  try {
    const start = resolveImportReference('_root_', entry)
    let candidates: { path: string; label?: string; uiTheme?: unknown }[] = [{ path: start }]
    if (options.package) {
      const manifest = parseDocument((await read(start, 'manifest-read')).text, 'invalid-package')
      const contributions = isRecord(manifest.contributes) ? manifest.contributes.themes : undefined
      if (!Array.isArray(contributions) || contributions.length === 0) throw new ThemeImportError('invalid-package')
      if (contributions.length > limits.maxThemes) throw new ThemeImportError('theme-count-limit')
      candidates = contributions.map(contribution => {
        if (!isRecord(contribution) || typeof contribution.path !== 'string') throw new ThemeImportError('invalid-package')
        return {
          path: resolveImportReference(start, contribution.path),
          label: typeof contribution.label === 'string' ? contribution.label : undefined,
          uiTheme: contribution.uiTheme
        }
      })
    }
    const themes: ThemeDefinition[] = []
    for (const candidate of candidates) {
      const flattened = await flatten(candidate.path, new Set(), 0)
      const contributionKind = declaredKind(candidate.uiTheme)
      const kind = contributionKind ?? flattened.kind ?? inferKind(flattened.colors)
      if (!contributionKind && !flattened.kind) flattened.unsupported.add('kind:inferred')
      if (candidate.uiTheme !== undefined && !contributionKind) flattened.unsupported.add('kind:unsupported')
      const reports = boundedReports([
        ...flattened.unsupported,
        ...adaptThemeTokenRules(flattened.tokenColors, kind).unsupported
      ])
      const theme = normalizeThemeDefinition({
        id: 'import-pending',
        name: candidate.label?.trim() || flattened.name || posix.basename(candidate.path, posix.extname(candidate.path)),
        kind,
        colors: Object.fromEntries(Object.entries(flattened.colors).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
        tokenColors: flattened.tokenColors,
        source: options.package ? 'vsix' : 'jsonc',
        unsupported: reports
      })
      if (!theme) throw new ThemeImportError('invalid-theme')
      theme.unsupported?.sort()
      // Hash the same canonical snapshot the storage boundary accepts. Names,
      // source locations and compatibility diagnostics are metadata, not identity.
      theme.id = 'import-' + createHash('sha256').update(JSON.stringify({
        kind: theme.kind, colors: theme.colors, tokenColors: theme.tokenColors
      })).digest('hex')
      const existing = themes.find(item => item.id === theme.id)
      if (existing) {
        if (theme.unsupported?.length) existing.unsupported = boundedReports([...(existing.unsupported ?? []), ...theme.unsupported])
      } else themes.push(theme)
    }
    ok = true
    count = themes.length
    return themes
  } catch (error) {
    code = importErrorCode(error)
    throw error
  } finally {
    io?.emit('parse-complete', { durationMs: performance.now() - startedAt, ok, count, code })
  }
}
