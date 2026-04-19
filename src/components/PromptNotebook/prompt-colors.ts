/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type PromptColor = 'red' | 'yellow' | 'green'

export const PROMPT_COLORS: ReadonlyArray<{ key: PromptColor; hex: string }> = [
  { key: 'red', hex: '#e74c3c' },
  { key: 'yellow', hex: '#f1c40f' },
  { key: 'green', hex: '#27ae60' }
] as const
