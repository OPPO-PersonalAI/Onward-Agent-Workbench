/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef } from 'react'
import type {
  SettingsState,
  ShortcutConfig,
  TerminalStyleConfig,
  GlobalTerminalStyle,
  ShortcutAction
} from '../types/settings.d.ts'
import type { ThemeColors, ThemeSettings } from '../types/theme'
import { DEFAULT_THEME_SETTINGS } from '../constants/themes'
import { applyColorMode, applyTheme } from '../utils/theme-applier'
import { DEFAULT_LOCALE, setLocaleOverlay, type AppLocale } from '../i18n/core'
import { DEFAULT_APPEARANCE, DEFAULT_LOCALE_PACK_SETTINGS, type AppearanceSettingsV1, type LocalePackSettingsV1 } from '../../electron/shared/appearance-schema'
import { legacyThemeRef, resolveAppearance, type ResolvedAppearance } from '../themes/resolve-appearance'
import { trackFeatureUse } from '../telemetry/track-feature-use'

/**
 * Save anti-shake time (milliseconds)
 */
const SAVE_DEBOUNCE_MS = 300

/** Settings panel default width */
const DEFAULT_SETTINGS_PANEL_WIDTH = 400

function createDefaultGlobalTerminalStyle(): GlobalTerminalStyle {
  return {
    foregroundColor: null,
    backgroundColor: null,
    fontFamily: null,
    fontSize: null,
    gitDiffFontSize: null
  }
}

function applyTerminalStylePatch(
  terminalId: string,
  previous: TerminalStyleConfig | null | undefined,
  patch: Partial<TerminalStyleConfig>
): TerminalStyleConfig {
  return {
    terminalId,
    foregroundColor: 'foregroundColor' in patch ? (patch.foregroundColor ?? null) : (previous?.foregroundColor ?? null),
    backgroundColor: 'backgroundColor' in patch ? (patch.backgroundColor ?? null) : (previous?.backgroundColor ?? null),
    fontFamily: 'fontFamily' in patch ? (patch.fontFamily ?? null) : (previous?.fontFamily ?? null),
    fontSize: 'fontSize' in patch ? (patch.fontSize ?? null) : (previous?.fontSize ?? null),
    gitDiffFontSize: 'gitDiffFontSize' in patch ? (patch.gitDiffFontSize ?? null) : (previous?.gitDiffFontSize ?? null)
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
    version: 8,
    shortcuts: createDefaultShortcuts(),
    terminalStyles: {},
    globalTerminalStyle: createDefaultGlobalTerminalStyle(),
    gitDiffFontSize: null,
    settingsPanelWidth: DEFAULT_SETTINGS_PANEL_WIDTH,
    language: DEFAULT_LOCALE,
    theme: DEFAULT_THEME_SETTINGS,
    appearance: DEFAULT_APPEARANCE,
    localePacks: DEFAULT_LOCALE_PACK_SETTINGS,
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
  resolvedAppearance: ResolvedAppearance | null
  localeOverlayRevision: number
  editorLocaleAtBoot: AppLocale

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
  updateTheme: (theme: ThemeSettings) => void
  updateAppearance: (appearance: AppearanceSettingsV1) => void
  updateLocalePacks: (localePacks: LocalePackSettingsV1) => void
  replaceSettingsFromMain: (settings: SettingsState) => void
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
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
  const [localeOverlayRevision, setLocaleOverlayRevision] = useState(0)
  const [editorLocaleAtBoot] = useState<AppLocale>(() => window.__onwardEditorLocaleAtBoot ?? DEFAULT_LOCALE)
  const [packTheme, setPackTheme] = useState<{ packId: string; themeId: string; kind: 'light' | 'dark'; colors: ThemeColors } | null>(null)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const shortcutCallbackRef = useRef<((action: ShortcutAction) => void) | null>(null)

  // Load settings
  useEffect(() => {
    const load = async () => {
      try {
        if (window.electronAPI?.settings) {
          const loadedSettings = await window.electronAPI.settings.load()
          setSettings(loadedSettings)
        } else {
          setSettings(createDefaultSettings())
        }
      } catch (error) {
        console.error('Failed to load settings:', error)
        setSettings(createDefaultSettings())
      } finally {
        setIsLoaded(true)
      }
    }
    load()
  }, [])

  useEffect(() => {
    const locale = settings?.language
    const packId = locale ? settings.localePacks?.activePackByLocale[locale] : undefined
    if (!locale || !packId || !window.electronAPI?.resourcePacks) {
      if (locale) setLocaleOverlay(locale, null)
      setLocaleOverlayRevision(value => value + 1)
      return
    }
    let active = true
    void window.electronAPI.resourcePacks.getLocaleOverlay(packId, locale).then(overlay => {
      if (!active) return
      setLocaleOverlay(locale, overlay)
      setLocaleOverlayRevision(value => value + 1)
    }).catch(() => {
      if (!active) return
      setLocaleOverlay(locale, null)
      setLocaleOverlayRevision(value => value + 1)
    })
    return () => { active = false }
  }, [settings?.language, settings?.localePacks])

  const resolvedAppearance = useMemo(() => {
    return settings?.appearance ? resolveAppearance(settings.appearance, systemPrefersDark, packTheme) : null
  }, [settings?.appearance, systemPrefersDark, packTheme])

  useEffect(() => {
    const appearance = settings?.appearance
    if (!appearance) return
    const requested = resolveAppearance(appearance, systemPrefersDark).kind === 'light'
      ? appearance.lightTheme
      : appearance.darkTheme
    if (requested.source !== 'pack' || !window.electronAPI?.resourcePacks) {
      setPackTheme(null)
      return
    }
    let active = true
    void window.electronAPI.resourcePacks.getTheme(requested.packId, requested.themeId).then(value => {
      if (!active || !value || typeof value !== 'object') return
      const candidate = value as { kind?: unknown; colors?: unknown }
      if ((candidate.kind !== 'light' && candidate.kind !== 'dark') || !candidate.colors || typeof candidate.colors !== 'object') return
      setPackTheme({ packId: requested.packId, themeId: requested.themeId, kind: candidate.kind, colors: candidate.colors as ThemeColors })
    }).catch(() => { if (active) setPackTheme(null) })
    return () => { active = false }
  }, [settings?.appearance, systemPrefersDark])

  useEffect(() => {
    if (!window.electronAPI?.appearance) {
      const media = window.matchMedia?.('(prefers-color-scheme: dark)')
      if (!media) return
      const onChange = () => setSystemPrefersDark(media.matches)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    let active = true
    void window.electronAPI.appearance.getSnapshot().then(snapshot => {
      if (active) setSystemPrefersDark(snapshot.kind === 'dark')
    }).catch(() => {})
    return window.electronAPI.appearance.onSnapshotUpdated(snapshot => {
      if (active) setSystemPrefersDark(snapshot.kind === 'dark')
    })
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

  // Debounced settings save
  const saveSettings = useCallback((newSettings: SettingsState) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        if (window.electronAPI?.settings) {
          await window.electronAPI.settings.save(newSettings)
        }
      } catch (error) {
        console.error('Failed to save settings:', error)
      }
    }, SAVE_DEBOUNCE_MS)
  }, [])

  // Update settings and save
  const updateSettings = useCallback((updater: (prev: SettingsState) => SettingsState) => {
    setSettings(prev => {
      if (!prev) return prev
      const newSettings = {
        ...updater(prev),
        updatedAt: Date.now()
      }
      saveSettings(newSettings)
      return newSettings
    })
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

  // Applied to DOM when theme changes
  useEffect(() => {
    if (!resolvedAppearance) return
    applyTheme(resolvedAppearance.colors)
    applyColorMode(resolvedAppearance.kind)
  }, [resolvedAppearance])

  // Update theme settings
  const updateTheme = useCallback((theme: ThemeSettings) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => ({
      ...prev,
      theme,
      appearance: {
        ...prev.appearance,
        darkTheme: legacyThemeRef(theme)
      }
    }))
  }, [updateSettings])

  const updateAppearance = useCallback((appearance: AppearanceSettingsV1) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => ({ ...prev, appearance }))
  }, [updateSettings])

  const updateLocalePacks = useCallback((localePacks: LocalePackSettingsV1) => {
    trackFeatureUse('setting-change')
    updateSettings(prev => ({ ...prev, localePacks }))
  }, [updateSettings])

  const replaceSettingsFromMain = useCallback((nextSettings: SettingsState) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    setSettings(nextSettings)
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
        [terminalId]: applyTerminalStylePatch(terminalId, prev.terminalStyles[terminalId], style)
      }
    }))
  }, [updateSettings])

  // Get terminal style
  const getTerminalStyle = useCallback((terminalId: string): TerminalStyleConfig | null => {
    const perTerminal = settings?.terminalStyles[terminalId]
    if (perTerminal) return perTerminal
    const globalStyle = settings?.globalTerminalStyle ?? createDefaultGlobalTerminalStyle()
    return {
      terminalId,
      foregroundColor: globalStyle.foregroundColor,
      backgroundColor: globalStyle.backgroundColor,
      fontFamily: globalStyle.fontFamily,
      fontSize: globalStyle.fontSize,
      gitDiffFontSize: globalStyle.gitDiffFontSize
    }
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
          applyTerminalStylePatch(terminalId, style, { [field]: value } as Partial<TerminalStyleConfig>)
        ])
      )
      return {
        ...prev,
        globalTerminalStyle,
        terminalStyles
      }
    })
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
    resolvedAppearance,
    localeOverlayRevision,
    editorLocaleAtBoot,
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
    updateAppearance,
    updateLocalePacks,
    replaceSettingsFromMain,
    updateLanguage,
    getAutoFollowGitBranchForTaskName,
    setAutoFollowGitBranchForTaskName,
    updatePerformanceDiagnosticsEnabled
  }), [
    settings,
    isLoaded,
    resolvedAppearance,
    localeOverlayRevision,
    editorLocaleAtBoot,
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
    updateAppearance,
    updateLocalePacks,
    replaceSettingsFromMain,
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
