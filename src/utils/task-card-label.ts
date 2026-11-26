/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Label model for one Task card in the Prompt sender's Task selector. The
 * bottom dock renders it on two lines: the slot position (the same number the
 * Task focus shortcut uses) and the Task's own name. A Task without a custom
 * name has `name === null`; the caller shows a localized placeholder.
 */
export interface TaskCardLabel {
  /** 1-based slot position. */
  position: number
  /** Trimmed custom name, or null when the Task has none. */
  name: string | null
  /** Full display title for tooltips and accessible names. */
  title: string
}

export function getTaskCardLabel(
  terminal: { title?: string | null; customName?: string | null },
  index: number
): TaskCardLabel {
  const position = Math.max(0, Math.floor(index)) + 1
  const name = terminal.customName?.trim() || null
  const title = terminal.title?.trim() || `Task ${position}`
  return { position, name, title }
}
