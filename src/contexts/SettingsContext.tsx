/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import type { SettingsState, ShortcutConfig, TerminalStyleConfig, ShortcutAction } from '../types/settings.d.ts'
import type { ThemeSettings } from '../types/theme'
import { DEFAULT_THEME_SETTINGS } from '../constants/themes'
import { applyTheme, resolveThemeColors } from '../utils/theme-applier'
import { DEFAULT_LOCALE, type AppLocale } from '../i18n/core'

/**
 * Save anti-shake time (milliseconds)
 */
const SAVE_DEBOUNCE_MS = 300

/** Settings panel default width */
const DEFAULT_SETTINGS_PANEL_WIDTH = 400

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
    version: 3,
    shortcuts: createDefaultShortcuts(),
    terminalStyles: {},
    gitDiffFontSize: null,
    settingsPanelWidth: DEFAULT_SETTINGS_PANEL_WIDTH,
    language: DEFAULT_LOCALE,
    theme: DEFAULT_THEME_SETTINGS,
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
  updateLanguage: (language: AppLocale) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

interface SettingsProviderProps {
  children: React.ReactNode
  onShortcutAction?: (action: ShortcutAction) => void
}

export function SettingsProvider({ children, onShortcutAction }: SettingsProviderProps) {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
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
    if (!settings?.theme) return
    applyTheme(resolveThemeColors(settings.theme))
  }, [settings?.theme])

  // Update theme settings
  const updateTheme = useCallback((theme: ThemeSettings) => {
    updateSettings(prev => ({
      ...prev,
      theme
    }))
  }, [updateSettings])

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
    updateSettings(prev => ({
      ...prev,
      terminalStyles: {
        ...prev.terminalStyles,
        [terminalId]: {
          terminalId,
          foregroundColor: style.foregroundColor ?? prev.terminalStyles[terminalId]?.foregroundColor ?? null,
          backgroundColor: style.backgroundColor ?? prev.terminalStyles[terminalId]?.backgroundColor ?? null,
          fontFamily: style.fontFamily ?? prev.terminalStyles[terminalId]?.fontFamily ?? null,
          fontSize: style.fontSize ?? prev.terminalStyles[terminalId]?.fontSize ?? null,
          gitDiffFontSize: style.gitDiffFontSize ?? prev.terminalStyles[terminalId]?.gitDiffFontSize ?? null
        }
      }
    }))
  }, [updateSettings])

  // Get terminal style
  const getTerminalStyle = useCallback((terminalId: string): TerminalStyleConfig | null => {
    return settings?.terminalStyles[terminalId] ?? null
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
    updateSettings(prev => ({
      ...prev,
      language
    }))
  }, [updateSettings])

  const value: SettingsContextValue = {
    settings,
    isLoaded,
    updateShortcut,
    getShortcut,
    updateTerminalStyle,
    getTerminalStyle,
    deleteTerminalStyle,
    onShortcutAction: onShortcutActionCallback,
    getSettingsPanelWidth,
    setSettingsPanelWidth,
    updateGitDiffFontSize,
    getGitDiffFontSize,
    updateTheme,
    updateLanguage
  }

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
