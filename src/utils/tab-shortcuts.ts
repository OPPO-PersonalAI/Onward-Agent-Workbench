/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type SwitchTabShortcutKey = `switchTab${number}`

export const LEGACY_SWITCH_TAB_SLOT_COUNT = 6

export const TAB_NAV_SHORTCUT_KEYS = [
  'switchPrevTab',
  'switchNextTab',
  'switchLastTab',
  'searchTabs'
] as const

export type TabNavShortcutKey = typeof TAB_NAV_SHORTCUT_KEYS[number]

export type WindowShortcutLookupAction =
  | { type: 'focusTerminal'; index: number }
  | { type: 'switchTab'; index: number }
  | { type: 'switchPrevTab' }
  | { type: 'switchNextTab' }
  | { type: 'switchLastTab' }
  | { type: 'searchTabs' }
  | { type: 'focusPromptEditor' }
  | { type: 'addToHistory' }
  | { type: 'terminalGitDiff' }
  | { type: 'terminalGitHistory' }
  | { type: 'terminalChangeWorkDir' }
  | { type: 'terminalOpenWorkDir' }
  | { type: 'terminalProjectEditor' }
  | { type: 'viewGitDiff' }

const SWITCH_TAB_KEY_RE = /^switchTab([1-9]\d*)$/

/** Parse a `switchTab<N>` shortcut key into its 1-based positive integer index. */
export function parseSwitchTabShortcutKey(key: string): number | null {
  const match = SWITCH_TAB_KEY_RE.exec(key)
  if (!match) return null
  const index = Number(match[1])
  return Number.isSafeInteger(index) && index >= 1 ? index : null
}

/** Build the canonical `switchTab<N>` key for a 1-based tab index. */
export function switchTabShortcutKey(index: number): SwitchTabShortcutKey {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`Tab shortcut index must be a positive integer, got ${index}`)
  }
  return `switchTab${index}`
}

/** Enumerate active `switchTab1..switchTabN` keys matching the open tab count (at least 1). */
export function listActiveSwitchTabKeys(tabCount: number): SwitchTabShortcutKey[] {
  const count = Number.isFinite(tabCount) ? Math.max(1, Math.floor(tabCount)) : 1
  const keys: SwitchTabShortcutKey[] = []
  for (let index = 1; index <= count; index++) {
    keys.push(`switchTab${index}`)
  }
  return keys
}

export interface DormantSwitchTabEntry {
  key: SwitchTabShortcutKey
  index: number
  accelerator: string
}

/**
 * List persisted non-empty `switchTab<N>` bindings whose index exceeds the current
 * open tab count, sorted ascending by tab index.
 */
export function listDormantSwitchTabEntries(
  shortcuts: object | null | undefined,
  tabCount: number
): DormantSwitchTabEntry[] {
  if (!shortcuts) return []
  const visibleCount = Number.isFinite(tabCount) ? Math.max(1, Math.floor(tabCount)) : 1
  const entries: DormantSwitchTabEntry[] = []
  for (const [key, value] of Object.entries(shortcuts as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value.trim()) continue
    const index = parseSwitchTabShortcutKey(key)
    if (index !== null && index > visibleCount) {
      entries.push({ key: key as SwitchTabShortcutKey, index, accelerator: value })
    }
  }
  entries.sort((a, b) => a.index - b.index)
  return entries
}

/**
 * Apply a single shortcut update to a draft copy while avoiding dead `null` keys
 * for dynamic tab slots above the legacy 1..6 fixed slots.
 */
export function applyShortcutDraftUpdate<T extends object>(
  shortcuts: T,
  key: string,
  value: string | null
): T {
  const next = { ...(shortcuts as Record<string, unknown>) }
  const dynamicIndex = parseSwitchTabShortcutKey(key)
  if (value === null && dynamicIndex !== null && dynamicIndex > LEGACY_SWITCH_TAB_SLOT_COUNT) {
    delete next[key]
  } else {
    next[key] = value
  }
  return next as T
}

/** Clear all dormant `switchTab<N>` bindings above the current tab count. */
export function clearDormantSwitchTabDraft<T extends object>(
  shortcuts: T,
  tabCount: number
): T {
  const dormant = listDormantSwitchTabEntries(shortcuts, tabCount)
  if (dormant.length === 0) return shortcuts
  let next = shortcuts
  for (const entry of dormant) {
    next = applyShortcutDraftUpdate(next, entry.key, null)
  }
  return next
}

/** Extract validated dynamic `switchTab<N>` bindings (N > 6) from raw persisted shortcuts. */
export function extractDynamicSwitchTabEntries(
  rawShortcuts: Record<string, unknown> | null | undefined,
  validateShortcut: (value: unknown) => string | null
): Record<SwitchTabShortcutKey, string> {
  const result = {} as Record<SwitchTabShortcutKey, string>
  if (!rawShortcuts || typeof rawShortcuts !== 'object') return result
  const entries: Array<[number, SwitchTabShortcutKey, string]> = []
  for (const [key, value] of Object.entries(rawShortcuts)) {
    const index = parseSwitchTabShortcutKey(key)
    if (index === null || index <= LEGACY_SWITCH_TAB_SLOT_COUNT) continue
    const validated = validateShortcut(value)
    if (validated) {
      entries.push([index, `switchTab${index}`, validated])
    }
  }
  entries.sort((a, b) => a[0] - b[0])
  for (const [, key, value] of entries) {
    result[key] = value
  }
  return result
}

const DIRECT_WINDOW_ACTION_KEYS: ReadonlyArray<readonly [string, WindowShortcutLookupAction]> = [
  ['switchPrevTab', { type: 'switchPrevTab' }],
  ['switchNextTab', { type: 'switchNextTab' }],
  ['switchLastTab', { type: 'switchLastTab' }],
  ['searchTabs', { type: 'searchTabs' }],
  ['focusPromptEditor', { type: 'focusPromptEditor' }],
  ['addToHistory', { type: 'addToHistory' }],
  ['terminalGitDiff', { type: 'terminalGitDiff' }],
  ['terminalGitHistory', { type: 'terminalGitHistory' }],
  ['terminalChangeWorkDir', { type: 'terminalChangeWorkDir' }],
  ['terminalOpenWorkDir', { type: 'terminalOpenWorkDir' }],
  ['terminalProjectEditor', { type: 'terminalProjectEditor' }],
  ['viewGitDiff', { type: 'viewGitDiff' }]
]

/**
 * Build an O(1) accelerator lookup table for window-level shortcut dispatch.
 * Preserves precedence: focusTerminal 1..8, switchTab 1..N (ascending), then direct window actions.
 */
export function buildWindowShortcutLookup(
  shortcuts: object | null | undefined,
  normalizeAccelerator: (accelerator: string) => string
): Map<string, WindowShortcutLookupAction> {
  const map = new Map<string, WindowShortcutLookupAction>()
  if (!shortcuts) return map
  const record = shortcuts as Record<string, unknown>

  const add = (raw: unknown, action: WindowShortcutLookupAction) => {
    if (typeof raw !== 'string' || !raw.trim()) return
    const normalized = normalizeAccelerator(raw.trim())
    if (normalized && !map.has(normalized)) {
      map.set(normalized, action)
    }
  }

  for (let i = 1; i <= 8; i++) {
    add(record[`focusTerminal${i}`], { type: 'focusTerminal', index: i })
  }

  const switchTabEntries: Array<[number, string]> = []
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' || !value.trim()) continue
    const index = parseSwitchTabShortcutKey(key)
    if (index !== null) {
      switchTabEntries.push([index, value])
    }
  }
  switchTabEntries.sort((a, b) => a[0] - b[0])
  for (const [index, value] of switchTabEntries) {
    add(value, { type: 'switchTab', index })
  }

  for (const [key, action] of DIRECT_WINDOW_ACTION_KEYS) {
    add(record[key], action)
  }

  return map
}
