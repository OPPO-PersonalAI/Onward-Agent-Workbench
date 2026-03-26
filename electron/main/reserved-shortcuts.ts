/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type ReservedShortcutKey =
  | 'promptEditCancel'
  | 'promptEditSave'
  | 'promptEditSaveAsNew'

const RESERVED_SHORTCUTS: Record<ReservedShortcutKey, string[]> = {
  promptEditCancel: ['Escape'],
  promptEditSave: [
    'CommandOrControl+S',
    'Control+S',
    'Command+S'
  ],
  promptEditSaveAsNew: [
    'CommandOrControl+Shift+S',
    'Control+Shift+S',
    'Command+Shift+S'
  ]
}

function normalizeAccelerator(accelerator: string): string {
  if (!accelerator) return ''
  return accelerator
    .split('+')
    .map(part => (part === 'Ctrl' ? 'Control' : part))
    .join('+')
}

function findReservedShortcutKey(accelerator: string): ReservedShortcutKey | null {
  const normalized = normalizeAccelerator(accelerator)
  if (!normalized) return null

  for (const [key, accelerators] of Object.entries(RESERVED_SHORTCUTS)) {
    const matched = accelerators.some(value => normalizeAccelerator(value) === normalized)
    if (matched) return key as ReservedShortcutKey
  }

  return null
}

function isReservedShortcut(accelerator: string): boolean {
  return findReservedShortcutKey(accelerator) !== null
}

export {
  RESERVED_SHORTCUTS,
  normalizeAccelerator,
  findReservedShortcutKey,
  isReservedShortcut
}
