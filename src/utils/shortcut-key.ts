/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const SPECIAL_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', Backquote: '`'
}

/** Shared physical identity for recording and window-level dispatch. */
export function shortcutKeyFromCode(code = ''): string | null {
  if (/^F\d{1,2}$/.test(code)) return code
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  return Object.hasOwn(SPECIAL_KEYS, code) ? SPECIAL_KEYS[code] : null
}

/** Preserve legacy dispatch for inputs the recorder does not recognize. */
export function windowShortcutKey(input: { code?: string; key: string }): string {
  return shortcutKeyFromCode(input.code) ?? (input.key.length === 1 ? input.key.toUpperCase() : input.key)
}
