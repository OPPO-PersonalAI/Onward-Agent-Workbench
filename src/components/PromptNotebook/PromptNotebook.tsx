/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, memo, startTransition } from 'react'
import { Prompt, PromptSendRecord } from '../../types/electron'
import type { TerminalBatchResult, TerminalInfo } from '../../types/prompt'
import type { ResolvedLayout } from '../../utils/layout-mode'
import type { EditorDraft, PromptCleanupConfig, PromptSchedule } from '../../types/tab.d.ts'
import { usePromptActions, type PromptDraftSnapshot, type PromptInputDispatcher } from '../../contexts/PromptActionsContext'
import { useSettings } from '../../contexts/SettingsContext'
import { createDefaultPromptInputSettings, resolvePromptTargets, shouldClearPromptDraft, type PromptInputResult } from '../../utils/prompt-input'
import { formatPromptInputFailureDetails } from '../../utils/prompt-input-labels'
import { isAnyModalOpen } from '../../utils/modal-dismiss'
import { buildAccelerator } from '../../utils/keyboard'
import { performanceTrace } from '../../utils/performance-trace'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { decideDraftPreservation } from './prompt-draft-preservation'
import { pendingStateFlush, snapshotPromptDraft } from '../../utils/pending-state-flush'
import type { ScheduleNotification } from '../../hooks/useScheduleEngine'
import { useModalEscape, useModalOpenRegistration } from '../../hooks/useModalEscape'
import { PromptSearch } from './PromptSearch'
import { PromptList } from './PromptList'
import { PromptSender } from './PromptSender'
import { PromptEditorContextMenu, type ContextMenuSnapshot } from './PromptEditorContextMenu'
import { ScheduleConfigModal } from './ScheduleConfigModal'
import { ScheduleNotificationBar } from './ScheduleNotification'
import { useI18n } from '../../i18n/useI18n'
import { transformVirtualPaddingForSend, type ImportPrepareResult } from '../../utils/prompt-io'
import {
  extractDroppedFilePaths,
  formatDroppedFilePathsForShell,
  hasExternalFilesInDataTransfer
} from '../../utils/terminal-file-drop'
import {
  applyPromptMentionCandidate,
  buildPromptContentWithImagesForSend,
  computePromptEditorTextInsertion,
  createPromptImageBatchId,
  decidePromptEditorPasteAction,
  detectPromptMentionTrigger,
  formatPromptImageToken,
  normalizePromptImageAttachments,
  renumberPromptImageAttachmentsAfterRemove,
  renumberPromptTextAfterImageRemove,
  type PromptImageAttachment
} from '../../utils/prompt-images'
import {
  PromptAttachmentLightbox,
  PromptAttachmentMentionMenu,
  PromptAttachmentStrip,
  type PromptAttachmentMentionMenuState
} from './PromptAttachmentWidgets'

import { createTerminalBatchResult, hasDeliveredTerminals } from '../../utils/terminal-batch'
import {
  computeBottomHistoryResize,
  computeBottomSenderResize,
  computeOuterPanelResize,
  DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH,
  DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH,
  DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT,
  DEFAULT_PROMPT_PANEL_RIGHT_WIDTH,
  type PromptPanelPosition
} from '../../utils/prompt-panel-layout'
import { buildPromptTaskHistorySummary } from './promptTaskHistory'
import { PROMPT_COLORS, type PromptColor } from './prompt-colors'
import './PromptNotebook.css'

type PromptColorFilter = 'red' | 'yellow' | 'green' | null
const DEFAULT_INPUT_SETTINGS = createDefaultPromptInputSettings()

// Lazily created by the autotest-only API. Any active tab can release the
// captured tab's gate after a switch; ordinary application builds never use it.
let inputAckBarrierForAutotest: { tabId: string; waiters: Set<() => void> } | null = null
function releaseInputAckForAutotest() {
  const barrier = inputAckBarrierForAutotest
  inputAckBarrierForAutotest = null
  barrier?.waiters.forEach(resolve => resolve())
}

interface PromptColorFilterStats {
  red: number
  yellow: number
  green: number
}

interface PromptTaskFilterOption {
  taskNumber: number
  count: number
}

interface PromptNotebookProps {
  terminals: TerminalInfo[]
  /** Active Task layout, mirrored by the sender's Task selector. */
  taskLayout: ResolvedLayout
  onSendAndExecute: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onTerminalRename: (id: string, newTitle: string) => void
  onChangeWorkDir: (terminalIds: string[], directory: string) => void
  position?: PromptPanelPosition
  width: number
  onWidthChange: (width: number) => void
  rightWidth?: number
  onRightWidthChange?: (width: number) => void
  bottomHeight?: number
  onBottomHeightChange?: (height: number) => void
  bottomHistoryWidth?: number
  onBottomHistoryWidthChange?: (width: number) => void
  bottomSenderWidth?: number
  onBottomSenderWidthChange?: (width: number) => void
  // Tab prompt related
  prompts: Prompt[]
  onAddPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>, targetTabId?: string) => void
  onAddPinnedPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'pinned'>) => void
  onUpdatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  onDeletePrompt: (promptId: string) => void
  onPinPrompt: (promptId: string) => void
  onUnpinPrompt: (promptId: string) => void
  onReorderPinnedPrompts: (dragId: string, targetId: string, position: 'before' | 'after') => void
  globalPromptIds: string[]
  promptCleanup: PromptCleanupConfig
  onExportAllPrompts: () => Promise<void> | void
  onPrepareImport: () => Promise<ImportPrepareResult>
  onExecuteImport: (globals: Prompt[], locals: Prompt[]) => void
  onTouchPromptLastUsed: (promptId: string) => void
  onCleanupPrompts: (options: { keepDays: number; deleteColored: boolean }) => void
  onUpdatePromptCleanup: (partial: Partial<PromptCleanupConfig>) => void
  promptEditorHeight: number
  onPromptEditorHeightChange: (height: number) => void
  // Per-tab prompt input mode toggle ('canvas' = click-anywhere virtual cursor,
  // 'line' = native line-by-line). Defaults to 'line' upstream.
  promptInputMode: 'canvas' | 'line'
  onPromptInputModeChange: (mode: 'canvas' | 'line') => void
  // Draft related
  editorDraft: EditorDraft | null
  onEditorDraftChange: (draft: EditorDraft | null) => void
  // Shortcut configuration
  addToHistoryShortcut: string | null
  // Hidden support
  hidden?: boolean
  activeTab: boolean
  // Related to scheduled tasks
  tabId: string
  scheduleMap: Map<string, PromptSchedule>
  scheduleNotifications: ScheduleNotification[]
  onAddSchedule: (schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => void
  onUpdateSchedule: (schedule: PromptSchedule) => void
  onDeleteSchedule: (promptId: string) => void
  onDismissScheduleNotification: (promptId: string, type: ScheduleNotification['type']) => void
  onRetrySchedule: (promptId: string) => void
  /**
   * Resolve the latest Git branch for a terminal id (cached transient info).
   * Used by the prompt editor's right-click context menu to offer
   * "insert current branch name". Optional — when missing the menu item is
   * rendered disabled.
   */
  getTerminalBranch?: (terminalId: string) => string | null
}

interface DeleteConfirmState {
  isOpen: boolean
  promptId: string
  promptTitle: string
}

interface ImportConfirmState {
  isOpen: boolean
  globals: Prompt[]
  locals: Prompt[]
  duplicateCount: number
}

interface RetentionConfirmState {
  isOpen: boolean
  mode: 'manual' | 'auto'
  keepDays: number
  isCustomDays: boolean
  customDaysInput: string
  deleteColored: boolean | null
}

export const PromptNotebook = memo(function PromptNotebook({
  terminals,
  taskLayout,
  onSendAndExecute,
  onTerminalRename,
  onChangeWorkDir,
  position = 'left',
  width,
  onWidthChange,
  rightWidth = DEFAULT_PROMPT_PANEL_RIGHT_WIDTH,
  onRightWidthChange,
  bottomHeight = DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT,
  onBottomHeightChange,
  bottomHistoryWidth = DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH,
  onBottomHistoryWidthChange,
  bottomSenderWidth = DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH,
  onBottomSenderWidthChange,
  prompts,
  onAddPrompt,
  onAddPinnedPrompt,
  onUpdatePrompt,
  onDeletePrompt,
  onPinPrompt,
  onUnpinPrompt,
  onReorderPinnedPrompts,
  globalPromptIds,
  promptCleanup,
  onExportAllPrompts,
  onPrepareImport,
  onExecuteImport,
  onTouchPromptLastUsed,
  onCleanupPrompts,
  onUpdatePromptCleanup,
  promptEditorHeight,
  onPromptEditorHeightChange,
  promptInputMode,
  onPromptInputModeChange,
  editorDraft,
  onEditorDraftChange,
  addToHistoryShortcut,
  hidden = false,
  activeTab,
  tabId,
  scheduleMap,
  scheduleNotifications,
  onAddSchedule,
  onUpdateSchedule,
  onDeleteSchedule,
  onDismissScheduleNotification,
  onRetrySchedule,
  getTerminalBranch
}: PromptNotebookProps) {
  const { t, locale } = useI18n()
  const { settings } = useSettings()
  const inputSettings = settings?.promptInput ?? DEFAULT_INPUT_SETTINGS
  const { getDraftController, registerInputDispatcher, dispatchInputAction, isActiveInputTab, isInputBlocked, publishInputState } = usePromptActions()
  const [selectedTerminalIds, setSelectedTerminalIds] = useState<string[]>([])
  const selectedTerminalIdsRef = useRef(selectedTerminalIds)
  const unavailableSelectionRef = useRef<string[]>([])
  const selectionFlushRef = useRef<(() => void) | null>(null)
  const registerSelectionFlush = useCallback((flush: () => void) => {
    selectionFlushRef.current = flush
    return () => {
      if (selectionFlushRef.current === flush) selectionFlushRef.current = null
    }
  }, [])
  const [inputBusy, setInputBusy] = useState(false)
  const inputBusyRef = useRef(false)
  const [inputNotice, setInputNotice] = useState<{ text: string; error: boolean } | null>(null)
  const inputDispatcherRef = useRef<PromptInputDispatcher>(async () => false)
  const inputMountedRef = useRef(true)
  useEffect(() => {
    inputMountedRef.current = true
    return () => {
      inputMountedRef.current = false
      if (window.electronAPI?.debug?.autotest && inputAckBarrierForAutotest?.tabId === tabId) releaseInputAckForAutotest()
    }
  }, [tabId])
  useLayoutEffect(() => registerInputDispatcher(tabId, (...args) => inputDispatcherRef.current(...args)), [registerInputDispatcher, tabId])
  useLayoutEffect(() => {
    publishInputState(tabId, { selectedIds: selectedTerminalIds, busy: inputBusy, notice: inputNotice })
  }, [publishInputState, tabId, selectedTerminalIds, inputBusy, inputNotice])
  const handleInputSelectionChange = useCallback((ids: string[]) => {
    const previous = selectedTerminalIdsRef.current
    if (previous.length === ids.length && previous.every((id, index) => id === ids[index])) return
    selectedTerminalIdsRef.current = ids
    setSelectedTerminalIds(ids)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'select-targets', tabId, count: ids.length })
  }, [tabId])
  useEffect(() => {
    // Retain unavailable manual targets until an explicit selection gesture.
    // Pruning here would silently reroute a default action to the active Task.
    const unavailable = selectedTerminalIds.filter(id => !terminals.some(terminal => terminal.id === id))
    const previous = unavailableSelectionRef.current
    if (previous.length === unavailable.length && previous.every((id, index) => id === unavailable[index])) return
    unavailableSelectionRef.current = unavailable
    if (unavailable.some(id => !previous.includes(id))) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, {
        phase: 'selection-unavailable', tabId, selected: selectedTerminalIds.length, unavailable: unavailable.length
      })
    }
  }, [selectedTerminalIds, terminals, tabId])
  const handleInputAction = useCallback((actionId: string) => dispatchInputAction(tabId, actionId, undefined, 'button'), [dispatchInputAction, tabId])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [filterEnabled, setFilterEnabled] = useState(false)
  const [targetsEnabled, setTargetsEnabled] = useState(false)
  const [activeColorFilter, setActiveColorFilter] = useState<PromptColorFilter>(null)
  const [activeTaskFilter, setActiveTaskFilter] = useState<number | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const saveMessageTimerRef = useRef<number>(0)

  const showSaveMessage = useCallback((msg: { type: 'success' | 'error'; text: string }) => {
    setSaveMessage(msg)
    if (saveMessageTimerRef.current) {
      window.clearTimeout(saveMessageTimerRef.current)
    }
    saveMessageTimerRef.current = window.setTimeout(() => {
      setSaveMessage(null)
    }, 2000)
  }, [])

  // Draft auto-preserve feedback floats over the prompt editor itself: the
  // search-box status slot truncates when the notebook panel is narrow
  // (user-resizable width), while the editor is exactly where the user is
  // looking when the double-click fires.
  const [draftToast, setDraftToast] = useState<string | null>(null)
  const draftToastTimerRef = useRef<number>(0)
  const showDraftToast = useCallback((text: string) => {
    setDraftToast(text)
    if (draftToastTimerRef.current) {
      window.clearTimeout(draftToastTimerRef.current)
    }
    draftToastTimerRef.current = window.setTimeout(() => {
      setDraftToast(null)
    }, 2000)
  }, [])
  useEffect(() => {
    return () => {
      if (draftToastTimerRef.current) {
        window.clearTimeout(draftToastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (saveMessageTimerRef.current) {
        window.clearTimeout(saveMessageTimerRef.current)
      }
    }
  }, [])

  const writeClipboardText = useCallback(async (text: string) => {
    if (window.electronAPI?.clipboard?.writeText) {
      await window.electronAPI.clipboard.writeText(text)
      return
    }
    await navigator.clipboard.writeText(text)
  }, [])
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null)
  const [appendContent, setAppendContent] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorTitle, setEditorTitle] = useState('')
  const [editorImages, setEditorImages] = useState<PromptImageAttachment[]>(() =>
    normalizePromptImageAttachments(editorDraft?.images)
  )
  // Refs that track the latest editor values so the debug API effect
  // does not need editorContent / editorTitle in its dependency array.
  const editorContentRef = useRef(editorContent)
  const editorTitleRef = useRef(editorTitle)
  const editorImagesRef = useRef(editorImages)
  const lastEditorSendToTaskRef = useRef<{ content: string; terminalId: string } | null>(null)
  editorContentRef.current = editorContent
  editorTitleRef.current = editorTitle
  editorImagesRef.current = editorImages
  const platform = window.electronAPI?.platform ?? 'darwin'
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    isOpen: false,
    promptId: '',
    promptTitle: ''
  })
  const [importConfirm, setImportConfirm] = useState<ImportConfirmState>({
    isOpen: false,
    globals: [],
    locals: [],
    duplicateCount: 0
  })
  const [retentionConfirm, setRetentionConfirm] = useState<RetentionConfirmState>({
    isOpen: false,
    mode: 'manual',
    keepDays: 7,
    isCustomDays: false,
    customDaysInput: '',
    deleteColored: null
  })

  // Schedule config modal state
  const [scheduleModalPrompt, setScheduleModalPrompt] = useState<Prompt | null>(null)

  // Send history viewer state
  const [sendHistoryPrompt, setSendHistoryPrompt] = useState<Prompt | null>(null)

  // One dispatcher owns buttons and shortcut IPC. The mutable latch is set
  // before the first await, so two events in one React frame cannot both send.
  inputDispatcherRef.current = async (actionId, targetId, origin = 'button') => {
    const action = inputSettings.actions.find(candidate => candidate.id === actionId)
    const reject = (reason: string, text: string) => {
      setInputNotice({ text, error: true })
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'rejected', tabId, actionId, origin, reason })
      return false
    }
    if (!isActiveInputTab(tabId)) return reject('inactive-tab', t('promptInput.runtime.unavailable'))
    if (inputBusyRef.current) return reject('in-flight', t('promptInput.runtime.busy'))
    if (isInputBlocked() || isAnyModalOpen()) return reject('blocked', t('promptInput.runtime.blocked'))
    if (!action) return reject('action-unavailable', t('promptInput.runtime.failed'))
    selectionFlushRef.current?.()
    const controller = getDraftController(tabId)
    if (!controller) return reject('draft-unavailable', t('promptInput.runtime.failed'))
    const snapshotStartedAt = performance.now()
    const snapshot: PromptDraftSnapshot = controller.snapshot()
    if (snapshot.composing) return reject('composing', t('promptInput.runtime.blocked'))
    const rawContent = action.includePrompt ? transformVirtualPaddingForSend(snapshot.content) : ''
    const snapshotImages = action.includePrompt ? normalizePromptImageAttachments(snapshot.images) : []
    const content = action.includePrompt
      ? buildPromptContentWithImagesForSend(rawContent, snapshotImages, platform)
      : ''
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, {
      phase: 'snapshot', tabId, revision: snapshot.revision, contentLen: content.length,
      durationMs: performance.now() - snapshotStartedAt
    })
    if (action.includePrompt && !content) return reject('empty-draft', t('promptInput.runtime.empty'))
    const targets = resolvePromptTargets(action, terminals.map(terminal => terminal.id),
      terminals.find(terminal => terminal.isActive)?.id ?? null, selectedTerminalIdsRef.current, targetId)
    if (!targets.ids.length) return reject(targets.reason ?? 'target-unavailable', t(targets.reason === 'target-conflict'
      ? 'promptInput.runtime.conflict' : 'promptInput.runtime.unavailable'))
    const api = window.electronAPI?.promptInput
    if (!api) return reject('api-unavailable', t('promptInput.runtime.failed'))

    inputBusyRef.current = true
    setInputBusy(true)
    setInputNotice(null)
    const startedAt = performance.now()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, {
      phase: 'send', tabId, actionId, origin, targets: targets.ids.length,
      includePrompt: action.includePrompt, terminalKey: action.terminalKey,
      contentLen: content.length, revision: snapshot.revision
    })
    let delivered = false
    try {
      const legacyAction = !action.includePrompt ? 'execute' : action.terminalKey === 'None' ? 'send' : 'sendAndExecute'
      try {
        window.electronAPI.telemetry.track('prompt/use', { action: legacyAction })
      } catch {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'usage-track-failed', tabId, actionId })
      }
      // Preserve the legacy Prompt action contract at the shared delivery boundary.
      // Only accepted invocations own a flow; its span waits for every recipient.
      const flowId = performanceTrace.enabled
        ? performanceTrace.createFlowId(legacyAction === 'sendAndExecute' ? 'prompt-send-execute' : `prompt-${legacyAction}`)
        : undefined
      const traceArgs = { action: legacyAction, terminalIds: targets.ids, flowId, origin }
      if (flowId) performanceTrace.recordFlowStart('ui.prompt.action', flowId, traceArgs, 'prompt')
      const results = await performanceTrace.timeAsync('ui.prompt.action', traceArgs, async () => {
        let successCount = 0
        let sentOnlyCount = 0
        try {
          return await Promise.all(targets.ids.map(async (terminalId) => {
            let result: PromptInputResult
            try {
              if (flowId) performanceTrace.setActiveTerminalFlow(terminalId, flowId)
              result = await api.send(terminalId, { content, includePrompt: action.includePrompt, terminalKey: action.terminalKey })
            } catch {
              result = { ok: false, phase: action.includePrompt ? 'content' : 'key', contentDelivered: false, reason: 'unavailable' }
            }
            if (result.ok) successCount += 1
            else if (result.contentDelivered) sentOnlyCount += 1
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, {
              phase: 'target-result', tabId, actionId, terminalId, ok: result.ok,
              sendPhase: result.phase, contentDelivered: result.contentDelivered, reason: result.reason
            })
            return { terminalId, result }
          }))
        } finally {
          if (flowId) performanceTrace.recordFlowEnd('ui.prompt.action.done', flowId, {
            action: legacyAction, successCount, sentOnlyCount,
            failedCount: targets.ids.length - successCount - sentOnlyCount
          }, 'prompt')
        }
      }, 'prompt')
      if (window.electronAPI?.debug?.autotest && inputAckBarrierForAutotest?.tabId === tabId) {
        const barrier = inputAckBarrierForAutotest
        await new Promise<void>(resolve => { barrier.waiters.add(resolve) })
      }
      const succeeded = results.filter(({ result }) => result.ok).length
      const allSucceeded = succeeded === targets.ids.length
      delivered = results.some(({ result }) => result.contentDelivered || result.ok)
      // Key-only actions never save unsent text. Each content dispatch records
      // its immutable snapshot once, including failed targets in mixed results.
      if (action.includePrompt && results.some(({ result }) => result.contentDelivered)) {
        const sentAt = Date.now()
        const sendHistory: PromptSendRecord[] = results.map(({ terminalId, result }) => ({
          taskId: terminalId,
          taskName: terminals.find(terminal => terminal.id === terminalId)?.title ?? terminalId,
          sentAt,
          action: action.terminalKey === 'None' ? 'send' : 'sendAndExecute',
          inputActionId: action.id,
          inputTerminalKey: action.terminalKey,
          inputResult: result
        }))
        onAddPrompt({
          title: snapshot.title.trim(),
          content: snapshotImages.length > 0 ? rawContent : content,
          color: snapshot.color,
          pinned: false,
          sendHistory,
          ...(snapshotImages.length > 0 ? { images: snapshotImages } : {})
        }, tabId)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, {
          phase: 'history-recorded', tabId, revision: snapshot.revision, targets: targets.ids.length, contentLen: content.length
        })
      }
      const currentRevision = controller.snapshot().revision
      if (inputMountedRef.current && shouldClearPromptDraft(action.includePrompt, allSucceeded, snapshot.revision, currentRevision)) {
        if (controller.clearIfRevision(snapshot.revision)) setSelectedId(null)
      } else {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, {
          phase: 'clear-skipped', tabId, sentRevision: snapshot.revision, currentRevision,
          reason: !inputMountedRef.current ? 'unmounted' : !action.includePrompt ? 'key-only' : !allSucceeded ? 'partial-failure' : 'newer-draft'
        })
      }
      if (inputMountedRef.current) {
        const contentOnly = results.some(({ result }) => !result.ok && result.contentDelivered)
        const unsafeMultiline = results.every(({ result }) => result.reason === 'unsafe-multiline-send')
        const summary = allSucceeded
          ? t('promptInput.runtime.sent', { count: succeeded })
          : contentOnly ? t('promptInput.runtime.keyFailed')
            : unsafeMultiline ? t('promptInput.runtime.unsafeMultiline')
              : succeeded ? t('promptInput.runtime.partial', { sent: succeeded, failed: targets.ids.length - succeeded })
                : t('promptInput.runtime.failed')
        const details = formatPromptInputFailureDetails(results.map(({ terminalId, result }) => ({
          taskName: terminals.find(terminal => terminal.id === terminalId)?.title
            || t('promptInput.runtime.task', { number: terminals.findIndex(terminal => terminal.id === terminalId) + 1 }),
          result
        })), t)
        setInputNotice({ error: !allSucceeded, text: details ? `${summary}\n${details}` : summary })
      }
      return allSucceeded
    } catch {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'failed', tabId, actionId, delivered })
      if (inputMountedRef.current) setInputNotice({ error: true, text: t(delivered ? 'promptInput.runtime.historyFailed' : 'promptInput.runtime.failed') })
      return false
    } finally {
      inputBusyRef.current = false
      if (inputMountedRef.current) setInputBusy(false)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, {
        phase: 'complete', tabId, actionId, durationMs: performance.now() - startedAt
      })
    }
  }

  const recordPromptEdit = useCallback((field: 'title' | 'content', value: string) => {
    if (!performanceTrace.enabled) return
    performanceTrace.recordInstant('ui.prompt.edit', {
      field,
      mode: editingPrompt ? 'edit' : 'new',
      ...performanceTrace.summarizeText('payload', value)
    }, 'prompt')
  }, [editingPrompt])

  const handleEditorContentChange = useCallback((nextContent: string) => {
    setEditorContent(nextContent)
    recordPromptEdit('content', nextContent)
  }, [recordPromptEdit])

  const handleEditorTitleChange = useCallback((nextTitle: string) => {
    setEditorTitle(nextTitle)
    recordPromptEdit('title', nextTitle)
  }, [recordPromptEdit])

  const handleEditorImagesChange = useCallback((nextImages: PromptImageAttachment[]) => {
    setEditorImages(nextImages)
  }, [])

  const promptTaskHistory = useMemo(
    () => buildPromptTaskHistorySummary(prompts, terminals.length),
    [prompts, terminals.length]
  )

  const promptMatchesTaskFilter = useCallback((promptId: string, taskNumber: number) => {
    return promptTaskHistory.promptTaskNumbers.get(promptId)?.includes(taskNumber) ?? false
  }, [promptTaskHistory])

  const searchMatchedPrompts = useMemo(() => {
    if (!searchKeyword.trim()) return prompts
    const keyword = searchKeyword.toLowerCase()
    return prompts.filter(p =>
      p.title.toLowerCase().includes(keyword) ||
      p.content.toLowerCase().includes(keyword)
    )
  }, [prompts, searchKeyword])

  const filteredPrompts = useMemo(() => {
    return searchMatchedPrompts.filter((prompt) => {
      if (filterEnabled && activeColorFilter && prompt.color !== activeColorFilter) {
        return false
      }
      if (filterEnabled && activeTaskFilter !== null && !promptMatchesTaskFilter(prompt.id, activeTaskFilter)) {
        return false
      }
      return true
    })
  }, [searchMatchedPrompts, filterEnabled, activeColorFilter, activeTaskFilter, promptMatchesTaskFilter])

  const colorFilterStats = useMemo<PromptColorFilterStats>(() => {
    const stats: PromptColorFilterStats = { red: 0, yellow: 0, green: 0 }
    searchMatchedPrompts.forEach((prompt) => {
      if (filterEnabled && activeTaskFilter !== null && !promptMatchesTaskFilter(prompt.id, activeTaskFilter)) {
        return
      }
      if (prompt.color === 'red') stats.red += 1
      if (prompt.color === 'yellow') stats.yellow += 1
      if (prompt.color === 'green') stats.green += 1
    })
    return stats
  }, [searchMatchedPrompts, filterEnabled, activeTaskFilter, promptMatchesTaskFilter])

  const taskFilterOptions = useMemo<PromptTaskFilterOption[]>(() => {
    return promptTaskHistory.allTaskNumbers.map((taskNumber) => {
      let count = 0
      searchMatchedPrompts.forEach((prompt) => {
        if (filterEnabled && activeColorFilter && prompt.color !== activeColorFilter) {
          return
        }
        if (promptMatchesTaskFilter(prompt.id, taskNumber)) {
          count += 1
        }
      })
      return { taskNumber, count }
    })
  }, [promptTaskHistory.allTaskNumbers, searchMatchedPrompts, filterEnabled, activeColorFilter, promptMatchesTaskFilter])

  const setFilterEnabledWithReset = useCallback((nextEnabled: boolean) => {
    setFilterEnabled(nextEnabled)
    if (!nextEnabled) {
      setActiveColorFilter(null)
      setActiveTaskFilter(null)
    }
  }, [])

  // Sync selection and edit state after cleanup
  useEffect(() => {
    if (selectedId && !prompts.some(p => p.id === selectedId)) {
      setSelectedId(null)
    }
    if (editingPrompt && !prompts.some(p => p.id === editingPrompt.id)) {
      setEditingPrompt(null)
    }
  }, [prompts, selectedId, editingPrompt])

  // Debug API (only exposed in automated testing mode)
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest || !activeTab) return

    const mapScheduleToDebug = (s: PromptSchedule) => ({
      promptId: s.promptId,
      tabId: s.tabId,
      targetTerminalIds: s.targetTerminalIds,
      scheduleType: s.scheduleType,
      status: s.status,
      nextExecutionAt: s.nextExecutionAt,
      executedCount: s.executedCount,
      executionLogCount: (s.executionLog ?? []).length,
      lastError: s.lastError ?? null,
      missedExecutions: s.missedExecutions,
      absoluteTime: s.absoluteTime ?? null,
      relativeOffsetMs: s.relativeOffsetMs ?? null,
      maxExecutions: s.maxExecutions,
      recurrence: s.recurrence ?? null,
      executionLog: s.executionLog ?? []
    })

    const api = {
      getPromptCount: () => prompts.length,
      getPrompts: () => prompts.map(p => ({
        id: p.id,
        title: p.title,
        content: p.content,
        pinned: p.pinned,
        color: p.color ?? undefined,
        lastUsedAt: p.lastUsedAt,
        taskNumbers: promptTaskHistory.promptTaskNumbers.get(p.id) ?? [],
        sendHistoryCount: p.sendHistory?.length ?? 0,
        sendHistory: p.sendHistory ?? [],
        images: p.images ?? []
      })),
      getVisiblePromptItems: () => filteredPrompts.map(p => ({
        id: p.id,
        title: p.title,
        color: p.color ?? undefined,
        taskNumbers: promptTaskHistory.promptTaskNumbers.get(p.id) ?? []
      })),
      getSelectedPromptId: () => selectedId,
      getLastEditorSendToTask: () => lastEditorSendToTaskRef.current,
      selectPrompt: (promptId: string) => {
        if (!prompts.some(prompt => prompt.id === promptId)) return false
        setSelectedId(promptId)
        return true
      },
      setPromptColor: (promptId: string, color: PromptColorFilter) => {
        if (color !== null && color !== 'red' && color !== 'yellow' && color !== 'green') {
          return false
        }
        const prompt = prompts.find(item => item.id === promptId)
        if (!prompt) return false
        onUpdatePrompt({ ...prompt, color }, true)
        return true
      },
      copyPrompt: async (promptId: string) => {
        const prompt = prompts.find(item => item.id === promptId)
        if (!prompt) return false
        try {
          await writeClipboardText(prompt.content)
          showSaveMessage({ type: 'success', text: t('promptNotebook.copySuccess') })
          return true
        } catch (error) {
          console.error('Failed to copy Prompt content:', error)
          showSaveMessage({ type: 'error', text: t('promptNotebook.copyFailed') })
          return false
        }
      },
      getColorFilterState: () => ({
        enabled: filterEnabled,
        activeColor: activeColorFilter,
        counts: colorFilterStats
      }),
      setColorFilter: (color: PromptColorFilter) => {
        if (color !== null && color !== 'red' && color !== 'yellow' && color !== 'green') {
          return false
        }
        if (color !== null) {
          setFilterEnabled(true)
        }
        setActiveColorFilter(color)
        return true
      },
      getTaskFilterState: () => ({
        enabled: filterEnabled,
        activeTaskNumber: activeTaskFilter,
        options: taskFilterOptions
      }),
      setTaskFilter: (taskNumber: number | null) => {
        if (taskNumber !== null && !Number.isFinite(taskNumber)) return false
        if (taskNumber !== null) {
          setFilterEnabled(true)
        }
        setActiveTaskFilter(taskNumber)
        return true
      },
      isFilterEnabled: () => filterEnabled,
      setFilterEnabled: (nextEnabled: boolean) => {
        setFilterEnabledWithReset(nextEnabled)
        return true
      },
      isTargetsEnabled: () => targetsEnabled,
      setTargetsEnabled: (nextEnabled: boolean) => {
        setTargetsEnabled(nextEnabled)
        return true
      },
      reorderPinnedPrompts: (dragId: string, targetId: string, position: 'before' | 'after') => {
        if (!prompts.some(prompt => prompt.id === dragId && prompt.pinned)) return false
        if (!prompts.some(prompt => prompt.id === targetId && prompt.pinned)) return false
        onReorderPinnedPrompts(dragId, targetId, position)
        return true
      },
      getCleanupConfig: () => ({
        autoEnabled: promptCleanup.autoEnabled,
        autoKeepDays: promptCleanup.autoKeepDays,
        autoDeleteColored: promptCleanup.autoDeleteColored,
        lastAutoCleanupAt: promptCleanup.lastAutoCleanupAt
      }),
      getEditorContent: () => editorContentRef.current,
      getLiveDraftSnapshot: () => getDraftController(tabId)?.snapshot() ?? null,
      isInputBusy: () => inputBusyRef.current,
      setInputAckHeld: (held: boolean) => {
        releaseInputAckForAutotest()
        if (held) inputAckBarrierForAutotest = { tabId, waiters: new Set() }
      },
      isInputAckWaiting: () => (inputAckBarrierForAutotest?.waiters.size ?? 0) > 0,
      setDraftSyncHeld: (held: boolean) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: { setDraftSyncHeld: (held: boolean) => void }
        }).__onwardPromptEditorContentControl
        control?.setDraftSyncHeld(held)
      },
      isDraftSyncHeld: () => (window as unknown as {
        __onwardPromptEditorContentControl?: { isDraftSyncHeld: () => boolean }
      }).__onwardPromptEditorContentControl?.isDraftSyncHeld() ?? false,
      getEditorHeight: () => {
        const editor = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor') as HTMLElement | null
        if (!editor) return null
        return editor.getBoundingClientRect().height
      },
      getPersistedEditorHeight: () => promptEditorHeight,
      setEditorContent: (content: string) => {
        // Drive the real editor-local snapshot. Keep the debounced preview
        // control for older tests that wait for a committed parent render.
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: { setContent: (v: string) => void; isDraftSyncHeld: () => boolean }
        }).__onwardPromptEditorContentControl
        control?.setContent(content)
        if (!control?.isDraftSyncHeld()) setEditorContent(content)
      },
      setEditorTitle: (value: string) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: { setTitle: (title: string) => void }
        }).__onwardPromptEditorContentControl
        control?.setTitle(value)
      },
      submitEditor: () => {
        const snapshot = getDraftController(tabId)?.snapshot()
        const snapImages = normalizePromptImageAttachments(snapshot?.images ?? editorImagesRef.current)
        if (!editorContentRef.current.trim() && snapImages.length === 0) return
        onAddPrompt({
          title: editorTitleRef.current.trim(),
          content: editorContentRef.current.trim(),
          pinned: false,
          color: undefined,
          ...(snapImages.length > 0 ? { images: snapImages } : {})
        })
      },
      // Prompt Editor file-drop + image attachment Debug API
      dropFilesIntoEditor: (filePaths: string[]) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            dropFiles: (paths: string[]) => { rawPaths: string[]; formattedText: string } | null
          }
        }).__onwardPromptEditorContentControl
        return control?.dropFiles(filePaths) ?? null
      },
      getLastEditorFileDrop: () => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            getLastFileDrop: () => { rawPaths: string[]; formattedText: string } | null
          }
        }).__onwardPromptEditorContentControl
        return control?.getLastFileDrop() ?? null
      },
      getEditorImages: () => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            getImages: () => PromptImageAttachment[]
          }
        }).__onwardPromptEditorContentControl
        return control?.getImages() ?? []
      },
      pasteClipboardIntoEditor: async (options?: {
        filePaths?: string[]
        autotestImage?: { width: number; height: number }
      }) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            pasteClipboard: (opts?: {
              filePaths?: string[]
              autotestImage?: { width: number; height: number }
            }) => Promise<unknown>
          }
        }).__onwardPromptEditorContentControl
        return (await control?.pasteClipboard(options)) ?? null
      },
      removeEditorImage: async (index: number) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            removeImage: (index: number) => Promise<boolean>
          }
        }).__onwardPromptEditorContentControl
        return (await control?.removeImage(index)) ?? false
      },
      insertEditorImageToken: (index: number) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            insertImageToken: (index: number) => boolean
          }
        }).__onwardPromptEditorContentControl
        return control?.insertImageToken(index) ?? false
      },
      openEditorImagePreview: (index: number) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            openImagePreview: (index: number) => boolean
          }
        }).__onwardPromptEditorContentControl
        return control?.openImagePreview(index) ?? false
      },
      closeEditorImagePreview: () => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            closeImagePreview: () => void
          }
        }).__onwardPromptEditorContentControl
        control?.closeImagePreview()
      },
      getEditorImagePreviewIndex: () => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            getImagePreviewIndex: () => number | null
          }
        }).__onwardPromptEditorContentControl
        return control?.getImagePreviewIndex() ?? null
      },
      getEditorMentionCandidates: () => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            getMentionCandidates: () => PromptImageAttachment[]
          }
        }).__onwardPromptEditorContentControl
        return control?.getMentionCandidates() ?? []
      },
      selectEditorMentionCandidate: (index: number) => {
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: {
            selectMentionCandidate: (index: number) => boolean
          }
        }).__onwardPromptEditorContentControl
        return control?.selectMentionCandidate(index) ?? false
      },
      // Scheduled task Debug API
      getSchedules: () => [...scheduleMap.values()].map(mapScheduleToDebug),
      getScheduleForPrompt: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        return s ? mapScheduleToDebug(s) : null
      },
      createSchedule: (promptId: string, type: 'relative' | 'absolute' | 'recurring', options?: {
        offsetMs?: number
        time?: number
        recurrence?: { startTime: number; intervalMs: number }
      }) => {
        if (terminals.length === 0) return false
        const now = Date.now()
        const offsetMs = options?.offsetMs ?? 5 * 60 * 1000
        const absTime = options?.time ?? now + 60 * 60 * 1000
        const rec = options?.recurrence ?? { startTime: now + 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 }

        let nextExec = now
        if (type === 'relative') nextExec = now + offsetMs
        else if (type === 'absolute') nextExec = absTime
        else {
          // Calculate next execution time based on interval pattern
          if (rec.startTime > now) {
            nextExec = rec.startTime
          } else {
            const elapsed = now - rec.startTime
            const periods = Math.ceil(elapsed / rec.intervalMs)
            nextExec = rec.startTime + periods * rec.intervalMs
          }
        }

        onAddSchedule({
          promptId,
          tabId,
          targetTerminalIds: [terminals[0].id],
          scheduleType: type,
          relativeOffsetMs: type === 'relative' ? offsetMs : undefined,
          absoluteTime: type === 'absolute' ? absTime : undefined,
          recurrence: type === 'recurring' ? rec : undefined,
          maxExecutions: type === 'recurring' ? null : 1,
          nextExecutionAt: nextExec,
          status: 'active',
          lastError: null
        })
        return true
      },
      pauseSchedule: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        if (!s || s.status !== 'active') return false
        onUpdateSchedule({ ...s, status: 'paused' })
        return true
      },
      resumeSchedule: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        if (!s || s.status !== 'paused') return false
        onUpdateSchedule({ ...s, status: 'active' })
        return true
      },
      deleteSchedule: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        if (!s) return false
        onDeleteSchedule(promptId)
        return true
      },
      openSendHistory: (promptId: string) => {
        const prompt = prompts.find((p) => p.id === promptId)
        if (!prompt) return false
        setSendHistoryPrompt(prompt)
        return true
      },
      // DOM-derived so the api effect needs no dependency on the state.
      isSendHistoryOpen: () => document.querySelector('.prompt-send-history-overlay') !== null,
      getDockPosition: () => position,
      getPanelDimensions: () => ({
        width,
        rightWidth,
        bottomHeight,
        bottomHistoryWidth,
        bottomSenderWidth,
        promptEditorHeight
      })
    }
    ;(window as any).__onwardPromptNotebookDebug = api
    return () => {
      if ((window as any).__onwardPromptNotebookDebug === api) {
        delete (window as any).__onwardPromptNotebookDebug
      }
    }
  }, [
    activeTab,
    prompts,
    promptCleanup,
    promptEditorHeight,
    position,
    width,
    rightWidth,
    bottomHeight,
    bottomHistoryWidth,
    bottomSenderWidth,
    onAddPrompt,
    scheduleMap,
    tabId,
    terminals,
    onAddSchedule,
    onUpdateSchedule,
    onDeleteSchedule,
    onReorderPinnedPrompts,
    promptTaskHistory,
    filteredPrompts,
    selectedId,
    onUpdatePrompt,
    showSaveMessage,
    writeClipboardText,
    t,
    filterEnabled,
    targetsEnabled,
    activeColorFilter,
    colorFilterStats,
    activeTaskFilter,
    taskFilterOptions,
    setFilterEnabledWithReset,
    getDraftController
  ])

  // Debounced preview only; dispatch reads the editor-local live snapshot.
  const editorContentForSend = useMemo(() => {
    const rawText = transformVirtualPaddingForSend(editorContent)
    return buildPromptContentWithImagesForSend(rawText, editorImages, platform)
  }, [editorContent, editorImages, platform])

  // Create new Prompt (commit)
  const handleSubmit = useCallback((
    title: string,
    content: string,
    color?: 'red' | 'yellow' | 'green' | null,
    images?: PromptImageAttachment[]
  ) => {
    const normalizedImages = normalizePromptImageAttachments(images)
    onAddPrompt({
      title,
      content,
      pinned: false,
      color: color || undefined,
      ...(normalizedImages.length > 0 ? { images: normalizedImages } : {})
    })
    setEditingPrompt(null)
  }, [onAddPrompt])

  // Delete Prompt (show confirmation box)
  const handleDelete = useCallback((id: string) => {
    const prompt = prompts.find(p => p.id === id)
    setDeleteConfirm({
      isOpen: true,
      promptId: id,
      promptTitle: prompt?.title || t('promptNotebook.untitledPrompt')
    })
  }, [prompts, t])

  const handleConfirmDelete = useCallback(() => {
    onDeletePrompt(deleteConfirm.promptId)

    if (selectedId === deleteConfirm.promptId) {
      setSelectedId(null)
    }
    if (editingPrompt?.id === deleteConfirm.promptId) {
      setEditingPrompt(null)
    }

    setDeleteConfirm({ isOpen: false, promptId: '', promptTitle: '' })
  }, [deleteConfirm, onDeletePrompt, selectedId, editingPrompt])

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirm({ isOpen: false, promptId: '', promptTitle: '' })
  }, [])

  const resetRetentionConfirm = useCallback(() => {
    setRetentionConfirm({
      isOpen: false,
      mode: 'manual',
      keepDays: 7,
      isCustomDays: false,
      customDaysInput: '',
      deleteColored: null
    })
  }, [])

  const openRetentionConfirm = useCallback((options: { mode: 'manual' | 'auto'; keepDays: number; isCustomDays?: boolean }) => {
    setRetentionConfirm({
      isOpen: true,
      mode: options.mode,
      keepDays: options.keepDays,
      isCustomDays: !!options.isCustomDays,
      customDaysInput: '',
      deleteColored: null
    })
  }, [])

  const handleRetentionKeepDays = useCallback((days: number) => {
    openRetentionConfirm({ mode: 'manual', keepDays: days, isCustomDays: false })
  }, [openRetentionConfirm])

  const handleRetentionKeepCustom = useCallback(() => {
    openRetentionConfirm({ mode: 'manual', keepDays: 0, isCustomDays: true })
  }, [openRetentionConfirm])

  const handleToggleAutoCleanup = useCallback((nextEnabled: boolean) => {
    if (!nextEnabled) {
      onUpdatePromptCleanup({ autoEnabled: false })
      return
    }
    openRetentionConfirm({ mode: 'auto', keepDays: 30, isCustomDays: false })
  }, [onUpdatePromptCleanup, openRetentionConfirm])

  const handleExportAllPrompts = useCallback(() => {
    void onExportAllPrompts()
  }, [onExportAllPrompts])

  const handleImportPrompts = useCallback(async () => {
    const result = await onPrepareImport()
    // User canceled file selection — show nothing
    if (!result.success && !result.error) return
    if (!result.success) {
      showSaveMessage({ type: 'error', text: result.error || t('promptNotebook.import.failed') })
      return
    }
    const total = result.globals.length + result.locals.length
    if (total === 0 && result.duplicateCount === 0) {
      showSaveMessage({ type: 'success', text: t('promptNotebook.import.emptyFile') })
      return
    }
    if (total === 0 && result.duplicateCount > 0) {
      showSaveMessage({ type: 'success', text: t('promptNotebook.import.allDuplicates', { count: result.duplicateCount }) })
      return
    }
    // Has importable content — open confirmation dialog
    setImportConfirm({
      isOpen: true,
      globals: result.globals,
      locals: result.locals,
      duplicateCount: result.duplicateCount
    })
  }, [onPrepareImport, showSaveMessage, t])

  const handleConfirmImport = useCallback(() => {
    const { globals, locals, duplicateCount } = importConfirm
    onExecuteImport(globals, locals)
    setImportConfirm({ isOpen: false, globals: [], locals: [], duplicateCount: 0 })
    const translationKey = duplicateCount > 0
      ? 'promptNotebook.import.successWithSkipped'
      : 'promptNotebook.import.success'
    showSaveMessage({
      type: 'success',
      text: t(translationKey, {
        global: globals.length,
        local: locals.length,
        skipped: duplicateCount
      })
    })
  }, [importConfirm, onExecuteImport, showSaveMessage, t])

  const handleCancelImport = useCallback(() => {
    setImportConfirm({ isOpen: false, globals: [], locals: [], duplicateCount: 0 })
  }, [])

  const handleConfirmRetention = useCallback(() => {
    const resolvedKeepDays = retentionConfirm.isCustomDays
      ? Number.parseInt(retentionConfirm.customDaysInput, 10)
      : retentionConfirm.keepDays

    if (!Number.isFinite(resolvedKeepDays) || resolvedKeepDays <= 0) {
      return
    }
    if (retentionConfirm.deleteColored === null) {
      return
    }

    if (retentionConfirm.mode === 'manual') {
      onCleanupPrompts({
        keepDays: resolvedKeepDays,
        deleteColored: retentionConfirm.deleteColored
      })
    } else {
      const now = Date.now()
      onCleanupPrompts({
        keepDays: 30,
        deleteColored: retentionConfirm.deleteColored
      })
      onUpdatePromptCleanup({
        autoEnabled: true,
        autoKeepDays: 30,
        autoDeleteColored: retentionConfirm.deleteColored,
        lastAutoCleanupAt: now
      })
    }

    resetRetentionConfirm()
  }, [retentionConfirm, onCleanupPrompts, onUpdatePromptCleanup, resetRetentionConfirm])

  const handleCancelRetention = useCallback(() => {
    resetRetentionConfirm()
  }, [resetRetentionConfirm])

  // Select Prompt
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  // Double click to edit — but never at the cost of the user's current
  // input: auto-preserve non-empty, modified editor content into history
  // FIRST, then load the double-clicked prompt. Skips the save when the
  // editor still holds the untouched original of the entry being edited
  // (browsing history by double-click must not duplicate entries).
  const handleDoubleClick = useCallback((prompt: Prompt) => {
    const snapshot = getDraftController(tabId)?.snapshot()
    const normalizedContent = transformVirtualPaddingForSend(snapshot?.content ?? editorContentRef.current)
    const draftTitle = snapshot?.title ?? editorTitleRef.current
    const draftImages = normalizePromptImageAttachments(snapshot?.images ?? editorImagesRef.current)
    const decision = decideDraftPreservation({
      normalizedContent,
      title: draftTitle,
      imagePaths: draftImages.map(img => img.path),
      editingOriginal: editingPrompt
        ? {
            normalizedContent: transformVirtualPaddingForSend(editingPrompt.content),
            title: editingPrompt.title,
            imagePaths: editingPrompt.images?.map(img => img.path)
          }
        : null
    })
    if (decision.preserve) {
      const savePreserved = async () => {
        let preservedImages = draftImages
        const sourceBatchId = editingPrompt?.images?.[0]?.batchId
        const draftBatchId = draftImages[0]?.batchId
        if (sourceBatchId && draftBatchId && sourceBatchId === draftBatchId && window.electronAPI?.clipboard?.clonePromptImageBatch) {
          const clonedBatchId = createPromptImageBatchId()
          const cloned = await window.electronAPI.clipboard.clonePromptImageBatch(sourceBatchId, clonedBatchId, draftImages)
          if (cloned.length > 0) preservedImages = cloned
        }
        onAddPrompt({
          title: draftTitle.trim(),
          content: normalizedContent,
          pinned: false,
          color: editingPrompt?.color ?? undefined,
          ...(preservedImages.length > 0 ? { images: preservedImages } : {})
        })
      }
      void savePreserved()
      showDraftToast(t('promptNotebook.draftPreserved'))
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT_AUTO_PRESERVED, {
      preserved: decision.preserve,
      reason: decision.reason,
      contentLen: normalizedContent.length,
      hadEditingSource: Boolean(editingPrompt)
    })
    setEditingPrompt(prompt)
  }, [editingPrompt, onAddPrompt, showDraftToast, t, getDraftController, tabId])

  // Cancel edit
  const handleCancelEdit = useCallback(() => {
    setEditingPrompt(null)
  }, [])

  // Toggle pin state
  const handleTogglePin = useCallback((id: string) => {
    const isGlobal = globalPromptIds.includes(id)
    if (isGlobal) {
      onUnpinPrompt(id)
    } else {
      onPinPrompt(id)
    }
  }, [globalPromptIds, onPinPrompt, onUnpinPrompt])

  // Append content to the input box
  const handleAppend = useCallback((prompt: Prompt) => {
    setAppendContent(prev => prev ? `${prev}\n\n${prompt.content}` : prompt.content)
    onTouchPromptLastUsed(prompt.id)
  }, [onTouchPromptLastUsed])

  // Toggle colors (preserves timestamp, does not affect sorting)
  const handleColorChange = useCallback((id: string, color: 'red' | 'yellow' | 'green' | null) => {
    const prompt = prompts.find(p => p.id === id)
    if (!prompt) return
    onUpdatePrompt({ ...prompt, color }, true)
  }, [prompts, onUpdatePrompt])

  const handleToggleColorFilter = useCallback((color: Exclude<PromptColorFilter, null>) => {
    setFilterEnabled(true)
    setActiveColorFilter((prev) => prev === color ? null : color)
  }, [])

  const handleToggleTaskFilter = useCallback((taskNumber: number) => {
    setFilterEnabled(true)
    setActiveTaskFilter((prev) => prev === taskNumber ? null : taskNumber)
  }, [])

  const handleToggleFilterEnabled = useCallback((nextEnabled: boolean) => {
    setFilterEnabledWithReset(nextEnabled)
  }, [setFilterEnabledWithReset])

  const handleToggleTargetsEnabled = useCallback((nextEnabled: boolean) => {
    setTargetsEnabled(nextEnabled)
  }, [])

  const handleCopyPrompt = useCallback(async (prompt: Prompt) => {
    try {
      await writeClipboardText(prompt.content)
      showSaveMessage({ type: 'success', text: t('promptNotebook.copySuccess') })
    } catch (error) {
      console.error('Failed to copy Prompt content:', error)
      showSaveMessage({ type: 'error', text: t('promptNotebook.copyFailed') })
    }
  }, [showSaveMessage, t, writeClipboardText])

  // Scheduled task operations
  const handleSetSchedule = useCallback((prompt: Prompt) => {
    setScheduleModalPrompt(prompt)
  }, [])

  const handleEditSchedule = useCallback((prompt: Prompt) => {
    setScheduleModalPrompt(prompt)
  }, [])

  const handleCancelSchedule = useCallback((promptId: string) => {
    onDeleteSchedule(promptId)
  }, [onDeleteSchedule])

  const handleScheduleConfirm = useCallback((schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => {
    const existing = scheduleMap.get(schedule.promptId)
    if (existing) {
      onUpdateSchedule({
        ...existing,
        ...schedule,
        // Keep runtime statistics while editing to avoid clearing history
        executedCount: existing.executedCount,
        createdAt: existing.createdAt,
        lastExecutedAt: existing.lastExecutedAt,
        missedExecutions: existing.missedExecutions,
        executionLog: existing.executionLog
      })
    } else {
      onAddSchedule(schedule)
    }
    setScheduleModalPrompt(null)
  }, [onAddSchedule, onUpdateSchedule, scheduleMap])

  const handleViewSendHistory = useCallback((prompt: Prompt) => {
    setSendHistoryPrompt(prompt)
  }, [])

  const handleAppendContentUsed = useCallback(() => {
    setAppendContent('')
  }, [])

  const handleSaveSuccess = useCallback(() => {
    showSaveMessage({ type: 'success', text: t('promptNotebook.saved') })
  }, [showSaveMessage, t])

  const handleScheduleCancel = useCallback(() => {
    setScheduleModalPrompt(null)
  }, [])

  const handlePauseSchedule = useCallback((promptId: string) => {
    const schedule = scheduleMap.get(promptId)
    if (schedule && schedule.status === 'active') {
      onUpdateSchedule({ ...schedule, status: 'paused' })
    }
  }, [scheduleMap, onUpdateSchedule])

  const handleResumeSchedule = useCallback((promptId: string) => {
    const schedule = scheduleMap.get(promptId)
    if (schedule && schedule.status === 'paused') {
      onUpdateSchedule({ ...schedule, status: 'active' })
    }
  }, [scheduleMap, onUpdateSchedule])

  const buildSendRecords = useCallback((
    terminalIds: string[],
    action: PromptSendRecord['action'],
    result?: PromptSendRecord['result']
  ): PromptSendRecord[] => {
    const now = Date.now()
    return terminalIds.map(tid => {
      const terminal = terminals.find(t => t.id === tid)
      return {
        taskId: tid,
        taskName: terminal?.title || tid,
        sentAt: now,
        action,
        result
      }
    })
  }, [terminals])

  // Send-and-execute triggered from the prompt context menu. Unlike the main
  // sender, this must NOT clear the editor, drop the current selection, or
  // exit editing state — the user may have unrelated content in the editor.
  // It still records send history and touches lastUsedAt on the target prompt.
  const runContextMenuSendAndExecute = useCallback(async (prompt: Prompt, terminalIds: string[]) => {
    if (terminalIds.length === 0) return
    try {
      const resolvedContent = buildPromptContentWithImagesForSend(
        prompt.content,
        normalizePromptImageAttachments(prompt.images),
        platform
      )
      const rawResult = await onSendAndExecute(terminalIds, resolvedContent)
      if (!hasDeliveredTerminals(rawResult)) return
      const sendRecords = [
        ...buildSendRecords(rawResult.successIds, 'sendAndExecute', 'executed'),
        ...buildSendRecords(rawResult.sentOnlyIds, 'sendAndExecute', 'sent-only')
      ]
      // Merge lastUsedAt refresh and sendHistory into a single updatePrompt to
      // avoid a stale-object overwrite: touchPromptLastUsed + updatePrompt in
      // two hops would race on the same prev snapshot, and the second hop —
      // carrying the closure's old lastUsedAt under preserveTimestamp — wins.
      const existingHistory = prompt.sendHistory ?? []
      const mergedHistory = sendRecords.length > 0
        ? [...sendRecords, ...existingHistory].slice(0, 100)
        : existingHistory
      onUpdatePrompt(
        { ...prompt, lastUsedAt: Date.now(), sendHistory: mergedHistory },
        true
      )
    } catch (error) {
      console.error('Prompt context-menu send-and-execute failed:', error)
    }
  }, [onSendAndExecute, onUpdatePrompt, buildSendRecords])

  const handleContextMenuSendAndExecute = useCallback((prompt: Prompt, terminalId: string) => {
    void runContextMenuSendAndExecute(prompt, [terminalId])
  }, [runContextMenuSendAndExecute])

  const handleContextMenuSendAndExecuteAll = useCallback((prompt: Prompt) => {
    void runContextMenuSendAndExecute(prompt, terminals.map(t => t.id))
  }, [runContextMenuSendAndExecute, terminals])

  // Explicit editor-menu text keeps its legacy transport while sharing the
  // input latch and revision guard with the configured action workflow.
  const handleSendAndExecute = useCallback(async (terminalIds: string[], content: string): Promise<TerminalBatchResult> => {
    const fallback = createTerminalBatchResult({ failedIds: [...terminalIds] })
    const controller = getDraftController(tabId)
    const snapshot = controller?.snapshot()
    if (inputBusyRef.current || !snapshot || snapshot.composing) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'editor-menu-rejected', tabId })
      return fallback
    }
    inputBusyRef.current = true
    setInputBusy(true)
    const startedAt = performance.now()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'editor-menu-send', tabId, targets: terminalIds.length })
    try {
      const sentWholeDraft = content === transformVirtualPaddingForSend(snapshot.content)
      const snapshotImages = normalizePromptImageAttachments(snapshot.images)
      const resolvedContent = buildPromptContentWithImagesForSend(
        content,
        snapshotImages,
        platform,
        undefined,
        { appendUnreferenced: sentWholeDraft }
      )
      const rawResult = await onSendAndExecute(terminalIds, resolvedContent)
      const sendRecords = [
        ...buildSendRecords(rawResult.successIds, 'sendAndExecute', 'executed'),
        ...buildSendRecords(rawResult.sentOnlyIds, 'sendAndExecute', 'sent-only')
      ]
      if (hasDeliveredTerminals(rawResult) && snapshot) {
        onAddPrompt({
          title: snapshot.title.trim(),
          content: sentWholeDraft && snapshotImages.length > 0 ? content : resolvedContent,
          color: snapshot.color,
          pinned: false,
          sendHistory: sendRecords,
          ...(sentWholeDraft && snapshotImages.length > 0 ? { images: snapshotImages } : {})
        }, tabId)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, { phase: 'history-recorded', tabId, revision: snapshot.revision, origin: 'editor-menu' })
        if (inputMountedRef.current && sentWholeDraft && !rawResult.failedIds.length && !rawResult.sentOnlyIds.length) {
          if (controller?.clearIfRevision(snapshot.revision)) setSelectedId(null)
        } else {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, { phase: 'clear-skipped', tabId, origin: 'editor-menu', sentWholeDraft })
        }
      }
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, {
        phase: 'editor-menu-result', tabId, succeeded: rawResult.successIds.length,
        sentOnly: rawResult.sentOnlyIds.length, failed: rawResult.failedIds.length
      })
      return rawResult
    } catch (error) {
      console.error('Prompt send and execute failed:', error)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'editor-menu-failed', tabId })
      return fallback
    } finally {
      inputBusyRef.current = false
      if (inputMountedRef.current) setInputBusy(false)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'editor-menu-complete', tabId, durationMs: performance.now() - startedAt })
    }
  }, [onSendAndExecute, buildSendRecords, getDraftController, tabId, onAddPrompt, platform])

  // Save the editor's right-click selection as a brand-new pinned prompt.
  // Derive a sensible title from the first non-empty line, capped to 40
  // chars; the full text becomes the prompt body. This is the reverse of
  // "Append to editor" — closing the loop between the editor and the pinned
  // list without forcing the user to leave the editor surface.
  const handleSavePinnedFromEditor = useCallback((selection: string) => {
    const trimmed = selection.trim()
    if (!trimmed) return
    const firstLine = trimmed.split('\n').find(line => line.trim().length > 0) ?? trimmed
    const compact = firstLine.replace(/\s+/g, ' ').trim()
    const title = compact.length > 40 ? `${compact.slice(0, 39)}…` : compact
    onAddPinnedPrompt({ title, content: trimmed, color: undefined })
    showSaveMessage({ type: 'success', text: t('promptNotebook.editor.contextMenu.savedAsPin') })
  }, [onAddPinnedPrompt, showSaveMessage, t])

  // Right-click "Send to Task" from inside the editor (not a saved Prompt).
  // The plain text path; does not annotate any Prompt's sendHistory.
  const handleSendEditorToTask = useCallback((content: string, terminalId: string) => {
    const sendContent = transformVirtualPaddingForSend(content)
    if (!sendContent) return
    lastEditorSendToTaskRef.current = { content: sendContent, terminalId }
    void handleSendAndExecute([terminalId], sendContent)
  }, [handleSendAndExecute])

  // Keep the global pinned Prompt order from Prompt History. Users can
  // reorder that list manually, and the editor import menu mirrors it.
  const pinnedPrompts = useMemo(() => {
    return prompts.filter(p => p.pinned)
  }, [prompts])

  const activeTerminal = useMemo(() => {
    return terminals.find(t => t.isActive) ?? terminals[0] ?? null
  }, [terminals])

  const editorCwd = activeTerminal?.lastCwd ?? null
  const editorTaskTitle = activeTerminal?.title ?? null
  const editorBranch = activeTerminal && getTerminalBranch
    ? getTerminalBranch(activeTerminal.id)
    : null

  const notebookRef = useRef<HTMLDivElement>(null)

  // Drag to adjust outer panel dimension (width in left/right, height in bottom)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startSize = position === 'bottom'
      ? bottomHeight
      : position === 'right'
        ? rightWidth
        : width
    const bodyClass = position === 'bottom'
      ? 'resizing-prompt-panel-vertical'
      : 'resizing-prompt-panel'

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextSize = computeOuterPanelResize({
        position,
        startSize,
        startX,
        startY,
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY
      })
      if (position === 'bottom') {
        onBottomHeightChange?.(nextSize)
      } else if (position === 'right') {
        onRightWidthChange?.(nextSize)
      } else {
        onWidthChange(nextSize)
      }
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove(bodyClass)
    }

    document.body.classList.add(bodyClass)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [position, width, rightWidth, bottomHeight, onWidthChange, onRightWidthChange, onBottomHeightChange])

  // Drag left internal resizer in bottom 3-column mode (adjusts history column width)
  const handleBottomHistoryResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (position !== 'bottom') return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = bottomHistoryWidth
    const currentSenderWidth = bottomSenderWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const containerWidth = notebookRef.current?.getBoundingClientRect().width
      const nextWidth = computeBottomHistoryResize({
        startWidth,
        startX,
        clientX: moveEvent.clientX,
        containerWidth,
        senderWidth: currentSenderWidth
      })
      onBottomHistoryWidthChange?.(nextWidth)
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing-prompt-panel')
    }

    document.body.classList.add('resizing-prompt-panel')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [position, bottomHistoryWidth, bottomSenderWidth, onBottomHistoryWidthChange])

  // Drag right internal resizer in bottom 3-column mode (adjusts sender column width)
  const handleBottomSenderResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (position !== 'bottom') return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = bottomSenderWidth
    const currentHistoryWidth = bottomHistoryWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const containerWidth = notebookRef.current?.getBoundingClientRect().width
      const nextWidth = computeBottomSenderResize({
        startWidth,
        startX,
        clientX: moveEvent.clientX,
        containerWidth,
        historyWidth: currentHistoryWidth
      })
      onBottomSenderWidthChange?.(nextWidth)
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing-prompt-panel')
    }

    document.body.classList.add('resizing-prompt-panel')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [position, bottomSenderWidth, bottomHistoryWidth, onBottomSenderWidthChange])

  const outerStyle = useMemo(() => {
    if (position === 'bottom') {
      return { height: bottomHeight }
    }
    return { width: position === 'right' ? rightWidth : width }
  }, [position, width, rightWidth, bottomHeight])

  // Delete confirmation box shortcut
  useEffect(() => {
    if (hidden || !deleteConfirm.isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        handleConfirmDelete()
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault()
        handleCancelDelete()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hidden, deleteConfirm.isOpen, handleConfirmDelete, handleCancelDelete])

  // Import confirmation dialog shortcut
  useEffect(() => {
    if (hidden || !importConfirm.isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancelImport()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirmImport()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hidden, importConfirm.isOpen, handleConfirmImport, handleCancelImport])

  const retentionKeepDays = useMemo(() => {
    if (!retentionConfirm.isCustomDays) {
      return retentionConfirm.keepDays
    }
    return Number.parseInt(retentionConfirm.customDaysInput, 10)
  }, [retentionConfirm.customDaysInput, retentionConfirm.isCustomDays, retentionConfirm.keepDays])

  const canConfirmRetention = useMemo(() => {
    return Number.isFinite(retentionKeepDays) && retentionKeepDays > 0 && retentionConfirm.deleteColored !== null
  }, [retentionKeepDays, retentionConfirm.deleteColored])

  const showRetentionDaysError = useMemo(() => {
    if (!retentionConfirm.isCustomDays) return false
    if (!retentionConfirm.customDaysInput.trim()) return false
    return !Number.isFinite(retentionKeepDays) || retentionKeepDays <= 0
  }, [retentionConfirm.customDaysInput, retentionConfirm.isCustomDays, retentionKeepDays])

  // Clear confirmation box shortcut
  useEffect(() => {
    if (!retentionConfirm.isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancelRetention()
        return
      }
      if (e.key === 'Enter' && canConfirmRetention) {
        e.preventDefault()
        handleConfirmRetention()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [retentionConfirm.isOpen, handleCancelRetention, handleConfirmRetention, canConfirmRetention])

  // Send-history panel: ESC closes (unified modal dismiss)
  const closeSendHistory = useCallback(() => setSendHistoryPrompt(null), [])
  useModalEscape(!hidden && sendHistoryPrompt !== null, closeSendHistory, 'prompt-send-history')

  // The three confirms keep their own key handling (y/n/Enter + Escape)
  // but must still suppress subpage-host capture-phase Escape while open.
  useModalOpenRegistration(!hidden && deleteConfirm.isOpen)
  useModalOpenRegistration(!hidden && importConfirm.isOpen)
  useModalOpenRegistration(retentionConfirm.isOpen)

  return (
    <>
      <div
        ref={notebookRef}
        className={`prompt-notebook prompt-notebook--${position}${hidden ? ' prompt-notebook-hidden' : ''}`}
        data-dock-position={position}
        style={outerStyle}
      >
        <div
          className="prompt-notebook-resizer"
          data-testid="prompt-notebook-resizer"
          onMouseDown={handleMouseDown}
        />

        <div
          className="prompt-notebook-history-pane"
          data-testid="prompt-notebook-history-pane"
          style={position === 'bottom' ? { width: bottomHistoryWidth } : undefined}
        >
          {/* search box */}
          <PromptSearch
            value={searchKeyword}
            onChange={setSearchKeyword}
            saveMessage={saveMessage}
          />

          {/* Scheduled task notification */}
          <ScheduleNotificationBar
            notifications={scheduleNotifications}
            onDismiss={onDismissScheduleNotification}
            onRetry={onRetrySchedule}
          />

          {/* History list */}
          <PromptList
            prompts={filteredPrompts}
            selectedId={selectedId}
            searchKeyword={searchKeyword}
            filterEnabled={filterEnabled}
            targetsEnabled={targetsEnabled}
            activeColorFilter={activeColorFilter}
            colorFilterStats={colorFilterStats}
            activeTaskFilter={activeTaskFilter}
            taskFilterOptions={taskFilterOptions}
            promptTaskNumbers={promptTaskHistory.promptTaskNumbers}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onDelete={handleDelete}
            onTogglePin={handleTogglePin}
            onAppend={handleAppend}
            onColorChange={handleColorChange}
            onToggleFilterEnabled={handleToggleFilterEnabled}
            onToggleTargetsEnabled={handleToggleTargetsEnabled}
            onToggleColorFilter={handleToggleColorFilter}
            onToggleTaskFilter={handleToggleTaskFilter}
            globalPromptIds={globalPromptIds}
            onReorderPinned={onReorderPinnedPrompts}
            autoCleanupEnabled={promptCleanup.autoEnabled}
            onExportAllPrompts={handleExportAllPrompts}
            onImportPrompts={handleImportPrompts}
            onRetentionKeepDays={handleRetentionKeepDays}
            onRetentionKeepCustom={handleRetentionKeepCustom}
            onToggleAutoCleanup={handleToggleAutoCleanup}
            scheduleMap={scheduleMap}
            onSetSchedule={handleSetSchedule}
            onEditSchedule={handleEditSchedule}
            onCancelSchedule={handleCancelSchedule}
            onPauseSchedule={handlePauseSchedule}
            onResumeSchedule={handleResumeSchedule}
            onViewSendHistory={handleViewSendHistory}
            onCopyPrompt={handleCopyPrompt}
            terminals={terminals}
            onSendAndExecuteToTask={handleContextMenuSendAndExecute}
            onSendAndExecuteToAllTasks={handleContextMenuSendAndExecuteAll}
          />
        </div>

        {position === 'bottom' && (
          <div
            className="prompt-notebook-col-resizer prompt-notebook-col-resizer-left"
            data-testid="prompt-bottom-resizer-left"
            onMouseDown={handleBottomHistoryResizeMouseDown}
          />
        )}

        {/* input area */}
        <PromptEditorWithAppend
          tabId={tabId}
          activeTab={activeTab}
          dockPosition={position}
          draftToast={draftToast}
          onSubmit={handleSubmit}
          onUpdatePrompt={onUpdatePrompt}
          editingPrompt={editingPrompt}
          onCancelEdit={handleCancelEdit}
          appendContent={appendContent}
          onAppendContentUsed={handleAppendContentUsed}
          onContentChange={handleEditorContentChange}
          onTitleChange={handleEditorTitleChange}
          onImagesChange={handleEditorImagesChange}
          promptEditorHeight={promptEditorHeight}
          onPromptEditorHeightChange={onPromptEditorHeightChange}
          promptInputMode={promptInputMode}
          onPromptInputModeChange={onPromptInputModeChange}
          editorDraft={editorDraft}
          onEditorDraftChange={onEditorDraftChange}
          addToHistoryShortcut={addToHistoryShortcut}
          hidden={hidden}
          onSaveSuccess={handleSaveSuccess}
          ctxPinnedPrompts={pinnedPrompts}
          ctxTerminals={terminals}
          ctxAppendPromptToContent={handleAppend}
          ctxSaveSelectionAsPinned={handleSavePinnedFromEditor}
          ctxSendToTask={handleSendEditorToTask}
          ctxCurrentCwd={editorCwd}
          ctxCurrentBranch={editorBranch}
          ctxCurrentTaskTitle={editorTaskTitle}
        />

        {position === 'bottom' && (
          <div
            className="prompt-notebook-col-resizer prompt-notebook-col-resizer-right"
            data-testid="prompt-bottom-resizer-right"
            onMouseDown={handleBottomSenderResizeMouseDown}
          />
        )}

        {/* Send control area */}
        <div
          className="prompt-notebook-sender-pane"
          data-testid="prompt-notebook-sender-pane"
          style={position === 'bottom' ? { width: bottomSenderWidth } : undefined}
        >
          <PromptSender
            terminals={terminals}
            taskLayout={taskLayout}
            tabId={tabId}
            hidden={hidden}
            activeTab={activeTab}
            promptContent={editorContentForSend}
            inputSettings={inputSettings}
            selectedIds={selectedTerminalIds}
            onSelectionChange={handleInputSelectionChange}
            registerSelectionFlush={registerSelectionFlush}
            onAction={handleInputAction}
            isSubmitting={inputBusy}
            notice={inputNotice}
            onTerminalRename={onTerminalRename}
            onChangeWorkDir={onChangeWorkDir}
          />
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {!hidden && deleteConfirm.isOpen && (
        <div className="confirm-dialog-overlay">
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{t('promptNotebook.deleteTitle')}</div>
            <div className="confirm-dialog-message">
              {t('promptNotebook.deleteMessage', { title: deleteConfirm.promptTitle })}
            </div>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelDelete}>
                {t('promptNotebook.cancelN')}
              </button>
              <button className="confirm-dialog-btn confirm" onClick={handleConfirmDelete} autoFocus>
                {t('promptNotebook.confirmY')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import confirmation dialog */}
      {!hidden && importConfirm.isOpen && (
        <div className="confirm-dialog-overlay">
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{t('promptNotebook.importConfirm.title')}</div>
            <div className="confirm-dialog-message">
              <div style={{ marginBottom: 8 }}>{t('promptNotebook.importConfirm.aboutToImport')}</div>
              <div style={{ lineHeight: 1.8 }}>
                {importConfirm.globals.length > 0 && (
                  <div>• {t('promptNotebook.importConfirm.globalCount', { count: importConfirm.globals.length })}</div>
                )}
                {importConfirm.locals.length > 0 && (
                  <div>• {t('promptNotebook.importConfirm.localCount', { count: importConfirm.locals.length })}</div>
                )}
                {importConfirm.duplicateCount > 0 && (
                  <div style={{ opacity: 0.7 }}>• {t('promptNotebook.importConfirm.skippedDuplicates', { count: importConfirm.duplicateCount })}</div>
                )}
              </div>
            </div>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelImport}>
                {t('promptNotebook.importConfirm.cancel')}
              </button>
              <button className="confirm-dialog-btn confirm" onClick={handleConfirmImport} autoFocus>
                {t('promptNotebook.importConfirm.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scheduled configuration Modal */}
      {!hidden && scheduleModalPrompt && (
        <ScheduleConfigModal
          prompt={scheduleModalPrompt}
          terminals={terminals}
          tabId={tabId}
          existingSchedule={scheduleMap.get(scheduleModalPrompt.id) ?? null}
          onConfirm={handleScheduleConfirm}
          onCancel={handleScheduleCancel}
        />
      )}

      {retentionConfirm.isOpen && (
        <div className="confirm-dialog-overlay">
          <div className="confirm-dialog prompt-retention-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">
              {retentionConfirm.mode === 'auto' ? t('promptNotebook.retention.autoTitle') : t('promptNotebook.retention.manualTitle')}
            </div>
            <div className="confirm-dialog-message">
              {retentionConfirm.mode === 'auto'
                ? t('promptNotebook.retention.autoMessage')
                : t('promptNotebook.retention.manualMessage')}
            </div>

            <div className="prompt-retention-days-row">
              {retentionConfirm.isCustomDays ? (
                <>
                  <span className="prompt-retention-days-label">{t('promptNotebook.retention.keepRecent')}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="prompt-retention-days-input"
                    value={retentionConfirm.customDaysInput}
                    onChange={(e) => {
                      const value = e.target.value
                      setRetentionConfirm(prev => ({ ...prev, customDaysInput: value }))
                    }}
                    placeholder={t('promptNotebook.retention.daysPlaceholder')}
                  />
                  <span className="prompt-retention-days-suffix">{t('promptNotebook.retention.daysSuffix')}</span>
                </>
              ) : (
                <span className="prompt-retention-days-text">
                  {t('promptNotebook.retention.keepRecentText', { days: retentionConfirm.mode === 'auto' ? 30 : retentionConfirm.keepDays })}
                </span>
              )}
            </div>
            {showRetentionDaysError && (
              <div className="prompt-retention-days-error">{t('promptNotebook.retention.invalidDays')}</div>
            )}

            <div className="prompt-retention-color-group">
              <div className="prompt-retention-color-title">{t('promptNotebook.retention.colorHandling')}</div>
              <div className="prompt-retention-color-options">
                <button
                  className={`prompt-retention-color-option ${retentionConfirm.deleteColored === true ? 'selected' : ''}`}
                  onClick={() => setRetentionConfirm(prev => ({ ...prev, deleteColored: true }))}
                >
                  {t('promptNotebook.retention.deleteColored')}
                </button>
                <button
                  className={`prompt-retention-color-option ${retentionConfirm.deleteColored === false ? 'selected' : ''}`}
                  onClick={() => setRetentionConfirm(prev => ({ ...prev, deleteColored: false }))}
                >
                  {t('promptNotebook.retention.keepColored')}
                </button>
              </div>
            </div>

            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelRetention}>
                {t('promptNotebook.retention.cancel')}
              </button>
              <button
                className="confirm-dialog-btn confirm"
                onClick={handleConfirmRetention}
                disabled={!canConfirmRetention}
              >
                {t('promptNotebook.retention.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send record panel */}
      {!hidden && sendHistoryPrompt && (
        <div className="prompt-send-history-overlay">
          <div className="prompt-send-history-panel" onClick={(e) => e.stopPropagation()}>
            <div className="prompt-send-history-header">
              <span className="prompt-send-history-title">
                {t('promptNotebook.sendHistory.title', { title: sendHistoryPrompt.title || t('promptNotebook.untitledPrompt') })}
              </span>
              <button className="prompt-send-history-close" onClick={() => setSendHistoryPrompt(null)}>
                {t('promptNotebook.sendHistory.close')}
              </button>
            </div>
            <div className="prompt-send-history-body">
              {(!sendHistoryPrompt.sendHistory || sendHistoryPrompt.sendHistory.length === 0) ? (
                <div className="prompt-send-history-empty">{t('promptNotebook.sendHistory.empty')}</div>
              ) : (
                sendHistoryPrompt.sendHistory.map((record, index) => (
                  <div key={index} className="prompt-send-history-item">
                    <span className="prompt-send-history-task">{record.taskName}</span>
                    <span className={`prompt-send-history-action ${record.action}`}>
                      {record.inputResult
                        ? t(record.inputResult.ok ? 'promptInput.runtime.recordSent'
                          : record.inputResult.contentDelivered ? 'promptInput.runtime.recordContentOnly' : 'promptInput.runtime.recordFailed')
                        : record.action === 'send'
                        ? t('promptNotebook.sendHistory.action.send')
                        : record.action === 'execute'
                          ? t('promptNotebook.sendHistory.action.execute')
                          : record.result === 'sent-only'
                            ? t('promptNotebook.sendHistory.action.sendAndExecuteSentOnly')
                            : t('promptNotebook.sendHistory.action.sendAndExecute')}
                    </span>
                    <span className="prompt-send-history-time">
                      {new Date(record.sentAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
                        month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit'
                      })}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
})

// Editor wrapper component with additional functionality
const PromptEditorWithAppend = memo(function PromptEditorWithAppend({
  tabId,
  activeTab,
  dockPosition = 'left',
  draftToast,
  onSubmit,
  onUpdatePrompt,
  editingPrompt,
  onCancelEdit,
  appendContent,
  onAppendContentUsed,
  onContentChange,
  onTitleChange,
  onImagesChange,
  promptEditorHeight,
  onPromptEditorHeightChange,
  editorDraft,
  onEditorDraftChange,
  addToHistoryShortcut,
  hidden = false,
  onSaveSuccess,
  ctxPinnedPrompts,
  ctxTerminals,
  ctxAppendPromptToContent,
  ctxSaveSelectionAsPinned,
  ctxSendToTask,
  ctxCurrentCwd,
  ctxCurrentBranch,
  ctxCurrentTaskTitle
}: {
  tabId: string
  activeTab: boolean
  dockPosition?: PromptPanelPosition
  draftToast: string | null
  onSubmit: (
    title: string,
    content: string,
    color?: 'red' | 'yellow' | 'green' | null,
    images?: PromptImageAttachment[]
  ) => void
  onUpdatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  editingPrompt: Prompt | null
  onCancelEdit: () => void
  appendContent: string
  onAppendContentUsed: () => void
  onContentChange: (content: string) => void
  onTitleChange: (title: string) => void
  onImagesChange: (images: PromptImageAttachment[]) => void
  promptEditorHeight: number
  onPromptEditorHeightChange: (height: number) => void
  promptInputMode: 'canvas' | 'line'
  onPromptInputModeChange: (mode: 'canvas' | 'line') => void
  editorDraft: EditorDraft | null
  onEditorDraftChange: (draft: EditorDraft | null) => void
  addToHistoryShortcut: string | null
  hidden?: boolean
  onSaveSuccess?: () => void
  ctxPinnedPrompts: Prompt[]
  ctxTerminals: TerminalInfo[]
  ctxAppendPromptToContent: (prompt: Prompt) => void
  ctxSaveSelectionAsPinned: (selection: string) => void
  ctxSendToTask: (content: string, terminalId: string) => void
  ctxCurrentCwd: string | null
  ctxCurrentBranch: string | null
  ctxCurrentTaskTitle: string | null
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const initialImages = useMemo(() => normalizePromptImageAttachments(editorDraft?.images), [])
  const [images, setImages] = useState<PromptImageAttachment[]>(initialImages)
  const imagesRef = useRef<PromptImageAttachment[]>(initialImages)
  const batchIdRef = useRef<string>(
    editorDraft?.batchId || initialImages[0]?.batchId || createPromptImageBatchId()
  )
  const batchSharedWithEditingPromptRef = useRef<boolean>(false)
  const [previewImageIndex, setPreviewImageIndex] = useState<number | null>(null)
  const previewImageIndexRef = useRef<number | null>(null)
  previewImageIndexRef.current = previewImageIndex
  const [mentionMenu, setMentionMenu] = useState<PromptAttachmentMentionMenuState | null>(null)
  const mentionMenuRef = useRef(mentionMenu)
  mentionMenuRef.current = mentionMenu
  const [isFileDropTarget, setIsFileDropTarget] = useState(false)
  const fileDropDepthRef = useRef(0)
  const lastEditorFileDropRef = useRef<{ rawPaths: string[]; formattedText: string } | null>(null)
  const lastKnownSelectionRef = useRef<{ start: number; end: number } | null>(null)
  // The editor surface is a contenteditable div (NOT a textarea): a native
  // textarea's IME composition is O(text-before-caret) — ~60ms at the end of a
  // 78KB draft, ~263ms mid-document — because the browser re-lays-out all
  // preceding text to anchor the composition. A contenteditable div avoids that
  // (~16ms), which is why every large chat composer uses one.
  //
  // The content is UNCONTROLLED: live DOM text is mirrored into a local ref
  // on input so hidden panels retain newlines. Keeping it out of React
  // state means typing / IME costs zero React reconciliation. A tiny
  // `hasContent` boolean drives button-disabled state.
  const [hasContent, setHasContent] = useState(() => {
    const c = editorDraft?.content ?? ''
    return (c.length > 0 && /\S/.test(c)) || initialImages.length > 0
  })
  const hasContentRef = useRef(hasContent)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; snapshot: ContextMenuSnapshot; canUndo: boolean } | null>(null)
  // Undo stack scoped to right-click context-menu mutations only. Native
  // textarea Cmd+Z continues to handle keystroke-level history; this stack
  // captures atomic menu operations (paste / cut / format / clear / etc.)
  // so a single Undo click reverts the whole menu action. Bounded at 50 to
  // keep memory predictable in long sessions.
  const HISTORY_LIMIT = 50
  const historyRef = useRef<Array<{ value: string; selectionStart: number; selectionEnd: number }>>([])
  const MIN_EDITOR_HEIGHT = 180
  const [height, setHeight] = useState(() => Math.max(promptEditorHeight, MIN_EDITOR_HEIGHT))
  const heightRef = useRef(height)
  const isDraggingRef = useRef(false)
  const hasMountedRef = useRef(false)
  // The editor surface (a contenteditable div). Kept named `editorRef` — it is
  // NOT a textarea. `contentEditable="plaintext-only"` gives plain-text
  // semantics natively (paste strips formatting, no rich markup).
  const editorRef = useRef<HTMLDivElement>(null)
  // Tracks IME composition so composition-sensitive handlers can short-circuit.
  const isComposingRef = useRef(false)
  const { registerFocusEditor, registerSubmitEditor, registerDraftController } = usePromptActions()
  const localContentRef = useRef(editorDraft?.content ?? '')
  const draftRevisionRef = useRef(0)
  const sourceRef = useRef<Prompt | null>(null)
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const onCancelEditRef = useRef(onCancelEdit)
  onCancelEditRef.current = onCancelEdit

  // ---- Contenteditable value + caret plumbing ----
  // Read the live plain text. innerText (NOT textContent) is layout-aware and
  // renders line breaks as '\n' whether they are text-node newlines or block
  // boundaries; textContent would drop Enter-created line breaks.
  const readContent = useCallback((): string => {
    // Hidden innerText degrades to textContent and loses block boundaries.
    // Capture text on the existing input read and retain it across panel hides.
    if (!hiddenRef.current && editorRef.current) {
      const live = editorRef.current.innerText
      if (live !== localContentRef.current) {
        localContentRef.current = live
        draftRevisionRef.current += 1
      }
    }
    return localContentRef.current
  }, [])

  // Flat caret offset within the plain text (for context-menu operations). Uses
  // a Range from the element start to the caret and measures its length. For
  // our DOM (a single text node with embedded '\n', kept so by the Enter
  // handler below) this equals the innerText offset.
  const getSelectionOffsets = useCallback((): { start: number; end: number } => {
    const el = editorRef.current
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return { start: 0, end: 0 }
    const range = sel.getRangeAt(0)
    const pre = document.createRange()
    pre.selectNodeContents(el)
    try {
      pre.setEnd(range.startContainer, range.startOffset)
      const start = pre.toString().length
      pre.setEnd(range.endContainer, range.endOffset)
      const end = pre.toString().length
      return { start, end }
    } catch {
      return { start: 0, end: 0 }
    }
  }, [])

  const captureCurrentSelection = useCallback(() => {
    const el = editorRef.current
    if (!el || document.activeElement !== el) return
    lastKnownSelectionRef.current = getSelectionOffsets()
  }, [getSelectionOffsets])

  // Place the caret at a flat offset (clamped) within the editor.
  const setCaretOffset = useCallback((offset: number): void => {
    const el = editorRef.current
    if (!el) return
    const sel = window.getSelection()
    if (!sel) return
    let remaining = Math.max(0, offset)
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    let target: Text | null = null
    let targetOffset = 0
    while (node) {
      const len = (node as Text).length
      if (remaining <= len) { target = node as Text; targetOffset = remaining; break }
      remaining -= len
      target = node as Text
      targetOffset = len
      node = walker.nextNode()
    }
    const range = document.createRange()
    if (target) {
      range.setStart(target, targetOffset)
    } else {
      range.setStart(el, 0)
    }
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    lastKnownSelectionRef.current = { start: Math.max(0, offset), end: Math.max(0, offset) }
  }, [])

  // Parent-notification debounce timer + stable-identity plumbing. The parent
  // callbacks are routed through refs so writeContent / scheduleParentSync never
  // change identity; otherwise effects that depend on writeContent (edit-load,
  // append) would re-fire on unrelated parent renders and could
  // wipe the user's in-progress edits.
  const parentNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftSyncHeldForAutotestRef = useRef(false)
  useEffect(() => () => {
    draftSyncHeldForAutotestRef.current = false
    if (parentNotifyTimerRef.current) clearTimeout(parentNotifyTimerRef.current)
    parentNotifyTimerRef.current = null
  }, [])
  const titleRef = useRef(title)
  const writeTitle = useCallback((next: string) => {
    titleRef.current = next
    draftRevisionRef.current += 1
    setTitle(next)
  }, [])
  const onContentChangeRef = useRef(onContentChange)
  const onTitleChangeRef = useRef(onTitleChange)
  const onImagesChangeRef = useRef(onImagesChange)
  const onEditorDraftChangeRef = useRef(onEditorDraftChange)
  onContentChangeRef.current = onContentChange
  onTitleChangeRef.current = onTitleChange
  onImagesChangeRef.current = onImagesChange
  onEditorDraftChangeRef.current = onEditorDraftChange

  useEffect(() => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_QUIT_STATE_FLUSH, { phase: 'editor-registered' })
    const unregister = pendingStateFlush.register(() => {
      if (!hasMountedRef.current) return
      if (parentNotifyTimerRef.current) clearTimeout(parentNotifyTimerRef.current)
      parentNotifyTimerRef.current = null
      const content = editorRef.current?.innerText ?? ''
      onEditorDraftChangeRef.current(
        snapshotPromptDraft(
          titleRef.current,
          content,
          heightRef.current,
          Date.now(),
          imagesRef.current.length > 0 ? batchIdRef.current : undefined,
          imagesRef.current.length > 0 ? imagesRef.current : undefined
        )
      )
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_QUIT_STATE_FLUSH, { phase: 'editor-collected', characters: content.length })
    })
    return () => {
      unregister()
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_QUIT_STATE_FLUSH, { phase: 'editor-unregistered' })
    }
  }, [])

  // Re-render (button-disabled only) when the empty<->non-empty flag flips.
  // /\S/.test stops at the first non-whitespace char (O(1) for real content).
  const syncHasContent = useCallback((v = readContent(), imgs = imagesRef.current) => {
    const has = (v.length > 0 && /\S/.test(v)) || imgs.length > 0
    if (has !== hasContentRef.current) {
      hasContentRef.current = has
      setHasContent(has)
    }
  }, [readContent])

  // Debounced parent sync (content / title / draft), called imperatively from
  // input, programmatic writes, and title/height changes. Stable identity.
  const scheduleParentSync = useCallback(() => {
    if (!hasMountedRef.current) return
    if (draftSyncHeldForAutotestRef.current) return
    if (parentNotifyTimerRef.current) clearTimeout(parentNotifyTimerRef.current)
    parentNotifyTimerRef.current = setTimeout(() => {
      parentNotifyTimerRef.current = null
      startTransition(() => {
        const content = readContent()
        const currentTitle = titleRef.current
        const currentImages = imagesRef.current
        onContentChangeRef.current(content)
        onTitleChangeRef.current(currentTitle)
        onImagesChangeRef.current(currentImages)
        if (!currentTitle.trim() && !content.trim() && currentImages.length === 0) {
          onEditorDraftChangeRef.current(null)
        } else {
          onEditorDraftChangeRef.current({
            title: currentTitle,
            content,
            height: heightRef.current,
            savedAt: Date.now(),
            ...(currentImages.length > 0
              ? { batchId: batchIdRef.current, images: currentImages }
              : {})
          })
        }
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, {
          phase: 'persist', tabId, revision: draftRevisionRef.current, contentLen: content.length
        })
      })
    }, 300)
  }, [readContent, tabId])

  const syncMentionMenu = useCallback((content: string, caretOffset: number, imgs = imagesRef.current) => {
    if (imgs.length === 0) {
      if (mentionMenuRef.current !== null) setMentionMenu(null)
      return
    }
    const trigger = detectPromptMentionTrigger(content, caretOffset, imgs)
    if (!trigger) {
      if (mentionMenuRef.current !== null) setMentionMenu(null)
      return
    }
    setMentionMenu((prev) => {
      const sameAnchor = prev && prev.startOffset === trigger.startOffset && prev.query === trigger.query
      const nextSelected = sameAnchor
        ? Math.min(prev.selectedIndex, trigger.candidates.length - 1)
        : 0
      return {
        startOffset: trigger.startOffset,
        endOffset: trigger.endOffset,
        query: trigger.query,
        selectedIndex: Math.max(0, nextSelected),
        candidates: trigger.candidates
      }
    })
  }, [])

  const writeImages = useCallback((nextImages: PromptImageAttachment[], nextBatchId?: string) => {
    const normalized = normalizePromptImageAttachments(nextImages)
    imagesRef.current = normalized
    if (nextBatchId) {
      batchIdRef.current = nextBatchId
    } else if (normalized[0]?.batchId) {
      batchIdRef.current = normalized[0].batchId
    }
    draftRevisionRef.current += 1
    setImages(normalized)
    onImagesChangeRef.current(normalized)
    const content = readContent()
    syncHasContent(content, normalized)
    if (normalized.length === 0 && mentionMenuRef.current !== null) {
      setMentionMenu(null)
    } else if (normalized.length > 0 && mentionMenuRef.current !== null) {
      const caret = lastKnownSelectionRef.current?.end ?? content.length
      syncMentionMenu(content, caret, normalized)
    }
  }, [readContent, syncHasContent, syncMentionMenu])

  // Imperatively set the editor content (programmatic mutations only). Writes
  // textContent (a single text node with '\n' chars, rendered as line breaks by
  // white-space:pre-wrap) so the DOM stays simple and caret offsets are exact.
  // `caretAt` restores the caret; default is end-of-content.
  const writeContent = useCallback((next: string, caretAt?: number) => {
    localContentRef.current = next
    draftRevisionRef.current += 1
    const el = editorRef.current
    const pos = caretAt === undefined ? next.length : Math.max(0, Math.min(caretAt, next.length))
    lastKnownSelectionRef.current = { start: pos, end: pos }
    if (el) {
      el.textContent = next
      if (document.activeElement === el) setCaretOffset(pos)
    }
    if (imagesRef.current.length > 0) {
      syncMentionMenu(next, pos, imagesRef.current)
    } else if (mentionMenuRef.current !== null) {
      setMentionMenu(null)
    }
    syncHasContent(next)
    scheduleParentSync()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, {
      phase: 'write', tabId, revision: draftRevisionRef.current, contentLen: next.length
    })
  }, [setCaretOffset, syncHasContent, syncMentionMenu, scheduleParentSync, tabId])

  useLayoutEffect(() => registerDraftController(tabId, {
    snapshot: () => ({
      content: readContent(), title: titleRef.current, revision: draftRevisionRef.current,
      sourceId: sourceRef.current?.id ?? null, color: sourceRef.current?.color ?? null,
      composing: isComposingRef.current,
      ...(imagesRef.current.length > 0
        ? { images: imagesRef.current, batchId: batchIdRef.current }
        : {})
    }),
    clearIfRevision: (revision) => {
      readContent()
      if (draftRevisionRef.current !== revision) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, {
          phase: 'clear-skipped', tabId, sentRevision: revision, currentRevision: draftRevisionRef.current
        })
        return false
      }
      batchSharedWithEditingPromptRef.current = false
      writeTitle('')
      writeImages([], createPromptImageBatchId())
      setPreviewImageIndex(null)
      writeContent('')
      sourceRef.current = null
      draftRevisionRef.current += 1
      onCancelEditRef.current()
      if (parentNotifyTimerRef.current) clearTimeout(parentNotifyTimerRef.current)
      onContentChangeRef.current('')
      onTitleChangeRef.current('')
      onImagesChangeRef.current([])
      onEditorDraftChangeRef.current(null)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, { phase: 'cleared', tabId, sentRevision: revision })
      return true
    }
  }), [registerDraftController, tabId, readContent, writeTitle, writeImages, writeContent])
  const platform = window.electronAPI?.platform ?? 'darwin'
  const isMac = platform === 'darwin'
  const saveShortcutLabel = isMac ? '⌘S' : 'Ctrl+S'
  const saveAsShortcutLabel = isMac ? '⌘⇧S' : 'Ctrl+Shift+S'

  const saveShortcut = 'CommandOrControl+S'
  const saveAsShortcut = 'CommandOrControl+Shift+S'

  const matchesAccelerator = useCallback((accelerator: string, expected: string) => {
    if (!accelerator) return false
    const normalize = (value: string) => value
      .split('+')
      .map(part => (part === 'Ctrl' || part === 'Control' || part === 'Cmd' || part === 'Command' || part === 'CmdOrCtrl' ? 'CommandOrControl' : part))
      .join('+')
    return normalize(accelerator) === normalize(expected)
  }, [])

  useEffect(() => {
    heightRef.current = height
  }, [height])

  // Silently restore drafts on first mount. Content is applied imperatively — a
  // contenteditable div has no defaultValue.
  useLayoutEffect(() => {
    if (!hasMountedRef.current && editorDraft) {
      const restoredImages = normalizePromptImageAttachments(editorDraft.images)
      if (restoredImages.length > 0 || editorDraft.batchId) {
        writeImages(restoredImages, editorDraft.batchId || restoredImages[0]?.batchId || createPromptImageBatchId())
      }
      writeTitle(editorDraft.title)
      writeContent(editorDraft.content)
      setHeight(Math.max(promptEditorHeight, editorDraft.height, MIN_EDITOR_HEIGHT))
      hasMountedRef.current = true
    } else if (!hasMountedRef.current) {
      hasMountedRef.current = true
    }
  }, [editorDraft, promptEditorHeight, writeContent, writeImages, writeTitle])

  useEffect(() => {
    if (isDraggingRef.current) return
    const normalizedHeight = Math.max(promptEditorHeight, MIN_EDITOR_HEIGHT)
    heightRef.current = normalizedHeight
    setHeight((prev) => (prev === normalizedHeight ? prev : normalizedHeight))
  }, [promptEditorHeight])

  // Populate content when edit mode is activated
  useLayoutEffect(() => {
    if (sourceRef.current === editingPrompt) return
    sourceRef.current = editingPrompt
    draftRevisionRef.current += 1
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, {
      phase: 'source-changed', tabId, revision: draftRevisionRef.current, hasSource: Boolean(editingPrompt)
    })
    if (editingPrompt) {
      const promptImages = normalizePromptImageAttachments(editingPrompt.images)
      batchSharedWithEditingPromptRef.current = promptImages.length > 0
      writeImages(promptImages, promptImages[0]?.batchId ?? createPromptImageBatchId())
      setPreviewImageIndex(null)
      writeTitle(editingPrompt.title)
      writeContent(editingPrompt.content)
    }
  }, [editingPrompt, writeContent, writeImages, writeTitle, tabId])

  // Copy-on-Write batch isolation so mutating images while editing a saved
  // Prompt does not corrupt the original entry's on-disk files if the user
  // cancels or chooses "Save as New".
  const ensureIsolatedBatchForMutation = useCallback(async (): Promise<string> => {
    if (!batchSharedWithEditingPromptRef.current) {
      return batchIdRef.current
    }
    const sourceBatchId = batchIdRef.current
    const nextBatchId = createPromptImageBatchId()
    batchSharedWithEditingPromptRef.current = false
    if (imagesRef.current.length > 0 && window.electronAPI?.clipboard?.clonePromptImageBatch) {
      const cloned = await window.electronAPI.clipboard.clonePromptImageBatch(sourceBatchId, nextBatchId, imagesRef.current)
      if (cloned.length > 0) {
        writeImages(cloned, nextBatchId)
        return nextBatchId
      }
    }
    batchIdRef.current = nextBatchId
    return nextBatchId
  }, [writeImages])

  // Programmatic content mutation used by the right-click context menu and
  // file-drop / token insertion.
  const applyMutation = useCallback((next: string, cursorAt?: number) => {
    const sel = getSelectionOffsets()
    historyRef.current.push({
      value: readContent(),
      selectionStart: sel.start,
      selectionEnd: sel.end
    })
    if (historyRef.current.length > HISTORY_LIMIT) {
      historyRef.current.shift()
    }
    writeContent(next, cursorAt)
    if (performanceTrace.enabled) {
      performanceTrace.recordInstant('ui.prompt.edit', {
        field: 'content',
        mode: editingPrompt ? 'edit' : 'new',
        ...performanceTrace.summarizeText('payload', next)
      }, 'prompt')
    }
  }, [editingPrompt, getSelectionOffsets, readContent, writeContent])

  // Insert text at the current (or last-known pre-blur) selection/caret, or
  // append to the end when the editor has never been focused.
  const insertTextIntoEditor = useCallback((
    insertedText: string,
    selectionOverride?: { start: number; end: number } | null
  ): { nextText: string; nextCaret: number } => {
    const currentText = readContent()
    const el = editorRef.current
    const activeSelection = selectionOverride !== undefined
      ? selectionOverride
      : (el && document.activeElement === el ? getSelectionOffsets() : lastKnownSelectionRef.current)
    const { nextText, nextCaret } = computePromptEditorTextInsertion(currentText, activeSelection, insertedText)
    applyMutation(nextText, nextCaret)
    if (el) {
      el.focus()
      setCaretOffset(nextCaret)
    }
    return { nextText, nextCaret }
  }, [applyMutation, getSelectionOffsets, readContent, setCaretOffset])

  const dropFilePathsIntoEditor = useCallback((
    rawPaths: readonly string[]
  ): { rawPaths: string[]; formattedText: string } | null => {
    const formattedText = formatDroppedFilePathsForShell(rawPaths, platform)
    if (!formattedText) return null
    insertTextIntoEditor(formattedText)
    const record = { rawPaths: [...rawPaths], formattedText }
    lastEditorFileDropRef.current = record
    return record
  }, [insertTextIntoEditor, platform])

  const pasteClipboardIntoEditor = useCallback(async (
    selectionOverride?: { start: number; end: number } | null,
    options?: {
      filePaths?: string[]
      autotestImage?: { width: number; height: number }
    }
  ) => {
    const pasteFn = window.electronAPI?.clipboard?.pastePrompt
    if (!pasteFn) return null
    const targetBatchId = await ensureIsolatedBatchForMutation()
    const nextIndex = imagesRef.current.length + 1
    const result = await pasteFn(targetBatchId, nextIndex, options)
    if (!result || result.kind === 'empty') return result ?? null
    if (result.kind === 'files') {
      const addedAttachments = Array.isArray(result.attachments) ? result.attachments : []
      if (addedAttachments.length > 0) {
        const nextImages = normalizePromptImageAttachments([...imagesRef.current, ...addedAttachments])
        writeImages(nextImages, targetBatchId)
        scheduleParentSync()
      }
      if (Array.isArray(result.directoryPaths) && result.directoryPaths.length > 0) {
        dropFilePathsIntoEditor(result.directoryPaths)
      }
      return result
    }
    if (result.kind === 'image' && result.attachment) {
      const nextImages = normalizePromptImageAttachments([...imagesRef.current, result.attachment])
      writeImages(nextImages, targetBatchId)
      scheduleParentSync()
      return result
    }
    if (result.kind === 'text' && typeof result.text === 'string') {
      insertTextIntoEditor(result.text, selectionOverride)
      return result
    }
    return result
  }, [dropFilePathsIntoEditor, ensureIsolatedBatchForMutation, insertTextIntoEditor, scheduleParentSync, writeImages])

  const handleRemoveImage = useCallback(async (indexToRemove: number): Promise<boolean> => {
    const existing = imagesRef.current
    if (!existing.some((img) => img.index === indexToRemove)) return false
    const targetBatchId = await ensureIsolatedBatchForMutation()
    let nextImages = renumberPromptImageAttachmentsAfterRemove(imagesRef.current, indexToRemove)
    if (window.electronAPI?.clipboard?.removePromptImage) {
      try {
        const diskUpdated = await window.electronAPI.clipboard.removePromptImage(
          targetBatchId,
          indexToRemove,
          imagesRef.current
        )
        if (Array.isArray(diskUpdated)) {
          nextImages = normalizePromptImageAttachments(diskUpdated)
        }
      } catch (err) {
        console.warn('[PromptEditor] removePromptImage failed:', err)
      }
    }
    writeImages(nextImages, targetBatchId)
    const currentText = readContent()
    const nextText = renumberPromptTextAfterImageRemove(currentText, indexToRemove)
    if (nextText !== currentText) {
      writeContent(nextText)
    } else {
      scheduleParentSync()
    }
    setPreviewImageIndex((prev) => {
      if (prev === null) return null
      if (nextImages.length === 0) return null
      if (prev === indexToRemove) return Math.min(indexToRemove, nextImages.length)
      if (prev > indexToRemove) return prev - 1
      return prev
    })
    return true
  }, [ensureIsolatedBatchForMutation, readContent, scheduleParentSync, writeContent, writeImages])

  const handleInsertImageToken = useCallback((index: number): boolean => {
    if (!imagesRef.current.some((img) => img.index === index)) return false
    const token = formatPromptImageToken(index)
    insertTextIntoEditor(token)
    return true
  }, [insertTextIntoEditor])

  const handleSelectMentionCandidate = useCallback((candidateIndex: number): boolean => {
    const currentMenu = mentionMenuRef.current
    const currentText = readContent()
    const caret = lastKnownSelectionRef.current?.end ?? currentText.length
    const trigger = currentMenu
      ? {
          startOffset: currentMenu.startOffset,
          endOffset: currentMenu.endOffset,
          query: currentMenu.query,
          candidates: currentMenu.candidates
        }
      : detectPromptMentionTrigger(currentText, caret, imagesRef.current)
    if (!trigger || !trigger.candidates.some((c) => c.index === candidateIndex)) return false
    const { nextText, nextCaret } = applyPromptMentionCandidate(currentText, trigger, candidateIndex)
    setMentionMenu(null)
    applyMutation(nextText, nextCaret)
    if (editorRef.current) {
      editorRef.current.focus()
      setCaretOffset(nextCaret)
    }
    return true
  }, [applyMutation, readContent, setCaretOffset])

  const handleOpenImagePreview = useCallback((index: number): boolean => {
    if (!imagesRef.current.some((img) => img.index === index)) return false
    setPreviewImageIndex(index)
    return true
  }, [])

  const closeImagePreview = useCallback(() => {
    setPreviewImageIndex(null)
  }, [])

  useModalEscape(!hidden && previewImageIndex !== null, closeImagePreview, 'prompt-image-lightbox')

  // Autotest-only controls mutate the same local snapshot as trusted input.
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest || !activeTab) return
    let live = true
    const control = {
      setContent: (value: string) => {
        hasMountedRef.current = true
        writeContent(value)
      },
      setTitle: writeTitle,
      isDraftSyncHeld: () => draftSyncHeldForAutotestRef.current,
      setDraftSyncHeld: (held: boolean) => {
        if (!live || draftSyncHeldForAutotestRef.current === held) return
        draftSyncHeldForAutotestRef.current = held
        if (parentNotifyTimerRef.current) clearTimeout(parentNotifyTimerRef.current)
        parentNotifyTimerRef.current = null
        // Release resumes the existing debounce, which reads the latest local
        // draft rather than an older payload captured before the hold.
        if (!held) scheduleParentSync()
      },
      dropFiles: (paths: string[]) => dropFilePathsIntoEditor(paths),
      getLastFileDrop: () => lastEditorFileDropRef.current,
      getImages: () => imagesRef.current,
      pasteClipboard: (opts?: {
        filePaths?: string[]
        autotestImage?: { width: number; height: number }
      }) => pasteClipboardIntoEditor(undefined, opts),
      removeImage: (index: number) => handleRemoveImage(index),
      insertImageToken: (index: number) => handleInsertImageToken(index),
      openImagePreview: (index: number) => handleOpenImagePreview(index),
      closeImagePreview,
      getImagePreviewIndex: () => previewImageIndexRef.current,
      getMentionCandidates: () => mentionMenuRef.current?.candidates ?? [],
      selectMentionCandidate: (index: number) => handleSelectMentionCandidate(index)
    }
    ;(window as unknown as { __onwardPromptEditorContentControl?: typeof control }).__onwardPromptEditorContentControl = control
    return () => {
      control.setDraftSyncHeld(false)
      live = false
      const w = window as unknown as { __onwardPromptEditorContentControl?: typeof control }
      if (w.__onwardPromptEditorContentControl === control) {
        delete w.__onwardPromptEditorContentControl
      }
    }
  }, [
    writeContent,
    writeTitle,
    scheduleParentSync,
    activeTab,
    dropFilePathsIntoEditor,
    pasteClipboardIntoEditor,
    handleRemoveImage,
    handleInsertImageToken,
    handleSelectMentionCandidate,
    handleOpenImagePreview,
    closeImagePreview
  ])

  // Title / height changes drive the debounced parent sync; content changes
  // drive it imperatively from handleInput / writeContent (content is no longer
  // React state). The 300 ms debounce keeps the parent tree off the hot path.
  useEffect(() => {
    scheduleParentSync()
    return () => {
      if (parentNotifyTimerRef.current) clearTimeout(parentNotifyTimerRef.current)
      parentNotifyTimerRef.current = null
    }
  }, [title, height, scheduleParentSync])

  // Handle additional content (append to whatever the editor currently holds).
  useEffect(() => {
    if (appendContent) {
      const prev = readContent()
      writeContent(prev ? `${prev}\n\n${appendContent}` : appendContent)
      onAppendContentUsed()
    }
  }, [appendContent, onAppendContentUsed, readContent, writeContent])

  // Handle drag to adjust height
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    const startY = e.clientY
    const startHeight = height

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = startY - e.clientY
      const newHeight = Math.max(MIN_EDITOR_HEIGHT, startHeight + delta)
      heightRef.current = newHeight
      setHeight(newHeight)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      onPromptEditorHeightChange(heightRef.current)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing-editor-height')
    }

    document.body.classList.add('resizing-editor-height')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [height, onPromptEditorHeightChange])

  // Save processing (two strategies). The persisted content goes through
  // transformVirtualPaddingForSend so virtual-cursor placements with no input
  // ("ghost" padding) don't bleed into saved prompts. Leading-column padding
  // is preserved as intentional indentation.
  const handleSave = useCallback((saveAsNew: boolean) => {
    const sendContent = transformVirtualPaddingForSend(readContent())
    const currentImages = imagesRef.current
    if ((!sendContent && currentImages.length === 0) || !editingPrompt) return

    const savedTitle = title.trim()
    const wasSharedBatch = batchSharedWithEditingPromptRef.current
    const currentBatchId = batchIdRef.current

    // Clear editing state and drafts
    batchSharedWithEditingPromptRef.current = false
    writeTitle('')
    writeImages([], createPromptImageBatchId())
    setPreviewImageIndex(null)
    writeContent('')
    onCancelEdit()
    onEditorDraftChange(null)
    onSaveSuccess?.()

    if (saveAsNew) {
      // Create new entry (inherit colors); clone batch if still shared with original
      if (wasSharedBatch && currentImages.length > 0 && window.electronAPI?.clipboard?.clonePromptImageBatch) {
        const clonedBatchId = createPromptImageBatchId()
        void window.electronAPI.clipboard.clonePromptImageBatch(currentBatchId, clonedBatchId, currentImages).then((cloned) => {
          onSubmit(savedTitle, sendContent, editingPrompt.color, cloned.length > 0 ? cloned : currentImages)
        })
      } else {
        onSubmit(savedTitle, sendContent, editingPrompt.color, currentImages)
      }
    } else {
      // Update the original entry directly (preserveTimestamp: true, keep the original position)
      const updatedPrompt: Prompt = {
        ...editingPrompt,
        title: savedTitle,
        content: sendContent,
        lastUsedAt: Date.now(),
        images: currentImages.length > 0 ? currentImages : undefined
        // Do not modify updatedAt, createdAt, pinned, color
      }
      onUpdatePrompt(updatedPrompt, true)
    }
  }, [title, readContent, writeContent, writeImages, writeTitle, editingPrompt, onSubmit, onUpdatePrompt, onCancelEdit, onEditorDraftChange, onSaveSuccess])

  // Submit processing (add new Prompt, optionally with a color tag).
  const handleSubmit = useCallback((color?: PromptColor | null) => {
    const sendContent = transformVirtualPaddingForSend(readContent())
    const currentImages = imagesRef.current
    if (!sendContent && currentImages.length === 0) return

    onSubmit(title.trim(), sendContent, color ?? null, currentImages)
    batchSharedWithEditingPromptRef.current = false
    writeTitle('')
    writeImages([], createPromptImageBatchId())
    setPreviewImageIndex(null)
    writeContent('')
    // Clear draft after submission
    onEditorDraftChange(null)
  }, [title, readContent, writeContent, writeImages, writeTitle, onSubmit, onEditorDraftChange])

  // Edit mode: apply a color and save the current edit in one action
  const handleSaveWithColor = useCallback((color: PromptColor) => {
    const sendContent = transformVirtualPaddingForSend(readContent())
    const currentImages = imagesRef.current
    if ((!sendContent && currentImages.length === 0) || !editingPrompt) return

    onUpdatePrompt({
      ...editingPrompt,
      title: title.trim(),
      content: sendContent,
      color,
      lastUsedAt: Date.now(),
      images: currentImages.length > 0 ? currentImages : undefined
    }, true)

    batchSharedWithEditingPromptRef.current = false
    writeTitle('')
    writeImages([], createPromptImageBatchId())
    setPreviewImageIndex(null)
    writeContent('')
    onCancelEdit()
    onEditorDraftChange(null)
    onSaveSuccess?.()
  }, [title, readContent, writeContent, writeImages, writeTitle, editingPrompt, onUpdatePrompt, onCancelEdit, onEditorDraftChange, onSaveSuccess])

  // Cancel edit
  const handleCancel = useCallback(() => {
    batchSharedWithEditingPromptRef.current = false
    writeTitle('')
    writeImages([], createPromptImageBatchId())
    setPreviewImageIndex(null)
    writeContent('')
    onCancelEdit()
    // Clear draft after canceling
    onEditorDraftChange(null)
    // Cancel the blur input box after editing to ensure that ESC can close the Editor normally next time
    editorRef.current?.blur()
  }, [writeContent, writeImages, writeTitle, onCancelEdit, onEditorDraftChange])

  // Parent content/title notifications are handled by the debounced
  // effect above — no separate immediate effects needed here.

  const handleTitleChange = useCallback((value: string) => {
    writeTitle(value)
    if (performanceTrace.enabled) {
      performanceTrace.recordInstant('ui.prompt.edit', {
        field: 'title',
        mode: editingPrompt ? 'edit' : 'new',
        ...performanceTrace.summarizeText('payload', value)
      }, 'prompt')
    }
  }, [editingPrompt, writeTitle])

  // Native input handler for the contenteditable. Does NOT push the value
  // through React state — the DOM is the source of truth. It only flips the
  // has-content flag (rare re-render) and schedules the debounced parent sync,
  // which is what keeps typing / IME O(1) in React terms regardless of size.
  const handleInput = useCallback(() => {
    const content = readContent()
    captureCurrentSelection()
    if (imagesRef.current.length > 0) {
      const caret = lastKnownSelectionRef.current?.end ?? content.length
      syncMentionMenu(content, caret, imagesRef.current)
    } else if (mentionMenuRef.current !== null) {
      setMentionMenu(null)
    }
    draftRevisionRef.current += 1
    syncHasContent(content)
    scheduleParentSync()
    if (performanceTrace.enabled) {
      performanceTrace.recordInstant('ui.prompt.edit', {
        field: 'content',
        mode: editingPrompt ? 'edit' : 'new',
        ...performanceTrace.summarizeText('payload', content)
      }, 'prompt')
    }
  }, [editingPrompt, captureCurrentSelection, syncHasContent, syncMentionMenu, scheduleParentSync, readContent])

  // Undo the most recent applyMutation by popping the history stack. Returns
  // false when the stack is empty (UI surface this as a disabled menu item).
  // Only content + caret are restored — title is owned by the user's keyboard
  // and is not part of menu mutations.
  const undoLastMutation = useCallback((): boolean => {
    const last = historyRef.current.pop()
    if (!last) return false
    writeContent(last.value, last.selectionStart)
    editorRef.current?.focus()
    return true
  }, [writeContent])

  const handleEditorDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesInDataTransfer(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    fileDropDepthRef.current += 1
    setIsFileDropTarget(true)
  }, [])

  const handleEditorDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesInDataTransfer(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
    if (!isFileDropTarget) {
      setIsFileDropTarget(true)
    }
  }, [isFileDropTarget])

  const handleEditorDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesInDataTransfer(e.dataTransfer) && fileDropDepthRef.current === 0) return
    e.preventDefault()
    e.stopPropagation()
    fileDropDepthRef.current = Math.max(0, fileDropDepthRef.current - 1)
    if (fileDropDepthRef.current === 0) {
      setIsFileDropTarget(false)
    }
  }, [])

  const handleEditorDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesInDataTransfer(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    fileDropDepthRef.current = 0
    setIsFileDropTarget(false)
    const resolvePath = (file: File) => window.electronAPI?.shell?.getPathForFile?.(file) ?? ''
    const uriListText = (() => {
      try {
        return e.dataTransfer?.getData('text/uri-list') ?? ''
      } catch {
        return ''
      }
    })()
    const rawPaths = extractDroppedFilePaths(e.dataTransfer?.files, resolvePath, { uriListText, platform })
    dropFilePathsIntoEditor(rawPaths)
  }, [dropFilePathsIntoEditor, platform])

  const handleEditorPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const resolvePath = (file: File) => window.electronAPI?.shell?.getPathForFile?.(file) ?? ''
    const uriListText = (() => {
      try {
        return e.clipboardData?.getData('text/uri-list') ?? ''
      } catch {
        return ''
      }
    })()
    const droppedFilePaths = extractDroppedFilePaths(e.clipboardData?.files, resolvePath, { uriListText, platform })
    const clipboardText = e.clipboardData?.getData('text/plain') ?? ''
    const hasImageItem = Array.from(e.clipboardData?.items ?? []).some((item) =>
      typeof item.type === 'string' && item.type.startsWith('image/')
    )
    const hasFilesType = Array.from(e.clipboardData?.types ?? []).includes('Files')
    const action = decidePromptEditorPasteAction({
      droppedFilePaths,
      clipboardText,
      hasImage: hasImageItem,
      hasFilesType
    })
    if (action.kind === 'files') {
      e.preventDefault()
      const sel = getSelectionOffsets()
      void pasteClipboardIntoEditor(sel, { filePaths: action.paths })
      return
    }
    if (action.kind === 'image' || action.kind === 'native-probe') {
      e.preventDefault()
      const sel = getSelectionOffsets()
      void pasteClipboardIntoEditor(sel)
    }
  }, [getSelectionOffsets, pasteClipboardIntoEditor, platform])

  const handleContextMenuPasteClipboard = useCallback(async (snapshot: ContextMenuSnapshot) => {
    await pasteClipboardIntoEditor({ start: snapshot.start, end: snapshot.end })
  }, [pasteClipboardIntoEditor])

  const handleEditorContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    // Capture value/selection atomically at the contextmenu event so menu
    // actions operate on what the user is currently looking at.
    const sel = getSelectionOffsets()
    lastKnownSelectionRef.current = sel
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      snapshot: {
        value: readContent(),
        start: sel.start,
        end: sel.end
      },
      canUndo: historyRef.current.length > 0
    })
  }, [getSelectionOffsets, readContent])

  const closeCtxMenu = useCallback(() => {
    setCtxMenu(null)
  }, [])

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false
  }, [])

  // Shortcut support
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || isComposingRef.current) return

    const activeMention = mentionMenuRef.current
    if (activeMention && activeMention.candidates.length > 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionMenu((prev) => prev ? {
          ...prev,
          selectedIndex: (prev.selectedIndex + 1) % prev.candidates.length
        } : null)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionMenu((prev) => prev ? {
          ...prev,
          selectedIndex: (prev.selectedIndex - 1 + prev.candidates.length) % prev.candidates.length
        } : null)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const chosen = activeMention.candidates[activeMention.selectedIndex] ?? activeMention.candidates[0]
        if (chosen) {
          handleSelectMentionCandidate(chosen.index)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMentionMenu(null)
        return
      }
    }

    // Construct an accelerator format of the current keystroke
    const accelerator = buildAccelerator(e.nativeEvent)

    if (editingPrompt) {
      const isSaveShortcut = matchesAccelerator(accelerator, saveShortcut)
      const isSaveAsShortcut = matchesAccelerator(accelerator, saveAsShortcut)
      // Escape deliberately does NOT cancel editing so an accidental Esc never discards modified text.

      if (isSaveShortcut) {
        e.preventDefault()
        handleSave(false)
        return
      }

      if (isSaveAsShortcut) {
        e.preventDefault()
        handleSave(true)
        return
      }

      return
    }

    // Check if the configured shortcuts match
    const isConfiguredShortcut = addToHistoryShortcut && accelerator === addToHistoryShortcut
    // If there is no shortcut configured, use the default Cmd/Ctrl+Enter
    const isDefaultShortcut = !addToHistoryShortcut && e.key === 'Enter' && (e.metaKey || e.ctrlKey)

    if (isConfiguredShortcut || isDefaultShortcut) {
      e.preventDefault()
      handleSubmit()
      return
    }

  }, [handleSubmit, handleSave, handleSelectMentionCandidate, editingPrompt, addToHistoryShortcut, matchesAccelerator, saveShortcut, saveAsShortcut])

  // Register callback to Context (only visible instance registration).
  // Keyboard-shortcut focus lands the caret at offset 0 — the predictable
  // "start fresh" anchor.
  useEffect(() => {
    if (hidden) return
    registerFocusEditor(() => {
      const el = editorRef.current
      if (!el) return
      el.focus()
      setCaretOffset(0)
    })
    registerSubmitEditor(() => handleSubmit())
    return () => {
      registerFocusEditor(null)
      registerSubmitEditor(null)
    }
  }, [registerFocusEditor, registerSubmitEditor, handleSubmit, hidden, setCaretOffset])

  const handleMentionHoverIndex = useCallback((idx: number) => {
    setMentionMenu((prev) => prev ? { ...prev, selectedIndex: idx } : null)
  }, [])

  const handleRemoveImageClick = useCallback((index: number) => {
    void handleRemoveImage(index)
  }, [handleRemoveImage])

  return (
    <div
      className={isFileDropTarget ? 'prompt-editor is-file-drop-target' : 'prompt-editor'}
      style={dockPosition === 'bottom' ? undefined : { height }}
      onKeyDown={handleKeyDown}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onDragEnter={handleEditorDragEnter}
      onDragOver={handleEditorDragOver}
      onDragLeave={handleEditorDragLeave}
      onDrop={handleEditorDrop}
      data-prompt-editing={editingPrompt ? 'true' : undefined}
    >
      <div className="prompt-editor-resizer" onMouseDown={handleMouseDown} />

      {draftToast && (
        <div className="prompt-editor-draft-toast" role="status">{draftToast}</div>
      )}

      <PromptAttachmentStrip
        images={images}
        onOpenPreview={handleOpenImagePreview}
        onInsertToken={handleInsertImageToken}
        onRemove={handleRemoveImageClick}
      />

      <div className="prompt-editor-inputs">
        <PromptAttachmentMentionMenu
          menu={mentionMenu}
          onHoverIndex={handleMentionHoverIndex}
          onSelectCandidate={handleSelectMentionCandidate}
        />
        <div className="prompt-editor-title-row">
          <input
            type="text"
            className="prompt-editor-title"
            placeholder={t('promptEditor.titlePlaceholder')}
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
          />
        </div>
        <div
          ref={editorRef}
          className="prompt-editor-content"
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={t('promptNotebook.editorPlaceholder')}
          data-placeholder={t('promptNotebook.editorPlaceholder')}
          spellCheck={false}
          onInput={handleInput}
          onKeyUp={captureCurrentSelection}
          onMouseUp={captureCurrentSelection}
          onBlur={captureCurrentSelection}
          onPaste={handleEditorPaste}
          onContextMenu={handleEditorContextMenu}
        />
      </div>
      {ctxMenu && (
        <PromptEditorContextMenu
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          snapshot={ctxMenu.snapshot}
          canUndo={ctxMenu.canUndo}
          isMac={isMac}
          onClose={closeCtxMenu}
          textareaRef={editorRef}
          applyMutation={applyMutation}
          onUndo={undoLastMutation}
          onPasteClipboard={handleContextMenuPasteClipboard}
          pinnedPrompts={ctxPinnedPrompts}
          appendPromptToContent={ctxAppendPromptToContent}
          saveSelectionAsPinned={ctxSaveSelectionAsPinned}
          currentCwd={ctxCurrentCwd}
          currentBranch={ctxCurrentBranch}
          currentTaskTitle={ctxCurrentTaskTitle}
          terminals={ctxTerminals}
          onSendToTask={ctxSendToTask}
        />
      )}

      <PromptAttachmentLightbox
        images={images}
        previewImageIndex={previewImageIndex}
        hidden={hidden}
        onSelectIndex={setPreviewImageIndex}
        onInsertToken={handleInsertImageToken}
        onClose={closeImagePreview}
      />

      <div className="prompt-editor-actions">
        <div
          className="prompt-editor-color-picker"
          role="group"
          aria-label={t('promptEditor.colorPickerLabel')}
        >
          {PROMPT_COLORS.map(({ key, hex }) => {
            const label = editingPrompt
              ? t(`promptEditor.saveWith.${key}`)
              : t(`promptEditor.addWith.${key}`)
            return (
              <button
                key={key}
                type="button"
                className={`prompt-editor-color-btn prompt-editor-color-btn-${key}`}
                style={{ ['--color' as string]: hex } as React.CSSProperties}
                disabled={!hasContent}
                onClick={() => editingPrompt ? handleSaveWithColor(key) : handleSubmit(key)}
                title={label}
                aria-label={label}
              >
                <span className="prompt-editor-color-dot" />
              </button>
            )
          })}
        </div>
        {editingPrompt ? (
          <>
            <button
              className="prompt-editor-btn prompt-editor-btn-cancel"
              onClick={handleCancel}
              title={t('common.cancel')}
            >
              {t('common.cancel')}
            </button>
            <button
              className="prompt-editor-btn prompt-editor-btn-submit"
              onClick={() => handleSave(false)}
              disabled={!hasContent}
              title={t('promptNotebook.shortcutTitle', { shortcut: saveShortcutLabel })}
            >
              {t('common.save')}
            </button>
            <button
              className="prompt-editor-btn prompt-editor-btn-submit"
              onClick={() => handleSave(true)}
              disabled={!hasContent}
              title={t('promptNotebook.shortcutTitle', { shortcut: saveAsShortcutLabel })}
            >
              {t('promptNotebook.saveAsNew')}
            </button>
          </>
        ) : (
          <button
            className="prompt-editor-btn prompt-editor-btn-submit"
            onClick={() => handleSubmit()}
            disabled={!hasContent}
          >
            {t('promptEditor.addToHistory')}
          </button>
        )}
      </div>
    </div>
  )
})
