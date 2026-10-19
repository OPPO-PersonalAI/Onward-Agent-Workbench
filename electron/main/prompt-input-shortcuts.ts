/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow, Event, Input, KeyboardInputEvent, WebContents } from 'electron'
import {
  createDefaultPromptInputSettings,
  normalizePromptInputSettings,
  promptShortcutCancellation,
  promptShortcutFromKey,
  reducePromptLeader,
  type PromptInputSettings,
  type PromptLeaderState,
  type PromptShortcutContext,
  type PromptShortcutEvent
} from '../../src/utils/prompt-input'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'

const emptyContext = (): PromptShortcutContext => ({
  tabId: '', visibleTerminalIds: [], activeTerminalId: null, blocked: true
})

/** A bounded renderer context is advisory; live target ownership is checked on use. */
export function isPromptShortcutContext(value: unknown): value is PromptShortcutContext {
  if (!value || typeof value !== 'object') return false
  const context = value as PromptShortcutContext
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128
  return typeof context.tabId === 'string' && context.tabId.length <= 128 &&
    (context.generation === undefined || (Number.isSafeInteger(context.generation) && context.generation >= 0)) &&
    typeof context.blocked === 'boolean' && Array.isArray(context.visibleTerminalIds) &&
    context.visibleTerminalIds.length <= 8 && context.visibleTerminalIds.every(validId) &&
    new Set(context.visibleTerminalIds).size === context.visibleTerminalIds.length &&
    (context.activeTerminalId === null || (validId(context.activeTerminalId) && context.visibleTerminalIds.includes(context.activeTerminalId))) &&
    (context.tabId.length > 0 || context.visibleTerminalIds.length === 0)
}

/** One state machine per Onward window, shared by the host and its guest contents. */
export class PromptInputShortcuts {
  private window: BrowserWindow | null = null
  private settings: PromptInputSettings = createDefaultPromptInputSettings()
  private context = emptyContext()
  private state: PromptLeaderState | null = null
  private owner: WebContents | null = null
  private suspended = false
  private preserveNativeMenus = false
  private timeout: ReturnType<typeof setTimeout> | null = null
  private sources = new Map<WebContents, () => void>()
  private swallowedKeys = new Set<string>()
  private menuSuppressed = new Set<WebContents>()
  private ownsTerminal: (id: string) => boolean = () => false
  private detachWindow: (() => void) | null = null

  init(window: BrowserWindow, settings: PromptInputSettings, ownsTerminal: (id: string) => boolean): void {
    this.dispose()
    this.window = window
    this.ownsTerminal = ownsTerminal
    this.settings = normalizePromptInputSettings(settings)
    const contents = window.webContents
    this.attach(contents)
    const blur = () => this.reset('blur')
    const closed = () => this.dispose()
    const gone = () => {
      this.reset('renderer-gone')
      this.context = emptyContext()
    }
    window.on('blur', blur)
    window.on('closed', closed)
    contents.on('render-process-gone', gone)
    this.detachWindow = () => {
      window.removeListener('blur', blur)
      window.removeListener('closed', closed)
      contents.removeListener('render-process-gone', gone)
    }
    this.trace('initialized')
  }

  /** Called only by the main-owned guest creation paths, never by guest IPC. */
  attach(contents: WebContents): void {
    if (!this.window || this.window.isDestroyed() || contents.isDestroyed() || this.sources.has(contents)) return
    const isMainContents = contents === this.window.webContents
    const destroyed = () => {
      this.sources.get(contents)?.()
      this.sources.delete(contents)
      this.ignoreMenu(contents, false)
      if (this.owner === contents || isMainContents) this.reset('contents-destroyed')
      this.trace('contents-detached', { contentsId: contents.id })
    }
    const blur = () => {
      if (this.owner === contents || this.suspended) this.reset('contents-blur')
    }
    const navigate = (_event: Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame || isInPlace) return
      if (isMainContents) {
        this.reset('reload')
        this.context = emptyContext()
      } else if (this.owner === contents) {
        this.reset('owner-navigated')
      }
    }
    contents.once('destroyed', destroyed)
    contents.on('blur', blur)
    contents.on('did-start-navigation', navigate)
    this.sources.set(contents, () => {
      contents.removeListener('destroyed', destroyed)
      contents.removeListener('blur', blur)
      contents.removeListener('did-start-navigation', navigate)
    })
    if (this.suspended) this.ignoreMenu(contents, !this.preserveNativeMenus)
    this.trace('contents-attached', { contentsId: contents.id })
  }

  /** Autotest-only native ingress; Electron owns key conversion and before-input-event. */
  sendInputEventForAutotest(contents: WebContents, value: unknown): boolean {
    if (process.env.ONWARD_AUTOTEST !== '1' || !this.window || this.window.isDestroyed() ||
      !this.window.isFocused() || !this.sources.has(contents) || contents.isDestroyed() || !contents.isFocused()) return false
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    // Reject unsupported DOM overrides rather than silently falsifying layout coverage.
    if (Object.keys(value).some(key => !['type', 'keyCode', 'modifiers'].includes(key))) return false
    const input = value as KeyboardInputEvent
    if (!['keyDown', 'rawKeyDown', 'keyUp', 'char'].includes(input.type) ||
      typeof input.keyCode !== 'string' || !input.keyCode.length || input.keyCode.length > 64) return false
    const allowedModifiers = new Set([
      'shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd', 'iskeypad', 'isautorepeat',
      'leftbuttondown', 'middlebuttondown', 'rightbuttondown', 'capslock', 'numlock', 'left', 'right'
    ])
    if (input.modifiers !== undefined && (!Array.isArray(input.modifiers) || input.modifiers.length > 16 ||
      input.modifiers.some(modifier => !allowedModifiers.has(modifier)))) return false
    try {
      contents.sendInputEvent({
        type: input.type, keyCode: input.keyCode,
        ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] })
      })
      return true
    } catch {
      return false
    }
  }

  updateSettings(settings: PromptInputSettings): void {
    const next = normalizePromptInputSettings(settings)
    // This comparison runs only on settings writes, never on the input path.
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return
    this.cancel('settings-changed')
    this.settings = next
    this.trace('settings-refreshed')
  }

  setContext(context: PromptShortcutContext): void {
    // Cancel before replacement so the outgoing event retains the old generation.
    if (this.context.tabId !== context.tabId) this.cancel('tab-changed')
    else if (this.context.generation !== context.generation) this.cancel('generation-changed')
    else if (context.blocked) this.cancel('blocked')
    else if (this.state?.targetId && !context.visibleTerminalIds.includes(this.state.targetId)) this.cancel('target-unavailable')
    this.context = {
      tabId: context.tabId,
      ...(context.generation === undefined ? {} : { generation: context.generation }),
      visibleTerminalIds: [...context.visibleTerminalIds],
      activeTerminalId: context.activeTerminalId, blocked: context.blocked
    }
    this.trace('context-received', {
      tabId: context.tabId,
      ...(context.generation === undefined ? {} : { generation: context.generation }),
      visibleCount: context.visibleTerminalIds.length, blocked: context.blocked
    })
  }

  suspend(suspended: boolean, preserveNativeMenus = false): void {
    this.cancel('recording')
    this.swallowedKeys.clear()
    this.suspended = suspended
    // Recorders need raw accelerators; text-entry dialogs retain the native Edit menu.
    this.preserveNativeMenus = suspended && preserveNativeMenus
    for (const contents of this.sources.keys()) this.ignoreMenu(contents, suspended && !this.preserveNativeMenus)
    this.trace('suspend-received', { suspended, preserveNativeMenus: this.preserveNativeMenus })
  }

  cancel(reason: string): void {
    const tabId = this.state?.tabId ?? this.context.tabId
    const active = this.state !== null
    const contentsId = this.owner?.id
    this.state = null
    this.owner = null
    this.clearTimeout()
    if (active) this.emit({ kind: 'cancel', tabId, active: false, reason }, contentsId)
  }

  /** True means skip other Onward matches, even when the physical key passes through. */
  route(contents: WebContents, event: Event, input: Input): boolean {
    if (!this.window || this.window.isDestroyed() || !this.sources.has(contents)) return false
    if (this.state && this.owner !== contents) {
      // A missing/delayed blur must never transfer a pending chord to a new surface.
      this.reset('owner-changed')
      return false
    }
    // Undo a one-stroke passthrough suppression on the next physical event.
    if (!this.suspended && this.menuSuppressed.has(contents)) this.ignoreMenu(contents, false)
    const physicalKey = input.code || input.key
    if (input.type === 'keyUp') {
      if (this.swallowedKeys.delete(physicalKey)) {
        event.preventDefault()
        return true
      }
      return this.suspended
    }
    if (input.type !== 'keyDown') return false
    if (!this.window.isFocused()) {
      if (this.state || this.suspended || this.swallowedKeys.size > 0) this.reset('unfocused-input')
      return false
    }
    // Chromium may suppress a consumed key's release before this hook. A fresh
    // physical down starts a new cycle without releasing other held keys.
    if (!input.isAutoRepeat && this.swallowedKeys.delete(physicalKey)) {
      this.trace('suppressed-release-retired', { remainingCount: this.swallowedKeys.size })
    }
    if (this.suspended) return true
    // Explicit AltGr metadata is text input. Some OS/layout pairs report only
    // Control+Alt, which Electron cannot distinguish from that physical chord.
    const cancellation = promptShortcutCancellation(input)
    if (cancellation) {
      this.cancel(cancellation)
      return true
    }
    if (this.state && Date.now() >= this.state.deadline) this.cancel('timeout')
    if (input.isAutoRepeat && this.swallowedKeys.has(physicalKey)) {
      event.preventDefault()
      return true
    }
    if (!this.settings.leader && !this.state) return false
    // Modifier presses are part of a following stroke, not unmatched strokes.
    if (/^(Control|Meta|Alt|Shift|AltGraph)$/.test(input.key)) return false
    const key = promptShortcutFromKey(input, process.platform)
    if (this.state && !key) {
      this.cancel('unmatched')
      this.swallowedKeys.add(physicalKey)
      event.preventDefault()
      return true
    }
    const previous = this.state
    const transition = reducePromptLeader(this.state, key, Date.now(), this.settings, this.context, {
      repeat: input.isAutoRepeat, platform: process.platform
    })
    if (transition.state?.targetId && !this.ownsTerminal(transition.state.targetId)) {
      transition.state = null
      transition.event = { kind: 'cancel', tabId: this.context.tabId, active: false, reason: 'target-unavailable' }
    } else if (transition.event?.kind === 'dispatch' && transition.event.targetId && !this.ownsTerminal(transition.event.targetId)) {
      transition.event = { kind: 'cancel', tabId: this.context.tabId, active: false, reason: 'target-unavailable' }
    }
    this.state = transition.state
    this.owner = this.state ? contents : null
    if (previous !== this.state) this.armTimeout()
    if (transition.event) this.emit(transition.event, contents.id)
    if (transition.consume) {
      this.swallowedKeys.add(physicalKey)
      event.preventDefault()
    }
    if (transition.event?.kind === 'passthrough') this.ignoreMenu(contents, true)
    // L L is deliberately the SECOND physical stroke; no synthetic reinjection.
    return transition.consume || transition.event?.kind === 'passthrough'
  }

  dispose(): void {
    if (!this.window) return
    this.reset('disposed')
    this.detachWindow?.()
    this.detachWindow = null
    for (const detach of this.sources.values()) detach()
    this.sources.clear()
    this.context = emptyContext()
    this.ownsTerminal = () => false
    this.trace('disposed')
    this.window = null
  }

  private reset(reason: string): void {
    this.cancel(reason)
    const wasSuspended = this.suspended
    this.suspended = false
    this.preserveNativeMenus = false
    this.swallowedKeys.clear()
    for (const contents of this.menuSuppressed) this.ignoreMenu(contents, false)
    this.trace(reason, { wasSuspended })
  }

  private ignoreMenu(contents: WebContents, ignore: boolean): void {
    if (ignore === this.menuSuppressed.has(contents)) return
    if (ignore) this.menuSuppressed.add(contents)
    else this.menuSuppressed.delete(contents)
    try {
      if (!contents.isDestroyed()) {
        contents.setIgnoreMenuShortcuts(ignore)
        this.trace('menu-suppression-changed', { ignore, contentsId: contents.id })
      }
    } catch {
      this.trace('menu-suppression-rejected')
    }
  }

  private clearTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
  }

  private armTimeout(): void {
    this.clearTimeout()
    if (!this.state) return
    this.timeout = setTimeout(() => this.cancel('timeout'), Math.max(0, this.state.deadline - Date.now()))
  }

  private emit(event: PromptShortcutEvent, contentsId?: number): void {
    const outgoing = this.context.generation === undefined ? event : { ...event, generation: this.context.generation }
    this.trace('event-send', { ...outgoing, contentsId })
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    try {
      this.window.webContents.send(IPC.PROMPT_INPUT_SHORTCUT, outgoing)
    } catch {
      this.trace('event-send-rejected')
    }
  }

  private trace(stage: string, extra: Record<string, unknown> = {}): void {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_SHORTCUT, { stage, ...extra })
  }
}

export const promptInputShortcuts = new PromptInputShortcuts()
