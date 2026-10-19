/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizePromptActionEmoji } from './prompt-emoji.ts'

/** Shared, side-effect-free contracts for input actions, persistence and chords. */
export type PromptActionPreset = 'sendAndExecute' | 'execute' | 'send' | 'sendAllAndExecute' | 'queue'
export interface PromptInputAction {
  id: string
  /** An empty name on a preset uses its localized built-in label. */
  name: string
  preset?: PromptActionPreset
  visible: boolean
  includePrompt: boolean
  terminalKey: string
  target: 'default' | 'all'
  shortcut: string | null
  /** Optional user color; absent values follow the preset's theme color. */
  color?: string
  /** Optional supported Unicode sequence; absent values follow the preset icon. */
  emoji?: string
}
export interface PromptInputSettings {
  leader: string | null
  timeoutMs: number
  actions: PromptInputAction[]
}
export interface PromptShortcutContext {
  tabId: string
  /** Window-local Tab activation epoch, so A -> B -> A cannot revive old input. */
  generation?: number
  visibleTerminalIds: string[]
  activeTerminalId: string | null
  blocked: boolean
}
export interface PromptShortcutEvent {
  kind: 'state' | 'dispatch' | 'cancel' | 'passthrough'
  tabId: string
  generation?: number
  active: boolean
  targetId?: string
  actionId?: string
  reason?: string
}
export interface PromptInputPayload {
  content: string
  includePrompt: boolean
  terminalKey: string
}
export interface PromptInputResult {
  ok: boolean
  phase: 'content' | 'key' | 'complete'
  contentDelivered: boolean
  reason?: 'invalid-input' | 'unavailable' | 'unsafe-multiline-send' | 'write-failed'
}
export interface PromptInputAPI {
  setContext: (context: PromptShortcutContext) => Promise<void>
  suspend: (suspended: boolean, preserveNativeMenus?: boolean) => Promise<void>
  cancel: (reason: string) => Promise<void>
  onShortcut: (callback: (event: PromptShortcutEvent) => void) => () => void
  send: (terminalId: string, payload: PromptInputPayload) => Promise<PromptInputResult>
}

export const PROMPT_TERMINAL_KEYS = [
  'None', 'Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  ...Array.from({ length: 26 }, (_, index) => `Control+${String.fromCharCode(65 + index)}`)
] as const

export function createDefaultPromptInputSettings(): PromptInputSettings {
  const action = (id: PromptActionPreset, includePrompt: boolean, terminalKey: string, shortcut: string, target: 'default' | 'all' = 'default'): PromptInputAction =>
    ({ id, preset: id, name: '', visible: true, includePrompt, terminalKey, shortcut, target })
  return {
    leader: null,
    timeoutMs: 1500,
    actions: [
      action('sendAndExecute', true, 'Enter', 'Enter'),
      action('execute', false, 'Enter', 'E'),
      action('send', true, 'None', 'S'),
      action('sendAllAndExecute', true, 'Enter', 'A', 'all'),
      action('queue', true, 'Tab', 'Q')
    ]
  }
}

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', space: 'Space',
  tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', plus: 'Plus'
}
const SHORTCUT_PUNCTUATION = new Set('-=[]\\;\',./`!@#$%^&*()_{}:"<>?~|')
export function normalizePromptShortcut(value: unknown, platform = 'darwin'): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 96) return null
  const trimmed = value.trim()
  const parts = (trimmed === '+' ? 'Plus' : trimmed.endsWith('++') ? `${trimmed.slice(0, -1)}Plus` : trimmed).split('+')
  const modifiers = new Set<string>()
  let key: string | null = null
  for (const part of parts) {
    const lower = part.trim().toLowerCase()
    if (lower === 'ctrl' || lower === 'control') modifiers.add('Control')
    else if (['cmd', 'command', 'meta', 'super', 'win'].includes(lower)) modifiers.add('Meta')
    else if (lower === 'commandorcontrol' || lower === 'cmdorctrl') modifiers.add(platform === 'portable' ? 'CommandOrControl' : platform === 'darwin' ? 'Meta' : 'Control')
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt')
    else if (lower === 'shift') modifiers.add('Shift')
    else {
      if (key || !lower) return null
      const alias = Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower) ? KEY_ALIASES[lower] : null
      const candidate = alias ?? (/^[a-z0-9]$/i.test(lower) || SHORTCUT_PUNCTUATION.has(lower) || /^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(lower) ? lower.toUpperCase() : null)
      if (!candidate) return null
      key = candidate
    }
  }
  if (!key) return null
  return [...['Control', 'Meta', 'CommandOrControl', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier)), key].join('+')
}

export interface PromptKeyboardInput {
  key: string; code?: string; control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean
  isComposing?: boolean; keyCode?: number
  modifiers?: string[]
  getModifierState?: (modifier: string) => boolean
}

/** Native ingress and the local preview must retire the same text-input sequences. */
export function promptShortcutCancellation(event: PromptKeyboardInput): 'ime' | 'altgr' | null {
  if (event.isComposing || event.keyCode === 229 || ['Process', 'Dead', 'Unidentified'].includes(event.key)) return 'ime'
  if (event.key === 'AltGraph' || event.modifiers?.includes('altgr') || event.getModifierState?.('AltGraph')) return 'altgr'
  return null
}

export function promptShortcutFromKey(event: PromptKeyboardInput, platform = 'darwin'): string | null {
  if (promptShortcutCancellation(event)) return null
  let key = event.key === ' ' ? 'Space' : event.key === '+' ? 'Plus' : event.key
  // Physical Latin keys remain usable with a CJK keyboard layout selected.
  if (/^Key[A-Z]$/.test(event.code ?? '')) key = event.code!.slice(3)
  else if (/^Digit[0-9]$/.test(event.code ?? '')) key = event.code!.slice(5)
  const parts = [
    (event.control || event.ctrlKey) && 'Control',
    (event.meta || event.metaKey) && 'Meta',
    (event.alt || event.altKey) && 'Alt',
    (event.shift || event.shiftKey) && 'Shift', key
  ].filter(Boolean)
  return normalizePromptShortcut(parts.join('+'), platform)
}

export function terminalKeyToSequence(key: string): string | null {
  const sequences: Record<string, string> = {
    None: '', Enter: '\r', Tab: '\t', 'Shift+Tab': '\x1b[Z', Escape: '\x1b',
    Backspace: '\x7f', Delete: '\x1b[3~', Up: '\x1b[A', Down: '\x1b[B',
    Right: '\x1b[C', Left: '\x1b[D', Home: '\x1b[H', End: '\x1b[F',
    PageUp: '\x1b[5~', PageDown: '\x1b[6~'
  }
  if (Object.prototype.hasOwnProperty.call(sequences, key)) return sequences[key]
  if (/^Control\+[A-Z]$/.test(key)) return String.fromCharCode(key.charCodeAt(8) - 64)
  return null
}

export function normalizePromptInputSettings(value: unknown): PromptInputSettings {
  const defaults = createDefaultPromptInputSettings()
  if (!value || typeof value !== 'object') return defaults
  const raw = value as Partial<PromptInputSettings>
  const actions: PromptInputAction[] = []
  const ids = new Set<string>()
  const shortcuts = new Set<string>()
  for (const candidate of Array.isArray(raw.actions) ? raw.actions : defaults.actions) {
    if (!candidate || typeof candidate !== 'object') continue
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 128 || ids.has(candidate.id)) continue
    const preset = defaults.actions.find(action => action.preset === candidate.preset)?.preset
    const name = typeof candidate.name === 'string' ? candidate.name.slice(0, 120) : ''
    if (!preset && !name.trim()) continue
    const terminalKey = typeof candidate.terminalKey === 'string' && terminalKeyToSequence(candidate.terminalKey) !== null
      ? candidate.terminalKey : 'None'
    if (candidate.includePrompt === false && terminalKey === 'None') continue
    ids.add(candidate.id)
    let shortcut = normalizePromptShortcut(candidate.shortcut, 'portable')
    if (shortcut === 'Escape' || /^[1-8]$/.test(shortcut ?? '') || shortcuts.has(shortcut ?? '')) shortcut = null
    if (shortcut) shortcuts.add(shortcut)
    const color = normalizePromptActionColor(candidate.color)
    const emoji = normalizePromptActionEmoji(candidate.emoji)
    actions.push({
      id: candidate.id, name,
      ...(color ? { color } : {}),
      ...(emoji ? { emoji } : {}),
      ...(preset ? { preset } : {}), visible: candidate.visible !== false,
      includePrompt: candidate.includePrompt !== false, terminalKey,
      target: candidate.target === 'all' ? 'all' : 'default', shortcut
    })
  }
  // Keep CommandOrControl portable on disk; only a matcher resolves the host.
  const parsedLeader = normalizePromptShortcut(raw.leader, 'portable')
  const leader = parsedLeader && (parsedLeader.includes('+') || /^F\d+$/.test(parsedLeader)) ? parsedLeader : null
  if (leader) {
    for (const action of actions) {
      if (action.shortcut === leader) action.shortcut = null
    }
  }
  return {
    leader,
    timeoutMs: typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? Math.max(500, Math.min(10000, Math.round(raw.timeoutMs))) : defaults.timeoutMs,
    actions
  }
}

export type PromptInputValidationError = 'invalid-leader' | 'invalid-shortcut' | 'duplicate-shortcut' | 'invalid-action' | 'shortcut-conflict'
export function validatePromptInputSettings(settings: PromptInputSettings, existingShortcuts: Array<string | null> = [], platform = 'darwin', globalShortcuts: Array<string | null> = []): PromptInputValidationError | null {
  if (!settings || !Array.isArray(settings.actions) || !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 500 || settings.timeoutMs > 10000) return 'invalid-action'
  const leader = normalizePromptShortcut(settings.leader, platform)
  if (settings.leader && (!leader || (!leader.includes('+') && !/^F\d+$/.test(leader)))) return 'invalid-leader'
  if (leader && existingShortcuts.some(key => normalizePromptShortcut(key, platform) === leader)) return 'shortcut-conflict'
  const keys = new Set<string>()
  const ids = new Set<string>()
  for (const action of settings.actions) {
    if (!action || typeof action.id !== 'string' || !action.id.trim() || action.id.length > 128 || ids.has(action.id)
      || typeof action.name !== 'string' || action.name.length > 120 || (!action.preset && !action.name.trim())
      || (action.preset !== undefined && !['sendAndExecute', 'execute', 'send', 'sendAllAndExecute', 'queue'].includes(action.preset))
        || (action.color !== undefined && !normalizePromptActionColor(action.color))
        || (action.emoji !== undefined && !normalizePromptActionEmoji(action.emoji))
       || (action.target !== 'default' && action.target !== 'all') || typeof action.visible !== 'boolean'
      || typeof action.includePrompt !== 'boolean' || terminalKeyToSequence(action.terminalKey) === null
      || (!action.includePrompt && action.terminalKey === 'None')) return 'invalid-action'
    ids.add(action.id)
    if (!action.shortcut) continue
    const key = normalizePromptShortcut(action.shortcut, platform)
    if (!key || key === 'Escape' || /^[1-8]$/.test(key) || key === leader) return 'invalid-shortcut'
    if (globalShortcuts.some(shortcut => normalizePromptShortcut(shortcut, platform) === key)) return 'shortcut-conflict'
    if (keys.has(key)) return 'duplicate-shortcut'
    keys.add(key)
  }
  return null
}

export interface PromptLeaderState { tabId: string; deadline: number; targetId?: string }
export interface PromptLeaderTransition {
  state: PromptLeaderState | null
  consume: boolean
  event?: PromptShortcutEvent
}
export function reducePromptLeader(
  state: PromptLeaderState | null, key: string | null, now: number,
  settings: PromptInputSettings, context: PromptShortcutContext,
  options: { repeat?: boolean; composing?: boolean; platform?: string } = {}
): PromptLeaderTransition {
  const cancel = (reason: string, consume = true): PromptLeaderTransition => ({
    state: null, consume, event: { kind: 'cancel', tabId: state?.tabId ?? context.tabId, active: false, reason }
  })
  if (context.blocked || options.composing) return state ? cancel('blocked', false) : { state: null, consume: false }
  const leader = normalizePromptShortcut(settings.leader, options.platform)
  if (!leader || !context.tabId) return { state: null, consume: false }
  let expired: PromptShortcutEvent | undefined
  if (state && (now >= state.deadline || state.tabId !== context.tabId)) {
    expired = { kind: 'cancel', tabId: state.tabId, active: false, reason: state.tabId !== context.tabId ? 'tab-changed' : 'timeout' }
    state = null
  }
  if (options.repeat) return { state, consume: Boolean(state || key === leader), event: expired }
  if (!key) return { state, consume: false, event: expired }
  if (key === leader) {
    if (state) return { state: null, consume: false, event: { kind: 'passthrough', active: false, tabId: context.tabId } }
    return {
      state: { tabId: context.tabId, deadline: now + settings.timeoutMs }, consume: true,
      event: { kind: 'state', active: true, tabId: context.tabId }
    }
  }
  if (!state) return { state: null, consume: false, event: expired }
  if (key === 'Escape') return cancel('escape')
  if (/^[1-8]$/.test(key)) {
    const targetId = context.visibleTerminalIds[Number(key) - 1]
    if (!targetId) return cancel('target-unavailable')
    return {
      state: { ...state, deadline: now + settings.timeoutMs, targetId }, consume: true,
      event: { kind: 'state', active: true, tabId: context.tabId, targetId }
    }
  }
  const action = settings.actions.find(candidate => normalizePromptShortcut(candidate.shortcut, options.platform) === key)
  if (!action) return cancel('unmatched')
  if (state.targetId && !context.visibleTerminalIds.includes(state.targetId)) return cancel('target-unavailable')
  if (state.targetId && action.target === 'all') return cancel('target-conflict')
  return {
    state: null, consume: true,
    event: { kind: 'dispatch', active: false, tabId: context.tabId, actionId: action.id, targetId: state.targetId }
  }
}

export function resolvePromptTargets(
  action: Pick<PromptInputAction, 'target'>, visibleIds: string[], activeId: string | null,
  selectedIds: string[], explicitId?: string
): { ids: string[]; reason?: 'target-unavailable' | 'target-conflict' } {
  if (explicitId) {
    if (action.target === 'all') return { ids: [], reason: 'target-conflict' }
    return visibleIds.includes(explicitId) ? { ids: [explicitId] } : { ids: [], reason: 'target-unavailable' }
  }
  if (action.target === 'all') return visibleIds.length ? { ids: [...new Set(visibleIds)] } : { ids: [], reason: 'target-unavailable' }
  if (selectedIds.length) {
    if (selectedIds.some(id => !visibleIds.includes(id))) return { ids: [], reason: 'target-unavailable' }
    return { ids: [...new Set(selectedIds)] }
  }
  return activeId && visibleIds.includes(activeId) ? { ids: [activeId] } : { ids: [], reason: 'target-unavailable' }
}

export function shouldClearPromptDraft(includePrompt: boolean, allSucceeded: boolean, sentRevision: number, currentRevision: number): boolean {
  return includePrompt && allSucceeded && sentRevision === currentRevision
}

export function normalizePromptActionColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined
}

/** Move a stable identity around an anchor, preserving hidden actions and objects. */
export function reorderPromptActions(actions: PromptInputAction[], sourceId: string, targetId: string, after: boolean): PromptInputAction[] {
  if (sourceId === targetId || !actions.some(action => action.id === sourceId) || !actions.some(action => action.id === targetId)) return actions
  const next = actions.filter(action => action.id !== sourceId)
  const target = next.findIndex(action => action.id === targetId)
  next.splice(target + (after ? 1 : 0), 0, actions.find(action => action.id === sourceId)!)
  return next.every((action, index) => action === actions[index]) ? actions : next
}
