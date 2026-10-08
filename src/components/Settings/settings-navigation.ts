/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TranslationKey } from '../../i18n/core'

export const SETTINGS_PAGES = ['general', 'appearance', 'fonts', 'shortcuts', 'about'] as const
export type SettingsPage = typeof SETTINGS_PAGES[number]
export const PAGE_LABELS: Record<SettingsPage, TranslationKey> = {
  general: 'settings.page.general', appearance: 'settings.section.appearance',
  fonts: 'settings.page.fonts', shortcuts: 'settings.section.shortcuts', about: 'settings.page.about'
}
export interface SettingsSearchEntry { page: SettingsPage; target: string; label: TranslationKey; keywords?: TranslationKey[]; keywordIndices?: number[] }
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  { page: 'general', target: 'language', label: 'settings.language.label' },
  { page: 'general', target: 'diagnostics', label: 'settings.section.diagnostics', keywords: ['settings.diagnostics.performanceToggle'] },
  { page: 'general', target: 'privacy', label: 'settings.section.telemetry', keywords: ['settings.telemetry.toggle'] },
  { page: 'appearance', target: 'themes', label: 'settings.themes.featured', keywords: ['settings.themes.system', 'settings.themes.customize', 'settings.themes.import', 'settings.themes.export'] },
  { page: 'fonts', target: 'terminal-font-size', label: 'settings.terminal.fontSize' },
  { page: 'fonts', target: 'editor-font-size', label: 'settings.terminal.editorFontSize' },
  { page: 'fonts', target: 'font-family', label: 'settings.terminal.fontFamily' },
  { page: 'shortcuts', target: 'globalShortcuts', label: 'settings.group.globalShortcuts', keywords: ['settings.shortcut.togglePrompt'] },
  { page: 'shortcuts', target: 'windowShortcuts', label: 'settings.group.windowShortcuts', keywords: ['settings.shortcut.focusPromptEditor', 'settings.shortcut.addToHistory'] },
  { page: 'shortcuts', target: 'terminalActions', label: 'settings.group.terminalActions', keywords: ['settings.shortcut.viewGitDiff', 'settings.shortcut.viewGitHistory', 'settings.shortcut.changeWorkDir', 'settings.shortcut.openWorkDir', 'settings.shortcut.openProjectEditor'] },
  { page: 'shortcuts', target: 'terminalFocus', label: 'settings.group.terminalFocus', keywords: ['settings.shortcut.focusTask'], keywordIndices: [1, 2, 3, 4, 5, 6, 7, 8] },
  { page: 'shortcuts', target: 'tabSwitch', label: 'settings.group.tabSwitch', keywords: ['settings.shortcut.switchTab'], keywordIndices: [1, 2, 3, 4, 5, 6] },
  { page: 'about', target: 'updates', label: 'settings.section.updates', keywords: ['settings.versionLabel', 'settings.update.checkLabel'] }
]

/** The bounded, translated index contains no user data or runtime DOM text. */
export function searchSettings(query: string, translate: (key: TranslationKey, params?: { index: number }) => string): SettingsSearchEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return SETTINGS_SEARCH_ENTRIES.filter(entry => {
    const keywords = (entry.keywords ?? []).flatMap(key => entry.keywordIndices
      ? entry.keywordIndices.map(index => translate(key, { index })) : [translate(key)])
    const text = [translate(PAGE_LABELS[entry.page]), translate(entry.label), ...keywords].join(' ').toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}

export function nextSettingsTab(current: number, key: string): number | null {
  if (key === 'Home') return 0
  if (key === 'End') return SETTINGS_PAGES.length - 1
  if (key === 'ArrowDown') return (current + 1) % SETTINGS_PAGES.length
  if (key === 'ArrowUp') return (current + SETTINGS_PAGES.length - 1) % SETTINGS_PAGES.length
  return null
}
