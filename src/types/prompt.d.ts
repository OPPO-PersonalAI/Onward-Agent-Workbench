/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt data structure
 */
export interface Prompt {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

/**
 * Prompt storage status
 */
export interface PromptStore {
  prompts: Prompt[]
  selectedId: string | null
}

/**
 * terminal layout mode
 * 1: Single window
 * 2: Dual window (horizontal)
 * 4: Four-square grid
 * 6: Six-square grid (3x2)
 */
export type LayoutMode = 1 | 2 | 4 | 6

/**
 * Terminal information
 */
export interface TerminalInfo {
  id: string
  /** Display name (formatted, such as "Task 1" or "Task 1: Development Task") */
  title: string
  /** Custom name (for editing) */
  customName: string | null
  /** Persisted working directory */
  lastCwd?: string | null
  isActive: boolean
}

/**
 * Terminal batch operation results
 */
export interface TerminalBatchResult {
  successIds: string[]
  failedIds: string[]
}

/**
 * Terminal shortcut actions
 */
export type TerminalShortcutAction = {
  terminalId: string
  action: 'gitDiff' | 'gitHistory' | 'changeWorkDir' | 'openWorkDir' | 'projectEditor'
  token: number
}

export type TerminalFocusRequest = {
  terminalId: string
  token: number
  reason: 'shortcut-activated' | 'shortcut-terminal' | 'window-focus'
}

/**
 * Prompt Storage API
 */
export interface PromptAPI {
  load: () => Promise<Prompt[]>
  save: (prompt: Prompt) => Promise<boolean>
  delete: (id: string) => Promise<boolean>
}
