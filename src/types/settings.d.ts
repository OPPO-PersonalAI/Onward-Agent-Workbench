/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Settings type definitions

import type { ThemeSettings } from './theme'
import type { AppLocale } from '../i18n/core'

// Shortcut configuration
export interface ShortcutConfig {
  // Terminal focus shortcuts (6)
  focusTerminal1: string | null
  focusTerminal2: string | null
  focusTerminal3: string | null
  focusTerminal4: string | null
  focusTerminal5: string | null
  focusTerminal6: string | null
  // Tab switching shortcuts (6)
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

// Terminal style configuration
export interface TerminalStyleConfig {
  terminalId: string
  foregroundColor: string | null
  backgroundColor: string | null
  fontFamily: string | null
  fontSize: number | null
  /** Git Diff / project editor font size (px), if empty, use the default value */
  gitDiffFontSize: number | null
}

// Complete settings state
export interface SettingsState {
  version: number
  shortcuts: ShortcutConfig
  terminalStyles: Record<string, TerminalStyleConfig>
  /** Git Diff font size (px), if empty, use the default value */
  gitDiffFontSize: number | null
  /** Settings panel width (300-600px) */
  settingsPanelWidth: number
  /** Interface language */
  language: AppLocale
  /** Theme settings */
  theme: ThemeSettings
  updatedAt: number
}

export type { ThemeSettings }

// Shortcut action type
export type ShortcutAction =
  | { type: 'focusTerminal'; index: number }
  | { type: 'switchTab'; index: number }
  | { type: 'activateAndFocusPrompt' }
  | { type: 'addToHistory' }
  | { type: 'focusPromptEditor' }
  | { type: 'terminalGitDiff' }
  | { type: 'terminalGitHistory' }
  | { type: 'terminalChangeWorkDir' }
  | { type: 'terminalOpenWorkDir' }
  | { type: 'terminalProjectEditor' }
  | { type: 'viewGitDiff' }

// Settings API interface
export interface SettingsAPI {
  load: () => Promise<SettingsState>
  save: (settings: SettingsState) => Promise<boolean>
  update: (partial: Partial<SettingsState>) => Promise<boolean>
  registerShortcuts: () => Promise<boolean>
  checkShortcutAvailable: (accelerator: string) => Promise<boolean>
  checkShortcutConflict: (accelerator: string, excludeKey?: string) => Promise<string | null>
  onShortcutTriggered: (callback: (action: ShortcutAction) => void) => () => void
  onWindowShortcutTriggered: (callback: (action: ShortcutAction) => void) => () => void
  onActivated: (callback: () => void) => () => void
}
