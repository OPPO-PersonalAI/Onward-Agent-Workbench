/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Terminal, IDisposable } from '@xterm/xterm'
import { TerminalKeyboardProtocol, encodeTerminalKey, type TerminalKey } from './terminal-keyboard-protocol'
import { terminalClipboardPayload, type TerminalClipboard } from './terminal-clipboard'

type Trace = (kind: 'protocol' | 'keys' | 'clipboard', detail: Record<string, unknown>) => void
export interface TerminalInputServices {
  platform: string
  readClipboard: () => Promise<TerminalClipboard>
  copyText: (text: string) => Promise<unknown>
  trace: Trace
}

/** Small synchronous DOM decisions; native clipboard IO stays in the main process. */
export class TerminalInputAdapter {
  readonly protocol = new TerminalKeyboardProtocol()
  private subscriptions: IDisposable[] = []
  private element: HTMLElement | null = null
  private disposed = false
  private generation = 0
  private pending: Promise<void> = Promise.resolve()
  private held = new Map<string, { event: TerminalKey; flags: number }>()
  private consumed = new Set<string>()
  private counts = { encoded: 0, releases: 0, composed: 0, legacy: 0 }
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private terminal: Terminal, private services: TerminalInputServices) {
    services.trace('protocol', { reason: 'installed', flags: 0, supportedFlags: 7 })
    for (const prefix of ['?', '>', '<', '=']) {
      this.subscriptions.push(terminal.parser.registerCsiHandler({ prefix, final: 'u' }, params => {
        const before = this.protocol.flags
        const reply = this.protocol.command(prefix, params)
        if (before !== this.protocol.flags) this.held.clear()
        if (reply) terminal.input(reply, false)
        services.trace('protocol', { reason: reply ? 'query-replied' : 'mode-command', prefix,
          flags: this.protocol.flags, previousFlags: before, depth: this.protocol.depth, buffer: this.protocol.buffer })
        return true
      }))
    }
    this.subscriptions.push(terminal.buffer.onBufferChange(buffer => {
      this.protocol.buffer = buffer.type
      this.held.clear()
      services.trace('protocol', { reason: 'buffer-switched', buffer: buffer.type, flags: this.protocol.flags })
    }))
    this.subscriptions.push(terminal.parser.registerEscHandler({ final: 'c' }, () => { this.reset('ris'); return false }))
    terminal.attachCustomKeyEventHandler(event => this.handleKey(event))
  }

  bindElement(): void {
    if (this.element === this.terminal.element) return
    this.unbindElement()
    this.element = this.terminal.element ?? null
    this.element?.addEventListener('paste', this.nativePaste, true)
    this.element?.addEventListener('focusout', this.blur, true)
  }

  private nativePaste = (event: ClipboardEvent): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
    const data = event.clipboardData
    const payload = data ? terminalClipboardPayload([...data.types, ...Array.from(data.files, file => file.type)], () => data.getData('text/plain')) : undefined
    void this.paste('native', payload?.kind === 'empty' ? undefined : payload)
  }

  private blur = (): void => {
    // Release only keys whose press reached this exact session before focus moved.
    for (const { event, flags } of this.held.values()) {
      const data = encodeTerminalKey({ ...event, type: 'keyup' }, flags, this.services.platform, this.terminal.options.macOptionIsMeta, true)
      if (data) this.terminal.input(data, true)
    }
    if (this.held.size || this.consumed.size) this.services.trace('protocol', { reason: 'focus-released', held: this.held.size })
    this.held.clear()
    this.consumed.clear()
  }

  private note(kind: keyof TerminalInputAdapter['counts']): void {
    this.counts[kind]++
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), 1000)
  }

  private flush(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (Object.values(this.counts).some(Boolean)) this.services.trace('keys', { ...this.counts, flags: this.protocol.flags })
    this.counts = { encoded: 0, releases: 0, composed: 0, legacy: 0 }
  }

  handleKey(event: KeyboardEvent): boolean {
    if (this.disposed) return true
    const key = event.code || event.key
    if (event.type === 'keypress') return !this.consumed.has(key) && !this.held.has(key)
    if (event.type === 'keyup') {
      if (this.consumed.delete(key)) { event.preventDefault(); return false }
      const pressed = this.held.get(key)
      this.held.delete(key)
      if (!pressed) return true
      const data = encodeTerminalKey({ ...pressed.event, type: 'keyup', shiftKey: event.shiftKey,
        altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey }, pressed.flags,
      this.services.platform, this.terminal.options.macOptionIsMeta, true)
      if (data) { this.terminal.input(data, true); this.note('releases') }
      event.preventDefault()
      return false
    }
    if (event.type !== 'keydown') return true
    if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) { this.note('composed'); return true }
    const control = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
    if (this.services.platform !== 'darwin' && control) {
      if (event.code === 'KeyC' && this.terminal.hasSelection()) {
        const text = this.terminal.getSelection()
        this.terminal.clearSelection()
        void Promise.resolve().then(() => this.services.copyText(text)).catch(() => this.services.trace('clipboard', { reason: 'copy-failed' }))
        this.services.trace('clipboard', { reason: 'selection-copied' })
        this.consumed.add(key)
        event.preventDefault()
        return false
      }
      if (event.code === 'KeyV') {
        this.consumed.add(key)
        event.preventDefault()
        void this.paste('keyboard')
        return false
      }
    }
    const data = encodeTerminalKey(event, this.protocol.flags, this.services.platform, this.terminal.options.macOptionIsMeta)
    if (data === null) { this.note('legacy'); return true }
    if (data) {
      // Store fields explicitly: native KeyboardEvent properties are not enumerable.
      const snapshot: TerminalKey = { key: event.key, code: event.code, type: 'keydown',
        ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
        location: event.location }
      this.held.set(key, { event: snapshot, flags: this.protocol.flags })
      this.terminal.input(data, true)
      this.note('encoded')
    }
    event.preventDefault()
    return false
  }

  paste(entry: 'keyboard' | 'context' | 'native', supplied?: TerminalClipboard): Promise<void> {
    const generation = this.generation
    const started = performance.now()
    this.services.trace('clipboard', { reason: 'requested', entry })
    // Read at invocation time, then deliver in invocation order to the captured session.
    let read: Promise<TerminalClipboard>
    try { read = supplied ? Promise.resolve(supplied) : this.services.readClipboard() }
    catch { read = Promise.resolve({ kind: 'unavailable' }) }
    read = read.catch((): TerminalClipboard => ({ kind: 'unavailable' }))
    this.pending = this.pending.then(async () => {
      const payload = await read
      if (this.disposed || generation !== this.generation) {
        this.services.trace('clipboard', { reason: 'canceled', entry, durationMs: performance.now() - started })
        return
      }
      if (payload.kind === 'text') this.terminal.paste(payload.text)
      else if (payload.kind === 'image') {
        const trigger: TerminalKey = { type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }
        this.terminal.input(encodeTerminalKey(trigger, this.protocol.flags, this.services.platform) ?? '\x16', true)
        const release = encodeTerminalKey({ ...trigger, type: 'keyup' }, this.protocol.flags, this.services.platform, false, true)
        if (release) this.terminal.input(release, true)
      }
      this.services.trace('clipboard', { reason: payload.kind, entry, durationMs: performance.now() - started })
    }).catch(() => this.services.trace('clipboard', { reason: 'delivery-failed', entry, durationMs: performance.now() - started }))
    return this.pending
  }

  reset(reason = 'reset'): void {
    this.generation++
    this.pending = Promise.resolve()
    this.held.clear()
    this.consumed.clear()
    this.protocol.reset()
    this.protocol.buffer = this.terminal.buffer.active.type
    this.services.trace('protocol', { reason, flags: 0 })
  }

  private unbindElement(): void {
    this.element?.removeEventListener('paste', this.nativePaste, true)
    this.element?.removeEventListener('focusout', this.blur, true)
    this.element = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset('disposed')
    this.flush()
    this.unbindElement()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.subscriptions = []
  }
}
