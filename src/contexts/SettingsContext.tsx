/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from 'react'
import type {
  SettingsState,
  ShortcutConfig,
  TerminalStyleConfig,
  GlobalTerminalStyle,
  ShortcutAction
} from '../types/settings.d.ts'
import type { ThemeSettings, ResolvedTheme } from '../types/theme'
import { DEFAULT_THEME_SETTINGS } from '../constants/themes'
import { applyResolvedTheme } from '../utils/theme-applier'
import { resolveTheme, normalizeThemeSettings } from '../themes/theme-engine'
import { patchTaskFonts, resolveTaskFonts } from '../themes/task-fonts'
import { perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
import { terminalSessionManager } from '../terminal/terminal-session-manager'
import { getAppliedEditorTheme } from '../themes/editor-theme'
import { DEFAULT_LOCALE, type AppLocale } from '../i18n/core'
import { trackFeatureUse } from '../telemetry/track-feature-use'

/**
 * Save anti-shake time (milliseconds)
 */
const SAVE_DEBOUNCE_MS = 300

/** Settings panel default width */
const DEFAULT_SETTINGS_PANEL_WIDTH = 400

function createDefaultGlobalTerminalStyle(): GlobalTerminalStyle {
  return {
    fontFamily: null,
    fontSize: null,
    gitDiffFontSize: null
  }
}

/**
 * Create the default shortcut configuration
 */
function createDefaultShortcuts(): ShortcutConfig {
  return {
    focusTerminal1: null,
    focusTerminal2: null,
    focusTerminal3: null,
    focusTerminal4: null,
    focusTerminal5: null,
    focusTerminal6: null,
    focusTerminal7: null,
    focusTerminal8: null,
    switchTab1: null,
    switchTab2: null,
    switchTab3: null,
    switchTab4: null,
    switchTab5: null,
    switchTab6: null,
    activateAndFocusPrompt: null,
    addToHistory: null,
    focusPromptEditor: null,
    terminalGitDiff: null,
    terminalGitHistory: null,
    terminalChangeWorkDir: null,
    terminalOpenWorkDir: null,
    terminalProjectEditor: null,
    viewGitDiff: null
  }
}

/**
 * Create default settings state
 */
function createDefaultSettings(): SettingsState {
  return {
    version: 9,
    shortcuts: createDefaultShortcuts(),
    terminalStyles: {},
    globalTerminalStyle: createDefaultGlobalTerminalStyle(),
    gitDiffFontSize: null,
    settingsPanelWidth: DEFAULT_SETTINGS_PANEL_WIDTH,
    language: DEFAULT_LOCALE,
    theme: DEFAULT_THEME_SETTINGS,
    telemetryConsent: null,
    telemetryInstanceId: null,
    autoFollowGitBranchForTaskName: true,
    performanceDiagnosticsEnabled: false,
    updatedAt: Date.now()
  }
}

interface SettingsContextValue {
  // state
  settings: SettingsState | null
  isLoaded: boolean

  // Shortcut operations
  updateShortcut: (key: keyof ShortcutConfig, value: string | null) => void
  getShortcut: (key: keyof ShortcutConfig) => string | null

  // Terminal style operations
  updateTerminalStyle: (terminalId: string, style: Partial<TerminalStyleConfig>) => void
  getTerminalStyle: (terminalId: string) => TerminalStyleConfig | null
  deleteTerminalStyle: (terminalId: string) => void
  applyStyleGlobally: (field: keyof GlobalTerminalStyle, value: string | number | null) => void

  // Shortcut events
  onShortcutAction: (callback: (action: ShortcutAction) => void) => () => void

  // Settings panel width
  getSettingsPanelWidth: () => number
  setSettingsPanelWidth: (width: number) => void

  // Git Diff font size
  updateGitDiffFontSize: (value: number | null) => void
  getGitDiffFontSize: () => number | null

  // theme
  updateTheme: (theme: ThemeSettings) => Promise<boolean>
  previewTheme: (theme: ThemeSettings | null) => void
  resolvedTheme: ResolvedTheme
  systemDark: boolean
  updateLanguage: (language: AppLocale) => void

  // Auto-follow Git branch for Task name (default true)
  getAutoFollowGitBranchForTaskName: () => boolean
  setAutoFollowGitBranchForTaskName: (enabled: boolean) => void

  updatePerformanceDiagnosticsEnabled: (enabled: boolean) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

interface SettingsProviderProps {
  children: React.ReactNode
  onShortcutAction?: (action: ShortcutAction) => void
}

export function SettingsProvider({ children, onShortcutAction }: SettingsProviderProps) {
  const [settings, setSettings] = useState<SettingsState | null>(() =>
    (window as unknown as { onwardThemeBootstrap?: { settings: SettingsState } }).onwardThemeBootstrap?.settings ?? null)
  const [isLoaded, setIsLoaded] = useState(Boolean(settings))
  const settingsRef = useRef<SettingsState | null>(settings)
  const savedThemeRef = useRef<ThemeSettings | null>(settings?.theme ?? null)
  const settingsSaveRevision = useRef(0)
  const acknowledgedSaveRevision = useRef(0)
  const pendingSettingsSaves = useRef(new Map<number, Promise<boolean>>())
  const pendingFontEdits = useRef(0)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [draftTheme, setDraftTheme] = useState<ThemeSettings | null>(null)
  const previewActiveRef = useRef(false)
  const themeCommitRevision = useRef(0)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const shortcutCallbackRef = useRef<((action: ShortcutAction) => void) | null>(null)

  const resolvedTheme = useMemo(() => resolveTheme(draftTheme ?? settings?.theme ?? DEFAULT_THEME_SETTINGS, systemDark),
    [draftTheme, settings?.theme, systemDark])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const changed = () => {
      setSystemDark(media.matches)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_SYSTEM, {
        dark: media.matches, mode: settingsRef.current?.theme.mode ?? 'system'
      })
    }
    media.addEventListener('change', changed)
    // Catch an appearance change between the render-time snapshot and subscription.
    changed()
    return () => media.removeEventListener('change', changed)
  }, [])

  // Load settings
  useEffect(() => {
    const load = async () => {
      if (settingsRef.current) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'bootstrap-loaded', mode: settingsRef.current.theme.mode })
        return
      }
      try {
        if (window.electronAPI?.settings) {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'load-send' })
          const loadedSettings = await window.electronAPI.settings.load()
          const normalized = { ...loadedSettings, theme: normalizeThemeSettings(loadedSettings.theme) }
          settingsRef.current = normalized
          setSettings(normalized)
        } else {
          settingsRef.current = createDefaultSettings()
          setSettings(settingsRef.current)
        }
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'loaded', mode: settingsRef.current?.theme.mode })
        savedThemeRef.current = settingsRef.current?.theme ?? null
      } catch (error) {
        console.error('Failed to load settings:', error)
        settingsRef.current = createDefaultSettings()
        setSettings(settingsRef.current)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'load-fallback' })
      } finally {
        setIsLoaded(true)
      }
    }
    load()
  }, [])

  // Listen for shortcut events
  useEffect(() => {
    if (!window.electronAPI?.settings) return

    const unsubscribe = window.electronAPI.settings.onShortcutTriggered((action) => {
      // Call external callback
      onShortcutAction?.(action)
      // Call internal callback
      shortcutCallbackRef.current?.(action)
    })

    return () => {
      unsubscribe()
    }
  }, [onShortcutAction])

  // Both save paths share acknowledgement ordering and retain the snapshot actually sent.
  const persistSettingsSnapshot = useCallback((snapshot: SettingsState): Promise<boolean> => {
    const revision = ++settingsSaveRevision.current
    if (pendingFontEdits.current) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_FONTS, { reason: 'patch-batch', count: pendingFontEdits.current })
      pendingFontEdits.current = 0
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'settings-send', revision })
    const pending = (async () => {
      const ok = window.electronAPI?.settings ? await window.electronAPI.settings.save(snapshot) : true
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'settings-received', revision, ok, acknowledged: ok && revision > acknowledgedSaveRevision.current })
      if (ok && revision > acknowledgedSaveRevision.current) {
        acknowledgedSaveRevision.current = revision
        savedThemeRef.current = snapshot.theme
      }
      return ok
    })()
    pendingSettingsSaves.current.set(revision, pending)
    const settled = () => { pendingSettingsSaves.current.delete(revision) }
    void pending.then(settled, settled)
    return pending
  }, [])

  // Debounced settings save
  const saveSettings = useCallback((newSettings: SettingsState) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = null
      try {
        if (window.electronAPI?.settings) {
          const current = settingsRef.current ?? newSettings
          const ok = await persistSettingsSnapshot(current)
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'settings-save', ok })
        }
      } catch (error) {
        console.error('Failed to save settings:', error)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'settings-save-error' })
      }
    }, SAVE_DEBOUNCE_MS)
  }, [persistSettingsSnapshot])

  // Update settings and save
  const updateSettings = useCallback((updater: (prev: SettingsState) => SettingsState) => {
    const prev = settingsRef.current
    if (!prev) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'update-unavailable' })
      return
    }
    const next = { ...updater(prev), updatedAt: Date.now() }
    settingsRef.current = next
    setSettings(next)
    saveSettings(next)
  }, [saveSettings])

  // Update a single shortcut
  const updateShortcut = useCallback((key: keyof ShortcutConfig, value: string | null) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => ({
      ...prev,
      shortcuts: {
        ...prev.shortcuts,
        [key]: value
      }
    }))
  }, [updateSettings])

  // Get a single shortcut
  const getShortcut = useCallback((key: keyof ShortcutConfig): string | null => {
    return settings?.shortcuts[key] ?? null
  }, [settings])

  useLayoutEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  const previewTheme = useCallback((theme: ThemeSettings | null) => {
    if (previewActiveRef.current !== Boolean(theme)) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: theme ? 'preview-start' : 'preview-end' })
    }
    previewActiveRef.current = Boolean(theme)
    setDraftTheme(theme)
  }, [])

  // Commit selection separately from drafts; a failed write rolls back only the theme.
  const updateTheme = useCallback(async (theme: ThemeSettings): Promise<boolean> => {
    const previous = settingsRef.current
    if (!previous) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'commit-unavailable' })
      return false
    }
    const request = ++themeCommitRevision.current
    trackFeatureUse('setting-change')
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    const precedingSaves = [...pendingSettingsSaves.current.values()]
    const next = { ...previous, theme: normalizeThemeSettings(theme), updatedAt: Date.now() }
    settingsRef.current = next
    setSettings(next)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'commit-request', mode: theme.mode, request })
    try {
      const ok = await persistSettingsSnapshot(next)
      if (!ok) throw new Error('Theme settings were not saved')
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'commit-saved', request })
      return true
    } catch {
      // An earlier Task save may be persisted already while its acknowledgement is still in flight.
      await Promise.allSettled(precedingSaves)
      if (request === themeCommitRevision.current && settingsRef.current) {
        const restored = { ...settingsRef.current, theme: savedThemeRef.current ?? previous.theme }
        settingsRef.current = restored
        setSettings(restored)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'rollback-applied', request })
      } else {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'rollback-skipped', request })
      }
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_STATE, { reason: 'commit-rejected', request })
      return false
    }
  }, [persistSettingsSnapshot])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const host = window as unknown as { __onwardThemeDebug?: unknown }
    host.__onwardThemeDebug = {
      getState: () => ({ settings: settingsRef.current, systemDark, resolvedTheme, draft: Boolean(draftTheme) }),
      getTerminalThemes: () => terminalSessionManager.getThemeSnapshotsForAutotest().map(entry => ({ ...entry, id: entry.terminalId,
        status: terminalSessionManager.getSessionDebugState(entry.terminalId)?.status })),
      getMonacoTheme: () => getAppliedEditorTheme()
    }
    return () => { delete host.__onwardThemeDebug }
  }, [systemDark, resolvedTheme, draftTheme])

  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
  }, [])

  // Update Git Diff font size
  const updateGitDiffFontSize = useCallback((value: number | null) => {
    updateSettings(prev => ({
      ...prev,
      gitDiffFontSize: value
    }))
  }, [updateSettings])

  // Get Git Diff font size
  const getGitDiffFontSize = useCallback((): number | null => {
    return settings?.gitDiffFontSize ?? null
  }, [settings])

  // Update terminal style
  const updateTerminalStyle = useCallback((terminalId: string, style: Partial<TerminalStyleConfig>) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => ({
      ...prev,
      terminalStyles: {
        ...prev.terminalStyles,
        [terminalId]: patchTaskFonts(terminalId, prev.terminalStyles[terminalId] ?? prev.globalTerminalStyle, style)
      }
    }))
    // Aggregate numeric-input edits at the existing persistence boundary, never per keystroke.
    pendingFontEdits.current = Math.min(65535, pendingFontEdits.current + 1)
  }, [updateSettings])

  // Get terminal style
  const getTerminalStyle = useCallback((terminalId: string): TerminalStyleConfig | null => {
    if (!settings) return null
    return resolveTaskFonts(settings, terminalId)
  }, [settings])

  // Remove terminal style
  const deleteTerminalStyle = useCallback((terminalId: string) => {
    updateSettings(prev => {
      const newStyles = { ...prev.terminalStyles }
      delete newStyles[terminalId]
      return {
        ...prev,
        terminalStyles: newStyles
      }
    })
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_FONTS, { reason: 'remove-style' })
  }, [updateSettings])

  const applyStyleGlobally = useCallback((field: keyof GlobalTerminalStyle, value: string | number | null) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => {
      const globalTerminalStyle = {
        ...(prev.globalTerminalStyle ?? createDefaultGlobalTerminalStyle()),
        [field]: value
      }
      const terminalStyles = Object.fromEntries(
        Object.entries(prev.terminalStyles).map(([terminalId, style]) => [
          terminalId,
          patchTaskFonts(terminalId, style, { [field]: value } as Partial<TerminalStyleConfig>)
        ])
      )
      return {
        ...prev,
        globalTerminalStyle,
        terminalStyles
      }
    })
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_FONTS, { reason: 'apply-all', field })
  }, [updateSettings])

  // Register a shortcut event callback
  const onShortcutActionCallback = useCallback((callback: (action: ShortcutAction) => void) => {
    shortcutCallbackRef.current = callback
    return () => {
      shortcutCallbackRef.current = null
    }
  }, [])

  // Get the Settings panel width
  const getSettingsPanelWidth = useCallback((): number => {
    return settings?.settingsPanelWidth ?? DEFAULT_SETTINGS_PANEL_WIDTH
  }, [settings])

  // Set Settings panel width (limited to 300-600px)
  const setSettingsPanelWidth = useCallback((width: number) => {
    const clampedWidth = Math.max(300, Math.min(600, width))
    updateSettings(prev => ({
      ...prev,
      settingsPanelWidth: clampedWidth
    }))
  }, [updateSettings])

  const updateLanguage = useCallback((language: AppLocale) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => ({
      ...prev,
      language
    }))
  }, [updateSettings])

  const getAutoFollowGitBranchForTaskName = useCallback((): boolean => {
    return settings?.autoFollowGitBranchForTaskName ?? true
  }, [settings])

  const setAutoFollowGitBranchForTaskName = useCallback((enabled: boolean) => {
    updateSettings(prev => ({
      ...prev,
      autoFollowGitBranchForTaskName: enabled
    }))
  }, [updateSettings])

  const updatePerformanceDiagnosticsEnabled = useCallback((enabled: boolean) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => ({
      ...prev,
      performanceDiagnosticsEnabled: enabled
    }))
  }, [updateSettings])

  // Memoized: this context is consumed app-wide (every useI18n caller). A
  // literal object here would change identity on every provider render and
  // force all consumers to re-render past React.memo / element-identity
  // bailouts — exactly the churn the subpage soft-close freeze relies on
  // avoiding. All function members are useCallback-stable.
  const value: SettingsContextValue = useMemo(() => ({
    settings,
    isLoaded,
    updateShortcut,
    getShortcut,
    updateTerminalStyle,
    getTerminalStyle,
    deleteTerminalStyle,
    applyStyleGlobally,
    onShortcutAction: onShortcutActionCallback,
    getSettingsPanelWidth,
    setSettingsPanelWidth,
    updateGitDiffFontSize,
    getGitDiffFontSize,
    updateTheme,
    previewTheme,
    resolvedTheme,
    systemDark,
    updateLanguage,
    getAutoFollowGitBranchForTaskName,
    setAutoFollowGitBranchForTaskName,
    updatePerformanceDiagnosticsEnabled
  }), [
    settings,
    isLoaded,
    updateShortcut,
    getShortcut,
    updateTerminalStyle,
    getTerminalStyle,
    deleteTerminalStyle,
    applyStyleGlobally,
    onShortcutActionCallback,
    getSettingsPanelWidth,
    setSettingsPanelWidth,
    updateGitDiffFontSize,
    getGitDiffFontSize,
    updateTheme,
    previewTheme,
    resolvedTheme,
    systemDark,
    updateLanguage,
    getAutoFollowGitBranchForTaskName,
    setAutoFollowGitBranchForTaskName,
    updatePerformanceDiagnosticsEnabled
  ])

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}
