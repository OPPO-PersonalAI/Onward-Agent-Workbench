/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Prompt } from './electron.d.ts'

/**
 * Timing type
 */
export type ScheduleType = 'absolute' | 'relative' | 'recurring'

/**
 * Period configuration
 */
export interface RecurrenceConfig {
  /** Starting timestamp (milliseconds) */
  startTime: number
  /** Interval in milliseconds (minimum 60000 = 1 minute) */
  intervalMs: number
}

/**
 * Scheduled task execution log entries
 */
export interface ExecutionLogEntry {
  /** Execution timestamp */
  timestamp: number
  /** Is it successful? */
  success: boolean
  /** Target terminal ID */
  targetTerminalIds: string[]
  /** Error message (on failure) */
  error?: string | null
}

/**
 * Prompt scheduled task
 */
export interface PromptSchedule {
  /** Associated Prompt ID */
  promptId: string
  /** Owning Tab ID */
  tabId: string
  /** Target endpoint ID list */
  targetTerminalIds: string[]
  /** Timing type */
  scheduleType: ScheduleType
  /** Absolute timestamp (absolute mode) */
  absoluteTime?: number
  /** Relative delay in milliseconds (relative mode) */
  relativeOffsetMs?: number
  /** Period configuration (recurring mode) */
  recurrence?: RecurrenceConfig
  /** Maximum number of executions, null=unlimited (only recurring is meaningful) */
  maxExecutions: number | null
  /** Executed times */
  executedCount: number
  /** Next execution timestamp */
  nextExecutionAt: number
  /** Create timestamp */
  createdAt: number
  /** Last execution timestamp */
  lastExecutedAt: number | null
  /** Schedule status */
  status: 'active' | 'paused' | 'completed' | 'failed'
  /** Latest error message */
  lastError?: string | null
  /** Missed executions */
  missedExecutions: number
  /** Execution history (last 50 entries) */
  executionLog?: ExecutionLogEntry[]
}

/**
 * Editor draft
 */
export interface EditorDraft {
  title: string
  content: string
  height: number
  savedAt: number
}

/**
 * Persisted terminal state
 */
export interface PersistedTerminalState {
  id: string
  customName: string | null
  lastCwd: string | null
}

/**
 * Per-file view state memory (persisted inside ProjectEditorState.fileStates)
 */
export interface FileViewMemory {
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  previewScrollAnchor?: { slug: string | null; ratio: number; headingOffsetY?: number; scrollTop?: number }
  outlineScrollTop?: number
  // Markdown-specific per-file view mode
  isPreviewOpen?: boolean
  isEditorVisible?: boolean
  outlineTarget?: 'editor' | 'preview'
}

/**
 * Project editor state (persistent by terminal + working directory)
 */
export interface ProjectEditorState {
  rootPath: string | null
  activeFilePath: string | null
  expandedDirs: string[]
  pinnedFiles?: string[]
  recentFiles?: string[]
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  savedAt: number
  // UI layout state (per-scope persistence)
  isPreviewOpen?: boolean
  isEditorVisible?: boolean
  isOutlineVisible?: boolean
  outlineTarget?: 'editor' | 'preview'
  fileTreeWidth?: number
  previewWidth?: number
  outlineWidth?: number
  modalWidth?: number
  modalHeight?: number
  // Scroll position memory
  previewScrollAnchor?: { slug: string | null; ratio: number; headingOffsetY?: number; scrollTop?: number }
  fileTreeScrollTop?: number
  outlineScrollTop?: number
  // Per-file state memory (keyed by normalized file path)
  fileStates?: Record<string, FileViewMemory>
}

/**
 * Prompt cleanup configuration
 */
export interface PromptCleanupConfig {
  /** Whether to enable automatic cleaning */
  autoEnabled: boolean
  /** Automatic cleaning retention days */
  autoKeepDays: number
  /** Whether to delete color annotations during automatic cleaning */
  autoDeleteColored: boolean
  /** Last automatic cleaning timestamp */
  lastAutoCleanupAt: number | null
}

/**
 * Local Prompt (independent for each Tab)
 */
export interface LocalPrompt extends Prompt {
  pinned: false
}

/**
 * Global Prompt (shared by all Tabs, pinned state)
 */
export interface GlobalPrompt extends Prompt {
  pinned: true
}

/**
 * Tab state
 */
export interface TabState {
  /** Tab unique identifier */
  id: string
  /** User-defined name part (without "Tab N:" prefix) */
  customName: string | null
  /** Create timestamp */
  createdAt: number
  /** layout mode */
  layoutMode: 1 | 2 | 4 | 6
  /** Currently active panel */
  activePanel: 'prompt' | null
  /** Prompt panel width */
  promptPanelWidth: number
  /** Prompt editor height */
  promptEditorHeight: number
  /** Current active terminal ID */
  activeTerminalId: string | null
  /** List of terminals for this Tab */
  terminals: PersistedTerminalState[]
  /** The local Prompt of this Tab (not pinned) */
  localPrompts: LocalPrompt[]
  /** Editor draft (auto-save) */
  editorDraft?: EditorDraft
}

/**
 * Application state
 */
export interface AppState {
  /** Currently active Tab ID */
  activeTabId: string
  /** All tab lists */
  tabs: TabState[]
  /** Global Prompt (pinned, shared by all Tabs) */
  globalPrompts: GlobalPrompt[]
  /** Prompt cleanup configuration */
  promptCleanup: PromptCleanupConfig
  /** Last focused terminal ID (used to restore focus on wakeup) */
  lastFocusedTerminalId: string | null
  /** Project editor state (stored by terminal + working directory) */
  projectEditorStates: Record<string, ProjectEditorState>
  /** Prompt scheduled task list */
  promptSchedules: PromptSchedule[]
  /** Last updated timestamp */
  updatedAt: number
}

/**
 * Get Tab display name
 * @param tab Tab state
 * @param index Tab index in the array (0-based)
 * @returns Formatted display name, such as "Tab 1" or "Tab 1: Feature Development"
 */
export function getTabDisplayName(tab: TabState, index: number): string

/**
 * Get terminal display name
 * @param index The index of the terminal in the current Tab (0-based)
 * @param customName User-defined name
 * @returns Formatted display name, such as "Task 1" or "Task 1: Development Task"
 */
export function getTerminalDisplayName(index: number, customName: string | null): string

/**
 * Create default tab state
 */
export function createDefaultTabState(id: string): TabState

/**
 * Create default app state
 */
export function createDefaultAppState(): AppState
