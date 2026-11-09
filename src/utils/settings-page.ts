/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsState } from '../types/settings'
import { normalizePromptShortcut, promptTargetSlot } from './prompt-input.ts'
import { isPromptPanelPosition, normalizePromptPanelPosition } from './prompt-panel-layout.ts'
import { RESERVED_SHORTCUTS } from '../../electron/main/reserved-shortcuts.ts'

export const SETTINGS_EDITABLE_PAGES = ['general', 'appearance', 'fonts', 'shortcuts'] as const
export type SettingsEditablePage = typeof SETTINGS_EDITABLE_PAGES[number]
export const SETTINGS_PAGE_FIELDS = {
  general: ['language', 'performanceDiagnosticsEnabled', 'telemetryConsent', 'terminalMacOptionIsMeta', 'promptPanelPosition'],
  appearance: ['theme'],
  fonts: ['terminalStyles', 'globalTerminalStyle', 'gitDiffFontSize'],
  shortcuts: ['shortcuts', 'promptInput']
} as const satisfies Record<SettingsEditablePage, readonly (keyof SettingsState)[]>
type PageField = typeof SETTINGS_PAGE_FIELDS[SettingsEditablePage][number]
export type SettingsPageValues = Partial<Pick<SettingsState, PageField>>
export interface SettingsPageCommit {
  page: SettingsEditablePage
  baseline: SettingsPageValues
  draft: SettingsPageValues
}
export type SettingsPageCommitError = 'invalid' | 'conflict' | 'write-failed' | 'shortcut-unavailable' | 'busy' | 'unavailable'
export type SettingsPageCommitResult = { success: true; settings: SettingsState } | { success: false; error: SettingsPageCommitError }

/** Referential equality keeps unchanged theme catalogs out of the edit path. */
export function settingsValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = Object.keys(left), b = Object.keys(right)
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) &&
    settingsValuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

export function selectSettingsPage(settings: SettingsState, page: SettingsEditablePage): SettingsPageValues {
  return Object.fromEntries(SETTINGS_PAGE_FIELDS[page].map(key => [
    key,
    key === 'terminalMacOptionIsMeta'
      ? settings[key] === true
      : key === 'promptPanelPosition'
        ? normalizePromptPanelPosition(settings[key])
        : settings[key]
  ]))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Three-way merge: unrelated live edits survive; arrays retain their ordered identity. */
export function mergeSettingsPage(current: SettingsPageValues, baseline: SettingsPageValues, draft: SettingsPageValues):
  { success: true; values: SettingsPageValues } | { success: false } {
  let conflict = false
  const merge = (live: unknown, before: unknown, edited: unknown): unknown => {
    if (settingsValuesEqual(before, edited)) return live
    if (settingsValuesEqual(live, before) || settingsValuesEqual(live, edited)) return edited
    if (isRecord(live) && isRecord(before) && isRecord(edited)) {
      const result: Record<string, unknown> = {}
      for (const key of new Set([...Object.keys(live), ...Object.keys(before), ...Object.keys(edited)])) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') { conflict = true; continue }
        const value = merge(live[key], before[key], edited[key])
        if (value !== undefined) result[key] = value
      }
      return result
    }
    conflict = true
    return live
  }
  const values = merge(current, baseline, draft) as SettingsPageValues
  return conflict ? { success: false } : { success: true, values }
}

export function isSettingsPageCommit(value: unknown): value is SettingsPageCommit {
  if (!isRecord(value) || !SETTINGS_EDITABLE_PAGES.includes(value.page as SettingsEditablePage)) return false
  const fields = SETTINGS_PAGE_FIELDS[value.page as SettingsEditablePage]
  return [value.baseline, value.draft].every(part => isRecord(part) && Object.keys(part).length === fields.length &&
    fields.every(field => {
      if (!Object.hasOwn(part, field)) return false
      const entry = part[field]
      if (field === 'language') return entry === 'en' || entry === 'zh-CN'
      if (field === 'promptPanelPosition') return isPromptPanelPosition(entry)
      if (field === 'performanceDiagnosticsEnabled' || field === 'terminalMacOptionIsMeta') return typeof entry === 'boolean'
      if (field === 'telemetryConsent') return entry === null || typeof entry === 'boolean'
      if (field === 'gitDiffFontSize') return entry === null || typeof entry === 'number' && Number.isFinite(entry)
      if (!isRecord(entry)) return false
      if (field === 'shortcuts') return Object.values(entry).every(item => item === null || typeof item === 'string')
      return true
    }))
}

export function settingsDraftShortcutConflict(settings: SettingsState, accelerator: string, platform: string,
  excludeKey?: string, leader = false): string | null {
  const key = normalizePromptShortcut(accelerator, platform)
  if (!key) return null
  for (const [name, values] of Object.entries(RESERVED_SHORTCUTS)) {
    if (values.some(value => normalizePromptShortcut(value, platform) === key)) return name
  }
  for (const [name, value] of Object.entries(settings.shortcuts)) {
    if (name !== excludeKey && value && normalizePromptShortcut(value, platform) === key) return name
  }
  if (!leader && normalizePromptShortcut(settings.promptInput.leader, platform) === key) return 'promptInputLeader'
  if (excludeKey === 'activateAndFocusPrompt') {
    if (settings.promptInput.actions.some(action => normalizePromptShortcut(action.shortcut, platform) === key)) return 'promptInputAction'
    if (settings.promptInput.targetModifier && promptTargetSlot(key, settings.promptInput.targetModifier) !== null) return 'promptInputTarget'
  }
  return null
}
