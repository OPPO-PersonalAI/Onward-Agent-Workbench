/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Convert KeyboardEvent to Electron accelerator format
 */
export function buildAccelerator(e: KeyboardEvent): string {
  const parts: string[] = []

  // modifier keys
  if (e.metaKey) parts.push('CommandOrControl')
  if (e.ctrlKey && !e.metaKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // primary key
  let key = e.key

  // Handle special keys
  const specialKeyMap: Record<string, string> = {
    ' ': 'Space',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'Escape': 'Escape',
    'Enter': 'Enter',
    'Backspace': 'Backspace',
    'Delete': 'Delete',
    'Tab': 'Tab'
  }

  if (specialKeyMap[key]) {
    key = specialKeyMap[key]
  } else if (key.length === 1) {
    // Convert single character key to uppercase
    key = key.toUpperCase()
  }

  // Ignore individual modifier keys
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    return ''
  }

  parts.push(key)
  return parts.join('+')
}
