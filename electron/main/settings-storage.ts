/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { isReservedShortcut } from './reserved-shortcuts'
import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '../../src/i18n/core'

/**
 * Shortcut configuration
 */
interface ShortcutConfig {
  // Terminal focus shortcuts (6) - window-level
  focusTerminal1: string | null
  focusTerminal2: string | null
  focusTerminal3: string | null
  focusTerminal4: string | null
  focusTerminal5: string | null
  focusTerminal6: string | null
  // Tab switching shortcuts (6) - window-level
  switchTab1: string | null
  switchTab2: string | null
  switchTab3: string | null
  switchTab4: string | null
  switchTab5: string | null
  switchTab6: string | null
  // Global shortcuts
  activateAndFocusPrompt: string | null
  // Window-level shortcuts
  addToHistory: string | null
  focusPromptEditor: string | null
  // Terminal action shortcuts (current terminal)
  terminalGitDiff: string | null
  terminalGitHistory: string | null
  terminalChangeWorkDir: string | null
  terminalOpenWorkDir: string | null
  terminalProjectEditor: string | null
  viewGitDiff: string | null
}

/**
 * Terminal style configuration
 */
interface TerminalStyleConfig {
  terminalId: string
  foregroundColor: string | null
  backgroundColor: string | null
  fontFamily: string | null
  fontSize: number | null
  /** Git Diff / project editor font size (px), if empty, use the default value */
  gitDiffFontSize: number | null
}

interface GlobalTerminalStyle {
  foregroundColor: string | null
  backgroundColor: string | null
  fontFamily: string | null
  fontSize: number | null
  gitDiffFontSize: number | null
}

/**
 * Complete settings state
 */
interface SettingsState {
  version: number
  shortcuts: ShortcutConfig
  terminalStyles: Record<string, TerminalStyleConfig>
  globalTerminalStyle: GlobalTerminalStyle
  gitDiffFontSize: number | null
  /** Settings panel width (300-600px) */
  settingsPanelWidth: number
  /** Interface language */
  language: AppLocale
  /** Theme settings */
  theme: ThemeSettings
  /** Telemetry consent: null = not yet asked, true = opted in, false = opted out */
  telemetryConsent: boolean | null
  /** Anonymous instance ID for telemetry (random UUID, regenerated on re-opt-in) */
  telemetryInstanceId: string | null
  updatedAt: number
}

// Theme-related types and constants (inline to avoid cross-process import rendering process types)
interface ThemeSettings {
  mode: 'preset' | 'custom'
  presetId: string
  custom: { accent: string } | null
}

const VALID_PRESET_IDS = new Set(['graphite', 'starlight', 'pine', 'umber', 'amethyst', 'glacier'])

const DEFAULT_THEME: ThemeSettings = {
  mode: 'preset',
  presetId: 'graphite',
  custom: null
}

const MIGRATION_THEME: ThemeSettings = {
  mode: 'preset',
  presetId: 'starlight',
  custom: null
}

// Current version number
const CURRENT_VERSION = 5

/** Settings panel default width */
const DEFAULT_SETTINGS_PANEL_WIDTH = 400
const DEFAULT_GIT_DIFF_FONT_SIZE = 19
const MIN_GIT_DIFF_FONT_SIZE = 10
const MAX_GIT_DIFF_FONT_SIZE = 28

function createDefaultGlobalTerminalStyle(): GlobalTerminalStyle {
  return {
    foregroundColor: null,
    backgroundColor: null,
    fontFamily: null,
    fontSize: null,
    gitDiffFontSize: null
  }
}

/**
 * Create the default shortcut configuration (all shortcuts default to null)
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
function createDefaultSettingsState(): SettingsState {
  return {
    version: CURRENT_VERSION,
    shortcuts: createDefaultShortcuts(),
    terminalStyles: {},
    globalTerminalStyle: createDefaultGlobalTerminalStyle(),
    gitDiffFontSize: null,
    settingsPanelWidth: DEFAULT_SETTINGS_PANEL_WIDTH,
    language: DEFAULT_LOCALE,
    theme: DEFAULT_THEME,
    telemetryConsent: null,
    telemetryInstanceId: null,
    updatedAt: Date.now()
  }
}

/**
 * Settings Storage Manager
 * Use JSON files stored in the userData directory
 */
class SettingsStorage {
  private storagePath: string
  private state: SettingsState

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'settings.json')
    this.state = this.load()
  }

  /**
   * Load settings data from file
   */
  private load(): SettingsState {
    try {
      if (existsSync(this.storagePath)) {
        const data = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(data) as Partial<SettingsState>
        return this.validateState(parsed)
      }
      return createDefaultSettingsState()
    } catch (error) {
      console.error('Failed to load settings:', error)
      return createDefaultSettingsState()
    }
  }

  /**
   * Validate settings state to ensure all fields are present and valid
   */
  private validateState(state: Partial<SettingsState> & { version?: number }): SettingsState {
    // Validate shortcut configuration
    const shortcuts: ShortcutConfig = {
      focusTerminal1: this.validateShortcut(state.shortcuts?.focusTerminal1),
      focusTerminal2: this.validateShortcut(state.shortcuts?.focusTerminal2),
      focusTerminal3: this.validateShortcut(state.shortcuts?.focusTerminal3),
      focusTerminal4: this.validateShortcut(state.shortcuts?.focusTerminal4),
      focusTerminal5: this.validateShortcut(state.shortcuts?.focusTerminal5),
      focusTerminal6: this.validateShortcut(state.shortcuts?.focusTerminal6),
      switchTab1: this.validateShortcut(state.shortcuts?.switchTab1),
      switchTab2: this.validateShortcut(state.shortcuts?.switchTab2),
      switchTab3: this.validateShortcut(state.shortcuts?.switchTab3),
      switchTab4: this.validateShortcut(state.shortcuts?.switchTab4),
      switchTab5: this.validateShortcut(state.shortcuts?.switchTab5),
      switchTab6: this.validateShortcut(state.shortcuts?.switchTab6),
      activateAndFocusPrompt: this.validateShortcut(state.shortcuts?.activateAndFocusPrompt),
      addToHistory: this.validateShortcut(state.shortcuts?.addToHistory),
      focusPromptEditor: this.validateShortcut(state.shortcuts?.focusPromptEditor),
      terminalGitDiff: this.validateShortcut(state.shortcuts?.terminalGitDiff),
      terminalGitHistory: this.validateShortcut(state.shortcuts?.terminalGitHistory),
      terminalChangeWorkDir: this.validateShortcut(state.shortcuts?.terminalChangeWorkDir),
      terminalOpenWorkDir: this.validateShortcut(state.shortcuts?.terminalOpenWorkDir),
      terminalProjectEditor: this.validateShortcut(state.shortcuts?.terminalProjectEditor),
      viewGitDiff: this.validateShortcut(state.shortcuts?.viewGitDiff)
    }

    // Verify terminal style configuration
    const terminalStyles: Record<string, TerminalStyleConfig> = {}
    if (state.terminalStyles && typeof state.terminalStyles === 'object') {
      for (const [terminalId, style] of Object.entries(state.terminalStyles)) {
        if (style && typeof style === 'object') {
          terminalStyles[terminalId] = this.validateTerminalStyle(terminalId, style)
        }
      }
    }
    const globalTerminalStyle = this.validateGlobalTerminalStyle(state.globalTerminalStyle)

    let gitDiffFontSize: number | null = DEFAULT_GIT_DIFF_FONT_SIZE
    if (state.gitDiffFontSize === null) {
      gitDiffFontSize = null
    } else if (typeof state.gitDiffFontSize === 'number') {
      if (state.gitDiffFontSize >= MIN_GIT_DIFF_FONT_SIZE && state.gitDiffFontSize <= MAX_GIT_DIFF_FONT_SIZE) {
        gitDiffFontSize = state.gitDiffFontSize
      }
    }

    // Verify Settings panel width (300-600px)
    let settingsPanelWidth = DEFAULT_SETTINGS_PANEL_WIDTH
    if (typeof state.settingsPanelWidth === 'number') {
      settingsPanelWidth = Math.max(300, Math.min(600, state.settingsPanelWidth))
    }

    // Determine whether it is an existing user (migrated from v1) and determine the default theme
    const isExistingUser = (state.version ?? 0) < 2 && !state.theme
    const theme = this.validateTheme(state.theme, isExistingUser)
    const language = isAppLocale(state.language) ? state.language : DEFAULT_LOCALE

    // Telemetry fields (added in v5).
    // - Existing user upgrading from v4 or earlier: default to false (no consent dialog).
    // - Brand-new install (no prior version): default to null (show consent dialog).
    const isUpgradeFromPreTelemetry = typeof state.version === 'number' && state.version < 5
    const telemetryConsent = typeof state.telemetryConsent === 'boolean'
      ? state.telemetryConsent
      : (isUpgradeFromPreTelemetry ? false : null)
    const telemetryInstanceId = typeof state.telemetryInstanceId === 'string' && state.telemetryInstanceId.length > 0
      ? state.telemetryInstanceId
      : null

    return {
      version: CURRENT_VERSION,
      shortcuts,
      terminalStyles,
      globalTerminalStyle,
      gitDiffFontSize,
      settingsPanelWidth,
      language,
      theme,
      telemetryConsent,
      telemetryInstanceId,
      updatedAt: state.updatedAt ?? Date.now()
    }
  }

  /**
   * Validate shortcut format
   */
  private validateShortcut(shortcut: unknown): string | null {
    if (typeof shortcut === 'string' && shortcut.trim().length > 0) {
      const normalized = shortcut.trim()
      if (isReservedShortcut(normalized)) {
        return null
      }
      return normalized
    }
    return null
  }

  /**
   * Verify terminal style configuration
   */
  private validateTerminalStyle(terminalId: string, style: Partial<TerminalStyleConfig>): TerminalStyleConfig {
    return {
      terminalId,
      foregroundColor: this.validateColor(style.foregroundColor),
      backgroundColor: this.validateColor(style.backgroundColor),
      fontFamily: typeof style.fontFamily === 'string' && style.fontFamily.trim()
        ? style.fontFamily.trim()
        : null,
      fontSize: typeof style.fontSize === 'number' && style.fontSize >= 8 && style.fontSize <= 72
        ? style.fontSize
        : null,
      gitDiffFontSize: typeof style.gitDiffFontSize === 'number' &&
        style.gitDiffFontSize >= MIN_GIT_DIFF_FONT_SIZE &&
        style.gitDiffFontSize <= MAX_GIT_DIFF_FONT_SIZE
        ? style.gitDiffFontSize
        : null
    }
  }

  private validateGlobalTerminalStyle(style: unknown): GlobalTerminalStyle {
    if (!style || typeof style !== 'object') {
      return createDefaultGlobalTerminalStyle()
    }
    const candidate = style as Partial<GlobalTerminalStyle>
    return {
      foregroundColor: this.validateColor(candidate.foregroundColor),
      backgroundColor: this.validateColor(candidate.backgroundColor),
      fontFamily: typeof candidate.fontFamily === 'string' && candidate.fontFamily.trim()
        ? candidate.fontFamily.trim()
        : null,
      fontSize: typeof candidate.fontSize === 'number' && candidate.fontSize >= 8 && candidate.fontSize <= 72
        ? candidate.fontSize
        : null,
      gitDiffFontSize: typeof candidate.gitDiffFontSize === 'number' &&
        candidate.gitDiffFontSize >= MIN_GIT_DIFF_FONT_SIZE &&
        candidate.gitDiffFontSize <= MAX_GIT_DIFF_FONT_SIZE
        ? candidate.gitDiffFontSize
        : null
    }
  }

  /**
   * Verify color format
   */
  private validateColor(color: unknown): string | null {
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      return color.toLowerCase()
    }
    return null
  }

  /**
   * Verify theme settings
   * isExisting: Whether it is an existing user (migrated from v1), determines the default theme
   */
  private validateTheme(theme: unknown, isExisting: boolean): ThemeSettings {
    if (!theme || typeof theme !== 'object') {
      return isExisting ? MIGRATION_THEME : DEFAULT_THEME
    }
    const t = theme as Record<string, unknown>

    const mode = t.mode === 'custom' ? 'custom' : 'preset'
    const presetId = typeof t.presetId === 'string' && VALID_PRESET_IDS.has(t.presetId)
      ? t.presetId
      : (isExisting ? 'starlight' : 'graphite')

    let custom: { accent: string } | null = null
    if (t.custom && typeof t.custom === 'object') {
      const c = t.custom as Record<string, unknown>
      const accent = this.validateColor(c.accent)
      if (accent) {
        custom = { accent }
      }
    }

    // Fall back to preset when custom mode is used but there is no valid custom color.
    if (mode === 'custom' && !custom) {
      return { mode: 'preset', presetId, custom: null }
    }

    return { mode, presetId, custom }
  }

  /**
   * Save settings data to file
   */
  private persist(): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save settings:', error)
    }
  }

  /**
   * Get current settings
   */
  get(): SettingsState {
    return JSON.parse(JSON.stringify(this.state))
  }

  /**
   * Save complete settings
   */
  save(settings: SettingsState): boolean {
    try {
      this.state = {
        ...this.validateState(settings),
        updatedAt: Date.now()
      }
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to save settings:', error)
      return false
    }
  }

  /**
   * Partial update settings
   */
  update(partial: Partial<SettingsState>): boolean {
    try {
      if (partial.shortcuts) {
        this.state.shortcuts = {
          ...this.state.shortcuts,
          ...partial.shortcuts
        }
      }
      if (partial.gitDiffFontSize !== undefined) {
        if (partial.gitDiffFontSize === null) {
          this.state.gitDiffFontSize = null
        } else if (
          typeof partial.gitDiffFontSize === 'number' &&
          partial.gitDiffFontSize >= MIN_GIT_DIFF_FONT_SIZE &&
          partial.gitDiffFontSize <= MAX_GIT_DIFF_FONT_SIZE
        ) {
          this.state.gitDiffFontSize = partial.gitDiffFontSize
        }
      }
      if (partial.terminalStyles) {
        for (const [terminalId, style] of Object.entries(partial.terminalStyles)) {
          if (style) {
            this.state.terminalStyles[terminalId] = this.validateTerminalStyle(terminalId, style)
          }
        }
      }
      if (partial.globalTerminalStyle) {
        this.state.globalTerminalStyle = this.validateGlobalTerminalStyle(partial.globalTerminalStyle)
      }
      if (partial.theme) {
        this.state.theme = this.validateTheme(partial.theme, false)
      }
      this.state.updatedAt = Date.now()
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to update settings:', error)
      return false
    }
  }

  /**
   * Get terminal style
   */
  getTerminalStyle(terminalId: string): TerminalStyleConfig | null {
    return this.state.terminalStyles[terminalId] || null
  }

  /**
   * Set terminal style
   */
  setTerminalStyle(terminalId: string, style: Partial<TerminalStyleConfig>): boolean {
    try {
      this.state.terminalStyles[terminalId] = this.validateTerminalStyle(terminalId, {
        ...this.state.terminalStyles[terminalId],
        ...style
      })
      this.state.updatedAt = Date.now()
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to set terminal style:', error)
      return false
    }
  }

  /**
   * Remove terminal style
   */
  deleteTerminalStyle(terminalId: string): boolean {
    try {
      delete this.state.terminalStyles[terminalId]
      this.state.updatedAt = Date.now()
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to delete terminal style:', error)
      return false
    }
  }

  /**
   * Get telemetry consent state (null = not asked yet)
   */
  getTelemetryConsent(): boolean | null {
    return this.state.telemetryConsent
  }

  /**
   * Get anonymous telemetry instance ID
   */
  getTelemetryInstanceId(): string | null {
    return this.state.telemetryInstanceId
  }

  /**
   * Set telemetry consent and instance ID atomically
   */
  setTelemetryConsent(consent: boolean, instanceId: string | null): void {
    this.state.telemetryConsent = consent
    this.state.telemetryInstanceId = consent ? instanceId : null
    this.state.updatedAt = Date.now()
    this.persist()
  }
}

// Singleton pattern
let instance: SettingsStorage | null = null

export function getSettingsStorage(): SettingsStorage {
  if (!instance) {
    instance = new SettingsStorage()
  }
  return instance
}

export type {
  SettingsState,
  ShortcutConfig,
  TerminalStyleConfig,
  GlobalTerminalStyle
}

export {
  createDefaultSettingsState,
  createDefaultShortcuts
}
