/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { AppState, TabState, GlobalPrompt, LocalPrompt, EditorDraft, ProjectEditorState, PromptCleanupConfig, PromptSchedule } from '../types/tab.d.ts'
import type { Prompt } from '../types/electron.d.ts'

/**
 * Draft saving anti-shake time (milliseconds)
 */
const DRAFT_SAVE_DEBOUNCE_MS = 300

/** Maximum number of tabs */
const MAX_TABS = 6

/** Automatic cleaning interval (24 hours) */
const AUTO_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

const DEFAULT_PROMPT_CLEANUP_CONFIG: PromptCleanupConfig = {
  autoEnabled: false,
  autoKeepDays: 30,
  autoDeleteColored: false,
  lastAutoCleanupAt: null
}
const DEFAULT_PROMPT_PANEL_WIDTH = 320
const DEFAULT_PROMPT_EDITOR_HEIGHT = 350
const MIN_PROMPT_EDITOR_HEIGHT = 100

/**
 * Generate unique ID
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
}

/**
 * Completion of Prompt's lastUsedAt
 */
function normalizePromptTimestamp<T extends Prompt>(prompt: T): T {
  const fallback = typeof prompt.updatedAt === 'number'
    ? prompt.updatedAt
    : (typeof prompt.createdAt === 'number' ? prompt.createdAt : Date.now())
  return {
    ...prompt,
    lastUsedAt: typeof prompt.lastUsedAt === 'number' ? prompt.lastUsedAt : fallback
  } as T
}

/**
 * Normalized Prompt cleanup configuration
 */
function normalizePromptCleanup(config?: Partial<PromptCleanupConfig> | null): PromptCleanupConfig {
  if (!config) return { ...DEFAULT_PROMPT_CLEANUP_CONFIG }
  const autoKeepDays = typeof config.autoKeepDays === 'number' && config.autoKeepDays > 0
    ? Math.floor(config.autoKeepDays)
    : DEFAULT_PROMPT_CLEANUP_CONFIG.autoKeepDays
  return {
    autoEnabled: !!config.autoEnabled,
    autoKeepDays,
    autoDeleteColored: !!config.autoDeleteColored,
    lastAutoCleanupAt: typeof config.lastAutoCleanupAt === 'number' ? config.lastAutoCleanupAt : null
  }
}

/**
 * Get Tab display name
 * @param tab Tab state
 * @param index Tab index in the array (0-based)
 * @returns Formatted display name, such as "Tab 1" or "Tab 1: Feature Development"
 */
function getTabDisplayName(tab: TabState, index: number): string {
  const position = index + 1
  if (tab.customName) {
    return `Tab ${position}: ${tab.customName}`
  }
  return `Tab ${position}`
}

/**
 * Get terminal display name
 * @param index The index of the terminal in the current Tab (0-based)
 * @param customName User-defined name
 * @returns Formatted display name, such as "Task 1" or "Task 1: Development Task"
 */
function getTerminalDisplayName(index: number, customName: string | null): string {
  const position = index + 1
  if (customName) {
    return `Task ${position}: ${customName}`
  }
  return `Task ${position}`
}

type ProjectEditorScope = {
  terminalId: string | null
  cwd: string | null
}

function normalizeProjectCwd(path: string): string {
  return path.replace(/\\/g, '/')
}

function normalizeProjectEditorQuickFiles(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const results: string[] = []
  const dedupe = new Set<string>()
  for (const item of paths) {
    if (typeof item !== 'string') continue
    const normalized = normalizeProjectCwd(item.trim())
    if (!normalized || dedupe.has(normalized)) continue
    dedupe.add(normalized)
    results.push(normalized)
  }
  return results
}

function normalizeProjectEditorState(state: ProjectEditorState): ProjectEditorState {
  return {
    ...state,
    expandedDirs: Array.isArray(state.expandedDirs) ? state.expandedDirs : [],
    pinnedFiles: normalizeProjectEditorQuickFiles(state.pinnedFiles),
    recentFiles: normalizeProjectEditorQuickFiles(state.recentFiles),
    savedAt: typeof state.savedAt === 'number' ? state.savedAt : Date.now()
  }
}

function isStringArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function buildProjectEditorStateKey(scope: ProjectEditorScope): string | null {
  const terminalId = typeof scope.terminalId === 'string' ? scope.terminalId.trim() : ''
  const cwd = typeof scope.cwd === 'string' ? scope.cwd.trim() : ''
  if (!terminalId || !cwd) return null
  return JSON.stringify([terminalId, normalizeProjectCwd(cwd)])
}

function isProjectEditorStateEqual(
  prev: ProjectEditorState | null | undefined,
  next: ProjectEditorState | null | undefined
): boolean {
  if (!prev && !next) return true
  if (!prev || !next) return false
  if (prev.rootPath !== next.rootPath) return false
  if (prev.activeFilePath !== next.activeFilePath) return false
  const prevDirs = prev.expandedDirs ?? []
  const nextDirs = next.expandedDirs ?? []
  if (!isStringArrayEqual(prevDirs, nextDirs)) return false
  const prevPinned = prev.pinnedFiles ?? []
  const nextPinned = next.pinnedFiles ?? []
  if (!isStringArrayEqual(prevPinned, nextPinned)) return false
  const prevRecent = prev.recentFiles ?? []
  const nextRecent = next.recentFiles ?? []
  if (!isStringArrayEqual(prevRecent, nextRecent)) return false
  const prevView = prev.editorViewState ?? null
  const nextView = next.editorViewState ?? null
  if (prevView !== nextView) return false
  if (prev.cursorLine !== next.cursorLine) return false
  if (prev.cursorColumn !== next.cursorColumn) return false
  if (prev.savedAt !== next.savedAt) return false
  return true
}

const DEBUG_APP_STATE = Boolean(window.electronAPI?.debug?.enabled)

function normalizePromptEditorHeight(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PROMPT_EDITOR_HEIGHT
  }
  return Math.max(Math.round(value), MIN_PROMPT_EDITOR_HEIGHT)
}

function normalizePersistedTerminalCwd(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
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
    promptCleanup: { ...DEFAULT_PROMPT_CLEANUP_CONFIG },
    lastFocusedTerminalId: null,
    projectEditorStates: {},
    promptSchedules: [],
    updatedAt: Date.now()
  }
}

interface AppStateContextValue {
  // state
  state: AppState
  isLoaded: boolean
  activeTab: TabState | null

  // Tab operation
  createTab: () => boolean
  closeTab: (tabId: string) => boolean
  switchTab: (tabId: string) => void
  renameTab: (tabId: string, customName: string | null) => void
  updateActiveTab: (updates: Partial<TabState>) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
  canCreateTab: () => boolean
  getTabDisplayName: (tab: TabState, index: number) => string
  getTerminalDisplayName: (index: number, customName: string | null) => string

  // Prompt operation
  addPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => void
  updatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  deletePrompt: (promptId: string) => void
  pinPrompt: (promptId: string) => void
  unpinPrompt: (promptId: string) => void
  reorderPinnedPrompts: (dragId: string, targetId: string, position: 'before' | 'after') => void
  touchPromptLastUsed: (promptId: string) => void
  cleanupPrompts: (options: { keepDays: number; deleteColored: boolean }) => void
  updatePromptCleanup: (partial: Partial<PromptCleanupConfig>) => void
  importPrompts: (globalPrompts: Prompt[], localPrompts: Prompt[]) => void

  // Merge all prompts (for display)
  getAllPrompts: () => Prompt[]

  // Get whether Tab has a running terminal
  hasRunningTerminals: (tabId: string) => boolean

  // Tab-level operations (not limited to activeTab)
  updateTabById: (tabId: string, updates: Partial<TabState>) => void
  updateEditorDraftForTab: (tabId: string, draft: EditorDraft | null) => void
  updatePromptEditorHeightForTab: (tabId: string, height: number) => void
  setTerminalLastCwd: (terminalId: string, cwd: string | null) => void

  // Draft operations
  updateEditorDraft: (draft: EditorDraft | null) => void
  getEditorDraft: () => EditorDraft | null

  // Terminal focus management
  setLastFocusedTerminalId: (terminalId: string | null) => void
  getLastFocusedTerminalId: () => string | null

  // Focus ownership (non-persistent)
  setLastFocusOwner: (owner: 'terminal' | 'input') => void
  getLastFocusOwner: () => 'terminal' | 'input'

  // Project editor state
  getProjectEditorState: (scope: ProjectEditorScope) => ProjectEditorState | null
  setProjectEditorState: (scope: ProjectEditorScope, state: ProjectEditorState | null) => void

  // Scheduled task operations
  addSchedule: (schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => void
  updateSchedule: (schedule: PromptSchedule) => void
  deleteSchedule: (promptId: string) => void
}

const AppStateContext = createContext<AppStateContextValue | null>(null)

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(createDefaultAppState())
  const [isLoaded, setIsLoaded] = useState(false)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const draftSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const draftSaveTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  const promptEditorHeightTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  const lastFocusOwnerRef = useRef<'terminal' | 'input'>('terminal')
  const perfCountersRef = useRef({
    updateCalls: 0,
    createTab: 0,
    closeTab: 0,
    switchTab: 0,
    renameTab: 0,
    reorderTabs: 0,
    updateActiveTab: 0,
    addPrompt: 0,
    updatePrompt: 0,
    deletePrompt: 0,
    pinPrompt: 0,
    unpinPrompt: 0,
    reorderPinnedPrompts: 0,
    updateEditorDraft: 0,
    updatePromptEditorHeight: 0,
    setTerminalLastCwd: 0,
    setLastFocusedTerminalId: 0,
    setProjectEditorState: 0
  })
  const perfIntervalRef = useRef<number | null>(null)

  // Loading state
  useEffect(() => {
    const load = async () => {
      try {
        const loadedState = await window.electronAPI.appState.load()
        const normalizedState: AppState = {
          ...loadedState,
          globalPrompts: (loadedState.globalPrompts || []).map(prompt => normalizePromptTimestamp(prompt)),
          promptCleanup: normalizePromptCleanup(loadedState.promptCleanup),
          tabs: loadedState.tabs.map(tab => ({
            ...tab,
            promptPanelWidth: Math.max(tab.promptPanelWidth || 0, DEFAULT_PROMPT_PANEL_WIDTH),
            promptEditorHeight: normalizePromptEditorHeight(
              tab.promptEditorHeight ?? tab.editorDraft?.height ?? DEFAULT_PROMPT_EDITOR_HEIGHT
            ),
            terminals: (tab.terminals ?? []).map((terminal) => ({
              ...terminal,
              customName: terminal.customName ?? null,
              lastCwd: normalizePersistedTerminalCwd(terminal.lastCwd)
            })),
            localPrompts: (tab.localPrompts || []).map(prompt => normalizePromptTimestamp(prompt))
          })),
          projectEditorStates: Object.fromEntries(
            Object.entries(loadedState.projectEditorStates ?? {}).map(([key, value]) => [key, normalizeProjectEditorState(value)])
          ),
          promptSchedules: Array.isArray(loadedState.promptSchedules) ? loadedState.promptSchedules : []
        }
        setState(normalizedState)
        const shouldSave = normalizedState.tabs.some((tab, index) => {
          const original = loadedState.tabs[index]
          return !original
            || tab.promptPanelWidth !== original.promptPanelWidth
            || tab.promptEditorHeight !== original.promptEditorHeight
            || tab.terminals.some((terminal, terminalIndex) => terminal.lastCwd !== original.terminals?.[terminalIndex]?.lastCwd)
        })
        if (shouldSave) {
          await window.electronAPI.appState.save(normalizedState)
        }
      } catch (error) {
        console.error('Failed to load app state:', error)
      } finally {
        setIsLoaded(true)
      }
    }
    load()
  }, [])

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current)
      }
      draftSaveTimersRef.current.forEach((timer) => clearTimeout(timer))
      draftSaveTimersRef.current.clear()
      promptEditorHeightTimersRef.current.forEach((timer) => clearTimeout(timer))
      promptEditorHeightTimersRef.current.clear()
    }
  }, [])

  // Debounced state save
  const saveState = useCallback((newState: AppState) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = setTimeout(() => {
      window.electronAPI.appState.save(newState)
    }, 500)
  }, [])

  // Update state and save
  const updateState = useCallback((updater: (prev: AppState) => AppState) => {
    setState(prev => {
      if (DEBUG_APP_STATE) {
        perfCountersRef.current.updateCalls += 1
      }
      const newState = {
        ...updater(prev),
        updatedAt: Date.now()
      }
      saveState(newState)
      return newState
    })
  }, [saveState])

  useEffect(() => {
    if (!DEBUG_APP_STATE) return
    if (perfIntervalRef.current) return
    perfIntervalRef.current = window.setInterval(() => {
      const snapshot = { ...perfCountersRef.current }
      Object.keys(perfCountersRef.current).forEach((key) => {
        // @ts-expect-error - reset numeric counters
        perfCountersRef.current[key] = 0
      })
      const hasActivity = Object.values(snapshot).some((count) => typeof count === 'number' && count > 0)
      if (hasActivity) {
        console.log('[AppState] perf:1s', snapshot)
        try {
          window.electronAPI.debug.log('appstate:perf:1s', snapshot)
        } catch {
          // ignore
        }
      }
    }, 1000)
    return () => {
      if (perfIntervalRef.current) {
        window.clearInterval(perfIntervalRef.current)
        perfIntervalRef.current = null
      }
    }
  }, [])

  // Get the currently active Tab
  const activeTab = state.tabs.find(t => t.id === state.activeTabId) || null

  // Check if new Tab can be created
  const canCreateTab = useCallback((): boolean => {
    return state.tabs.length < MAX_TABS
  }, [state.tabs.length])

  // Tab operation
  const createTab = useCallback((): boolean => {
    if (!canCreateTab()) {
      return false
    }
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.createTab += 1
    }
    updateState(prev => {
      if (prev.tabs.length >= MAX_TABS) {
        return prev
      }
      const newTabId = generateId()
      const newTab = createDefaultTabState(newTabId)
      return {
        ...prev,
        activeTabId: newTabId,
        tabs: [...prev.tabs, newTab]
      }
    })
    return true
  }, [updateState, canCreateTab])

  const closeTab = useCallback((tabId: string): boolean => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.closeTab += 1
    }
    let canClose = true
    setState(prev => {
      // Can't close last Tab
      if (prev.tabs.length <= 1) {
        canClose = false
        return prev
      }

      const tabIndex = prev.tabs.findIndex(t => t.id === tabId)
      if (tabIndex === -1) {
        canClose = false
        return prev
      }

      const newTabs = prev.tabs.filter(t => t.id !== tabId)
      let newActiveTabId = prev.activeTabId

      // If the current Tab is closed, switch to the adjacent Tab
      if (prev.activeTabId === tabId) {
        const newIndex = Math.min(tabIndex, newTabs.length - 1)
        newActiveTabId = newTabs[newIndex].id
      }

      // Mark the active scheduled task belonging to this Tab as failed
      const newSchedules = prev.promptSchedules.map(s =>
        s.tabId === tabId && s.status === 'active'
          ? { ...s, status: 'failed' as const, lastError: 'The owning Tab was closed.' }
          : s
      )

      const newState = {
        ...prev,
        activeTabId: newActiveTabId,
        tabs: newTabs,
        promptSchedules: newSchedules,
        updatedAt: Date.now()
      }
      saveState(newState)
      return newState
    })
    return canClose
  }, [saveState])

  const switchTab = useCallback((tabId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.switchTab += 1
    }
    updateState(prev => {
      if (!prev.tabs.find(t => t.id === tabId)) return prev
      return {
        ...prev,
        activeTabId: tabId
      }
    })
  }, [updateState])

  const renameTab = useCallback((tabId: string, customName: string | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.renameTab += 1
    }
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === tabId
          ? { ...tab, customName: customName?.trim() || null }
          : tab
      )
    }))
  }, [updateState])

  // Reorder Tabs
  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.reorderTabs += 1
    }
    updateState(prev => {
      const newTabs = [...prev.tabs]
      const [movedTab] = newTabs.splice(fromIndex, 1)
      newTabs.splice(toIndex, 0, movedTab)
      return {
        ...prev,
        tabs: newTabs
      }
    })
  }, [updateState])

  const updateActiveTab = useCallback((updates: Partial<TabState>) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updateActiveTab += 1
    }
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === prev.activeTabId ? { ...tab, ...updates } : tab
      )
    }))
  }, [updateState])

  // Update any Tab by ID (not limited to activeTab)
  const updateTabById = useCallback((tabId: string, updates: Partial<TabState>) => {
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      )
    }))
  }, [updateState])

  // Prompt operation
  const addPrompt = useCallback((promptData: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.addPrompt += 1
    }
    const now = Date.now()
    const newPrompt: LocalPrompt = {
      ...promptData,
      id: generateId(),
      pinned: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }

    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === prev.activeTabId
          ? { ...tab, localPrompts: [newPrompt, ...tab.localPrompts] }
          : tab
      )
    }))
  }, [updateState])

  const updatePrompt = useCallback((prompt: Prompt, preserveTimestamp?: boolean) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updatePrompt += 1
    }
    updateState(prev => {
      const now = Date.now()
      // Keep updatedAt when preserveTimestamp is used, and do not force update of lastUsedAt
      const updatedPromptData = preserveTimestamp
        ? {
          ...prompt,
          lastUsedAt: typeof prompt.lastUsedAt === 'number' ? prompt.lastUsedAt : now
        }
        : { ...prompt, updatedAt: now, lastUsedAt: now }

      // Check if it is a global prompt
      const globalIndex = prev.globalPrompts.findIndex(p => p.id === prompt.id)
      if (globalIndex >= 0) {
        return {
          ...prev,
          globalPrompts: prev.globalPrompts.map(p =>
            p.id === prompt.id ? { ...updatedPromptData, pinned: true } as GlobalPrompt : p
          )
        }
      }

      // Check if it is the local prompt of the current Tab
      return {
        ...prev,
        tabs: prev.tabs.map(tab => {
          if (tab.id !== prev.activeTabId) return tab
          return {
            ...tab,
            localPrompts: tab.localPrompts.map(p =>
              p.id === prompt.id ? { ...updatedPromptData, pinned: false } as LocalPrompt : p
            )
          }
        })
      }
    })
  }, [updateState])

  const deletePrompt = useCallback((promptId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.deletePrompt += 1
    }
    updateState(prev => {
      // Linked deletion of associated scheduled tasks
      const newSchedules = prev.promptSchedules.filter(s => s.promptId !== promptId)

      // Check if it is a global prompt
      const globalIndex = prev.globalPrompts.findIndex(p => p.id === promptId)
      if (globalIndex >= 0) {
        return {
          ...prev,
          globalPrompts: prev.globalPrompts.filter(p => p.id !== promptId),
          promptSchedules: newSchedules
        }
      }

      // Remove from current Tab
      return {
        ...prev,
        tabs: prev.tabs.map(tab => {
          if (tab.id !== prev.activeTabId) return tab
          return {
            ...tab,
            localPrompts: tab.localPrompts.filter(p => p.id !== promptId)
          }
        }),
        promptSchedules: newSchedules
      }
    })
  }, [updateState])

  const pinPrompt = useCallback((promptId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.pinPrompt += 1
    }
    updateState(prev => {
      // Find the prompt you want to pin in the current Tab
      const currentTab = prev.tabs.find(t => t.id === prev.activeTabId)
      if (!currentTab) return prev

      const promptToPin = currentTab.localPrompts.find(p => p.id === promptId)
      if (!promptToPin) return prev

      // Move to global
      const globalPrompt: GlobalPrompt = {
        ...promptToPin,
        pinned: true,
        updatedAt: Date.now(),
        lastUsedAt: typeof promptToPin.lastUsedAt === 'number' ? promptToPin.lastUsedAt : Date.now()
      }

      return {
        ...prev,
        globalPrompts: [globalPrompt, ...prev.globalPrompts],
        tabs: prev.tabs.map(tab =>
          tab.id === prev.activeTabId
            ? { ...tab, localPrompts: tab.localPrompts.filter(p => p.id !== promptId) }
            : tab
        )
      }
    })
  }, [updateState])

  const unpinPrompt = useCallback((promptId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.unpinPrompt += 1
    }
    updateState(prev => {
      const promptToUnpin = prev.globalPrompts.find(p => p.id === promptId)
      if (!promptToUnpin) return prev

      // Move local to current Tab
      const localPrompt: LocalPrompt = {
        ...promptToUnpin,
        pinned: false,
        updatedAt: Date.now(),
        lastUsedAt: typeof promptToUnpin.lastUsedAt === 'number' ? promptToUnpin.lastUsedAt : Date.now()
      }

      return {
        ...prev,
        globalPrompts: prev.globalPrompts.filter(p => p.id !== promptId),
        tabs: prev.tabs.map(tab =>
          tab.id === prev.activeTabId
            ? { ...tab, localPrompts: [localPrompt, ...tab.localPrompts] }
            : tab
        )
      }
    })
  }, [updateState])

  // Reorder pinned (global) Prompt
  const reorderPinnedPrompts = useCallback((dragId: string, targetId: string, position: 'before' | 'after') => {
    if (dragId === targetId) return
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.reorderPinnedPrompts += 1
    }
    updateState(prev => {
      const ids = prev.globalPrompts.map(p => p.id)
      const fromIndex = ids.indexOf(dragId)
      const targetIndex = ids.indexOf(targetId)
      if (fromIndex === -1 || targetIndex === -1) return prev

      ids.splice(fromIndex, 1)

      let insertIndex = targetIndex
      if (fromIndex < targetIndex) {
        insertIndex -= 1
      }
      if (position === 'after') {
        insertIndex += 1
      }

      insertIndex = Math.max(0, Math.min(insertIndex, ids.length))
      ids.splice(insertIndex, 0, dragId)

      const promptMap = new Map(prev.globalPrompts.map(p => [p.id, p]))
      const reordered = ids.map(id => promptMap.get(id)).filter(Boolean) as GlobalPrompt[]

      return {
        ...prev,
        globalPrompts: reordered
      }
    })
  }, [updateState])

  // Update Prompt's lastUsedAt
  const touchPromptLastUsed = useCallback((promptId: string) => {
    const now = Date.now()
    updateState(prev => ({
      ...prev,
      globalPrompts: prev.globalPrompts.map(p =>
        p.id === promptId ? { ...p, lastUsedAt: now } as GlobalPrompt : p
      ),
      tabs: prev.tabs.map(tab => ({
        ...tab,
        localPrompts: tab.localPrompts.map(p =>
          p.id === promptId ? { ...p, lastUsedAt: now } as LocalPrompt : p
        )
      }))
    }))
  }, [updateState])

  // Clean history Prompt (by lastUsedAt)
  const cleanupPrompts = useCallback((options: { keepDays: number; deleteColored: boolean }) => {
    const now = Date.now()
    const cutoff = now - options.keepDays * 24 * 60 * 60 * 1000
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab => ({
        ...tab,
        localPrompts: tab.localPrompts.filter(prompt => {
          if (prompt.pinned) return true
          const isColored = prompt.color === 'red' || prompt.color === 'yellow' || prompt.color === 'green'
          const shouldDelete = prompt.lastUsedAt < cutoff && (options.deleteColored || !isColored)
          return !shouldDelete
        })
      }))
    }))
  }, [updateState])

  // Update Prompt cleanup configuration
  const updatePromptCleanup = useCallback((partial: Partial<PromptCleanupConfig>) => {
    updateState(prev => ({
      ...prev,
      promptCleanup: normalizePromptCleanup({ ...prev.promptCleanup, ...partial })
    }))
  }, [updateState])

  const importPrompts = useCallback((globalPrompts: Prompt[], localPrompts: Prompt[]) => {
    if (globalPrompts.length === 0 && localPrompts.length === 0) return
    updateState(prev => ({
      ...prev,
      globalPrompts: [
        ...globalPrompts.map(prompt => normalizePromptTimestamp({ ...prompt, pinned: true } as Prompt) as GlobalPrompt),
        ...prev.globalPrompts
      ],
      tabs: prev.tabs.map((tab) => {
        if (tab.id !== prev.activeTabId) return tab
        return {
          ...tab,
          localPrompts: [
            ...localPrompts.map(prompt => normalizePromptTimestamp({ ...prompt, pinned: false } as Prompt) as LocalPrompt),
            ...tab.localPrompts
          ]
        }
      })
    }))
  }, [updateState])

  // Get all Prompts (global + local to current Tab)
  const getAllPrompts = useCallback((): Prompt[] => {
    const currentTab = state.tabs.find(t => t.id === state.activeTabId)
    if (!currentTab) return [...state.globalPrompts]

    // Global Prompt comes first, local Prompt comes last
    return [...state.globalPrompts, ...currentTab.localPrompts]
  }, [state])

  // Automatic cleanup schedule
  const runAutoCleanup = useCallback(() => {
    cleanupPrompts({
      keepDays: state.promptCleanup.autoKeepDays,
      deleteColored: state.promptCleanup.autoDeleteColored
    })
    updatePromptCleanup({ lastAutoCleanupAt: Date.now() })
  }, [cleanupPrompts, state.promptCleanup.autoDeleteColored, state.promptCleanup.autoKeepDays, updatePromptCleanup])

  useEffect(() => {
    if (!state.promptCleanup.autoEnabled) return

    const now = Date.now()
    const lastRun = state.promptCleanup.lastAutoCleanupAt ?? 0
    if (now - lastRun >= AUTO_CLEANUP_INTERVAL_MS) {
      runAutoCleanup()
      return
    }

    const delay = AUTO_CLEANUP_INTERVAL_MS - (now - lastRun)
    const timerId = window.setTimeout(() => {
      runAutoCleanup()
    }, delay)

    return () => window.clearTimeout(timerId)
  }, [state.promptCleanup.autoEnabled, state.promptCleanup.lastAutoCleanupAt, runAutoCleanup])

  // Check if Tab has a running terminal
  const hasRunningTerminals = useCallback((tabId: string): boolean => {
    const tab = state.tabs.find(t => t.id === tabId)
    return tab ? tab.terminals.length > 0 : false
  }, [state])

  // Update editor draft (independent 300ms anti-shake)
  const updateEditorDraft = useCallback((draft: EditorDraft | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updateEditorDraft += 1
    }
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current)
    }
    draftSaveTimeoutRef.current = setTimeout(() => {
      setState(prev => {
        const newState = {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === prev.activeTabId
              ? { ...tab, editorDraft: draft ?? undefined }
              : tab
          ),
          updatedAt: Date.now()
        }
        // Save directly without ordinary anti-shake
        window.electronAPI.appState.save(newState)
        return newState
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }, [])

  // Tab-level draft anti-shake saving (independent timer for each Tab)
  const updateEditorDraftForTab = useCallback((tabId: string, draft: EditorDraft | null) => {
    const existingTimer = draftSaveTimersRef.current.get(tabId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      draftSaveTimersRef.current.delete(tabId)
      setState(prev => {
        const newState = {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === tabId
              ? { ...tab, editorDraft: draft ?? undefined }
              : tab
          ),
          updatedAt: Date.now()
        }
        window.electronAPI.appState.save(newState)
        return newState
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)
    draftSaveTimersRef.current.set(tabId, timer)
  }, [])

  const updatePromptEditorHeightForTab = useCallback((tabId: string, height: number) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updatePromptEditorHeight += 1
    }
    const normalizedHeight = normalizePromptEditorHeight(height)
    const existingTimer = promptEditorHeightTimersRef.current.get(tabId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      promptEditorHeightTimersRef.current.delete(tabId)
      setState(prev => {
        const currentTab = prev.tabs.find(tab => tab.id === tabId)
        if (!currentTab || currentTab.promptEditorHeight === normalizedHeight) {
          return prev
        }
        const newState = {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === tabId
              ? { ...tab, promptEditorHeight: normalizedHeight }
              : tab
          ),
          updatedAt: Date.now()
        }
        window.electronAPI.appState.save(newState)
        return newState
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)
    promptEditorHeightTimersRef.current.set(tabId, timer)
  }, [])

  const setTerminalLastCwd = useCallback((terminalId: string, cwd: string | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.setTerminalLastCwd += 1
    }
    const normalizedCwd = normalizePersistedTerminalCwd(cwd)
    updateState(prev => {
      let changed = false
      const tabs = prev.tabs.map((tab) => {
        let tabChanged = false
        const terminals = tab.terminals.map((terminal) => {
          if (terminal.id !== terminalId) {
            return terminal
          }
          if (terminal.lastCwd === normalizedCwd) {
            return terminal
          }
          changed = true
          tabChanged = true
          return {
            ...terminal,
            lastCwd: normalizedCwd
          }
        })
        return tabChanged ? { ...tab, terminals } : tab
      })
      return changed ? { ...prev, tabs } : prev
    })
  }, [updateState])

  // Get the editor draft of the current Tab
  const getEditorDraft = useCallback((): EditorDraft | null => {
    const currentTab = state.tabs.find(t => t.id === state.activeTabId)
    return currentTab?.editorDraft ?? null
  }, [state])

  // Set the last focused terminal ID
  const setLastFocusedTerminalId = useCallback((terminalId: string | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.setLastFocusedTerminalId += 1
    }
    updateState(prev => ({
      ...prev,
      lastFocusedTerminalId: terminalId
    }))
  }, [updateState])

  // Get the last focused terminal ID
  const getLastFocusedTerminalId = useCallback((): string | null => {
    return state.lastFocusedTerminalId
  }, [state.lastFocusedTerminalId])

  // Set focus ownership (not persistent)
  const setLastFocusOwner = useCallback((owner: 'terminal' | 'input') => {
    lastFocusOwnerRef.current = owner
  }, [])

  // Get focus ownership (not persisted)
  const getLastFocusOwner = useCallback((): 'terminal' | 'input' => {
    return lastFocusOwnerRef.current
  }, [])

  const getProjectEditorState = useCallback((scope: ProjectEditorScope): ProjectEditorState | null => {
    const stateKey = buildProjectEditorStateKey(scope)
    if (!stateKey) return null
    return state.projectEditorStates?.[stateKey] ?? null
  }, [state.projectEditorStates])

  const setProjectEditorState = useCallback((scope: ProjectEditorScope, projectState: ProjectEditorState | null) => {
    const stateKey = buildProjectEditorStateKey(scope)
    if (!stateKey) return
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.setProjectEditorState += 1
    }
    const normalizedState = projectState ? normalizeProjectEditorState(projectState) : null
    updateState(prev => {
      const nextStates = { ...(prev.projectEditorStates ?? {}) }
      const previousState = nextStates[stateKey] ?? null
      if (normalizedState) {
        if (isProjectEditorStateEqual(previousState, normalizedState)) {
          return prev
        }
      } else if (!previousState) {
        return prev
      }
      if (normalizedState) {
        nextStates[stateKey] = normalizedState
      } else {
        delete nextStates[stateKey]
      }
      return {
        ...prev,
        projectEditorStates: nextStates
      }
    })
  }, [updateState])

  // Add a scheduled task
  const addSchedule = useCallback((schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => {
    updateState(prev => {
      // Each Prompt has at most one scheduled task
      const existing = prev.promptSchedules.find(s => s.promptId === schedule.promptId)
      const newSchedule: PromptSchedule = {
        ...schedule,
        executedCount: 0,
        createdAt: Date.now(),
        lastExecutedAt: null,
        missedExecutions: 0
      }
      if (existing) {
        return {
          ...prev,
          promptSchedules: prev.promptSchedules.map(s =>
            s.promptId === schedule.promptId ? newSchedule : s
          )
        }
      }
      return {
        ...prev,
        promptSchedules: [...prev.promptSchedules, newSchedule]
      }
    })
  }, [updateState])

  // Update scheduled tasks
  const updateSchedule = useCallback((schedule: PromptSchedule) => {
    updateState(prev => ({
      ...prev,
      promptSchedules: prev.promptSchedules.map(s =>
        s.promptId === schedule.promptId ? schedule : s
      )
    }))
  }, [updateState])

  // Delete scheduled tasks
  const deleteScheduleByPromptId = useCallback((promptId: string) => {
    updateState(prev => ({
      ...prev,
      promptSchedules: prev.promptSchedules.filter(s => s.promptId !== promptId)
    }))
  }, [updateState])

  const value: AppStateContextValue = useMemo(() => ({
    state,
    isLoaded,
    activeTab,
    createTab,
    closeTab,
    switchTab,
    renameTab,
    updateActiveTab,
    updateTabById,
    updateEditorDraftForTab,
    updatePromptEditorHeightForTab,
    setTerminalLastCwd,
    reorderTabs,
    canCreateTab,
    getTabDisplayName,
    getTerminalDisplayName,
    addPrompt,
    updatePrompt,
    deletePrompt,
    pinPrompt,
    unpinPrompt,
    reorderPinnedPrompts,
    touchPromptLastUsed,
    cleanupPrompts,
    updatePromptCleanup,
    importPrompts,
    getAllPrompts,
    hasRunningTerminals,
    updateEditorDraft,
    getEditorDraft,
    setLastFocusedTerminalId,
    getLastFocusedTerminalId,
    setLastFocusOwner,
    getLastFocusOwner,
    getProjectEditorState,
    setProjectEditorState,
    addSchedule,
    updateSchedule,
    deleteSchedule: deleteScheduleByPromptId
  }), [
    state, isLoaded, activeTab,
    createTab, closeTab, switchTab, renameTab,
    updateActiveTab, updateTabById, updateEditorDraftForTab, updatePromptEditorHeightForTab, setTerminalLastCwd,
    reorderTabs, canCreateTab,
    addPrompt, updatePrompt, deletePrompt,
    pinPrompt, unpinPrompt, reorderPinnedPrompts,
    touchPromptLastUsed, cleanupPrompts, updatePromptCleanup, importPrompts,
    getAllPrompts, hasRunningTerminals,
    updateEditorDraft, getEditorDraft,
    setLastFocusedTerminalId, getLastFocusedTerminalId,
    setLastFocusOwner, getLastFocusOwner,
    getProjectEditorState, setProjectEditorState,
    addSchedule, updateSchedule, deleteScheduleByPromptId
  ])

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  )
}

export function useAppState(): AppStateContextValue {
  const context = useContext(AppStateContext)
  if (!context) {
    throw new Error('useAppState must be used within an AppStateProvider')
  }
  return context
}
