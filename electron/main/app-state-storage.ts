/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'

/**
 * Prompt data structure
 */
interface Prompt {
  id: string
  title: string
  content: string
  pinned: boolean
  color?: 'red' | 'yellow' | 'green' | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

/**
 * Local Prompt (independent for each Tab)
 */
interface LocalPrompt extends Prompt {
  pinned: false
}

/**
 * Global Prompt (shared by all Tabs, pinned state)
 */
interface GlobalPrompt extends Prompt {
  pinned: true
}

/**
 * Editor draft
 */
interface EditorDraft {
  title: string
  content: string
  height: number
  savedAt: number
}

/**
 * Persisted terminal state
 */
interface PersistedTerminalState {
  id: string
  customName: string | null
  lastCwd: string | null
}

/**
 * Project editor state (persistent by terminal + working directory)
 */
interface ProjectEditorState {
  rootPath: string | null
  activeFilePath: string | null
  expandedDirs: string[]
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  savedAt: number
}

/**
 * Prompt cleanup configuration
 */
interface PromptCleanupConfig {
  autoEnabled: boolean
  autoKeepDays: number
  autoDeleteColored: boolean
  lastAutoCleanupAt: number | null
}

/**
 * Tab state
 */
interface TabState {
  id: string
  customName: string | null
  createdAt: number
  layoutMode: 1 | 2 | 4 | 6
  activePanel: 'prompt' | null
  promptPanelWidth: number
  promptEditorHeight: number
  activeTerminalId: string | null
  terminals: PersistedTerminalState[]
  localPrompts: LocalPrompt[]
  editorDraft?: EditorDraft
}

/**
 * Global UI preferences persisted across restarts and upgrades.
 */
interface UIPreferences {
  projectEditorFileTreeWidth?: number
  projectEditorModalSize?: { width: number; height: number }
  projectEditorMarkdownPreviewWidth?: number
  projectEditorMarkdownEditorVisible?: boolean
  projectEditorOutlineVisible?: boolean
  projectEditorOutlineWidth?: number
  projectEditorOutlineTarget?: 'editor' | 'preview'
  gitDiffFileListWidth?: number
  gitDiffModalSize?: { width: number; height: number }
  gitDiffSplitViewRatio?: number
  gitDiffImageDisplayMode?: string
  gitDiffImageCompareMode?: string
  gitHistoryFileListWidth?: number
  gitHistoryHideWhitespace?: boolean
  gitHistoryDiffStyle?: string
  gitHistorySummaryHeight?: number
  gitHistoryStates?: Record<string, unknown>
}

/**
 * Application state
 */
interface AppState {
  activeTabId: string
  tabs: TabState[]
  globalPrompts: GlobalPrompt[]
  promptCleanup: PromptCleanupConfig
  lastFocusedTerminalId: string | null
  projectEditorStates: Record<string, ProjectEditorState>
  promptSchedules: PromptSchedule[]
  uiPreferences: UIPreferences
  updatedAt: number
}

/**
 * Legacy terminal configuration (for migration)
 */
interface LegacyTerminalConfig {
  version: number
  layoutMode: 1 | 2 | 4 | 6
  activeTerminalId: string | null
  activePanel: 'prompt' | null
  terminals: { id: string; title: string }[]
  promptPanelWidth: number
  updatedAt: number
}

const DEFAULT_PROMPT_PANEL_WIDTH = 280
const DEFAULT_PROMPT_EDITOR_HEIGHT = 350
const MIN_PROMPT_PANEL_WIDTH = 150
const MIN_PROMPT_EDITOR_HEIGHT = 100

/**
 * Scheduled task execution log entries (main process side type)
 */
interface ExecutionLogEntry {
  timestamp: number
  success: boolean
  targetTerminalIds: string[]
  error?: string | null
}

/**
 * Prompt scheduled task (main process side type)
 */
interface PromptSchedule {
  promptId: string
  tabId: string
  targetTerminalIds: string[]
  scheduleType: 'absolute' | 'relative' | 'recurring'
  absoluteTime?: number
  relativeOffsetMs?: number
  recurrence?: {
    startTime: number
    intervalMs: number
  }
  maxExecutions: number | null
  executedCount: number
  nextExecutionAt: number
  createdAt: number
  lastExecutedAt: number | null
  status: 'active' | 'paused' | 'completed' | 'failed'
  lastError?: string | null
  missedExecutions: number
  executionLog?: ExecutionLogEntry[]
}


/**
 * Generate unique ID
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
}

/**
 * Normalize Prompt timestamps by filling in lastUsedAt
 */
function normalizePromptTimestamp<T extends Prompt>(prompt: T): T {
  const fallback = typeof prompt.updatedAt === 'number'
    ? prompt.updatedAt
    : (typeof prompt.createdAt === 'number' ? prompt.createdAt : Date.now())
  return {
    ...prompt,
    lastUsedAt: typeof prompt.lastUsedAt === 'number' ? prompt.lastUsedAt : fallback
  }
}

/**
 * Create default tab state
 */
function createDefaultTabState(id: string): TabState {
  return {
    id,
    customName: null,
    createdAt: Date.now(),
    layoutMode: 1,
    activePanel: null,
    promptPanelWidth: DEFAULT_PROMPT_PANEL_WIDTH,
    promptEditorHeight: DEFAULT_PROMPT_EDITOR_HEIGHT,
    activeTerminalId: null,
    terminals: [],
    localPrompts: []
  }
}

/**
 * Create default app state
 */
function createDefaultAppState(): AppState {
  const tabId = generateId()
  return {
    activeTabId: tabId,
    tabs: [createDefaultTabState(tabId)],
    globalPrompts: [],
    promptCleanup: {
      autoEnabled: false,
      autoKeepDays: 30,
      autoDeleteColored: false,
      lastAutoCleanupAt: null
    },
    lastFocusedTerminalId: null,
    projectEditorStates: {},
    promptSchedules: [],
    uiPreferences: {},
    updatedAt: Date.now()
  }
}

/**
 * Application state storage manager
 * Use JSON files stored in the userData directory
 */
class AppStateStorage {
  private storagePath: string
  private legacyConfigPath: string
  private legacyPromptsPath: string
  private state: AppState

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'app-state.json')
    this.legacyConfigPath = join(userDataPath, 'terminal-config.json')
    this.legacyPromptsPath = join(userDataPath, 'prompts.json')
    this.state = this.load()
  }

  /**
   * Load state data from file
   */
  private load(): AppState {
    try {
      // Load the new format first
      if (existsSync(this.storagePath)) {
        const data = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(data) as AppState
        return this.validateState(parsed)
      }

      // Try migrating from the old format
      return this.migrateFromLegacy()
    } catch (error) {
      console.error('Failed to load app state:', error)
      return createDefaultAppState()
    }
  }

  /**
   * Migrate data from old configuration files
   */
  private migrateFromLegacy(): AppState {
    console.log('Migrating from legacy config files...')

    let legacyConfig: LegacyTerminalConfig | null = null
    let legacyPrompts: Prompt[] = []

    // Read legacy terminal configuration
    try {
      if (existsSync(this.legacyConfigPath)) {
        const data = readFileSync(this.legacyConfigPath, 'utf-8')
        legacyConfig = JSON.parse(data) as LegacyTerminalConfig
      }
    } catch (error) {
      console.error('Failed to read legacy terminal config:', error)
    }

    // Read legacy Prompt data
    try {
      if (existsSync(this.legacyPromptsPath)) {
        const data = readFileSync(this.legacyPromptsPath, 'utf-8')
        legacyPrompts = JSON.parse(data) as Prompt[]
      }
    } catch (error) {
      console.error('Failed to read legacy prompts:', error)
    }

    // If there is no old data, return to the default state
    if (!legacyConfig && legacyPrompts.length === 0) {
      return createDefaultAppState()
    }

    // Separate pinned and non-pinned prompts
    const globalPrompts: GlobalPrompt[] = []
    const localPrompts: LocalPrompt[] = []

    legacyPrompts.forEach(prompt => {
      const normalized = normalizePromptTimestamp(prompt)
      if (prompt.pinned) {
        globalPrompts.push({ ...normalized, pinned: true } as GlobalPrompt)
      } else {
        localPrompts.push({ ...normalized, pinned: false } as LocalPrompt)
      }
    })

    // Create the first Tab
    const tabId = generateId()
    // Convert legacy terminals format (title → customName)
    const migratedTerminals: PersistedTerminalState[] =
      (legacyConfig?.terminals ?? []).map(t => ({
        id: t.id,
        // Extract custom name from title (or null if "Agent N" format)
        customName: /^Agent \d+$/.test(t.title) ? null : t.title,
        lastCwd: null
      }))

    const firstTab: TabState = {
      id: tabId,
      customName: null,
      createdAt: Date.now(),
      layoutMode: legacyConfig?.layoutMode ?? 1,
      activePanel: legacyConfig?.activePanel ?? null,
      promptPanelWidth: legacyConfig?.promptPanelWidth ?? DEFAULT_PROMPT_PANEL_WIDTH,
      promptEditorHeight: DEFAULT_PROMPT_EDITOR_HEIGHT,
      activeTerminalId: legacyConfig?.activeTerminalId ?? null,
      terminals: migratedTerminals,
      localPrompts
    }

    const newState: AppState = {
      activeTabId: tabId,
      tabs: [firstTab],
      globalPrompts,
      promptCleanup: {
        autoEnabled: false,
        autoKeepDays: 30,
        autoDeleteColored: false,
        lastAutoCleanupAt: null
      },
      lastFocusedTerminalId: null,
      projectEditorStates: {},
      promptSchedules: [],
      uiPreferences: {},
      updatedAt: Date.now()
    }

    // Save the new state
    this.state = newState
    this.persist()

    // Back up old files
    this.backupLegacyFiles()

    console.log('Migration completed successfully')
    return newState
  }

  /**
   * Back up old configuration files
   */
  private backupLegacyFiles(): void {
    try {
      if (existsSync(this.legacyConfigPath)) {
        renameSync(this.legacyConfigPath, this.legacyConfigPath + '.backup')
      }
      if (existsSync(this.legacyPromptsPath)) {
        renameSync(this.legacyPromptsPath, this.legacyPromptsPath + '.backup')
      }
    } catch (error) {
      console.error('Failed to backup legacy files:', error)
    }
  }

  /**
   * Validate state data to ensure all fields are present and valid
   */
  private validateState(state: Partial<AppState>): AppState {
    // Validate tabs
    let tabs: TabState[] = []
    if (Array.isArray(state.tabs) && state.tabs.length > 0) {
      tabs = state.tabs.map(tab => this.validateTab(tab))
    } else {
      const tabId = generateId()
      tabs = [createDefaultTabState(tabId)]
    }

    // Verify activeTabId
    let activeTabId = state.activeTabId
    if (!activeTabId || !tabs.find(t => t.id === activeTabId)) {
      activeTabId = tabs[0].id
    }

    // Verify globalPrompts
    const globalPrompts: GlobalPrompt[] = Array.isArray(state.globalPrompts)
      ? state.globalPrompts.map(p => ({ ...normalizePromptTimestamp(p), pinned: true } as GlobalPrompt))
      : []

    // Verify lastFocusedTerminalId
    const lastFocusedTerminalId = typeof state.lastFocusedTerminalId === 'string'
      ? state.lastFocusedTerminalId
      : null

    const projectEditorStates: Record<string, ProjectEditorState> = {}
    if (state.projectEditorStates && typeof state.projectEditorStates === 'object') {
      Object.entries(state.projectEditorStates as Record<string, ProjectEditorState>).forEach(([stateKey, value]) => {
        if (!stateKey) return
        const rootPath = typeof value?.rootPath === 'string' ? value.rootPath : null
        const activeFilePath = typeof value?.activeFilePath === 'string' ? value.activeFilePath : null
        const expandedDirs = Array.isArray(value?.expandedDirs)
          ? value.expandedDirs.filter((item): item is string => typeof item === 'string')
          : []
        const cursorLine = typeof value?.cursorLine === 'number' ? value.cursorLine : undefined
        const cursorColumn = typeof value?.cursorColumn === 'number' ? value.cursorColumn : undefined
        const savedAt = typeof value?.savedAt === 'number' ? value.savedAt : 0
        projectEditorStates[stateKey] = {
          rootPath,
          activeFilePath,
          expandedDirs,
          editorViewState: value?.editorViewState,
          cursorLine,
          cursorColumn,
          savedAt
        }
      })
    }

    const promptCleanup = this.validatePromptCleanup(state.promptCleanup)

    // Verify promptSchedules
    const promptSchedules = this.validatePromptSchedules(
      (state as AppState & { promptSchedules?: unknown }).promptSchedules
    )

    // Preserve uiPreferences as-is (all fields are optional)
    const uiPreferences: UIPreferences =
      state.uiPreferences && typeof state.uiPreferences === 'object'
        ? (state.uiPreferences as UIPreferences)
        : {}

    return {
      activeTabId,
      tabs,
      globalPrompts,
      promptCleanup,
      lastFocusedTerminalId,
      projectEditorStates,
      promptSchedules,
      uiPreferences,
      updatedAt: state.updatedAt ?? Date.now()
    }
  }

  /**
   * Legacy terminal data (for migration)
   */
  private migrateTerminalData(rawTerminals: unknown): PersistedTerminalState[] {
    if (!Array.isArray(rawTerminals)) return []

    return rawTerminals.map((t: { id?: string; title?: string; customName?: string | null; lastCwd?: string | null }) => {
      const id = t.id ?? ''
      const lastCwd = typeof t.lastCwd === 'string' && t.lastCwd.trim()
        ? t.lastCwd
        : null

      // If there is already a customName field, use it directly
      if ('customName' in t && t.customName !== undefined) {
        return { id, customName: t.customName, lastCwd }
      }

      // Extract custom name from old format title
      if (t.title) {
        // Check if it is in "Agent N: xxx" format
        const match = t.title.match(/^Agent \d+: (.+)$/)
        if (match) {
          return { id, customName: match[1], lastCwd }
        }
        // Check if it is in "Agent N" format (no custom name)
        if (/^Agent \d+$/.test(t.title)) {
          return { id, customName: null, lastCwd }
        }
        // Otherwise the entire title is a custom name
        return { id, customName: t.title, lastCwd }
      }

      return { id, customName: null, lastCwd }
    })
  }

  /**
   * Validate single tab data
   */
  private validateTab(tab: Partial<TabState> & { name?: string }): TabState {
    const validLayoutModes = [1, 2, 4, 6]
    const promptPanelWidth = typeof tab.promptPanelWidth === 'number' && tab.promptPanelWidth >= MIN_PROMPT_PANEL_WIDTH
      ? tab.promptPanelWidth
      : DEFAULT_PROMPT_PANEL_WIDTH

    // Handle migration from older versions: if there is a name field but no customName, try to extract the custom name
    let customName: string | null = null
    if (tab.customName !== undefined) {
      customName = tab.customName
    } else if (tab.name) {
      // Extract the custom part from the old format name (if any)
      const match = tab.name.match(/^Tab \d+: (.+)$/)
      if (match) {
        customName = match[1]
      } else if (!/^Tab \d+$/.test(tab.name)) {
        // If not in "Tab N" format, the entire name is a custom name
        customName = tab.name
      }
    }

    const editorDraft = this.validateEditorDraft(tab.editorDraft)

    const promptEditorHeight = typeof tab.promptEditorHeight === 'number' && tab.promptEditorHeight >= MIN_PROMPT_EDITOR_HEIGHT
      ? tab.promptEditorHeight
      : Math.max(editorDraft?.height ?? 0, DEFAULT_PROMPT_EDITOR_HEIGHT)

    // Migrate terminal data: convert title to customName
    const terminals = this.migrateTerminalData(tab.terminals)

    return {
      id: tab.id ?? generateId(),
      customName,
      createdAt: tab.createdAt ?? Date.now(),
      layoutMode: validLayoutModes.includes(tab.layoutMode as number)
        ? tab.layoutMode as 1 | 2 | 4 | 6
        : 1,
      activePanel: tab.activePanel === 'prompt' ? 'prompt' : null,
      promptPanelWidth,
      promptEditorHeight,
      activeTerminalId: tab.activeTerminalId ?? null,
      terminals,
      localPrompts: Array.isArray(tab.localPrompts)
        ? tab.localPrompts.map(p => ({ ...normalizePromptTimestamp(p), pinned: false } as LocalPrompt))
        : [],
      editorDraft
    }
  }

  /**
   * Validate editor draft data
   */
  private validateEditorDraft(draft: unknown): EditorDraft | undefined {
    if (!draft || typeof draft !== 'object') {
      return undefined
    }

    const d = draft as Partial<EditorDraft>

    // Validate required field types
    if (typeof d.title !== 'string' ||
        typeof d.content !== 'string' ||
        typeof d.height !== 'number' ||
        typeof d.savedAt !== 'number') {
      return undefined
    }

    // Don't save draft when empty content
    if (!d.title.trim() && !d.content.trim()) {
      return undefined
    }

    return {
      title: d.title,
      content: d.content,
      height: d.height,
      savedAt: d.savedAt
    }
  }

  /**
   * Validate Prompt cleanup configuration
   */
  private validatePromptCleanup(value: unknown): PromptCleanupConfig {
    const defaultConfig: PromptCleanupConfig = {
      autoEnabled: false,
      autoKeepDays: 30,
      autoDeleteColored: false,
      lastAutoCleanupAt: null
    }

    if (!value || typeof value !== 'object') {
      return defaultConfig
    }

    const v = value as Partial<PromptCleanupConfig>
    const autoKeepDays = typeof v.autoKeepDays === 'number' && v.autoKeepDays > 0
      ? Math.floor(v.autoKeepDays)
      : defaultConfig.autoKeepDays

    return {
      autoEnabled: !!v.autoEnabled,
      autoKeepDays,
      autoDeleteColored: !!v.autoDeleteColored,
      lastAutoCleanupAt: typeof v.lastAutoCleanupAt === 'number' ? v.lastAutoCleanupAt : null
    }
  }

  /**
   * Validate the Prompt schedule array
   */
  private validatePromptSchedules(value: unknown): PromptSchedule[] {
    if (!Array.isArray(value)) return []

    return value.filter((item: unknown): item is PromptSchedule => {
      if (!item || typeof item !== 'object') return false
      const s = item as Partial<PromptSchedule> & { recurrence?: Record<string, unknown> }
      if (typeof s.promptId !== 'string' || !s.promptId) return false
      if (typeof s.tabId !== 'string' || !s.tabId) return false
      if (!Array.isArray(s.targetTerminalIds) || s.targetTerminalIds.length === 0) return false
      if (!['absolute', 'relative', 'recurring'].includes(s.scheduleType as string)) return false
      if (!['active', 'paused', 'completed', 'failed'].includes(s.status as string)) return false
      if (typeof s.nextExecutionAt !== 'number') return false
      if (typeof s.createdAt !== 'number') return false
      if (typeof s.executedCount !== 'number') return false
      if (typeof s.missedExecutions !== 'number') return false
      // Verify and truncate executionLog
      if (s.executionLog !== undefined) {
        if (!Array.isArray(s.executionLog)) {
          (s as PromptSchedule).executionLog = []
        } else {
          // Keep the last 50 items
          (s as PromptSchedule).executionLog = s.executionLog
            .filter((entry: unknown) => {
              if (!entry || typeof entry !== 'object') return false
              const e = entry as Partial<ExecutionLogEntry>
              return typeof e.timestamp === 'number' && typeof e.success === 'boolean'
            })
            .slice(-50)
        }
      }
      return true
    })
  }

  /**
   * Save state data to file
   */
  private persist(): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save app state:', error)
    }
  }

  getTerminalLastCwd(terminalId: string): string | null {
    for (const tab of this.state.tabs) {
      const terminal = tab.terminals.find((item) => item.id === terminalId)
      if (terminal) {
        return terminal.lastCwd
      }
    }
    return null
  }

  setTerminalLastCwd(terminalId: string, cwd: string | null): boolean {
    return this.setTerminalLastCwds([{ terminalId, cwd }])
  }

  setTerminalLastCwds(updates: Array<{ terminalId: string; cwd: string | null }>): boolean {
    if (updates.length === 0) return false

    const normalizedUpdates = new Map<string, string | null>()
    updates.forEach(({ terminalId, cwd }) => {
      if (!terminalId) return
      const normalizedCwd = typeof cwd === 'string' && cwd.trim()
        ? cwd
        : null
      normalizedUpdates.set(terminalId, normalizedCwd)
    })

    if (normalizedUpdates.size === 0) return false

    let changed = false
    const nextTabs = this.state.tabs.map((tab) => {
      let tabChanged = false
      const terminals = tab.terminals.map((terminal) => {
        if (!normalizedUpdates.has(terminal.id)) {
          return terminal
        }
        const nextCwd = normalizedUpdates.get(terminal.id) ?? null
        if (terminal.lastCwd === nextCwd) {
          return terminal
        }
        changed = true
        tabChanged = true
        return {
          ...terminal,
          lastCwd: nextCwd
        }
      })
      return tabChanged ? { ...tab, terminals } : tab
    })

    if (!changed) return false

    this.state = {
      ...this.state,
      tabs: nextTabs,
      updatedAt: Date.now()
    }
    this.persist()
    return true
  }

  /**
   * Get current state
   */
  get(): AppState {
    return JSON.parse(JSON.stringify(this.state))
  }

  /**
   * Save complete state
   */
  save(state: AppState): boolean {
    try {
      this.state = {
        ...this.validateState(state),
        updatedAt: Date.now()
      }
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to save app state:', error)
      return false
    }
  }
}

// Singleton pattern
let instance: AppStateStorage | null = null

export function getAppStateStorage(): AppStateStorage {
  if (!instance) {
    instance = new AppStateStorage()
  }
  return instance
}

export type {
  AppState,
  TabState,
  LocalPrompt,
  GlobalPrompt
}

export {
  generateId,
  createDefaultTabState,
  createDefaultAppState
}
