/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { isReservedShortcut, RESERVED_SHORTCUTS } from './reserved-shortcuts'
import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '../../src/i18n/core'
import type { ThemeSettings } from '../../src/types/theme'
import { DEFAULT_THEME_SETTINGS } from '../../src/constants/themes'
import { getAvailableThemeIds, normalizeThemeSettings } from '../../src/themes/theme-engine'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { createDefaultPromptInputSettings, normalizePromptInputSettings, normalizePromptShortcut, promptTargetSlot, validatePromptInputSettings, type PromptInputSettings } from '../../src/utils/prompt-input'

/**
 * Shortcut configuration
 */
interface ShortcutConfig {
  // Terminal focus shortcuts (8) - window-level
  focusTerminal1: string | null
  focusTerminal2: string | null
  focusTerminal3: string | null
  focusTerminal4: string | null
  focusTerminal5: string | null
  focusTerminal6: string | null
  focusTerminal7: string | null
  focusTerminal8: string | null
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
  fontFamily: string | null
  fontSize: number | null
  /** Git Diff / project editor font size (px), if empty, use the default value */
  gitDiffFontSize: number | null
}

interface GlobalTerminalStyle {
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
  promptInput: PromptInputSettings
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
  /** Auto-follow Git branch for Task name (default true). Added in v6. */
  autoFollowGitBranchForTaskName: boolean
  /** Global switch for opt-in performance diagnostics panels. Added in v7. */
  performanceDiagnosticsEnabled: boolean
  updatedAt: number
}

// Current version number
// v6: introduces autoFollowGitBranchForTaskName (default true).
// v7: introduces performanceDiagnosticsEnabled (default false; legacy values reset on upgrade).
// v8: unified named themes with per-theme customization and Task overrides.
// v9: retire Task color overrides; preserve Task fonts and theme-level colors.
// v10: ordered Prompt input actions with an opt-in, user-defined leader.
const CURRENT_VERSION = 10

/** Settings panel default width */
const DEFAULT_SETTINGS_PANEL_WIDTH = 400
const DEFAULT_GIT_DIFF_FONT_SIZE = 19
const MIN_GIT_DIFF_FONT_SIZE = 10
const MAX_GIT_DIFF_FONT_SIZE = 28

function createDefaultGlobalTerminalStyle(): GlobalTerminalStyle {
  return {
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
function createDefaultSettingsState(): SettingsState {
  return {
    version: CURRENT_VERSION,
    shortcuts: createDefaultShortcuts(),
    promptInput: createDefaultPromptInputSettings(),
    terminalStyles: {},
    globalTerminalStyle: createDefaultGlobalTerminalStyle(),
    gitDiffFontSize: null,
    settingsPanelWidth: DEFAULT_SETTINGS_PANEL_WIDTH,
    language: DEFAULT_LOCALE,
    theme: normalizeThemeSettings(DEFAULT_THEME_SETTINGS),
    telemetryConsent: null,
    telemetryInstanceId: null,
    autoFollowGitBranchForTaskName: true,
    performanceDiagnosticsEnabled: false,
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
        const normalized = this.validateState(parsed)
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, {
          reason: (parsed.version ?? 0) < CURRENT_VERSION ? 'migrated' : 'loaded', mode: normalized.theme.mode
        })
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, {
          reason: (parsed.version ?? 0) < 10 || !parsed.promptInput ? 'migrated' : 'loaded',
          actions: normalized.promptInput.actions.length, leader: Boolean(normalized.promptInput.leader)
        })
        return normalized
      }
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'new-profile' })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'new-profile' })
      return createDefaultSettingsState()
    } catch (error) {
      console.error('Failed to load settings:', error)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'load-fallback' })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'load-fallback' })
      return { ...createDefaultSettingsState(), theme: normalizeThemeSettings(undefined, { existing: true }) }
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
      focusTerminal7: this.validateShortcut(state.shortcuts?.focusTerminal7),
      focusTerminal8: this.validateShortcut(state.shortcuts?.focusTerminal8),
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
    const theme = normalizeThemeSettings(state.theme, {
      existing: true,
      legacyPreV2: (state.version ?? 0) < 2 && !state.theme,
      terminalStyles,
      globalTerminalStyle: state.globalTerminalStyle
    })
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
    // v7: force-reset performanceDiagnosticsEnabled to false on upgrade so users
    // who toggled it ON in earlier versions land on the documented default; the
    // toggle is respected normally on subsequent loads.
    const isLegacyPerfDiagState = typeof state.version === 'number' && state.version < 7
    const performanceDiagnosticsEnabled = isLegacyPerfDiagState
      ? false
      : state.performanceDiagnosticsEnabled === true

    // autoFollowGitBranchForTaskName (v6): default true for fresh installs and
    // for existing users upgrading from < v6 (the rule needs to take effect
    // immediately so terminals start following branches without extra setup).
    const autoFollowGitBranchForTaskName = typeof state.autoFollowGitBranchForTaskName === 'boolean'
      ? state.autoFollowGitBranchForTaskName
      : true

    const promptInput = normalizePromptInputSettings(state.promptInput)
    // Preserve existing action bindings when a hand-edited selector collides.
    if (promptInput.targetModifier && [promptInput.leader, shortcuts.activateAndFocusPrompt, ...promptInput.actions.map(action => action.shortcut)]
      .some(key => promptTargetSlot(normalizePromptShortcut(key, process.platform), promptInput.targetModifier) !== null)) {
      promptInput.targetModifier = null
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'selector-conflict-recovered' })
    }
    const leaderError = validatePromptInputSettings({ ...promptInput, actions: [] }, [
      ...Object.values(shortcuts), ...Object.values(RESERVED_SHORTCUTS).flat()
    ], process.platform, [shortcuts.activateAndFocusPrompt])
    if (leaderError) {
      promptInput.leader = null
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'leader-rejected', error: leaderError })
    }
    // Apply first-binding-wins to host aliases while retaining portable strings on disk.
    const leaderKey = normalizePromptShortcut(promptInput.leader, process.platform)
    const globalKey = normalizePromptShortcut(shortcuts.activateAndFocusPrompt, process.platform)
    const actionKeys = new Set<string>()
    let changedCount = 0
    for (const action of promptInput.actions) {
      const key = normalizePromptShortcut(action.shortcut, process.platform)
      if (!key) continue
      if (key === leaderKey || key === globalKey || actionKeys.has(key)) {
        action.shortcut = null
        changedCount += 1
      } else {
        actionKeys.add(key)
      }
    }
    if (changedCount > 0) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'host-shortcuts-normalized', changedCount })
    }

    return {
      version: CURRENT_VERSION,
      shortcuts,
      promptInput,
      terminalStyles,
      globalTerminalStyle,
      gitDiffFontSize,
      settingsPanelWidth,
      language,
      theme,
      telemetryConsent,
      telemetryInstanceId,
      autoFollowGitBranchForTaskName,
      performanceDiagnosticsEnabled,
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
   * Save settings data to file
   */
  private persist(throwOnError = false): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save settings:', error)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'write-failed', propagated: throwOnError })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'write-failed', propagated: throwOnError })
      if (throwOnError) throw error
    }
  }

  /**
   * Get current settings
   */
  get(): SettingsState {
    return JSON.parse(JSON.stringify(this.state))
  }

  /** Bounded clock input: never clone imported color/token catalogs on timer ticks. */
  getThemeScheduleSnapshot() {
    const { mode, schedule } = this.state.theme
    return { mode, schedule: { ...schedule, ranges: schedule.ranges.map(range => ({ ...range, days: [...range.days] })),
      temporary: schedule.temporary ? { ...schedule.temporary } : null }, availableIds: getAvailableThemeIds(this.state.theme) }
  }

  /** A bounded snapshot for worker structured-cloning, excluding unrelated imported themes. */
  getThemeExportSnapshot(themeId: string): ThemeSettings {
    const theme = this.state.theme
    return {
      ...theme, mode: 'manual', themeId,
      overrides: { [themeId]: theme.overrides[themeId] ?? {} },
      imported: theme.imported.filter(item => item.id === themeId)
    }
  }

  /**
   * Save complete settings.
   * Telemetry fields are preserved from the current in-memory state because
   * they are managed exclusively through setTelemetryConsent(). The renderer's
   * SettingsContext may hold a stale snapshot, so accepting its telemetry
   * values here would overwrite a newer consent decision.
   */
  save(settings: SettingsState): boolean {
    const previous = this.state
    const started = performance.now()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'save-received' })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'save-received', legacySnapshot: settings?.promptInput === undefined })
    try {
      // Older renderer bootstraps may omit this section; preserve the saved actions.
      const promptInput = settings.promptInput ?? previous.promptInput
      const shortcuts = settings.shortcuts ?? previous.shortcuts
      const error = validatePromptInputSettings(promptInput, [
        ...Object.values(shortcuts), ...Object.values(RESERVED_SHORTCUTS).flat()
      ], process.platform, [shortcuts.activateAndFocusPrompt])
      if (error) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'save-invalid', error })
        return false
      }
      const validated = this.validateState({ ...settings, promptInput })
      // Preserve telemetry state — only setTelemetryConsent() may modify these
      validated.telemetryConsent = this.state.telemetryConsent
      validated.telemetryInstanceId = this.state.telemetryInstanceId
      this.state = {
        ...validated,
        updatedAt: Date.now()
      }
      this.persist(true)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'saved', mode: this.state.theme.mode, ok: true })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, {
        reason: 'saved', actions: this.state.promptInput.actions.length,
        leader: Boolean(this.state.promptInput.leader), durationMs: performance.now() - started
      })
      return true
    } catch (error) {
      this.state = previous
      console.error('Failed to save settings:', error)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'save-rejected', ok: false })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'save-rejected', rollback: true })
      return false
    }
  }

  /**
   * Partial update settings
   */
  update(partial: Partial<SettingsState>): boolean {
    const previous = this.state
    const started = performance.now()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'update-received', theme: Boolean(partial.theme) })
    try {
      if (partial.promptInput !== undefined || partial.shortcuts) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'update-received' })
        const promptInput = partial.promptInput ?? previous.promptInput
        const shortcuts = { ...previous.shortcuts, ...partial.shortcuts }
        const error = validatePromptInputSettings(promptInput, [
          ...Object.values(shortcuts), ...Object.values(RESERVED_SHORTCUTS).flat()
        ], process.platform, [shortcuts.activateAndFocusPrompt])
        if (error) {
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'update-invalid', error })
          return false
        }
      }
      this.state = { ...this.state, terminalStyles: { ...this.state.terminalStyles } }
      if (partial.promptInput !== undefined) {
        this.state.promptInput = normalizePromptInputSettings(partial.promptInput)
      }
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
        this.state.theme = normalizeThemeSettings(partial.theme)
      }
      if (typeof partial.autoFollowGitBranchForTaskName === 'boolean') {
        this.state.autoFollowGitBranchForTaskName = partial.autoFollowGitBranchForTaskName
      }
      if (typeof partial.performanceDiagnosticsEnabled === 'boolean') {
        this.state.performanceDiagnosticsEnabled = partial.performanceDiagnosticsEnabled
      }
      this.state.updatedAt = Date.now()
      this.persist(true)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'updated', theme: Boolean(partial.theme), mode: this.state.theme.mode, ok: true })
      if (partial.promptInput !== undefined || partial.shortcuts) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'updated', durationMs: performance.now() - started })
      }
      return true
    } catch (error) {
      this.state = previous
      console.error('Failed to update settings:', error)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THEME_SETTINGS, { reason: 'update-rejected', ok: false })
      if (partial.promptInput !== undefined || partial.shortcuts) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT_SETTINGS, { reason: 'update-rejected', rollback: true })
      }
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
   * Set telemetry consent and instance ID atomically.
   * Accepts null to reset consent to the "not yet asked" state (debug use only).
   */
  setTelemetryConsent(consent: boolean | null, instanceId: string | null): void {
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
