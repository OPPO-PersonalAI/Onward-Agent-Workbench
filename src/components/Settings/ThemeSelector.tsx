/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_THEME_SETTINGS, THEME_PRESETS } from '../../constants/themes'
import { getActiveThemeId, getAvailableThemes, isThemeColor, resolveTheme, THEME_LIMITS } from '../../themes/theme-engine'
import { FEATURED_THEME_IDS } from '../../themes/theme-presets'
import type { PresetThemeId, ResolvedTheme, ThemeDefinition, ThemeSettings } from '../../types/theme'
import type { TranslationKey } from '../../i18n/core'
import { useI18n } from '../../i18n/useI18n'
import { useModalEscape } from '../../hooks/useModalEscape'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import './ThemeSelector.css'

const COMMON_COLORS: ReadonlyArray<[string, TranslationKey]> = [
  ['onward.background', 'settings.themes.color.appBackground'],
  ['onward.foreground', 'settings.themes.color.appForeground'],
  ['onward.accent', 'settings.themes.color.accent'],
  ['editor.background', 'settings.themes.color.editorBackground'],
  ['editor.foreground', 'settings.themes.color.editorForeground'],
  ['terminal.background', 'settings.themes.color.terminalBackground'],
  ['terminal.foreground', 'settings.themes.color.terminalForeground']
]

const ADVANCED_COLORS: ReadonlyArray<[string, TranslationKey]> = [
  ['terminalCursor.foreground', 'settings.themes.color.cursorForeground'],
  ['terminalCursor.background', 'settings.themes.color.cursorBackground'],
  ['terminal.selectionBackground', 'settings.themes.color.selectionBackground'],
  ['terminal.selectionForeground', 'settings.themes.color.selectionForeground'],
  ['panel.border', 'settings.themes.color.panelBorder'],
  ['editor.selectionBackground', 'settings.themes.color.editorSelection']
]

const ANSI_COLORS = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'] as const
const IMPORT_ERRORS: Record<string, TranslationKey> = {
  'invalid-json': 'settings.themes.importError.invalid-json',
  'invalid-theme': 'settings.themes.importError.invalid-theme',
  'missing-include': 'settings.themes.importError.missing-include',
  'include-cycle': 'settings.themes.importError.include-cycle',
  'invalid-package': 'settings.themes.importError.invalid-package',
  'unsupported-file': 'settings.themes.importError.unsupported-file',
  'read-failed': 'settings.themes.importError.read-failed',
  'limit-exceeded': 'settings.themes.importError.limit-exceeded',
  'unsupported-format': 'settings.themes.importError.unsupported-file',
  'file-not-found': 'settings.themes.importError.missing-include',
  'file-unreadable': 'settings.themes.importError.read-failed',
  'invalid-archive': 'settings.themes.importError.invalid-package',
  'duplicate-entry': 'settings.themes.importError.invalid-package',
  'size-limit': 'settings.themes.importError.limit-exceeded',
  'theme-count-limit': 'settings.themes.importError.limit-exceeded',
  'include-depth-limit': 'settings.themes.importError.limit-exceeded',
  'path-outside-root': 'settings.themes.importError.path-outside-root',
  'timeout': 'settings.themes.importError.timeout',
  'busy': 'settings.themes.importError.busy',
  'worker-failed': 'settings.themes.importError.generic',
  'dialog-failed': 'settings.themes.importError.generic'
}

interface ThemeDraft {
  id: string
  values: Record<string, string>
  previewOverrides: Record<string, string>
  classic: ThemeSettings['classic']
  classicAccent: string
}

function effectiveColor(theme: ResolvedTheme, token: string): string {
  const appKeys: Record<string, string> = {
    'onward.background': '--bg-0',
    'onward.foreground': '--text-1',
    'onward.accent': '--accent',
    'panel.border': '--border'
  }
  if (appKeys[token]) return theme.colors[appKeys[token]]
  if (token.startsWith('editor.')) return theme.editor.colors[token] ?? ''
  const terminalKeys: Record<string, keyof ResolvedTheme['terminal']> = {
    'terminal.background': 'background',
    'terminal.foreground': 'foreground',
    'terminalCursor.foreground': 'cursor',
    'terminalCursor.background': 'cursorAccent',
    'terminal.selectionBackground': 'selectionBackground',
    'terminal.selectionForeground': 'selectionForeground'
  }
  const ansiName = token.replace(/^terminal\.ansi/, '')
  const key = terminalKeys[token] ?? `${ansiName.charAt(0).toLowerCase()}${ansiName.slice(1)}` as keyof ResolvedTheme['terminal']
  const value = theme.terminal[key]
  return typeof value === 'string' ? value : ''
}

function pickerColor(color: string): string {
  if (!isThemeColor(color)) return '#000000'
  if (color.length === 4 || color.length === 5) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
  }
  return color.slice(0, 7)
}

function CheckIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
  </svg>
}

/** Decorative DOM-only preview: no editor, terminal, or worker instances. */
function WorkbenchPreview({ theme }: { theme: ResolvedTheme }) {
  const style = {
    '--mini-bg': theme.colors['--bg-0'],
    '--mini-panel': theme.colors['--panel'],
    '--mini-sidebar': theme.colors['--bg-2'],
    '--mini-border': theme.colors['--border'],
    '--mini-fg': theme.colors['--text-1'],
    '--mini-muted': theme.colors['--text-3'],
    '--mini-accent': theme.colors['--accent'],
    '--mini-editor-bg': theme.editor.colors['editor.background'],
    '--mini-editor-fg': theme.editor.colors['editor.foreground'],
    '--mini-terminal-bg': theme.terminal.background,
    '--mini-terminal-fg': theme.terminal.foreground,
    '--mini-blue': theme.terminal.blue,
    '--mini-green': theme.terminal.green,
    '--mini-magenta': theme.terminal.magenta,
    '--mini-yellow': theme.terminal.yellow
  } as CSSProperties
  return <span className="theme-workbench" style={style} aria-hidden="true">
    <span className="theme-mini-title"><i /><i /><i /><span /></span>
    <span className="theme-mini-body">
      <span className="theme-mini-activity"><i /><i /><i /></span>
      <span className="theme-mini-sidebar"><b /><i /><i /><i /><i /></span>
      <span className="theme-mini-main">
        <span className="theme-mini-tab"><i /> app.ts <span>×</span></span>
        <span className="theme-mini-editor">
          <span><em>1</em><b>const</b> app = {'{'}</span>
          <span><em>2</em>  theme: <strong>'onward'</strong>,</span>
          <span><em>3</em>  ready: <b>true</b></span>
          <span><em>4</em>{'}'}</span>
        </span>
        <span className="theme-mini-terminal"><span><b>❯</b> pnpm dev</span><span><strong>✓</strong> localhost:5173 <i /></span></span>
      </span>
    </span>
    <span className="theme-mini-status"><i /><span /><span /></span>
  </span>
}

interface ColorFieldProps {
  token: string
  label: string
  value: string
  effective: string
  overridden: boolean
  onChange: (value: string) => void
  testId?: string
  allowAlpha?: boolean
}

function ColorField({ token, label, value, effective, overridden, onChange, testId, allowAlpha = true }: ColorFieldProps) {
  const { t } = useI18n()
  const id = useId()
  const valid = isThemeColor(value) && (allowAlpha || value.length === 4 || value.length === 7)
  const invalid = value !== '' && !valid
  const swatch = isThemeColor(value) ? value : effective
  return <div className={`theme-color-field${invalid ? ' is-invalid' : ''}`}>
    <label htmlFor={id}>{label}</label>
    <div className="theme-color-controls">
      <span className="theme-color-swatch" style={{ '--swatch-color': swatch || 'transparent' } as CSSProperties}>
        <input
          type="color"
          value={pickerColor(swatch)}
          aria-label={t('settings.themes.pickColor', { name: label })}
          onChange={event => {
            const rgb = event.target.value
            const alpha = isThemeColor(value) && value.length === 9 ? value.slice(7)
              : isThemeColor(value) && value.length === 5 ? value[4].repeat(2) : ''
            onChange(`${rgb}${alpha}`)
          }}
        />
      </span>
      <input
        id={id}
        data-testid={testId ?? `theme-override-${token}`}
        className="theme-color-text"
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        placeholder={t('settings.themes.inherit')}
        onChange={event => onChange(event.target.value)}
        onBlur={() => {
          if (invalid) perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'error', operation: 'validation', field: token })
        }}
      />
      <button
        type="button"
        className="theme-color-inherit"
        disabled={!overridden}
        onClick={() => {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'inherit', field: token })
          onChange('')
        }}
        title={t('settings.themes.inheritColor', { name: label })}
        aria-label={t('settings.themes.inheritColor', { name: label })}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 6a5 5 0 1 1-.2 4M3 2.5V6h3.5" /></svg>
      </button>
    </div>
    {invalid && <p id={`${id}-error`} className="theme-field-error">{t(allowAlpha ? 'settings.themes.invalidColor' : 'settings.themes.invalidClassicColor')}</p>}
  </div>
}

export function ThemeSelector() {
  const { settings, systemDark, previewTheme, updateTheme } = useSettings()
  const { t } = useI18n()
  const currentTheme = settings?.theme ?? DEFAULT_THEME_SETTINGS
  const available = useMemo(() => getAvailableThemes(currentTheme), [currentTheme])
  const activeId = getActiveThemeId(currentTheme, systemDark)
  const [draft, setDraft] = useState<ThemeDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [candidates, setCandidates] = useState<ThemeDefinition[] | null>(null)
  const [choices, setChoices] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<TranslationKey | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState<'success' | 'error' | null>(null)
  const exportingRef = useRef(false)
  const pendingExportRef = useRef<string | null>(null)
  const customizeButton = useRef<HTMLButtonElement>(null)
  const importButton = useRef<HTMLButtonElement>(null)
  const draftPanel = useRef<HTMLElement>(null)
  const importPanel = useRef<HTMLElement>(null)
  const mounted = useRef(true)
  const savingRef = useRef(false)
  const draftRef = useRef(draft)
  const candidatesRef = useRef(candidates)
  const previewRef = useRef(previewTheme)
  const importRequest = useRef(0)
  const pendingImportRef = useRef<{ request: number; id: string } | null>(null)
  const idPrefix = useId()
  draftRef.current = draft
  candidatesRef.current = candidates
  previewRef.current = previewTheme

  const pinnedTheme = useMemo<ThemeSettings | null>(() => draft ? {
    ...currentTheme,
    mode: 'manual',
    themeId: draft.id,
    classic: draft.classic,
    overrides: { ...currentTheme.overrides, [draft.id]: draft.previewOverrides }
  } : null, [currentTheme, draft?.id, draft?.classic, draft?.previewOverrides])
  const displayTheme = useMemo(() => resolveTheme(pinnedTheme ?? currentTheme, systemDark), [pinnedTheme, currentTheme, systemDark])
  const featured = useMemo(() => FEATURED_THEME_IDS.map(id => resolveTheme({ ...currentTheme, mode: 'manual', themeId: id }, systemDark)), [currentTheme, systemDark])
  const moreThemes = available.filter(theme => !(FEATURED_THEME_IDS as readonly string[]).includes(theme.id))
  const invalidDraft = Boolean(draft && (
    Object.values(draft.values).some(value => value !== '' && !isThemeColor(value)) ||
    (draft.classic.mode === 'custom' && draft.id === 'onward-classic' && (!isThemeColor(draft.classicAccent) || ![4, 7].includes(draft.classicAccent.length)))
  ))
  const locked = Boolean(draft || candidates || importing || saving || exporting || !settings)

  const abortPendingImport = useCallback((cause: 'escape' | 'unmount') => {
    const pending = pendingImportRef.current
    if (!pending) return
    pendingImportRef.current = null
    void window.electronAPI.themes.cancelImport(pending.id, cause).then(result => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, {
        reason: 'cancel-settled', source: cause, canceled: result.canceled
      })
    }).catch(() => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'error', operation: 'cancel', source: cause })
    })
  }, [])

  const abortPendingExport = useCallback((cause: 'escape' | 'unmount') => {
    const id = pendingExportRef.current
    if (!id) return
    pendingExportRef.current = null
    exportingRef.current = false
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EXPORT, { stage: 'cancel-ipc-send', cause })
    void window.electronAPI.themes.cancelExport(id).then(result => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EXPORT, { stage: 'cancel-ipc-received', canceled: result.canceled, cause })
    }).catch(() => perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EXPORT, { stage: 'cancel-ipc-rejected', cause }))
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      importRequest.current += 1
      if (draftRef.current) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'cancel', source: 'unmount' })
        previewRef.current(null)
      }
      if (candidatesRef.current || pendingImportRef.current !== null) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, {
          reason: 'cancel', source: 'unmount', pending: pendingImportRef.current !== null, candidates: Boolean(candidatesRef.current)
        })
      }
      abortPendingImport('unmount')
      abortPendingExport('unmount')
    }
  }, [])

  useEffect(() => {
    if (pinnedTheme) previewRef.current(pinnedTheme)
  }, [pinnedTheme])

  useEffect(() => {
    if (draft) draftPanel.current?.focus()
  }, [draft?.id])

  useEffect(() => {
    if (candidates) importPanel.current?.focus()
  }, [candidates])

  const cancelDraft = useCallback(() => {
    if (savingRef.current) return
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'cancel' })
    setDraft(null)
    draftRef.current = null
    previewRef.current(null)
    setSaveError(false)
    // Focus after React enables the originating button again.
    queueMicrotask(() => customizeButton.current?.focus())
  }, [])

  const cancelImport = useCallback(() => {
    if (savingRef.current) return
    importRequest.current += 1
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'cancel' })
    abortPendingImport('escape')
    setCandidates(null)
    setChoices(new Set())
    setImportError(null)
    setImporting(false)
    setSaveError(false)
    queueMicrotask(() => importButton.current?.focus())
  }, [])

  useModalEscape(Boolean(draft), cancelDraft, 'theme-customize')
  useModalEscape(Boolean(candidates) || importing, cancelImport, 'theme-import')
  useModalEscape(exporting, () => { abortPendingExport('escape'); setExporting(false); setExportStatus(null) }, 'theme-export')

  const persist = async (next: ThemeSettings): Promise<boolean> => {
    if (savingRef.current) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'skip', operation: 'persist', cause: 'busy' })
      return false
    }
    savingRef.current = true
    setSaving(true)
    setSaveError(false)
    try {
      const success = await updateTheme(next)
      if (mounted.current && !success) setSaveError(true)
      return success
    } catch {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'error', operation: 'persist', code: 'unexpected', mounted: mounted.current })
      if (mounted.current) setSaveError(true)
      return false
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }

  const selectTheme = (id: string) => {
    if (!locked) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'select', operation: 'theme' })
      void persist({ ...currentTheme, mode: 'manual', themeId: id })
    }
  }

  const beginDraft = () => {
    if (locked) return
    const overrides = { ...(currentTheme.overrides[activeId] ?? {}) }
    setSaveError(false)
    setDraft({
      id: activeId,
      values: overrides,
      previewOverrides: overrides,
      classic: currentTheme.classic,
      classicAccent: currentTheme.classic.custom?.accent ?? '#3b82f6'
    })
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'open' })
  }

  const updateDraftColor = (token: string, value: string) => {
    setSaveError(false)
    setDraft(previous => {
      if (!previous) return previous
      const values = { ...previous.values, [token]: value }
      if (value !== '' && !isThemeColor(value)) return { ...previous, values }
      const previewOverrides = { ...previous.previewOverrides }
      if (value === '') {
        delete values[token]
        delete previewOverrides[token]
      } else previewOverrides[token] = value
      return { ...previous, values, previewOverrides }
    })
  }

  const resetDraft = () => {
    if (savingRef.current) return
    setDraft(previous => previous ? { ...previous, values: {}, previewOverrides: {} } : null)
    setSaveError(false)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'reset' })
  }

  const saveDraft = async () => {
    if (!draft || invalidDraft || savingRef.current) return
    const overrides = { ...currentTheme.overrides }
    if (Object.keys(draft.previewOverrides).length) overrides[draft.id] = draft.previewOverrides
    else delete overrides[draft.id]
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'save', count: Object.keys(draft.previewOverrides).length })
    const success = await persist({ ...currentTheme, overrides, classic: draft.classic })
    if (!mounted.current) return
    if (success) {
      setDraft(null)
      draftRef.current = null
      previewRef.current(null)
      queueMicrotask(() => customizeButton.current?.focus())
    } else perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'error', operation: 'save' })
  }

  const openImport = async () => {
    if (locked) return
    const request = ++importRequest.current
    const requestId = crypto.randomUUID()
    pendingImportRef.current = { request, id: requestId }
    setImporting(true)
    setImportError(null)
    setSaveError(false)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'open', request })
    try {
      const result = await window.electronAPI.themes.import(requestId)
      if (!mounted.current || request !== importRequest.current) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, {
          reason: 'stale-result', source: mounted.current ? 'superseded' : 'unmount', outcome: 'resolved', request
        })
        return
      }
      if (result.canceled) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'cancel', source: 'dialog' })
        return
      }
      if (!result.success || !result.themes?.length) {
        const code = result.error?.code ?? 'invalid-theme'
        const key = Object.hasOwn(IMPORT_ERRORS, code) ? IMPORT_ERRORS[code] : 'settings.themes.importError.generic'
        setImportError(key)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'error', code: Object.hasOwn(IMPORT_ERRORS, code) ? code : 'unknown' })
        return
      }
      const unique = [...new Map(result.themes.map(theme => [theme.id, theme])).values()]
      setCandidates(unique)
      setChoices(new Set(unique.map(theme => theme.id)))
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'selection', count: unique.length })
    } catch {
      if (mounted.current && request === importRequest.current) {
        setImportError('settings.themes.importError.generic')
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'error', code: 'unknown', operation: 'import', request })
      } else {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, {
          reason: 'stale-result', source: mounted.current ? 'superseded' : 'unmount', outcome: 'rejected', request
        })
      }
    } finally {
      if (pendingImportRef.current?.request === request) pendingImportRef.current = null
      if (mounted.current && request === importRequest.current) setImporting(false)
    }
  }

  const confirmImport = async () => {
    if (!candidates || !choices.size || savingRef.current) return
    const selected = candidates.filter(theme => choices.has(theme.id))
    if (!selected.length) return
    const imported = new Map(currentTheme.imported.map(theme => [theme.id, theme]))
    for (const theme of selected) if (!imported.has(theme.id)) imported.set(theme.id, theme)
    if (imported.size > THEME_LIMITS.imported) {
      setImportError('settings.themes.importError.catalog-full')
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'error', code: 'catalog-full', count: imported.size })
      return
    }
    setImportError(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'confirm', count: selected.length })
    const success = await persist({ ...currentTheme, imported: [...imported.values()], mode: 'manual', themeId: selected[0].id })
    if (!mounted.current) return
    if (success) {
      setCandidates(null)
      setChoices(new Set())
      queueMicrotask(() => importButton.current?.focus())
    } else perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'error', operation: 'save' })
  }

  const exportTheme = async () => {
    if (locked || exportingRef.current) return
    exportingRef.current = true
    const requestId = crypto.randomUUID()
    pendingExportRef.current = requestId
    setExporting(true)
    setExportStatus(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EXPORT, { stage: 'ipc-send' })
    try {
      const result = await window.electronAPI.themes.export(requestId, activeId)
      const current = pendingExportRef.current === requestId
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EXPORT, { stage: 'ipc-received', ok: result.success, canceled: result.canceled === true, mounted: mounted.current, current })
      if (mounted.current && current && !result.canceled) setExportStatus(result.success ? 'success' : 'error')
    } catch {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_EXPORT, { stage: 'ipc-rejected' })
      if (mounted.current && pendingExportRef.current === requestId) setExportStatus('error')
    } finally {
      if (pendingExportRef.current === requestId) {
        pendingExportRef.current = null
        exportingRef.current = false
        if (mounted.current) setExporting(false)
      }
    }
  }

  const themeName = (theme: ThemeDefinition) => currentTheme.imported.some(item => item.id === theme.id)
    ? `${theme.name} · ${theme.id.slice(-8)}` : theme.name
  const colorField = (token: string, label: string) => draft && <ColorField
    key={token}
    token={token}
    label={label}
    value={draft.values[token] ?? effectiveColor(displayTheme, token)}
    effective={effectiveColor(displayTheme, token)}
    overridden={Object.hasOwn(draft.values, token)}
    onChange={value => updateDraftColor(token, value)}
  />

  return <div className="theme-selector" data-testid="themes-root" aria-busy={saving || importing || exporting}>
    <fieldset className="theme-selection-controls" disabled={locked}>
      <label className="theme-select-field" htmlFor={`${idPrefix}-mode`}>
        <span>{t('settings.themes.mode')}</span>
        <select id={`${idPrefix}-mode`} data-testid="theme-mode" value={currentTheme.mode} onChange={event => {
          const mode = event.target.value as ThemeSettings['mode']
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'mode', mode: mode === 'system' ? 'system' : 'manual' })
          void persist({ ...currentTheme, mode, themeId: activeId })
        }}>
          <option value="system">{t('settings.themes.system')}</option>
          <option value="manual">{t('settings.themes.manual')}</option>
        </select>
      </label>
      <p className="theme-hint">{t(currentTheme.mode === 'system' ? 'settings.themes.systemHint' : 'settings.themes.manualHint')}</p>
      <div className={`theme-system-pair${currentTheme.mode === 'manual' ? ' is-inactive' : ''}`}>
        {(['light', 'dark'] as const).map(kind => <label className="theme-select-field" key={kind} htmlFor={`${idPrefix}-${kind}`}>
          <span>{t(kind === 'light' ? 'settings.themes.lightTheme' : 'settings.themes.darkTheme')}</span>
          <select id={`${idPrefix}-${kind}`} data-testid={`theme-pair-${kind}`} disabled={currentTheme.mode !== 'system'} value={currentTheme[kind === 'light' ? 'lightThemeId' : 'darkThemeId']} onChange={event => {
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'pair', kind })
            void persist({ ...currentTheme, [kind === 'light' ? 'lightThemeId' : 'darkThemeId']: event.target.value })
          }}>
            {available.filter(theme => theme.kind === kind).map(theme => <option key={theme.id} value={theme.id}>{themeName(theme)}</option>)}
          </select>
        </label>)}
      </div>
      <div className="theme-preset-grid" role="group" aria-label={t('settings.themes.featured')}>
        {featured.map(theme => <button
          type="button"
          key={theme.id}
          data-testid={`theme-card-${theme.id}`}
          className={`theme-preset-card${displayTheme.id === theme.id ? ' selected' : ''}`}
          aria-pressed={displayTheme.id === theme.id}
          onClick={() => selectTheme(theme.id)}
        >
          <WorkbenchPreview theme={theme} />
          <span className="theme-card-caption"><span className="theme-preset-name">{theme.name}</span><span className="theme-card-kind">{t(theme.kind === 'light' ? 'settings.themes.light' : 'settings.themes.dark')}</span></span>
          {displayTheme.id === theme.id && <span className="theme-preset-check"><CheckIcon /><span>{t('settings.themes.selected')}</span></span>}
        </button>)}
      </div>
      <label className="theme-select-field" htmlFor={`${idPrefix}-more`}>
        <span>{t('settings.themes.more')}</span>
        <select id={`${idPrefix}-more`} data-testid="theme-more" value={moreThemes.some(theme => theme.id === displayTheme.id) ? displayTheme.id : ''} onChange={event => selectTheme(event.target.value)}>
          <option value="" disabled>{t('settings.themes.morePlaceholder')}</option>
          {moreThemes.map(theme => <option key={theme.id} value={theme.id}>{themeName(theme)}</option>)}
        </select>
      </label>
      {activeId === 'onward-classic' && !draft && <label className="theme-select-field theme-classic-preset" htmlFor={`${idPrefix}-classic-select`}>
        <span>{t('settings.themes.classicPreset')}</span>
        <select id={`${idPrefix}-classic-select`} data-testid="classic-preset" value={currentTheme.classic.presetId} onChange={event => {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'classic-preset', source: 'selection', mode: 'preset' })
          void persist({ ...currentTheme, classic: { ...currentTheme.classic, mode: 'preset', presetId: event.target.value as PresetThemeId } })
        }}>
          {THEME_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{t(`settings.theme.preset.${preset.id}.name` as TranslationKey)}</option>)}
        </select>
      </label>}
    </fieldset>

    <div className="theme-active-bar">
      <span className="theme-active-name">{t('settings.themes.active', { name: displayTheme.name })}</span>
      <button type="button" ref={customizeButton} data-testid="theme-customize" className="theme-button" disabled={locked} onClick={beginDraft}>{t('settings.themes.customize')}</button>
    </div>
    {activeId === 'onward-classic' && !draft && <p className="theme-hint">{t('settings.themes.classicHint')}</p>}

    {draft && <section className="theme-inline-panel" ref={draftPanel} tabIndex={-1} aria-labelledby={`${idPrefix}-draft-title`}>
      <div className="theme-inline-header"><h3 id={`${idPrefix}-draft-title`}>{t('settings.themes.customizeTitle', { name: displayTheme.name })}</h3><span className="theme-preview-badge">{t('settings.themes.previewBadge')}</span></div>
      <p className="theme-hint">{t('settings.themes.previewHint')}</p>
      <WorkbenchPreview theme={displayTheme} />
      <fieldset className="theme-draft-fields" disabled={saving}>
        {draft.id === 'onward-classic' && <div className="theme-classic-controls">
          <label className="theme-select-field" htmlFor={`${idPrefix}-classic`}>
            <span>{t('settings.themes.classicPreset')}</span>
            <select id={`${idPrefix}-classic`} data-testid="classic-preset" value={draft.classic.presetId} onChange={event => {
              const presetId = event.target.value as PresetThemeId
              perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'classic-preset', source: 'draft', mode: 'preset' })
              setDraft(previous => previous ? { ...previous, classic: { ...previous.classic, presetId, mode: 'preset' } } : null)
            }}>
              {THEME_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{t(`settings.theme.preset.${preset.id}.name` as TranslationKey)}</option>)}
            </select>
          </label>
          <label className="theme-checkbox-label"><input type="checkbox" checked={draft.classic.mode === 'custom'} onChange={event => {
            const custom = event.target.checked
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE, { reason: 'classic-mode', mode: custom ? 'custom' : 'preset' })
            setDraft(previous => previous ? { ...previous, classic: { ...previous.classic, mode: custom ? 'custom' : 'preset', custom: { accent: isThemeColor(previous.classicAccent) && [4, 7].includes(previous.classicAccent.length) ? pickerColor(previous.classicAccent) : '#3b82f6' } } } : null)
          }} /><span>{t('settings.themes.classicCustom')}</span></label>
          {draft.classic.mode === 'custom' && <ColorField token="classic-accent" testId="classic-accent" allowAlpha={false} label={t('settings.theme.customAccent')} value={draft.classicAccent} effective={draft.classic.custom?.accent ?? '#3b82f6'} overridden={draft.classicAccent !== '#3b82f6'} onChange={value => {
            const accent = value || '#3b82f6'
            setDraft(previous => previous ? { ...previous, classicAccent: accent, classic: isThemeColor(accent) && [4, 7].includes(accent.length) ? { ...previous.classic, custom: { accent: pickerColor(accent) } } : previous.classic } : null)
          }} />}
        </div>}
        <h4 className="theme-fields-title">{t('settings.themes.commonColors')}</h4>
        {COMMON_COLORS.map(([token, label]) => colorField(token, t(label)))}
        <details className="theme-advanced-colors">
          <summary data-testid="theme-advanced-toggle">{t('settings.themes.advancedColors')}</summary>
          {ADVANCED_COLORS.map(([token, label]) => colorField(token, t(label)))}
          <h4 className="theme-fields-title">{t('settings.themes.ansiColors')}</h4>
          {[false, true].flatMap(bright => ANSI_COLORS.map(name => {
            const baseName = t(`settings.themes.ansi.${name.toLowerCase()}` as TranslationKey)
            return colorField(`terminal.ansi${bright ? 'Bright' : ''}${name}`, bright ? t('settings.themes.ansi.bright', { color: baseName }) : baseName)
          }))}
        </details>
      </fieldset>
      {invalidDraft && <p className="theme-error" role="status">{t('settings.themes.invalidColors')}</p>}
      {saveError && <p className="theme-error" role="alert">{t('settings.themes.saveError')}</p>}
      <div className="theme-draft-footer">
        <p className="theme-hint">{t('settings.themes.resetHint')}</p>
        <button type="button" className="theme-button theme-reset-button" data-testid="theme-draft-reset" disabled={saving} onClick={resetDraft}>{t('settings.themes.reset')}</button>
        <div className="theme-actions">
          <button type="button" className="theme-button" data-testid="theme-draft-cancel" disabled={saving} onClick={cancelDraft}>{t('common.cancel')}</button>
          <button type="button" className="theme-button theme-button-primary" data-testid="theme-draft-save" disabled={saving || invalidDraft} onClick={() => void saveDraft()}>{t(saving ? 'settings.themes.saving' : 'common.save')}</button>
        </div>
      </div>
    </section>}

    <div className="theme-import-section">
      <button type="button" className="theme-button theme-import-button" ref={importButton} data-testid="theme-import" disabled={locked} onClick={() => void openImport()}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M8 1v9m-3-3 3 3 3-3M2 10v4h12v-4" /></svg>
        <span>{t(importing ? 'settings.themes.importWorking' : 'settings.themes.import')}</span>
      </button>
      <p className="theme-hint">{t('settings.themes.importHint')}</p>
      {importError && <p className="theme-error" data-testid="theme-import-error" role="alert">{t(importError)}</p>}
      <button type="button" className="theme-button theme-import-button" data-testid="theme-export" disabled={locked} onClick={() => void exportTheme()}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M8 11V2m-3 3 3-3 3 3M2 10v4h12v-4" /></svg>
        <span>{t(exporting ? 'settings.themes.exportWorking' : 'settings.themes.export')}</span>
      </button>
      <p className="theme-hint">{t('settings.themes.exportHint')}</p>
      {exportStatus && <p className={exportStatus === 'error' ? 'theme-error' : 'theme-hint'} data-testid="theme-export-status" role={exportStatus === 'error' ? 'alert' : 'status'}>{t(exportStatus === 'error' ? 'settings.themes.exportError' : 'settings.themes.exportSuccess')}</p>}
    </div>

    {candidates && <section className="theme-inline-panel" ref={importPanel} tabIndex={-1} aria-labelledby={`${idPrefix}-import-title`}>
      <h3 id={`${idPrefix}-import-title`}>{t('settings.themes.importTitle')}</h3>
      <p className="theme-hint">{t('settings.themes.importSelectionHint')}</p>
      <fieldset className="theme-import-candidates" disabled={saving}>
        {candidates.map(theme => <div key={theme.id} className="theme-import-candidate">
          <label className="theme-checkbox-label">
            <input type="checkbox" data-testid={`theme-import-choice-${theme.id}`} checked={choices.has(theme.id)} onChange={event => {
              const next = new Set(choices)
              if (event.target.checked) next.add(theme.id)
              else next.delete(theme.id)
              setChoices(next)
              setImportError(null)
              setSaveError(false)
              perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI, { reason: 'selection', count: next.size })
            }} />
            <span><strong>{theme.name}</strong><span className="theme-import-meta">{t(theme.kind === 'light' ? 'settings.themes.light' : 'settings.themes.dark')} · <code>{theme.id.slice(-8)}</code></span></span>
          </label>
          {theme.source && <p className="theme-import-source">{theme.source}</p>}
          {currentTheme.imported.some(item => item.id === theme.id) && <span className="theme-import-existing">{t('settings.themes.importExisting')}</span>}
          {theme.unsupported?.length ? <details className="theme-unsupported"><summary>{t('settings.themes.importUnsupported', { count: theme.unsupported.length })}</summary><ul>{theme.unsupported.map((field, index) => <li key={`${index}-${field}`}><code>{field}</code></li>)}</ul></details> : <p className="theme-hint">{t('settings.themes.importSupported')}</p>}
        </div>)}
      </fieldset>
      {saveError && <p className="theme-error" data-testid="theme-import-error" role="alert">{t('settings.themes.saveError')}</p>}
      <div className="theme-actions">
        <button type="button" className="theme-button" disabled={saving} onClick={cancelImport}>{t('common.cancel')}</button>
        <button type="button" className="theme-button theme-button-primary" data-testid="theme-import-confirm" disabled={saving || choices.size === 0} onClick={() => void confirmImport()}>{t(saving ? 'settings.themes.saving' : 'settings.themes.importConfirm')}</button>
      </div>
    </section>}
    {saveError && !draft && !candidates && <p className="theme-error" role="alert">{t('settings.themes.saveError')}</p>}
  </div>
}
