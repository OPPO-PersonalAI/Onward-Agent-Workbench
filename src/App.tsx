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
import { FeedbackModal } from './components/FeedbackModal'
import { PromptNotebook } from './components/PromptNotebook/PromptNotebook'
import { TerminalGrid } from './components/TerminalGrid/TerminalGrid'
import { Settings } from './components/Settings'
import { ChangeLogModal } from './components/ChangeLogModal'
import { useScheduleEngine } from './hooks/useScheduleEngine'
import type { ScheduleNotification } from './hooks/useScheduleEngine'
import {
  LayoutMode,
  TerminalBatchResult,
  TerminalInfo,
  TerminalShortcutAction,
  TerminalFocusRequest
} from './types/prompt'
import type { TerminalBatchIssue, TerminalBatchIssueReason } from './types/prompt'
import type { AppInfo, CurrentChangelogResult, Prompt } from './types/electron.d.ts'
import type { TabState, EditorDraft, PromptCleanupConfig, PromptSchedule, ExecutionLogEntry } from './types/tab.d.ts'
import type { ShortcutAction } from './types/settings.d.ts'
import type { ProjectEditorOpenEventDetail, ProjectEditorOpenRequest, SubpageId } from './types/subpage'
import { requestOpenExternalHttpLink } from './utils/externalLink'
import { computeNextExecution } from './utils/schedule'
import {
  createTerminalBatchResult,
  getDeliveredTerminalIds
} from './utils/terminal-batch'
import {
  buildImportPlan,
  buildPromptExportPayload,
  formatExportFileName,
  parsePromptExportPayload,
  type ImportPrepareResult
} from './utils/prompt-io'
import { useI18n } from './i18n/useI18n'
import { ConsentDialog } from './components/ConsentDialog/ConsentDialog'
import { terminalSessionManager } from './terminal/terminal-session-manager'
import { focusCoordinator, type TerminalFocusRestoreReason } from './terminal/focus-coordinator'
import { registerTerminalFocusDebugApi } from './terminal/focus-debug-api'
import { buildChangeDirectoryCommand, type TerminalShellKind } from './utils/terminal-command'
import './App.css'
import './styles/form-controls.css'

const MAX_SCHEDULE_LOG_ENTRIES = 50
const DEFAULT_SEND_AND_EXECUTE_SETTLE_DELAY_MS = 150
const WINDOWS_SEND_AND_EXECUTE_SETTLE_DELAY_MS = 500
const DEBUG_TERMINAL_FOCUS = Boolean(window.electronAPI?.debug?.enabled)

type SendAndExecuteDelayPlatform = AppInfo['platform']

interface SendAndExecuteDelayContext {
  platform: SendAndExecuteDelayPlatform
  platformVersion: string
}

interface SendAndExecuteDelayConfig {
  defaultDelayMs: number
  versionRules: Array<{
    platformVersionPrefix: string
    delayMs: number
  }>
}

const SEND_AND_EXECUTE_SETTLE_DELAY_CONFIG: Record<SendAndExecuteDelayPlatform, SendAndExecuteDelayConfig> = {
  darwin: {
    defaultDelayMs: DEFAULT_SEND_AND_EXECUTE_SETTLE_DELAY_MS,
    versionRules: []
  },
  win32: {
    defaultDelayMs: WINDOWS_SEND_AND_EXECUTE_SETTLE_DELAY_MS,
    versionRules: []
  },
  linux: {
    defaultDelayMs: DEFAULT_SEND_AND_EXECUTE_SETTLE_DELAY_MS,
    versionRules: []
  },
  unknown: {
    defaultDelayMs: DEFAULT_SEND_AND_EXECUTE_SETTLE_DELAY_MS,
    versionRules: []
  }
}

let sendAndExecuteDelayContextPromise: Promise<SendAndExecuteDelayContext> | null = null

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

async function waitForSendAndExecuteSettle(): Promise<void> {
  const delayMs = resolveSendAndExecuteSettleDelayMs(await getSendAndExecuteDelayContext())
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs)
  })
}

function normalizeSendAndExecuteDelayPlatform(platform: string): SendAndExecuteDelayPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform
  }
  return 'unknown'
}

function resolveSendAndExecuteSettleDelayMs(context: SendAndExecuteDelayContext): number {
  const config = SEND_AND_EXECUTE_SETTLE_DELAY_CONFIG[context.platform] ?? SEND_AND_EXECUTE_SETTLE_DELAY_CONFIG.unknown
  const versionRule = config.versionRules.find((rule) => {
    return context.platformVersion.startsWith(rule.platformVersionPrefix)
  })
  return versionRule?.delayMs ?? config.defaultDelayMs
}

function getSendAndExecuteDelayContext(): Promise<SendAndExecuteDelayContext> {
  if (!sendAndExecuteDelayContextPromise) {
    sendAndExecuteDelayContextPromise = window.electronAPI.appInfo.get()
      .then((info) => ({
        platform: normalizeSendAndExecuteDelayPlatform(info.platform || window.electronAPI.platform),
        platformVersion: info.platformVersion || 'unknown'
      }))
      .catch(() => ({
        platform: normalizeSendAndExecuteDelayPlatform(window.electronAPI.platform),
        platformVersion: 'unknown'
      }))
  }
  return sendAndExecuteDelayContextPromise
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

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

// Terminal grid component for a single Tab
const TabTerminalGrid = memo(function TabTerminalGrid({
  tab,
  isActive,
  onTerminalFocus,
  onTerminalRename,
  onPersistTerminalCwd,
  onOpenProjectEditor,
  projectEditorTerminalId,
  projectEditorCwd,
  focusRequest,
  shortcutAction,
  projectEditorOpen,
  projectEditorOpenRequest,
  onCloseProjectEditor,
  onProjectEditorDirtyChange
}: {
  tab: TabState
  isActive: boolean
  onTerminalFocus: (tabId: string, terminalId: string) => void
  onTerminalRename: (tabId: string, terminalId: string, newTitle: string) => void
  onPersistTerminalCwd: (terminalId: string, cwd: string | null) => void
  onOpenProjectEditor: (terminalId: string) => void
  projectEditorTerminalId: string | null
  projectEditorCwd: string | null
  focusRequest: TerminalFocusRequest | null
  shortcutAction: TerminalShortcutAction | null
  projectEditorOpen: boolean
  projectEditorOpenRequest: ProjectEditorOpenRequest | null
  onCloseProjectEditor: () => void
  onProjectEditorDirtyChange: (dirty: boolean) => void
}) {
  const { getTerminalDisplayName, updateTabById } = useAppState()
  const terminals: TerminalInfo[] = useMemo(() => {
    return tab.terminals.map((t, index) => ({
      id: t.id,
      title: getTerminalDisplayName(index, t.customName),
      customName: t.customName,
      lastCwd: t.lastCwd,
      isActive: t.id === tab.activeTerminalId
    }))
  }, [tab.terminals, tab.activeTerminalId, getTerminalDisplayName])

  const handleTerminalFocus = useCallback((terminalId: string) => {
    onTerminalFocus(tab.id, terminalId)
  }, [tab.id, onTerminalFocus])

  const handleTerminalRename = useCallback((terminalId: string, newTitle: string) => {
    onTerminalRename(tab.id, terminalId, newTitle)
  }, [tab.id, onTerminalRename])

  const handleActiveSubpageChange = useCallback((subpage: SubpageId | null, terminalId: string | null) => {
    updateTabById(tab.id, { activeSubpage: subpage, subpageTerminalId: terminalId })
  }, [tab.id, updateTabById])

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
      onPersistTerminalCwd={onPersistTerminalCwd}
      onOpenProjectEditor={onOpenProjectEditor}
      tabId={tab.id}
      hidden={!isActive}
      shortcutAction={actionForTab}
      focusRequest={focusRequestForTab}
      projectEditorOpen={projectEditorOpen}
      projectEditorTerminalId={projectEditorTerminalId}
      projectEditorCwd={projectEditorCwd}
      projectEditorOpenRequest={projectEditorOpenRequest}
      onCloseProjectEditor={onCloseProjectEditor}
      onProjectEditorDirtyChange={onProjectEditorDirtyChange}
      initialActiveSubpage={tab.activeSubpage}
      initialSubpageTerminalId={tab.subpageTerminalId}
      onActiveSubpageChange={handleActiveSubpageChange}
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
  const { locale, t } = useI18n()
  const {
    state,
    getTabDisplayName,
    getTerminalDisplayName,
    updateTabById,
    updateEditorDraftForTab,
    updatePromptEditorHeightForTab,
    importPrompts
  } = useAppState()

  const terminals: TerminalInfo[] = useMemo(() => {
    return tab.terminals.slice(0, tab.layoutMode).map((t, index) => ({
      id: t.id,
      title: getTerminalDisplayName(index, t.customName),
      customName: t.customName,
      lastCwd: t.lastCwd,
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

  const handlePromptEditorHeightChange = useCallback((height: number) => {
    updatePromptEditorHeightForTab(tab.id, height)
  }, [tab.id, updatePromptEditorHeightForTab])

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

  const handlePrepareImport = useCallback(async (): Promise<ImportPrepareResult> => {
    const fileResult = await window.electronAPI.dialog.openTextFile({
      title: t('app.importPrompts'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    if (!fileResult.success) {
      if (fileResult.canceled) {
        return { success: false, globals: [], locals: [], duplicateCount: 0 }
      }
      return { success: false, globals: [], locals: [], duplicateCount: 0, error: fileResult.error }
    }

    const parsed = parsePromptExportPayload(fileResult.content ?? '')
    if (!parsed.success) {
      return { success: false, globals: [], locals: [], duplicateCount: 0, error: parsed.error }
    }

    const existingPrompts = [
      ...state.globalPrompts,
      ...state.tabs.flatMap(item => item.localPrompts)
    ]
    const plan = buildImportPlan(parsed.payload, existingPrompts)

    return {
      success: true,
      globals: plan.globals,
      locals: plan.locals,
      duplicateCount: plan.duplicateCount
    }
  }, [state.globalPrompts, state.tabs, t])

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
      onPrepareImport={handlePrepareImport}
      onExecuteImport={importPrompts}
      onTouchPromptLastUsed={onTouchPromptLastUsed}
      onCleanupPrompts={onCleanupPrompts}
      onUpdatePromptCleanup={onUpdatePromptCleanup}
      promptEditorHeight={tab.promptEditorHeight}
      onPromptEditorHeightChange={handlePromptEditorHeightChange}
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
  const { locale, t } = useI18n()
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
    setTerminalLastCwd,
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

  const { registerCloseSettings, registerTryCloseSettingsOnSwitch } = usePromptActions()

  // Telemetry consent state: null = not asked, true/false = answered
  const [telemetryConsent, setTelemetryConsentState] = useState<boolean | null | 'loading'>('loading')

  useEffect(() => {
    window.electronAPI.telemetry.getConsent().then((consent) => {
      setTelemetryConsentState(consent)
    })
  }, [])

  const handleTelemetryConsent = useCallback((consent: boolean) => {
    setTelemetryConsentState(consent)
  }, [])

  const buildTerminalIssue = useCallback((
    terminalId: string,
    status: TerminalBatchIssue['status'],
    reason: TerminalBatchIssueReason,
    error?: string
  ): TerminalBatchIssue => {
    const messageKey = reason === 'unsafe-multiline-send'
      ? 'terminalAction.reason.unsafeMultilineSend'
      : reason === 'unsafe-multiline-execute'
        ? 'terminalAction.reason.unsafeMultilineExecute'
        : reason === 'execute-failed'
          ? 'terminalAction.reason.executeFailed'
          : 'terminalAction.reason.sendFailed'

    return {
      terminalId,
      status,
      reason,
      message: t(messageKey),
      error
    }
  }, [t])

  const summarizeScheduleBatchError = useCallback((result: TerminalBatchResult): string => {
    const sentOnlyCount = result.sentOnlyIds.length
    const failedCount = result.failedIds.length
    const unsafeMultiLineFailures = result.issues.filter(
      (issue) => issue.reason === 'unsafe-multiline-send'
    ).length

    if (sentOnlyCount > 0 && failedCount === 0) {
      return t('schedule.sentOnly', { count: sentOnlyCount })
    }

    if (failedCount > 0 && sentOnlyCount === 0 && unsafeMultiLineFailures === failedCount) {
      return t('schedule.multilineBlocked', { count: failedCount })
    }

    if (sentOnlyCount > 0 && failedCount > 0) {
      return t('schedule.partialMixed', {
        sentOnlyCount,
        failedCount
      })
    }

    if (failedCount > 0) {
      return t('schedule.partialFailure', { count: failedCount })
    }

    return result.issues[0]?.message ?? t('schedule.partialFailure', { count: 1 })
  }, [t])

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
              customName: null,
              lastCwd: null
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
      lastCwd: t.lastCwd,
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

  const writeToTerminals = useCallback(async (
    terminalIds: string[],
    data: string,
    action: string
  ): Promise<TerminalBatchResult> => {
    const result = createTerminalBatchResult()

    for (const id of terminalIds) {
      try {
        const ok = await window.electronAPI.terminal.write(id, data)
        if (ok) {
          result.successIds.push(id)
        } else {
          result.failedIds.push(id)
          result.issues.push(buildTerminalIssue(id, 'failed', 'execute-failed'))
        }
      } catch (error) {
        result.failedIds.push(id)
        result.issues.push(buildTerminalIssue(id, 'failed', 'execute-failed', String(error)))
        console.warn('[PromptSender] terminal write threw:', { action, terminalId: id, error: String(error) })
      }
    }

    if (result.failedIds.length > 0) {
      console.warn('[PromptSender] terminal write failed:', { action, failedIds: result.failedIds })
    }

    return result
  }, [buildTerminalIssue])

  // Send content to terminals.
  //
  // Strategy (two tiers):
  //   1. Single-line content: always use the main-process raw input path.
  //      This avoids relying on renderer-only input injection semantics.
  //   2. Multi-line content: prefer mounted xterm session paste() so
  //      bracketed paste mode is applied when supported by the child program.
  //   3. Session unavailable: use the main-process input sequence API so
  //      multi-line content still goes through paste semantics instead of the
  //      old direct PTY write fallback.
  const sendContentToTerminals = useCallback(async (
    terminalIds: string[],
    content: string,
    action: string
  ): Promise<TerminalBatchResult> => {
    const result = createTerminalBatchResult()
    const isMultiLine = /\r?\n/.test(content)

    for (const id of terminalIds) {
      if (isMultiLine) {
        const sessionBracketedPaste = terminalSessionManager.isBracketedPasteEnabled(id)
        if (sessionBracketedPaste === true && terminalSessionManager.paste(id, content)) {
          result.successIds.push(id)
          continue
        }
        if (sessionBracketedPaste === false) {
          result.failedIds.push(id)
          result.issues.push(buildTerminalIssue(id, 'failed', 'unsafe-multiline-send'))
          continue
        }
      }

      try {
        if (isMultiLine) {
          const capabilities = await window.electronAPI.terminal.getInputCapabilities(id)
          if (!capabilities.bracketedPasteEnabled) {
            result.failedIds.push(id)
            result.issues.push(buildTerminalIssue(id, 'failed', 'unsafe-multiline-send'))
            continue
          }
        }
        const writeResult = await window.electronAPI.terminal.sendInputSequence(id, {
          kind: isMultiLine ? 'paste' : 'raw',
          content
        })
        if (writeResult.ok) {
          result.successIds.push(id)
        } else {
          result.failedIds.push(id)
          result.issues.push(buildTerminalIssue(id, 'failed', 'send-failed', writeResult.error))
        }
      } catch (error) {
        result.failedIds.push(id)
        result.issues.push(buildTerminalIssue(id, 'failed', 'send-failed', String(error)))
        console.warn('[PromptSender] terminal write threw:', { action, terminalId: id, error: String(error) })
      }
    }

    if (result.failedIds.length > 0) {
      console.warn('[PromptSender] terminal send failed:', { action, failedIds: result.failedIds })
    }

    return result
  }, [buildTerminalIssue])

  // Send command to specified terminal
  const handleSendToTerminals = useCallback(async (terminalIds: string[], content: string) => {
    window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
    return sendContentToTerminals(terminalIds, content, 'send')
  }, [sendContentToTerminals])

  // Execute command in terminal (send carriage return)
  const handleExecuteOnTerminals = useCallback(async (terminalIds: string[]) => {
    window.electronAPI.telemetry.track('prompt/use', { action: 'execute' })
    return writeToTerminals(terminalIds, '\r', 'execute')
  }, [writeToTerminals])

  const handleSendAndExecuteOnTerminals = useCallback(async (terminalIds: string[], content: string) => {
    window.electronAPI.telemetry.track('prompt/use', { action: 'sendAndExecute' })
    const sendResult = await sendContentToTerminals(terminalIds, content, 'send-and-execute:send')
    const deliveredIds = getDeliveredTerminalIds(sendResult)
    if (deliveredIds.length === 0) {
      return sendResult
    }

    await waitForSendAndExecuteSettle()

    const executeResult = await writeToTerminals(deliveredIds, '\r', 'send-and-execute:execute')
    const result = createTerminalBatchResult({
      successIds: executeResult.successIds,
      failedIds: sendResult.failedIds,
      issues: [...sendResult.issues]
    })

    if (executeResult.sentOnlyIds.length > 0) {
      result.sentOnlyIds.push(...executeResult.sentOnlyIds)
    }

    if (executeResult.failedIds.length > 0) {
      result.sentOnlyIds.push(...executeResult.failedIds)
      result.issues.push(
        ...executeResult.issues.map((issue) => ({
          ...issue,
          status: 'sent-only' as const
        }))
      )
    }

    if (result.failedIds.length > 0 || result.sentOnlyIds.length > 0) {
      console.warn('[PromptSender] sendAndExecute completed with issues:', {
        successIds: result.successIds,
        sentOnlyIds: result.sentOnlyIds,
        failedIds: result.failedIds,
        issues: result.issues
      })
    }

    return result
  }, [sendContentToTerminals, writeToTerminals])

  const handleRetrySchedule = useCallback(async (promptId: string) => {
    const prompt = allPromptsForSchedule.find(p => p.id === promptId)
    const schedule = state.promptSchedules.find(s => s.promptId === promptId)
    if (!prompt || !schedule) return

    const tab = state.tabs.find(t => t.id === schedule.tabId)
    if (!tab) return

    const availableTerminalIds = schedule.targetTerminalIds.filter(terminalId =>
      tab.terminals.some(t => t.id === terminalId)
    )

    const result = await handleSendAndExecuteOnTerminals(availableTerminalIds, prompt.content)
    const now = Date.now()
    const successLog: ExecutionLogEntry = {
      timestamp: now,
      success: result.failedIds.length === 0 && result.sentOnlyIds.length === 0,
      targetTerminalIds: availableTerminalIds,
      error: result.failedIds.length > 0 || result.sentOnlyIds.length > 0
        ? summarizeScheduleBatchError(result)
        : undefined
    }

    setScheduleNotifications(prev => prev.filter(n => !(n.promptId === promptId && n.type === 'missed-execution')))

    if (result.failedIds.length > 0 || result.sentOnlyIds.length > 0) {
      updateSchedule({
        ...schedule,
        missedExecutions: 0,
        lastError: summarizeScheduleBatchError(result),
        executionLog: appendScheduleLogEntry(schedule, successLog)
      })
      return
    }

    const executedCount = schedule.executedCount + 1

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
  }, [
    allPromptsForSchedule,
    handleSendAndExecuteOnTerminals,
    state.promptSchedules,
    state.tabs,
    summarizeScheduleBatchError,
    updateSchedule
  ])

  useScheduleEngine({
    isLoaded,
    schedules: state.promptSchedules,
    tabs: tabsForSchedule,
    allPrompts: allPromptsForSchedule,
    updateSchedule,
    onNotification: handleScheduleNotification,
    onSendAndExecute: handleSendAndExecuteOnTerminals,
    summarizeBatchError: summarizeScheduleBatchError
  })

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
  const [showChangeLog, setShowChangeLog] = useState(false)
  const [changeLogResult, setChangeLogResult] = useState<CurrentChangelogResult | null>(null)
  const [changeLogLoading, setChangeLogLoading] = useState(false)
  const [showFeedbackModal, setShowFeedbackModal] = useState(false)
  // Track the panel state before Settings opened for each tab during the current Settings session.
  const panelBeforeSettingsByTabRef = useRef<Record<string, 'prompt' | null>>({})
  const showSettingsRef = useRef(false)
  showSettingsRef.current = showSettings
  const activePanelRef = useRef<'prompt' | null>(activeTab?.activePanel ?? null)
  activePanelRef.current = activeTab?.activePanel ?? null
  const activeTabIdRef = useRef<string | null>(activeTab?.id ?? null)
  activeTabIdRef.current = activeTab?.id ?? null
  const [projectEditorOpen, setProjectEditorOpen] = useState(false)
  const [projectEditorTerminalId, setProjectEditorTerminalId] = useState<string | null>(null)
  const [projectEditorCwd, setProjectEditorCwd] = useState<string | null>(null)
  const [projectEditorDirty, setProjectEditorDirty] = useState(false)
  const [projectEditorOpenRequest, setProjectEditorOpenRequest] = useState<ProjectEditorOpenRequest | null>(null)
  const projectEditorDebugOpenedRef = useRef(false)
  const projectEditorProfileScenarioRef = useRef(false)
  const projectEditorOpenRequestIdRef = useRef(0)

  const clearPanelBeforeSettings = useCallback(() => {
    panelBeforeSettingsByTabRef.current = {}
  }, [])

  const getPanelBeforeSettings = useCallback((tabId: string | null | undefined, fallbackPanel: 'prompt' | null = null) => {
    if (!tabId) return fallbackPanel
    const panelByTab = panelBeforeSettingsByTabRef.current
    return Object.prototype.hasOwnProperty.call(panelByTab, tabId)
      ? panelByTab[tabId]
      : fallbackPanel
  }, [])

  // True panel switching handling
  const handlePanelChangeWithSettings = useCallback((panel: 'prompt' | 'settings' | null) => {
    if (panel === 'settings') {
      const currentTabId = activeTabIdRef.current
      if (currentTabId) {
        panelBeforeSettingsByTabRef.current[currentTabId] = activePanelRef.current
      }
      setShowSettings(true)
      updateActiveTab({ activePanel: null })
    } else {
      clearPanelBeforeSettings()
      setShowSettings(false)
      updateActiveTab({ activePanel: panel })
    }
  }, [clearPanelBeforeSettings, updateActiveTab])

  // Close Settings
  const handleCloseSettings = useCallback(() => {
    clearPanelBeforeSettings()
    setShowSettings(false)
  }, [clearPanelBeforeSettings])

  const handleToggleChangeLog = useCallback(() => {
    setShowChangeLog((previous) => {
      const next = !previous
      if (next) {
        setShowFeedbackModal(false)
      }
      return next
    })
  }, [])

  const handleCloseChangeLog = useCallback(() => {
    setShowChangeLog(false)
  }, [])

  useEffect(() => {
    let active = true
    setChangeLogLoading(true)
    void window.electronAPI.changelog.getCurrent(locale)
      .then((nextResult) => {
        if (!active) return
        setChangeLogResult(nextResult)
      })
      .catch((error) => {
        if (!active) return
        setChangeLogResult({
          success: false,
          locale,
          tag: null,
          reason: 'read-failed',
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        if (!active) return
        setChangeLogLoading(false)
      })
    return () => {
      active = false
    }
  }, [locale])

  const handleFeedbackToggle = useCallback(() => {
    setShowFeedbackModal((previous) => {
      const next = !previous
      if (next) {
        setShowChangeLog(false)
      }
      return next
    })
  }, [])

  const handleCloseFeedbackModal = useCallback(() => {
    setShowFeedbackModal(false)
  }, [])
  // Conditionally close Settings on Task/Tab switch
  // Only closes if the relevant panel state is 'prompt'; otherwise keeps Settings open
  const handleTryCloseSettingsOnSwitch = useCallback((targetTabId?: string, targetActivePanel?: 'prompt' | null) => {
    if (!showSettingsRef.current) return
    const resolvedTabId = targetTabId ?? activeTabIdRef.current
    // focusTerminal (same tab): use the active tab's saved panel state for this Settings session
    // switchTab: prefer the target tab's saved panel state, otherwise fall back to targetTab.activePanel
    const panelToCheck = getPanelBeforeSettings(resolvedTabId, targetActivePanel ?? null)
    if (panelToCheck === 'prompt') {
      clearPanelBeforeSettings()
      setShowSettings(false)
    }
  }, [clearPanelBeforeSettings, getPanelBeforeSettings])

  const handleOpenProjectEditor = useCallback(async (
    terminalId: string,
    options?: {
      filePath?: string | null
      repoRoot?: string | null
    }
  ) => {
    if (
      projectEditorOpen &&
      projectEditorTerminalId &&
      projectEditorTerminalId !== terminalId &&
      projectEditorDirty
    ) {
      const confirmed = window.confirm(t('app.unsavedProjectEditorConfirm'))
      if (!confirmed) return
    }

    const persistedCwd = state.tabs
      .flatMap((tab) => tab.terminals)
      .find((terminal) => terminal.id === terminalId)?.lastCwd ?? null
    setProjectEditorTerminalId(terminalId)
    setProjectEditorCwd(persistedCwd)
    setProjectEditorOpen(true)
    try {
      const resolvedCwd = await window.electronAPI.git.getTerminalCwd(terminalId) || persistedCwd
      setProjectEditorCwd(resolvedCwd)
    } catch {
      setProjectEditorCwd(persistedCwd)
    }
    if (typeof options?.filePath === 'string' && options.filePath.trim()) {
      projectEditorOpenRequestIdRef.current += 1
      setProjectEditorOpenRequest({
        id: projectEditorOpenRequestIdRef.current,
        terminalId,
        filePath: options.filePath ?? null,
        repoRoot: options.repoRoot ?? null
      })
    }
  }, [projectEditorOpen, projectEditorTerminalId, projectEditorDirty, state.tabs, t])

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
        const shellKind = await resolveTerminalShellKind(terminalId)
        const cdCommand = buildChangeDirectoryCommand(platform, debugCwd, shellKind)
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

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<ProjectEditorOpenEventDetail>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      void handleOpenProjectEditor(terminalId, {
        filePath: customEvent.detail?.filePath ?? null,
        repoRoot: customEvent.detail?.repoRoot ?? null
      })
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
    setProjectEditorOpenRequest(null)
  }, [])

  // Register closeSettings callback to Context
  useEffect(() => {
    registerCloseSettings(handleCloseSettings)
    return () => {
      registerCloseSettings(null)
    }
  }, [registerCloseSettings, handleCloseSettings])

  // Register tryCloseSettingsOnSwitch callback to Context
  useEffect(() => {
    registerTryCloseSettingsOnSwitch(handleTryCloseSettingsOnSwitch)
    return () => {
      registerTryCloseSettingsOnSwitch(null)
    }
  }, [registerTryCloseSettingsOnSwitch, handleTryCloseSettingsOnSwitch])

  // Restore focus when ProjectEditor or Settings panel closes
  const prevProjectEditorOpenRef = useRef(projectEditorOpen)
  const projectEditorTerminalIdRef = useRef(projectEditorTerminalId)
  const prevShowSettingsRef = useRef(showSettings)
  const prevShowChangeLogRef = useRef(showChangeLog)
  const prevShowFeedbackModalRef = useRef(showFeedbackModal)

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

  useEffect(() => {
    const wasOpen = prevShowChangeLogRef.current
    prevShowChangeLogRef.current = showChangeLog
    if (wasOpen && !showChangeLog) {
      const terminalId = activeTab?.activeTerminalId
      if (terminalId) {
        requestAnimationFrame(() => {
          terminalSessionManager.focusIfNeeded(terminalId)
        })
      }
    }
  }, [showChangeLog, activeTab?.activeTerminalId])

  useEffect(() => {
    const wasOpen = prevShowFeedbackModalRef.current
    prevShowFeedbackModalRef.current = showFeedbackModal
    if (wasOpen && !showFeedbackModal) {
      const terminalId = activeTab?.activeTerminalId
      if (terminalId) {
        requestAnimationFrame(() => {
          terminalSessionManager.focusIfNeeded(terminalId)
        })
      }
    }
  }, [showFeedbackModal, activeTab?.activeTerminalId])

  // Change working directory
  const handleChangeWorkDir = useCallback(async (terminalIds: string[], directory: string) => {
    const platform = window.electronAPI.platform

    for (const id of terminalIds) {
      const shellKind = await resolveTerminalShellKind(id)
      const fullCommand = buildChangeDirectoryCommand(platform, directory, shellKind)
      await window.electronAPI.terminal.write(id, fullCommand)
      setTerminalLastCwd(id, directory)
    }
  }, [setTerminalLastCwd])

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
            result = createTerminalBatchResult({
              failedIds: [terminalId],
              issues: [buildTerminalIssue(terminalId, 'failed', 'send-failed')]
            })
        }

        // When sent successfully and there is content, save to Prompt history
        if (getDeliveredTerminalIds(result).length > 0 && content.trim()) {
          addPrompt({ title: '', content: content.trim(), pinned: false })
        }

        window.electronAPI.terminal.sendPromptBridgeResponse(requestId, {
          success: result.successIds.length > 0 && result.sentOnlyIds.length === 0 && result.failedIds.length === 0,
          successIds: result.successIds,
          sentOnlyIds: result.sentOnlyIds,
          failedIds: result.failedIds,
          issues: result.issues,
          error: result.issues[0]?.message
        })
      } catch (error) {
        window.electronAPI.terminal.sendPromptBridgeResponse(requestId, {
          success: false,
          successIds: [],
          sentOnlyIds: [],
          failedIds: [terminalId],
          error: String(error)
        })
      }
    })
    return cleanup
  }, [
    addPrompt,
    buildTerminalIssue,
    handleExecuteOnTerminals,
    handleSendAndExecuteOnTerminals,
    handleSendToTerminals
  ])

  // Restore project editor subpage after app restart
  const editorSubpageRestoredRef = useRef(false)
  useEffect(() => {
    if (editorSubpageRestoredRef.current) return
    if (!isLoaded || !activeTab) return
    if (activeTab.activeSubpage !== 'editor') return
    const terminalId = activeTab.subpageTerminalId || activeTab.activeTerminalId || activeTab.terminals[0]?.id
    if (!terminalId) return
    editorSubpageRestoredRef.current = true
    const persistedCwd = activeTab.terminals.find(t => t.id === terminalId)?.lastCwd ?? null
    setProjectEditorTerminalId(terminalId)
    setProjectEditorCwd(persistedCwd)
    setProjectEditorOpen(true)
  }, [isLoaded, activeTab])

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
      {telemetryConsent === null && (
        <ConsentDialog onConsent={handleTelemetryConsent} />
      )}
      <TabBar />
      <div className="app-body">
        <Sidebar
          activePanel={displayActivePanel}
          isFeedbackOpen={showFeedbackModal}
          layoutMode={layoutMode}
          isChangeLogOpen={showChangeLog}
          onPanelChange={handlePanelChangeWithSettings}
          onFeedbackToggle={handleFeedbackToggle}
          onLayoutChange={handleLayoutChange}
          onChangeLogToggle={handleToggleChangeLog}
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
              onPersistTerminalCwd={setTerminalLastCwd}
              onOpenProjectEditor={handleOpenProjectEditor}
              projectEditorTerminalId={projectEditorTerminalId}
              projectEditorCwd={projectEditorCwd}
              focusRequest={terminalFocusRequest}
              shortcutAction={terminalShortcutAction}
              projectEditorOpen={projectEditorOpen}
              projectEditorOpenRequest={projectEditorOpenRequest}
              onCloseProjectEditor={handleCloseProjectEditor}
              onProjectEditorDirtyChange={setProjectEditorDirty}
            />
          ))}
        </div>
      </main>
      </div>
      <ChangeLogModal
        isOpen={showChangeLog}
        onClose={handleCloseChangeLog}
        result={changeLogResult}
        isLoading={changeLogLoading}
      />
      <FeedbackModal isOpen={showFeedbackModal} onClose={handleCloseFeedbackModal} />
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
  const { focusEditor, submitEditor, closeSettings, tryCloseSettingsOnSwitch } = usePromptActions()
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
            // Keep Settings open while switching Tasks inside the same Tab.
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
            // Conditionally close Settings based on the target tab's pre-Settings panel context.
            tryCloseSettingsOnSwitch(targetTab.id, targetTab.activePanel)
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
        window.electronAPI.telemetry.track('dropdown/development', { action: 'gitDiff' })
        dispatchTerminalAction('gitDiff')
        break
      }
      case 'terminalGitHistory': {
        window.electronAPI.telemetry.track('dropdown/development', { action: 'gitHistory' })
        dispatchTerminalAction('gitHistory')
        break
      }
      case 'terminalChangeWorkDir': {
        window.electronAPI.telemetry.track('dropdown/workspace', { action: 'changeDir' })
        dispatchTerminalAction('changeWorkDir')
        break
      }
      case 'terminalOpenWorkDir': {
        window.electronAPI.telemetry.track('dropdown/workspace', { action: 'openDir' })
        dispatchTerminalAction('openWorkDir')
        break
      }
      case 'terminalProjectEditor': {
        window.electronAPI.telemetry.track('dropdown/development', { action: 'editor' })
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
  }, [activeTab, state.tabs, switchTab, updateActiveTab, getLastFocusedTerminalId, setLastFocusedTerminalId, setLastFocusOwner, closeSettings, tryCloseSettingsOnSwitch, focusEditor, submitEditor, requestTerminalFocus])

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
