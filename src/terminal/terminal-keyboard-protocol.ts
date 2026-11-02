/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type KeyboardBuffer = 'normal' | 'alternate'
export const KEYBOARD_SUPPORTED_FLAGS = 7
export const KEYBOARD_STACK_LIMIT = 16
export interface TerminalKey {
  key: string
  code: string
  type: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  location?: number
  getModifierState?: (key: string) => boolean
}

/** Independent bounded stacks; unsupported enhancements are never advertised. */
export class TerminalKeyboardProtocol {
  private stacks: Record<KeyboardBuffer, number[]> = { normal: [0], alternate: [0] }
  buffer: KeyboardBuffer = 'normal'
  get flags(): number { return this.stacks[this.buffer].at(-1)! }
  get depth(): number { return this.stacks[this.buffer].length }
  reset(): void { this.stacks = { normal: [0], alternate: [0] }; this.buffer = 'normal' }
  command(prefix: string, params: (number | number[])[]): string | null {
    if (params.some(value => !Number.isInteger(value) || (value as number) < 0)) return null
    const values = params as number[]
    if (prefix === '?') return values.every(value => value === 0) ? `\x1b[?${this.flags}u` : null
    const stack = this.stacks[this.buffer]
    const flags = (values[0] ?? 0) & KEYBOARD_SUPPORTED_FLAGS
    if (prefix === '>' && values.length <= 1) {
      if (stack.length === KEYBOARD_STACK_LIMIT) stack.shift()
      stack.push(flags)
    } else if (prefix === '<' && values.length <= 1) {
      const count = values[0] || 1
      stack.splice(Math.max(0, stack.length - count))
      if (!stack.length) stack.push(0)
    } else if (prefix === '=' && values.length <= 2) {
      const mode = values[1] || 1
      if (mode === 1) stack[stack.length - 1] = flags
      else if (mode === 2) stack[stack.length - 1] |= flags
      else if (mode === 3) stack[stack.length - 1] &= ~flags
    }
    return null
  }
}

const CSI = '\x1b['
const FUNCTIONAL: Record<string, [number, string]> = {
  Escape: [27, 'u'], Enter: [13, 'u'], Tab: [9, 'u'], Backspace: [127, 'u'],
  Insert: [2, '~'], Delete: [3, '~'], PageUp: [5, '~'], PageDown: [6, '~'],
  ArrowUp: [1, 'A'], ArrowDown: [1, 'B'], ArrowRight: [1, 'C'], ArrowLeft: [1, 'D'],
  Home: [1, 'H'], End: [1, 'F'], F1: [1, 'P'], F2: [1, 'Q'], F3: [13, '~'], F4: [1, 'S'],
  F5: [15, '~'], F6: [17, '~'], F7: [18, '~'], F8: [19, '~'], F9: [20, '~'],
  F10: [21, '~'], F11: [23, '~'], F12: [24, '~'],
  CapsLock: [57358, 'u'], ScrollLock: [57359, 'u'], NumLock: [57360, 'u'],
  PrintScreen: [57361, 'u'], Pause: [57362, 'u'], ContextMenu: [57363, 'u']
}
const BASE: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: ' '
}
const UNSHIFTED: Record<string, string> = Object.fromEntries(
  Array.from('~!@#$%^&*()_+{}|:"<>?').map((value, index) => [value, '`1234567890-=[]\\;\',./'[index]])
)
const KEYPAD: Record<string, number> = {
  NumpadDecimal: 57409, NumpadDivide: 57410, NumpadMultiply: 57411, NumpadSubtract: 57412,
  NumpadAdd: 57413, NumpadEnter: 57414, NumpadEqual: 57415, NumpadComma: 57416
}
function baseKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return BASE[code]
}

/** Null leaves DOM text/IME and legacy encoding with xterm; empty suppresses release. */
export function encodeTerminalKey(event: TerminalKey, flags: number, platform: string, macOptionIsMeta = false, wasEncoded = false): string | null {
  if (!(flags & 3) || !['keydown', 'keyup'].includes(event.type)) return null
  if (event.isComposing || event.keyCode === 229 || ['Dead', 'Process', 'Unidentified', 'AltGraph'].includes(event.key)) return null
  if (event.getModifierState?.('AltGraph')) return null
  const functional = FUNCTIONAL[event.key]
  if (platform === 'darwin' && event.altKey && !macOptionIsMeta && !functional) return null
  // Native Command clipboard/menu actions retain their platform ownership.
  if (platform === 'darwin' && event.metaKey) return null
  const mods = (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0) | (event.metaKey ? 8 : 0)
  const disambiguate = Boolean(flags & 1)
  const release = event.type === 'keyup'
  const eventType = release ? 3 : event.repeat ? 2 : 1
  if (release && !(flags & 2)) return ''
  let number: number, suffix = 'u', alternate = ''
  const keypad = disambiguate && event.location === 3
    ? (/^Numpad[0-9]$/.test(event.code) ? 57399 + Number(event.code.slice(6)) : KEYPAD[event.code]) : undefined
  if (keypad !== undefined) number = keypad
  else if (functional) {
    // Recovery keys remain usable at a shell after an application crashes.
    if (['Enter', 'Tab', 'Backspace'].includes(event.key) && mods === 0 && !(release && wasEncoded)) return release ? '' : null
    if (!disambiguate && event.key === 'Escape' && mods === 0 && !release && !event.repeat) return '\x1b'
    ;[number, suffix] = functional
  } else {
    if (!(mods & 14) && !(release && wasEncoded)) return null
    if (Array.from(event.key).length !== 1) return null
    const base = baseKey(event.code)
    const key = platform === 'darwin' && event.altKey && macOptionIsMeta && base
      ? base : event.key.toLowerCase()
    const unshifted = (event.shiftKey || (release && wasEncoded)) && base && UNSHIFTED[key] === base ? base : key
    number = unshifted.codePointAt(0)!
    if (number < 32 || number === 127) return null
    // Event-type reporting alone preserves representable legacy presses, then
    // reports repeats/releases in CSI form. Ordinary text stays with xterm.
    if (!disambiguate && !release && !event.repeat && !(mods & 8) && !event.shiftKey) {
      const control = number >= 97 && number <= 122 ? number - 96
        : number >= 91 && number <= 95 ? number - 64 : number === 32 ? 0 : undefined
      if (event.ctrlKey && control !== undefined) return `${event.altKey ? '\x1b' : ''}${String.fromCharCode(control)}`
      if (!event.ctrlKey && event.altKey) return `\x1b${event.key}`
    }
    if (flags & 4) {
      const shifted = event.shiftKey && event.key.codePointAt(0) !== number ? event.key.codePointAt(0) : undefined
      const layout = base && base.codePointAt(0) !== number ? base.codePointAt(0) : undefined
      if (shifted !== undefined || layout !== undefined) alternate = `:${shifted ?? ''}${layout === undefined ? '' : `:${layout}`}`
    }
  }
  if (release && !(flags & 2)) return ''
  const locks = (event.getModifierState?.('CapsLock') ? 64 : 0) | (event.getModifierState?.('NumLock') ? 128 : 0)
  const modifier = mods + locks + 1
  const type = flags & 2 && eventType !== 1 ? `:${eventType}` : ''
  if (suffix !== 'u' && modifier === 1 && !type) return `${CSI}${suffix === '~' ? number : ''}${suffix}`
  return `${CSI}${number}${alternate}${modifier === 1 && !type ? '' : `;${modifier}${type}`}${suffix}`
}
