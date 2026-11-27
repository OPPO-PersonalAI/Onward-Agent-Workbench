/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single space delimiter separating keys in user-facing shortcut displays
 * across macOS, Windows, and Linux (for example: "⌘ 1", "Ctrl F", "⌘ ⇧ S",
 * "Ctrl Shift S", "⌘ +", "Ctrl +").
 */
export const SHORTCUT_DISPLAY_SEPARATOR = ' '

/**
 * Split an Electron-style or canonical shortcut string into ordered key tokens
 * while preserving a literal "+" key (for example "CommandOrControl++", "+").
 */
export function splitAcceleratorTokens(accelerator: string): string[] {
  const trimmed = accelerator.trim()
  if (!trimmed) return []
  if (trimmed === '+') return ['+']

  const tokens: string[] = []
  let index = 0
  while (index < trimmed.length) {
    const plusIndex = trimmed.indexOf('+', index)
    if (plusIndex === -1) {
      const part = trimmed.slice(index).trim()
      if (part) tokens.push(part)
      break
    }
    const part = trimmed.slice(index, plusIndex).trim()
    if (part) tokens.push(part)

    // A trailing "+" immediately after a delimiter represents the literal "+" key
    // (for example "CommandOrControl++").
    if (plusIndex === trimmed.length - 1 && trimmed[plusIndex - 1] === '+') {
      tokens.push('+')
      break
    }
    index = plusIndex + 1
  }
  return tokens
}

/**
 * Map a modifier token to its platform-appropriate display label.
 * Returns null when the token is not a recognized modifier.
 */
export function formatShortcutModifierToken(token: string, platform: string = 'darwin'): string | null {
  const isMac = platform === 'darwin'
  switch (token) {
    case 'CommandOrControl':
    case 'CmdOrCtrl':
      return isMac ? '\u2318' : 'Ctrl'
    case 'Command':
    case 'Cmd':
      return isMac ? '\u2318' : platform === 'win32' ? 'Win' : 'Super'
    case 'Meta':
    case 'Super':
      return isMac ? '\u2318' : platform === 'win32' ? 'Win' : 'Super'
    case 'Control':
    case 'Ctrl':
      return 'Ctrl'
    case 'Alt':
    case 'Option':
      return isMac ? '\u2325' : 'Alt'
    case 'Shift':
      return isMac ? '\u21E7' : 'Shift'
    default:
      return null
  }
}

const ACCELERATOR_SPECIAL_KEY_LABELS: Record<string, string> = {
  Plus: '+',
  Space: '\u2423',
  Enter: '\u21B5',
  Return: '\u21B5',
  Tab: '\u21E5',
  Backspace: '\u232B',
  Delete: '\u2326',
  Escape: 'Esc',
  Esc: 'Esc',
  Up: '\u2191',
  Down: '\u2193',
  Left: '\u2190',
  Right: '\u2192'
}

/**
 * Format an Electron accelerator string for user-facing display, joining every
 * key token with a single space across all platforms.
 */
export function formatAcceleratorDisplay(
  accelerator: string | null | undefined,
  platform: string = 'darwin'
): string {
  if (!accelerator) return ''
  const tokens = splitAcceleratorTokens(accelerator)
  if (tokens.length === 0) return ''

  return tokens
    .map(token => formatShortcutModifierToken(token, platform) ?? ACCELERATOR_SPECIAL_KEY_LABELS[token] ?? token)
    .join(SHORTCUT_DISPLAY_SEPARATOR)
}
