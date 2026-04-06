/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Prompt } from '../types/electron.d.ts'
import type { AppState, PromptCleanupConfig } from '../types/tab.d.ts'

export const PROMPT_EXPORT_SCHEMA_VERSION = 1

export interface ExportedPromptRecord extends Omit<Prompt, 'createdAt' | 'updatedAt' | 'lastUsedAt'> {
  createdAt: number
  createdAtIso: string
  updatedAt: number
  updatedAtIso: string
  lastUsedAt: number
  lastUsedAtIso: string
}

export interface ExportedTab {
  id: string
  index: number
  displayName: string
  customName: string | null
  layoutMode: number
  activePanel: string | null
  promptPanelWidth: number
  activeTerminalId: string | null
  terminals: Array<{ id: string; customName: string | null }>
  createdAt: number
  createdAtIso: string
  localPromptCount: number
  localPrompts: ExportedPromptRecord[]
}

export interface PromptExportPayload {
  schemaVersion: number
  exportedAt: number
  exportedAtIso: string
  appInfo: unknown
  promptCleanup: PromptCleanupConfig
  summary: {
    totalCount: number
    globalCount: number
    localCount: number
    tabCount: number
    activeTabId: string | null
  }
  globalPrompts: ExportedPromptRecord[]
  tabs: ExportedTab[]
}

export interface PromptImportPlan {
  globals: Prompt[]
  locals: Prompt[]
  duplicateCount: number
}

export interface PromptImportResult {
  success: boolean
  canceled?: boolean
  globalImported: number
  localImported: number
  skippedDuplicate: number
  error?: string
}

export interface ImportPrepareResult {
  success: boolean
  globals: Prompt[]
  locals: Prompt[]
  duplicateCount: number
  error?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function generateImportId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
}

function normalizeColor(value: unknown): Prompt['color'] {
  return value === 'red' || value === 'yellow' || value === 'green' ? value : null
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function resolveTimestamp(value: unknown, fallback: number): number {
  return normalizeTimestamp(value, fallback)
}

export function toIsoString(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

export function formatExportFileName(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `onward-prompt-history-${year}${month}${day}-${hours}${minutes}${seconds}.json`
}

export function normalizePromptForExport(prompt: Prompt, exportNow: number): ExportedPromptRecord {
  const createdAt = normalizeTimestamp(prompt.createdAt, exportNow)
  const updatedAt = normalizeTimestamp(prompt.updatedAt, exportNow)
  const lastUsedAt = normalizeTimestamp(prompt.lastUsedAt, exportNow)
  return {
    ...prompt,
    createdAt,
    createdAtIso: toIsoString(createdAt),
    updatedAt,
    updatedAtIso: toIsoString(updatedAt),
    lastUsedAt,
    lastUsedAtIso: toIsoString(lastUsedAt)
  }
}

export function sortLocalPromptsByUiOrder(prompts: Prompt[], exportNow: number): Prompt[] {
  return [...prompts].sort((a, b) => {
    return normalizeTimestamp(b.updatedAt, exportNow) - normalizeTimestamp(a.updatedAt, exportNow)
  })
}

export function buildPromptExportPayload(
  state: Pick<AppState, 'globalPrompts' | 'tabs' | 'promptCleanup' | 'activeTabId'>,
  getTabDisplayName: (tab: AppState['tabs'][number], index: number) => string,
  appInfo: unknown,
  exportNow: number
): PromptExportPayload {
  const globalPrompts = state.globalPrompts.map(prompt => normalizePromptForExport(prompt, exportNow))
  const tabs = state.tabs.map((item, index) => {
    const tabCreatedAt = normalizeTimestamp(item.createdAt, exportNow)
    const localPrompts = sortLocalPromptsByUiOrder(item.localPrompts, exportNow)
      .map(prompt => normalizePromptForExport(prompt, exportNow))
    return {
      id: item.id,
      index,
      displayName: getTabDisplayName(item, index),
      customName: item.customName,
      layoutMode: item.layoutMode,
      activePanel: item.activePanel,
      promptPanelWidth: item.promptPanelWidth,
      activeTerminalId: item.activeTerminalId,
      terminals: item.terminals.map(terminal => ({
        id: terminal.id,
        customName: terminal.customName
      })),
      createdAt: tabCreatedAt,
      createdAtIso: toIsoString(tabCreatedAt),
      localPromptCount: localPrompts.length,
      localPrompts
    }
  })
  const localCount = tabs.reduce((sum, item) => sum + item.localPrompts.length, 0)

  return {
    schemaVersion: PROMPT_EXPORT_SCHEMA_VERSION,
    exportedAt: exportNow,
    exportedAtIso: toIsoString(exportNow),
    appInfo,
    promptCleanup: state.promptCleanup,
    summary: {
      totalCount: globalPrompts.length + localCount,
      globalCount: globalPrompts.length,
      localCount,
      tabCount: tabs.length,
      activeTabId: state.activeTabId
    },
    globalPrompts,
    tabs
  }
}

function isValidSendHistory(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((record) => {
    if (!isObject(record)) return false
    const action = record.action
    return (
      typeof record.taskId === 'string' &&
      typeof record.taskName === 'string' &&
      typeof record.sentAt === 'number' &&
      (action === 'send' || action === 'execute' || action === 'sendAndExecute') &&
      (record.result === undefined || record.result === 'executed' || record.result === 'sent-only')
    )
  })
}

function isValidPromptRecord(record: unknown): record is ExportedPromptRecord {
  if (!isObject(record)) return false
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.content === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    typeof record.lastUsedAt === 'number' &&
    typeof record.pinned === 'boolean' &&
    isValidSendHistory(record.sendHistory)
  )
}

export function validateExportPayload(
  data: unknown
): { valid: true; payload: PromptExportPayload } | { valid: false; error: string } {
  if (!isObject(data)) {
    return { valid: false, error: 'The file content is not a valid JSON object.' }
  }

  if (data.schemaVersion !== PROMPT_EXPORT_SCHEMA_VERSION) {
    return {
      valid: false,
      error: `Unsupported schema version: expected v${PROMPT_EXPORT_SCHEMA_VERSION}, got v${String(data.schemaVersion ?? 'unknown')}.`
    }
  }

  if (!Array.isArray(data.globalPrompts)) {
    return { valid: false, error: 'Invalid prompt export: missing globalPrompts.' }
  }

  if (!Array.isArray(data.tabs)) {
    return { valid: false, error: 'Invalid prompt export: missing tabs.' }
  }

  for (let index = 0; index < data.globalPrompts.length; index += 1) {
    if (!isValidPromptRecord(data.globalPrompts[index])) {
      return { valid: false, error: `Invalid global prompt at index ${index}.` }
    }
  }

  for (let tabIndex = 0; tabIndex < data.tabs.length; tabIndex += 1) {
    const tab = data.tabs[tabIndex]
    if (!isObject(tab) || !Array.isArray(tab.localPrompts)) {
      return { valid: false, error: `Invalid tab entry at index ${tabIndex}.` }
    }
    for (let promptIndex = 0; promptIndex < tab.localPrompts.length; promptIndex += 1) {
      if (!isValidPromptRecord(tab.localPrompts[promptIndex])) {
        return {
          valid: false,
          error: `Invalid local prompt at tab ${tabIndex}, index ${promptIndex}.`
        }
      }
    }
  }

  return { valid: true, payload: data as PromptExportPayload }
}

export function parsePromptExportPayload(
  content: string
): { success: true; payload: PromptExportPayload } | { success: false; error: string } {
  try {
    const parsed = JSON.parse(content) as unknown
    const validated = validateExportPayload(parsed)
    if (!validated.valid) {
      return { success: false, error: validated.error }
    }
    return { success: true, payload: validated.payload }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to parse JSON.'
    }
  }
}

function deserializePromptRecord(record: ExportedPromptRecord): Prompt {
  const {
    createdAtIso: _createdAtIso,
    updatedAtIso: _updatedAtIso,
    lastUsedAtIso: _lastUsedAtIso,
    pinned: _pinned,
    color,
    ...rest
  } = record
  const createdAt = normalizeTimestamp(record.createdAt, Date.now())
  const updatedAt = normalizeTimestamp(record.updatedAt, createdAt)
  const lastUsedAt = normalizeTimestamp(record.lastUsedAt, updatedAt)
  return {
    ...rest,
    id: generateImportId(),
    pinned: false,
    color: normalizeColor(color),
    createdAt,
    updatedAt,
    lastUsedAt
  }
}

function promptFingerprint(prompt: Pick<Prompt, 'title' | 'content'>): string {
  return `${prompt.title}\u0000${prompt.content}`
}

export function buildImportPlan(payload: PromptExportPayload, existingPrompts: Prompt[]): PromptImportPlan {
  const fingerprints = new Set(existingPrompts.map(promptFingerprint))
  let duplicateCount = 0

  const importRecords = (records: ExportedPromptRecord[]): Prompt[] => {
    const imported: Prompt[] = []
    for (const record of records) {
      const fingerprint = promptFingerprint(record)
      if (fingerprints.has(fingerprint)) {
        duplicateCount += 1
        continue
      }
      fingerprints.add(fingerprint)
      imported.push(deserializePromptRecord(record))
    }
    return imported
  }

  const globals = importRecords(payload.globalPrompts).map((prompt) => ({
    ...prompt,
    pinned: true as const
  }))

  const localRecords = payload.tabs
    .flatMap((tab) => tab.localPrompts)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const locals = importRecords(localRecords).map((prompt) => ({
    ...prompt,
    pinned: false as const
  }))

  return { globals, locals, duplicateCount }
}
