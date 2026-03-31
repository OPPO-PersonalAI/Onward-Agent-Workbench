/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { AppStateProvider, useAppState } from './contexts/AppStateContext'
import { SettingsProvider, useSettings } from './contexts/SettingsContext'
import { PromptActionsProvider, usePromptActions } from './contexts/PromptActionsContext'
import { TabBar } from './components/TabBar'
import { Sidebar } from './components/Sidebar/Sidebar'
import { PromptNotebook } from './components/PromptNotebook/PromptNotebook'
import { TerminalGrid } from './components/TerminalGrid/TerminalGrid'
import { Settings } from './components/Settings'
import { ProjectEditor } from './components/ProjectEditor'
import { useScheduleEngine } from './hooks/useScheduleEngine'
import type { ScheduleNotification } from './hooks/useScheduleEngine'
import { LayoutMode, TerminalBatchResult, TerminalInfo, TerminalShortcutAction, TerminalFocusRequest } from './types/prompt'
import type { Prompt } from './types/electron.d.ts'
import type { TabState, EditorDraft, PromptCleanupConfig, PromptSchedule, ExecutionLogEntry } from './types/tab.d.ts'
import type { ShortcutAction } from './types/settings.d.ts'
import { requestOpenExternalHttpLink } from './utils/externalLink'
import { computeNextExecution } from './utils/schedule'
import {
  buildImportPlan,
  buildPromptExportPayload,
  formatExportFileName,
  parsePromptExportPayload,
  type PromptImportResult
} from './utils/prompt-io'
import { useI18n } from './i18n/useI18n'
import { terminalSessionManager } from './terminal/terminal-session-manager'
import { focusCoordinator, type TerminalFocusRestoreReason } from './terminal/focus-coordinator'
import { registerTerminalFocusDebugApi } from './terminal/focus-debug-api'
import './App.css'

const MAX_SCHEDULE_LOG_ENTRIES = 50
const DEBUG_TERMINAL_FOCUS = Boolean(window.electronAPI?.debug?.enabled)

function debugTerminalFocus(message: string, data?: unknown) {
  if (!DEBUG_TERMINAL_FOCUS) return
  console.log(`[TerminalFocus] ${message}`, data)
  try {
    window.electronAPI.debug.log(`[TerminalFocus] ${message}`, data)
  } catch {
    // ignore debug logging failures
  }
}

function appendScheduleLogEntry(schedule: PromptSchedule, entry: ExecutionLogEntry): ExecutionLogEntry[] {
  const log = [...(schedule.executionLog ?? []), entry]
  return log.slice(-MAX_SCHEDULE_LOG_ENTRIES)
}

async function resolveProjectEditorDebugCwd(
  terminalId: string,
  preferredCwd: string | null | undefined
): Promise<string | null> {
  if (typeof preferredCwd === 'string' && preferredCwd.trim()) {
    return preferredCwd
  }
  try {
    return await window.electronAPI.git.getTerminalCwd(terminalId)
  } catch {
    return null
  }
}

// Terminal grid component for a single Tab
const TabTerminalGrid = memo(function TabTerminalGrid({
  tab,
  isActive,
  onTerminalFocus,
  onTerminalRename,
  onOpenProjectEditor,
  focusRequest,
  shortcutAction,
  projectEditorOpen
}: {
  tab: TabState
  isActive: boolean
  onTerminalFocus: (tabId: string, terminalId: string) => void
  onTerminalRename: (tabId: string, terminalId: string, newTitle: string) => void
  onOpenProjectEditor: (terminalId: string) => void
  focusRequest: TerminalFocusRequest | null
  shortcutAction: TerminalShortcutAction | null
  projectEditorOpen: boolean
}) {
  const { getTerminalDisplayName } = useAppState()
  const terminals: TerminalInfo[] = useMemo(() => {
    return tab.terminals.map((t, index) => ({
      id: t.id,
      title: getTerminalDisplayName(index, t.customName),
      customName: t.customName,
      isActive: t.id === tab.activeTerminalId
    }))
  }, [tab.terminals, tab.activeTerminalId, getTerminalDisplayName])

  const handleTerminalFocus = useCallback((terminalId: string) => {
    onTerminalFocus(tab.id, terminalId)
  }, [tab.id, onTerminalFocus])

  const handleTerminalRename = useCallback((terminalId: string, newTitle: string) => {
    onTerminalRename(tab.id, terminalId, newTitle)
  }, [tab.id, onTerminalRename])

  const actionForTab = useMemo(() => {
    if (!shortcutAction) return null
    if (!tab.terminals.some(t => t.id === shortcutAction.terminalId)) return null
    return shortcutAction
  }, [shortcutAction, tab.terminals])

  const focusRequestForTab = useMemo(() => {
    if (!focusRequest) return null
    if (!tab.terminals.some(t => t.id === focusRequest.terminalId)) return null
    return focusRequest
  }, [focusRequest, tab.terminals])

  return (
    <TerminalGrid
      layoutMode={tab.layoutMode}
      terminals={terminals}
      activeTerminalId={tab.activeTerminalId}
      theme="vscode-dark"
      onTerminalFocus={handleTerminalFocus}
      onTerminalRename={handleTerminalRename}
      onOpenProjectEditor={onOpenProjectEditor}
      tabId={tab.id}
      hidden={!isActive}
      shortcutAction={actionForTab}
      focusRequest={focusRequestForTab}
      projectEditorOpen={projectEditorOpen}
    />
  )
})

// PromptNotebook component for a single Tab (imitation of TabTerminalGrid mode)
const TabPromptNotebook = memo(function TabPromptNotebook({
  tab,
  isActive,
  showSettings,
  onSend,
  onExecute,
  onSendAndExecute,
  onChangeWorkDir,
  addPrompt: onAddPrompt,
  updatePrompt: onUpdatePrompt,
  deletePrompt: onDeletePrompt,
  pinPrompt: onPinPrompt,
  unpinPrompt: onUnpinPrompt,
  reorderPinnedPrompts: onReorderPinnedPrompts,
  touchPromptLastUsed: onTouchPromptLastUsed,
  cleanupPrompts: onCleanupPrompts,
  updatePromptCleanup: onUpdatePromptCleanup,
  addToHistoryShortcut,
  scheduleMap,
  scheduleNotifications,
  addSchedule: onAddSchedule,
  updateSchedule: onUpdateSchedule,
  deleteSchedule: onDeleteSchedule,
  onDismissScheduleNotification,
  onRetrySchedule
}: {
  tab: TabState
  isActive: boolean
  showSettings: boolean
  onSend: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onExecute: (terminalIds: string[]) => Promise<TerminalBatchResult>
  onSendAndExecute: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onChangeWorkDir: (terminalIds: string[], directory: string) => void
  addPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => void
  updatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  deletePrompt: (promptId: string) => void
  pinPrompt: (promptId: string) => void
  unpinPrompt: (promptId: string) => void
  reorderPinnedPrompts: (dragId: string, targetId: string, position: 'before' | 'after') => void
  touchPromptLastUsed: (promptId: string) => void
  cleanupPrompts: (options: { keepDays: number; deleteColored: boolean }) => void
  updatePromptCleanup: (partial: Partial<PromptCleanupConfig>) => void
  addToHistoryShortcut: string | null
  scheduleMap: Map<string, PromptSchedule>
  scheduleNotifications: ScheduleNotification[]
  addSchedule: (schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => void
  updateSchedule: (schedule: PromptSchedule) => void
  deleteSchedule: (promptId: string) => void
  onDismissScheduleNotification: (promptId: string, type: ScheduleNotification['type']) => void
  onRetrySchedule: (promptId: string) => void
}) {
  const { t } = useI18n()
  const {
    state,
    getTabDisplayName,
    getTerminalDisplayName,
    updateTabById,
    updateEditorDraftForTab,
    importPrompts
  } = useAppState()

  const terminals: TerminalInfo[] = useMemo(() => {
    return tab.terminals.slice(0, tab.layoutMode).map((t, index) => ({
      id: t.id,
      title: getTerminalDisplayName(index, t.customName),
      customName: t.customName,
      isActive: t.id === tab.activeTerminalId
    }))
  }, [tab.terminals, tab.layoutMode, tab.activeTerminalId, getTerminalDisplayName])

  const prompts = useMemo(() => {
    return [...state.globalPrompts, ...tab.localPrompts]
  }, [state.globalPrompts, tab.localPrompts])

  const globalPromptIds = useMemo(() => {
    return state.globalPrompts.map(p => p.id)
  }, [state.globalPrompts])

  const editorDraft = tab.editorDraft ?? null

  const hidden = showSettings || !isActive || tab.activePanel !== 'prompt'

  const handleTerminalRename = useCallback((id: string, newCustomName: string) => {
    const newTerminals = tab.terminals.map(t =>
      t.id === id ? { ...t, customName: newCustomName.trim() || null } : t
    )
    updateTabById(tab.id, { terminals: newTerminals })
  }, [tab.id, tab.terminals, updateTabById])

  const handleWidthChange = useCallback((width: number) => {
    updateTabById(tab.id, { promptPanelWidth: width })
  }, [tab.id, updateTabById])

  const handleEditorDraftChange = useCallback((draft: EditorDraft | null) => {
    updateEditorDraftForTab(tab.id, draft)
  }, [tab.id, updateEditorDraftForTab])

  const handleExportAllPrompts = useCallback(async () => {
    const exportNow = Date.now()
    const appInfo = await window.electronAPI.appInfo.get().catch((error) => {
      console.warn('Failed to load app info for export:', error)
      return null
    })

    const payload = buildPromptExportPayload(state, getTabDisplayName, appInfo, exportNow)

    const result = await window.electronAPI.dialog.saveTextFile({
      title: t('app.exportPrompts'),
      defaultFileName: formatExportFileName(exportNow),
      content: JSON.stringify(payload, null, 2)
    })

    if (!result.success && !result.canceled) {
      console.error('Failed to export Prompts:', result.error || 'unknown error')
    }
  }, [getTabDisplayName, state, t])

  const handleImportAllPrompts = useCallback(async (): Promise<PromptImportResult> => {
    const fileResult = await window.electronAPI.dialog.openTextFile({
      title: t('app.importPrompts'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    if (!fileResult.success) {
      return {
        success: false,
        canceled: fileResult.canceled,
        globalImported: 0,
        localImported: 0,
        skippedDuplicate: 0,
        error: fileResult.error
      }
    }

    const parsed = parsePromptExportPayload(fileResult.content ?? '')
    if (!parsed.success) {
      console.error('Failed to parse prompt import payload:', parsed.error)
      return {
        success: false,
        globalImported: 0,
        localImported: 0,
        skippedDuplicate: 0,
        error: parsed.error
      }
    }

    const existingPrompts = [
      ...state.globalPrompts,
      ...state.tabs.flatMap(item => item.localPrompts)
    ]
    const plan = buildImportPlan(parsed.payload, existingPrompts)
    importPrompts(plan.globals, plan.locals)
    return {
      success: true,
      globalImported: plan.globals.length,
      localImported: plan.locals.length,
      skippedDuplicate: plan.duplicateCount
    }
  }, [importPrompts, state.globalPrompts, state.tabs, t])

  return (
    <PromptNotebook
      terminals={terminals}
      onSend={onSend}
      onExecute={onExecute}
      onSendAndExecute={onSendAndExecute}
      onTerminalRename={handleTerminalRename}
      onChangeWorkDir={onChangeWorkDir}
      width={tab.promptPanelWidth}
      onWidthChange={handleWidthChange}
      prompts={prompts}
      onAddPrompt={onAddPrompt}
      onUpdatePrompt={onUpdatePrompt}
      onDeletePrompt={onDeletePrompt}
      onPinPrompt={onPinPrompt}
      onUnpinPrompt={onUnpinPrompt}
      onReorderPinnedPrompts={onReorderPinnedPrompts}
      globalPromptIds={globalPromptIds}
      promptCleanup={state.promptCleanup}
      onExportAllPrompts={handleExportAllPrompts}
      onImportAllPrompts={handleImportAllPrompts}
      onTouchPromptLastUsed={onTouchPromptLastUsed}
      onCleanupPrompts={onCleanupPrompts}
      onUpdatePromptCleanup={onUpdatePromptCleanup}
      editorDraft={editorDraft}
      onEditorDraftChange={handleEditorDraftChange}
      addToHistoryShortcut={addToHistoryShortcut}
      hidden={hidden}
      tabId={tab.id}
      scheduleMap={scheduleMap}
      scheduleNotifications={scheduleNotifications}
      onAddSchedule={onAddSchedule}
      onUpdateSchedule={onUpdateSchedule}
      onDeleteSchedule={onDeleteSchedule}
      onDismissScheduleNotification={onDismissScheduleNotification}
      onRetrySchedule={onRetrySchedule}
    />
  )
})

function AppContent({
  terminalShortcutAction,
  terminalFocusRequest
}: {
  terminalShortcutAction: TerminalShortcutAction | null
  terminalFocusRequest: TerminalFocusRequest | null
}) {
  const { t } = useI18n()
  const {
    state,
    isLoaded,
    activeTab,
    updateActiveTab,
    addPrompt,
    updatePrompt,
    deletePrompt,
    pinPrompt,
    unpinPrompt,
    reorderPinnedPrompts,
    touchPromptLastUsed,
    cleanupPrompts,
    updatePromptCleanup,
    setLastFocusedTerminalId,
    getTerminalDisplayName,
    setLastFocusOwner,
    addSchedule,
    updateSchedule,
    deleteSchedule
  } = useAppState()

  const {
    settings,
    getSettingsPanelWidth,
    setSettingsPanelWidth
  } = useSettings()

  const { registerCloseSettings } = usePromptActions()

  // Automatically create terminals for each Tab (when layout requires more terminals)
  useEffect(() => {
    if (!isLoaded) return

    state.tabs.forEach(tab => {
      const layoutMode = tab.layoutMode
      const currentTerminals = tab.terminals

      if (currentTerminals.length < layoutMode) {
        // Only process the currently active Tab (avoid repeated updates)
        if (tab.id === state.activeTabId) {
          const newTerminals = [...currentTerminals]
          for (let i = currentTerminals.length; i < layoutMode; i++) {
            newTerminals.push({
              id: `terminal-${tab.id}-${Date.now()}-${i}`,
              customName: null
            })
          }
          updateActiveTab({
            terminals: newTerminals,
            activeTerminalId: tab.activeTerminalId || newTerminals[0]?.id || null
          })
        }
      }
    })
  }, [isLoaded, state.tabs, state.activeTabId, updateActiveTab])

  // Set default active terminal
  useEffect(() => {
    if (activeTab && activeTab.terminals.length > 0 && !activeTab.activeTerminalId) {
      updateActiveTab({ activeTerminalId: activeTab.terminals[0].id })
    }
  }, [activeTab?.terminals.length, activeTab?.activeTerminalId, updateActiveTab])

  // List of terminals for the current Tab
  const terminals: TerminalInfo[] = useMemo(() => {
    if (!activeTab) return []
    return activeTab.terminals.map((t, index) => ({
      id: t.id,
      title: getTerminalDisplayName(index, t.customName),
      customName: t.customName,
      isActive: t.id === activeTab.activeTerminalId
    }))
  }, [activeTab, getTerminalDisplayName])

  // Scheduled tasks: build scheduleMap and collect all prompts
  const [scheduleNotifications, setScheduleNotifications] = useState<ScheduleNotification[]>([])

  const scheduleMap = useMemo(() => {
    const map = new Map<string, PromptSchedule>()
    for (const s of state.promptSchedules) {
      map.set(s.promptId, s)
    }
    return map
  }, [state.promptSchedules])

  const allPromptsForSchedule = useMemo(() => {
    const all: Prompt[] = [...state.globalPrompts]
    for (const tab of state.tabs) {
      all.push(...tab.localPrompts)
    }
    return all
  }, [state.globalPrompts, state.tabs])

  const tabsForSchedule = useMemo(() => {
    return state.tabs.map(tab => ({
      id: tab.id,
      terminals: tab.terminals.map(t => ({ id: t.id }))
    }))
  }, [state.tabs])

  const handleScheduleNotification = useCallback((notification: ScheduleNotification) => {
    setScheduleNotifications(prev => {
      // Remove duplicates
      if (prev.some(n => n.promptId === notification.promptId && n.type === notification.type)) {
        return prev
      }
      return [...prev, notification]
    })
  }, [])

  const handleDismissScheduleNotification = useCallback((promptId: string, type: ScheduleNotification['type']) => {
    setScheduleNotifications(prev => prev.filter(n => !(n.promptId === promptId && n.type === type)))
  }, [])

  const handleRetrySchedule = useCallback(async (promptId: string) => {
    // Find the corresponding prompt and execute it immediately
    const prompt = allPromptsForSchedule.find(p => p.id === promptId)
    const schedule = state.promptSchedules.find(s => s.promptId === promptId)
    if (!prompt || !schedule) return

    const tab = state.tabs.find(t => t.id === schedule.tabId)
    if (!tab) return

    const availableTerminalIds = schedule.targetTerminalIds.filter(terminalId =>
      tab.terminals.some(t => t.id === terminalId)
    )

    for (const terminalId of availableTerminalIds) {
      const result = await window.electronAPI.terminal.writeSplit(terminalId, prompt.content, '\r')
      if (!result.ok) {
        console.warn('[Schedule] retry writeSplit failed:', {
          terminalId,
          phase: result.phase,
          error: result.error
        })
      }
    }

    const now = Date.now()
    const executedCount = schedule.executedCount + 1
    const successLog: ExecutionLogEntry = {
      timestamp: now,
      success: true,
      targetTerminalIds: availableTerminalIds
    }

    // Clear this missed-execution notification and keep other notifications with the same prompt
    setScheduleNotifications(prev => prev.filter(n => !(n.promptId === promptId && n.type === 'missed-execution')))

    // Update the execution count and recalculate the next execution to avoid immediate repeated triggering
    if (schedule.scheduleType === 'recurring') {
      const reachedMax = schedule.maxExecutions !== null && executedCount >= schedule.maxExecutions
      updateSchedule({
        ...schedule,
        executedCount,
        missedExecutions: 0,
        lastExecutedAt: now,
        status: reachedMax ? 'completed' : schedule.status,
        nextExecutionAt: reachedMax ? schedule.nextExecutionAt : computeNextExecution(schedule, now + 1),
        executionLog: appendScheduleLogEntry(schedule, successLog),
        lastError: null
      })
      return
    }

    updateSchedule({
      ...schedule,
      executedCount,
      missedExecutions: 0,
      lastExecutedAt: now,
      status: 'completed',
      nextExecutionAt: now,
      executionLog: appendScheduleLogEntry(schedule, successLog),
      lastError: null
    })
  }, [allPromptsForSchedule, state.promptSchedules, state.tabs, updateSchedule])

  // Install scheduling engine
  useScheduleEngine({
    isLoaded,
    schedules: state.promptSchedules,
    tabs: tabsForSchedule,
    allPrompts: allPromptsForSchedule,
    updateSchedule,
    onNotification: handleScheduleNotification
  })

  const writeToTerminals = useCallback(async (
    terminalIds: string[],
    data: string,
    action: string
  ): Promise<TerminalBatchResult> => {
    const successIds: string[] = []
    const failedIds: string[] = []

    for (const id of terminalIds) {
      try {
        const ok = await window.electronAPI.terminal.write(id, data)
        if (ok) {
          successIds.push(id)
        } else {
          failedIds.push(id)
        }
      } catch (error) {
        failedIds.push(id)
        console.warn('[PromptSender] terminal write threw:', { action, terminalId: id, error: String(error) })
      }
    }

    if (failedIds.length > 0) {
      console.warn('[PromptSender] terminal write failed:', { action, failedIds })
    }

    return { successIds, failedIds }
  }, [])

  // Send content to terminals as a paste operation.
  //
  // Strategy (two tiers):
  //   1. xterm.js paste — uses terminal.paste() which applies bracketed paste mode
  //      when the child program supports it (e.g. Claude Code sends \x1b[?2004h).
  //      Within bracketed paste, \r\n is safe — the child treats the entire block
  //      as pasted text rather than interpreting each \r as Enter.
  //   2. Direct PTY write — fallback when the xterm.js instance is unavailable
  //      (e.g. terminal on an unmounted tab). Content is written as-is.
  //
  // Content is NOT modified (no line ending normalization). The bracketed paste
  // mechanism is what protects multi-line content from being split — this is
  // the same approach used by every modern terminal emulator (macOS Terminal,
  // iTerm2, Windows Terminal, etc.).
  const sendContentToTerminals = useCallback(async (
    terminalIds: string[],
    content: string,
    action: string
  ): Promise<TerminalBatchResult> => {
    const successIds: string[] = []
    const failedIds: string[] = []

    for (const id of terminalIds) {
      // Tier 1: try xterm.js paste via session manager (handles bracketed paste mode)
      if (terminalSessionManager.paste(id, content)) {
        successIds.push(id)
        continue
      }

      // Tier 2: fallback to direct PTY write (session not found)
      try {
        const ok = await window.electronAPI.terminal.write(id, content)
        if (ok) {
          successIds.push(id)
        } else {
          failedIds.push(id)
        }
      } catch (error) {
        failedIds.push(id)
        console.warn('[PromptSender] terminal write threw:', { action, terminalId: id, error: String(error) })
      }
    }

    if (failedIds.length > 0) {
      console.warn('[PromptSender] terminal send failed:', { action, failedIds })
    }

    return { successIds, failedIds }
  }, [])

  // Send command to specified terminal
  const handleSendToTerminals = useCallback(async (terminalIds: string[], content: string) => {
    return sendContentToTerminals(terminalIds, content, 'send')
  }, [sendContentToTerminals])

  // Execute command in terminal (send carriage return)
  const handleExecuteOnTerminals = useCallback(async (terminalIds: string[]) => {
    return writeToTerminals(terminalIds, '\r', 'execute')
  }, [writeToTerminals])

  const handleSendAndExecuteOnTerminals = useCallback(async (terminalIds: string[], content: string) => {
    // Send content to terminals and execute (Enter).
    //
    // Tier 1 — via session manager (pasteAndExecute):
    //   Single-line: terminal.input(content + '\r') — raw input, no brackets.
    //   Multi-line:  terminal.paste(content) + 300 ms delay + terminal.input('\r').
    //
    // Tier 2 — direct PTY write (session unavailable, e.g. unmounted tab):
    //   Fallback to the old two-phase approach: pty.write(content), delay, pty.write('\r').
    const successIds: string[] = []
    const failedIds: string[] = []

    for (const id of terminalIds) {
      // Tier 1: session manager handles single-line vs multi-line internally
      if (terminalSessionManager.pasteAndExecute(id, content)) {
        successIds.push(id)
        continue
      }

      // Tier 2: direct PTY write (no session)
      try {
        const result = await window.electronAPI.terminal.writeSplit(id, content, '\r')
        if (result.ok) {
          successIds.push(id)
        } else {
          failedIds.push(id)
          console.warn('[PromptSender] send-and-execute writeSplit failed:', {
            terminalId: id,
            phase: result.phase,
            error: result.error
          })
        }
      } catch (error) {
        failedIds.push(id)
        console.warn('[PromptSender] send-and-execute write threw:', { terminalId: id, error: String(error) })
      }
    }

    if (failedIds.length > 0) {
      console.warn('[PromptSender] send-and-execute failed:', { failedIds })
    }

    return { successIds, failedIds }
  }, [])

  // Terminal focus processing (with tabId parameter)
  const handleTerminalFocusWithTab = useCallback((tabId: string, terminalId: string) => {
    if (tabId === state.activeTabId) {
      setLastFocusOwner('terminal')
      updateActiveTab({ activeTerminalId: terminalId })
      // Record the last focused terminal ID
      setLastFocusedTerminalId(terminalId)
    }
  }, [state.activeTabId, updateActiveTab, setLastFocusedTerminalId, setLastFocusOwner])

  // Terminal rename processing (with tabId parameter)
  const handleTerminalRenameWithTab = useCallback((tabId: string, terminalId: string, newCustomName: string) => {
    if (tabId === state.activeTabId && activeTab) {
      const newTerminals = activeTab.terminals.map(t =>
        t.id === terminalId ? { ...t, customName: newCustomName.trim() || null } : t
      )
      updateActiveTab({ terminals: newTerminals })
    }
  }, [state.activeTabId, activeTab, updateActiveTab])

  // Layout change handling
  const handleLayoutChange = useCallback((mode: LayoutMode) => {
    updateActiveTab({ layoutMode: mode })
  }, [updateActiveTab])

  // Display state of the Settings panel (independent of Tab state)
  const [showSettings, setShowSettings] = useState(false)
  const [projectEditorOpen, setProjectEditorOpen] = useState(false)
  const [projectEditorTerminalId, setProjectEditorTerminalId] = useState<string | null>(null)
  const [projectEditorCwd, setProjectEditorCwd] = useState<string | null>(null)
  const [projectEditorDirty, setProjectEditorDirty] = useState(false)
  const projectEditorDebugOpenedRef = useRef(false)
  const projectEditorProfileScenarioRef = useRef(false)

  // True panel switching handling
  const handlePanelChangeWithSettings = useCallback((panel: 'prompt' | 'settings' | null) => {
    if (panel === 'settings') {
      setShowSettings(true)
      updateActiveTab({ activePanel: null })
    } else {
      setShowSettings(false)
      updateActiveTab({ activePanel: panel })
    }
  }, [updateActiveTab])

  // Close Settings
  const handleCloseSettings = useCallback(() => {
    setShowSettings(false)
  }, [])

  const handleOpenProjectEditor = useCallback(async (terminalId: string) => {
    if (
      projectEditorOpen &&
      projectEditorTerminalId &&
      projectEditorTerminalId !== terminalId &&
      projectEditorDirty
    ) {
      const confirmed = window.confirm(t('app.unsavedProjectEditorConfirm'))
      if (!confirmed) return
    }

    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    setProjectEditorTerminalId(terminalId)
    setProjectEditorCwd(cwd)
    setProjectEditorOpen(true)
  }, [projectEditorOpen, projectEditorTerminalId, projectEditorDirty, t])

  // Debug profile: Automatically execute ProjectEditor <-> Git Diff loop to facilitate CPU sampling
  useEffect(() => {
    if (!window.electronAPI?.debug?.profile) return
    if (!isLoaded || !activeTab) return
    if (projectEditorProfileScenarioRef.current) return

    const terminalId = activeTab.activeTerminalId || activeTab.terminals[0]?.id
    if (!terminalId) return

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms)
    })

    const openProjectEditorDebug = (cwd: string) => {
      setProjectEditorTerminalId(terminalId)
      setProjectEditorCwd(cwd)
      setProjectEditorOpen(true)
    }

    const run = async () => {
      try {
        const debugCwd = await resolveProjectEditorDebugCwd(terminalId, window.electronAPI.debug.profileCwd)
        if (!debugCwd) {
          console.warn('Profile scenario skipped: failed to resolve project editor cwd')
          return
        }
        projectEditorProfileScenarioRef.current = true
        const platform = window.electronAPI.platform
        const cdCommand = platform === 'win32'
          ? `cd /d "${debugCwd}"\r`
          : `cd "${debugCwd}"\r`
        await window.electronAPI.terminal.write(terminalId, cdCommand)
        await sleep(400)
        openProjectEditorDebug(debugCwd)
        await sleep(1400)
        window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
        await sleep(1600)
        window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
        await sleep(600)
        openProjectEditorDebug(debugCwd)
        await sleep(1400)
        window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
      } catch (error) {
        console.warn('Profile scenario failed:', error)
      }
    }

    void run()
  }, [activeTab, isLoaded])

  // Debug profile: Allow external triggering to open ProjectEditor (for automation switching)
  useEffect(() => {
    if (!window.electronAPI?.debug?.profile && !window.electronAPI?.debug?.autotest) return
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      void handleOpenProjectEditor(terminalId)
    }
    window.addEventListener('project-editor:open', handler as EventListener)
    return () => window.removeEventListener('project-editor:open', handler as EventListener)
  }, [handleOpenProjectEditor])

  useEffect(() => {
    if (!window.electronAPI?.debug?.profile && !window.electronAPI?.debug?.autotest) return
    if (window.electronAPI?.debug?.profile) return
    if (!isLoaded || !activeTab) return
    if (projectEditorOpen || projectEditorDebugOpenedRef.current) return
    const firstTerminal = activeTab.terminals[0]
    if (!firstTerminal) return
    void (async () => {
      const preferredCwd = window.electronAPI.debug.autotest
        ? window.electronAPI.debug.autotestCwd
        : window.electronAPI.debug.profileCwd
      const debugCwd = await resolveProjectEditorDebugCwd(firstTerminal.id, preferredCwd)
      if (!debugCwd) {
        console.warn('[ProjectEditorDebug] skipped auto open: failed to resolve cwd')
        return
      }
      projectEditorDebugOpenedRef.current = true
      console.log('[ProjectEditorDebug] auto open project editor', firstTerminal.id, debugCwd)
      window.electronAPI.debug.log('App:autoOpenProjectEditor', { terminalId: firstTerminal.id, cwd: debugCwd })
      setProjectEditorTerminalId(firstTerminal.id)
      setProjectEditorCwd(debugCwd)
      setProjectEditorOpen(true)
    })()
  }, [activeTab, isLoaded, projectEditorOpen])

  const handleCloseProjectEditor = useCallback(() => {
    setProjectEditorOpen(false)
    setProjectEditorTerminalId(null)
    setProjectEditorCwd(null)
    setProjectEditorDirty(false)
  }, [])

  // Register closeSettings callback to Context
  useEffect(() => {
    registerCloseSettings(handleCloseSettings)
    return () => {
      registerCloseSettings(null)
    }
  }, [registerCloseSettings, handleCloseSettings])

  // Restore focus when ProjectEditor or Settings panel closes
  const prevProjectEditorOpenRef = useRef(projectEditorOpen)
  const projectEditorTerminalIdRef = useRef(projectEditorTerminalId)
  const prevShowSettingsRef = useRef(showSettings)

  useEffect(() => {
    projectEditorTerminalIdRef.current = projectEditorTerminalId
  }, [projectEditorTerminalId])

  useEffect(() => {
    const wasOpen = prevProjectEditorOpenRef.current
    prevProjectEditorOpenRef.current = projectEditorOpen
    if (wasOpen && !projectEditorOpen) {
      // Restore focus to the terminal that opened the editor
      const terminalId = projectEditorTerminalIdRef.current ?? activeTab?.activeTerminalId
      if (terminalId) {
        requestAnimationFrame(() => {
          terminalSessionManager.focusIfNeeded(terminalId)
        })
      }
    }
  }, [projectEditorOpen, activeTab?.activeTerminalId])

  useEffect(() => {
    const wasOpen = prevShowSettingsRef.current
    prevShowSettingsRef.current = showSettings
    if (wasOpen && !showSettings) {
      const terminalId = activeTab?.activeTerminalId
      if (terminalId) {
        requestAnimationFrame(() => {
          terminalSessionManager.focusIfNeeded(terminalId)
        })
      }
    }
  }, [showSettings, activeTab?.activeTerminalId])

  // Change working directory
  const handleChangeWorkDir = useCallback(async (terminalIds: string[], directory: string) => {
    const platform = window.electronAPI.platform
    let fullCommand: string

    if (platform === 'win32') {
      fullCommand = `cd /d "${directory}"\r`
    } else {
      fullCommand = `cd "${directory}"\r`
    }

    for (const id of terminalIds) {
      await window.electronAPI.terminal.write(id, fullCommand)
    }
  }, [])

  // Globally intercept all link clicks in the page, and unify the main process "open externally after confirmation" process
  useEffect(() => {
    const handleDocumentLinkClick = (event: MouseEvent) => {
      const target = event.target as Element | null
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor) return

      const href = anchor.getAttribute('href')
      if (!href) return

      event.preventDefault()
      void requestOpenExternalHttpLink(href).then((result) => {
        if (!result.success && result.error && !result.canceled && !result.blocked) {
          console.warn('[LinkGuard] Failed to open external link:', result.error)
        }
      })
    }

    document.addEventListener('click', handleDocumentLinkClick, true)
    return () => {
      document.removeEventListener('click', handleDocumentLinkClick, true)
    }
  }, [])

  // Prompt Bridge IPC monitoring: receiving command sending requests from the main process
  useEffect(() => {
    const cleanup = window.electronAPI.terminal.onPromptBridgeSend(async (request) => {
      const { requestId, terminalId, content, action } = request
      try {
        let result: TerminalBatchResult

        switch (action) {
          case 'send':
            result = await handleSendToTerminals([terminalId], content)
            break
          case 'execute':
            result = await handleExecuteOnTerminals([terminalId])
            break
          case 'send-and-execute':
            result = await handleSendAndExecuteOnTerminals([terminalId], content)
            break
          default:
            result = { successIds: [], failedIds: [terminalId] }
        }

        // When sent successfully and there is content, save to Prompt history
        if (result.successIds.length > 0 && content.trim()) {
          addPrompt({ title: '', content: content.trim(), pinned: false })
        }

        window.electronAPI.terminal.sendPromptBridgeResponse(requestId, {
          success: result.successIds.length > 0,
          successIds: result.successIds,
          failedIds: result.failedIds
        })
      } catch (error) {
        window.electronAPI.terminal.sendPromptBridgeResponse(requestId, {
          success: false,
          successIds: [],
          failedIds: [terminalId],
          error: String(error)
        })
      }
    })
    return cleanup
  }, [handleSendToTerminals, handleExecuteOnTerminals, handleSendAndExecuteOnTerminals, addPrompt])

  // Wait for loading to complete
  if (!isLoaded || !activeTab) {
    return (
      <div className="app">
        <div className="app-loading">Loading...</div>
      </div>
    )
  }

  const layoutMode = activeTab.layoutMode
  const activePanel = activeTab.activePanel

  // Calculate the displayed activePanel (for Sidebar)
  const displayActivePanel = showSettings ? 'settings' : activePanel

  return (
    <div className="app">
      <TabBar />
      <div className="app-body">
        <Sidebar
          activePanel={displayActivePanel}
          layoutMode={layoutMode}
          onPanelChange={handlePanelChangeWithSettings}
          onLayoutChange={handleLayoutChange}
        />
        <main className="main-content">
          {showSettings && (
            <Settings
              terminals={terminals.slice(0, layoutMode)}
              onClose={handleCloseSettings}
              width={getSettingsPanelWidth()}
              onWidthChange={setSettingsPanelWidth}
            />
          )}
          {/* Render PromptNotebook for all Tabs, hiding inactive ones to maintain state */}
          {state.tabs.map(tab => (
            <TabPromptNotebook
              key={`prompt-${tab.id}`}
              tab={tab}
              isActive={tab.id === state.activeTabId}
              showSettings={showSettings}
              onSend={handleSendToTerminals}
              onExecute={handleExecuteOnTerminals}
              onSendAndExecute={handleSendAndExecuteOnTerminals}
              onChangeWorkDir={handleChangeWorkDir}
              addPrompt={addPrompt}
              updatePrompt={updatePrompt}
              deletePrompt={deletePrompt}
              pinPrompt={pinPrompt}
              unpinPrompt={unpinPrompt}
              reorderPinnedPrompts={reorderPinnedPrompts}
              touchPromptLastUsed={touchPromptLastUsed}
              cleanupPrompts={cleanupPrompts}
              updatePromptCleanup={updatePromptCleanup}
              addToHistoryShortcut={settings?.shortcuts?.addToHistory ?? null}
              scheduleMap={scheduleMap}
              scheduleNotifications={scheduleNotifications}
              addSchedule={addSchedule}
              updateSchedule={updateSchedule}
              deleteSchedule={deleteSchedule}
              onDismissScheduleNotification={handleDismissScheduleNotification}
              onRetrySchedule={handleRetrySchedule}
            />
          ))}
          <div className="terminal-area">
            {/* Render all Tab terminals, hiding inactive ones to keep them alive */}
            {state.tabs.map(tab => (
              <TabTerminalGrid
                key={tab.id}
                tab={tab}
                isActive={tab.id === state.activeTabId}
                onTerminalFocus={handleTerminalFocusWithTab}
                onTerminalRename={handleTerminalRenameWithTab}
                onOpenProjectEditor={handleOpenProjectEditor}
                focusRequest={terminalFocusRequest}
                shortcutAction={terminalShortcutAction}
                projectEditorOpen={projectEditorOpen}
              />
            ))}
            <ProjectEditor
              isOpen={projectEditorOpen}
              terminalId={projectEditorTerminalId}
              cwd={projectEditorCwd}
              onClose={handleCloseProjectEditor}
              onDirtyChange={setProjectEditorDirty}
              displayMode="panel"
            />
          </div>
        </main>
      </div>
    </div>
  )
}

function AppWithSettings() {
  return (
    <PromptActionsProvider>
      <SettingsProviderWithHandler />
    </PromptActionsProvider>
  )
}

// SettingsProvider wrapper component inside PromptActionsProvider
function SettingsProviderWithHandler() {
  const {
    switchTab,
    updateActiveTab,
    activeTab,
    state,
    getLastFocusedTerminalId,
    setLastFocusedTerminalId,
    setLastFocusOwner,
    getLastFocusOwner
  } = useAppState()
  const { focusEditor, submitEditor, closeSettings } = usePromptActions()
  const lastFocusedElementRef = useRef<HTMLElement | null>(null)
  const [terminalShortcutAction, setTerminalShortcutAction] = useState<TerminalShortcutAction | null>(null)
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<TerminalFocusRequest | null>(null)
  const terminalShortcutSeqRef = useRef(0)
  const terminalFocusSeqRef = useRef(0)

  const requestTerminalFocus = useCallback((terminalId: string, reason: TerminalFocusRequest['reason']) => {
    const immediateFocused = terminalSessionManager.focusIfNeeded(terminalId)
    debugTerminalFocus('request-terminal-focus', {
      terminalId,
      reason,
      immediateFocused,
      snapshot: terminalSessionManager.getFocusDebugSnapshot(terminalId)
    })

    if (immediateFocused) {
      setTerminalFocusRequest(null)
      return
    }

    terminalFocusSeqRef.current += 1
    const nextRequest = {
      terminalId,
      reason,
      token: terminalFocusSeqRef.current
    }
    debugTerminalFocus('queue-terminal-focus-request', nextRequest)
    setTerminalFocusRequest(nextRequest)
  }, [])

  const prepareTerminalRestore = useCallback((terminalId: string) => {
    if (!activeTab || !activeTab.terminals.some(t => t.id === terminalId)) {
      return false
    }

    setLastFocusOwner('terminal')
    setLastFocusedTerminalId(terminalId)
    if (activeTab.activeTerminalId !== terminalId) {
      updateActiveTab({ activeTerminalId: terminalId })
    }
    return true
  }, [activeTab, setLastFocusedTerminalId, setLastFocusOwner, updateActiveTab])

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      focusCoordinator.notePointerDown(event.target)
    }

    document.addEventListener('mousedown', handleMouseDown, true)
    return () => document.removeEventListener('mousedown', handleMouseDown, true)
  }, [])

  // Record the latest input focus (to avoid being snatched away by the terminal when returning to the window)
  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return

      const isTerminalFocus = !!target.closest('.xterm')
      if (isTerminalFocus) {
        setLastFocusOwner('terminal')
        lastFocusedElementRef.current = target
        return
      }

      const isInputElement = target.matches('input, textarea, select, [contenteditable="true"]')
      if (isInputElement) {
        setLastFocusOwner('input')
        lastFocusedElementRef.current = target
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    return () => document.removeEventListener('focusin', handleFocusIn)
  }, [setLastFocusOwner])

  // Handle shortcut actions (global and window-level shortcuts from the main process)
  const handleShortcutAction = useCallback((action: ShortcutAction) => {
    const resolveTerminalId = () => {
      if (!activeTab) return null
      if (activeTab.activeTerminalId) return activeTab.activeTerminalId
      const lastFocusedId = getLastFocusedTerminalId()
      if (lastFocusedId && activeTab.terminals.some(t => t.id === lastFocusedId)) {
        return lastFocusedId
      }
      return activeTab.terminals[0]?.id || null
    }

    const dispatchTerminalAction = (nextAction: TerminalShortcutAction['action']) => {
      const terminalId = resolveTerminalId()
      if (!terminalId) return
      terminalShortcutSeqRef.current += 1
      setTerminalShortcutAction({
        terminalId,
        action: nextAction,
        token: terminalShortcutSeqRef.current
      })
    }

    switch (action.type) {
      case 'focusTerminal': {
        // Focus on the specified terminal
        if (activeTab && action.index <= activeTab.terminals.length) {
          const terminalId = activeTab.terminals[action.index - 1]?.id
          if (terminalId) {
            setLastFocusOwner('terminal')
            // First close the Settings panel (if it is open)
            closeSettings()
            // Only update activeTerminalId, do not change activePanel (keep Prompt panel state)
            updateActiveTab({ activeTerminalId: terminalId })
            setLastFocusedTerminalId(terminalId)
            requestTerminalFocus(terminalId, 'shortcut-terminal')
          }
        }
        break
      }
      case 'switchTab': {
        // Switch to the specified Tab and restore terminal focus
        if (action.index <= state.tabs.length) {
          const targetTab = state.tabs[action.index - 1]
          if (targetTab) {
            closeSettings()
            switchTab(targetTab.id)
            const terminalId = targetTab.activeTerminalId
            if (terminalId) {
              setLastFocusOwner('terminal')
              setLastFocusedTerminalId(terminalId)
              requestTerminalFocus(terminalId, 'shortcut-activated')
            }
          }
        }
        break
      }
      case 'activateAndFocusPrompt': {
        // Close Settings first
        closeSettings()
        setLastFocusOwner('input')
        // Open the Prompt panel and focus
        updateActiveTab({ activePanel: 'prompt' })
        // Delay focus, wait for panel rendering
        setTimeout(() => {
          focusEditor()
        }, 100)
        break
      }
      case 'addToHistory': {
        // Add editor content to history
        submitEditor()
        break
      }
      case 'focusPromptEditor': {
        // Close Settings first
        closeSettings()
        setLastFocusOwner('input')
        // Focus on the Prompt Editor
        updateActiveTab({ activePanel: 'prompt' })
        setTimeout(() => {
          focusEditor()
        }, 100)
        break
      }
      case 'terminalGitDiff': {
        dispatchTerminalAction('gitDiff')
        break
      }
      case 'terminalGitHistory': {
        dispatchTerminalAction('gitHistory')
        break
      }
      case 'terminalChangeWorkDir': {
        dispatchTerminalAction('changeWorkDir')
        break
      }
      case 'terminalOpenWorkDir': {
        dispatchTerminalAction('openWorkDir')
        break
      }
      case 'terminalProjectEditor': {
        dispatchTerminalAction('projectEditor')
        break
      }
      case 'viewGitDiff': {
        const terminalId = activeTab?.activeTerminalId || getLastFocusedTerminalId()
        if (terminalId) {
          window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
        }
        break
      }
    }
  }, [activeTab, state.tabs, switchTab, updateActiveTab, getLastFocusedTerminalId, setLastFocusedTerminalId, setLastFocusOwner, closeSettings, focusEditor, submitEditor, requestTerminalFocus])

  const restoreLastFocus = useCallback((reason: TerminalFocusRestoreReason) => {
    if (!activeTab) return

    window.setTimeout(() => {
      const activeElement = document.activeElement as HTMLElement | null
      const shouldPreserveCurrentFocus = reason !== 'shortcut-activated'
      if (
        shouldPreserveCurrentFocus &&
        activeElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement
      ) {
        return
      }

      const focusOwner = getLastFocusOwner()
      const lastFocusedElement = lastFocusedElementRef.current
      const lastTerminalId = getLastFocusedTerminalId()

      debugTerminalFocus('restore-last-focus:start', {
        reason,
        focusOwner,
        activeTagName: activeElement?.tagName ?? null,
        activeClassName: activeElement?.className ?? null,
        activeTerminalId: activeTab.activeTerminalId,
        lastTerminalId,
        pointer: focusCoordinator.getDebugState()
      })

      if (focusOwner === 'input') {
        if (!focusCoordinator.shouldRestoreInput(reason)) {
          debugTerminalFocus('restore-last-focus:skip-input', { reason })
          return
        }
        if (lastFocusedElement && document.contains(lastFocusedElement)) {
          lastFocusedElement.focus()
          debugTerminalFocus('restore-last-focus:focused-input-element', {
            reason,
            tagName: lastFocusedElement.tagName,
            className: lastFocusedElement.className
          })
          return
        }
        if (activeTab.activePanel === 'prompt') {
          focusEditor()
          debugTerminalFocus('restore-last-focus:focused-prompt-editor', { reason })
          return
        }
      }

      if (lastTerminalId && activeTab.terminals.some(t => t.id === lastTerminalId)) {
        if (!focusCoordinator.shouldRestoreTerminal(reason)) {
          debugTerminalFocus('restore-last-focus:skip-terminal', {
            reason,
            terminalId: lastTerminalId
          })
          return
        }
        setLastFocusOwner('terminal')
        if (activeTab.activeTerminalId !== lastTerminalId) {
          updateActiveTab({ activeTerminalId: lastTerminalId })
        }
        debugTerminalFocus('restore-last-focus:request-terminal', {
          reason,
          terminalId: lastTerminalId,
          activeTerminalId: activeTab.activeTerminalId
        })
        requestTerminalFocus(lastTerminalId, reason)
      }
    }, 0)
  }, [activeTab, focusEditor, getLastFocusOwner, getLastFocusedTerminalId, setLastFocusOwner, updateActiveTab, requestTerminalFocus])

  // Listen for window activation events (wake up from the background)
  useEffect(() => {
    if (!window.electronAPI?.settings?.onActivated) return

    const unsubscribe = window.electronAPI.settings.onActivated(() => {
      restoreLastFocus('shortcut-activated')
    })

    return unsubscribe
  }, [restoreLastFocus])

  // Restore input position when window regains focus
  useEffect(() => {
    const handleWindowFocus = () => {
      restoreLastFocus('window-focus')
    }

    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [restoreLastFocus])

  // Fixed occasional loss of input focus (e.g. just pressing Shift)
  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') return
      const activeElement = document.activeElement as HTMLElement | null
      if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) {
        return
      }
      if (getLastFocusOwner() !== 'input') return
      restoreLastFocus('window-focus')
    }

    window.addEventListener('keyup', handleKeyUp)
    return () => window.removeEventListener('keyup', handleKeyUp)
  }, [getLastFocusOwner, restoreLastFocus])

  // Listen for window-level shortcut events from the main process (using before-input-event interception)
  useEffect(() => {
    if (!window.electronAPI?.settings?.onWindowShortcutTriggered) return

    const unsubscribe = window.electronAPI.settings.onWindowShortcutTriggered((action) => {
      handleShortcutAction(action)
    })

    return unsubscribe
  }, [handleShortcutAction])

  useEffect(() => {
    if (!window.electronAPI?.debug?.enabled && !window.electronAPI?.debug?.autotest) return
    return registerTerminalFocusDebugApi({
      restoreFocus: restoreLastFocus,
      prepareTerminalRestore,
      getLastFocusOwner,
      getLastFocusedTerminalId,
      getActiveTerminalId: () => activeTab?.activeTerminalId ?? null
    })
  }, [activeTab?.activeTerminalId, getLastFocusOwner, getLastFocusedTerminalId, prepareTerminalRestore, restoreLastFocus])

  return (
    <SettingsProvider onShortcutAction={handleShortcutAction}>
      <AppContent
        terminalShortcutAction={terminalShortcutAction}
        terminalFocusRequest={terminalFocusRequest}
      />
    </SettingsProvider>
  )
}

function App() {
  return (
    <AppStateProvider>
      <AppWithSettings />
    </AppStateProvider>
  )
}

export default App
