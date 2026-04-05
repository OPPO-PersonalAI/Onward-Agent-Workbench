/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react'
import { Prompt, PromptSendRecord } from '../../types/electron'
import type { TerminalBatchResult, TerminalInfo } from '../../types/prompt'
import type { EditorDraft, PromptCleanupConfig, PromptSchedule } from '../../types/tab.d.ts'
import { usePromptActions } from '../../contexts/PromptActionsContext'
import { buildAccelerator } from '../../utils/keyboard'
import type { ScheduleNotification } from '../../hooks/useScheduleEngine'
import { PromptSearch } from './PromptSearch'
import { PromptList } from './PromptList'
import { PromptSender } from './PromptSender'
import { ScheduleConfigModal } from './ScheduleConfigModal'
import { ScheduleNotificationBar } from './ScheduleNotification'
import { useI18n } from '../../i18n/useI18n'
import type { ImportPrepareResult } from '../../utils/prompt-io'
import './PromptNotebook.css'

interface PromptNotebookProps {
  terminals: TerminalInfo[]
  onSend: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onExecute: (terminalIds: string[]) => Promise<TerminalBatchResult>
  onSendAndExecute: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onTerminalRename: (id: string, newTitle: string) => void
  onChangeWorkDir: (terminalIds: string[], directory: string) => void
  width: number
  onWidthChange: (width: number) => void
  // Tab prompt related
  prompts: Prompt[]
  onAddPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => void
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
  // Draft related
  editorDraft: EditorDraft | null
  onEditorDraftChange: (draft: EditorDraft | null) => void
  // Shortcut configuration
  addToHistoryShortcut: string | null
  // Hidden support
  hidden?: boolean
  // Related to scheduled tasks
  tabId: string
  scheduleMap: Map<string, PromptSchedule>
  scheduleNotifications: ScheduleNotification[]
  onAddSchedule: (schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => void
  onUpdateSchedule: (schedule: PromptSchedule) => void
  onDeleteSchedule: (promptId: string) => void
  onDismissScheduleNotification: (promptId: string, type: ScheduleNotification['type']) => void
  onRetrySchedule: (promptId: string) => void
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
  onSend,
  onExecute,
  onSendAndExecute,
  onTerminalRename,
  onChangeWorkDir,
  width,
  onWidthChange,
  prompts,
  onAddPrompt,
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
  editorDraft,
  onEditorDraftChange,
  addToHistoryShortcut,
  hidden = false,
  tabId,
  scheduleMap,
  scheduleNotifications,
  onAddSchedule,
  onUpdateSchedule,
  onDeleteSchedule,
  onDismissScheduleNotification,
  onRetrySchedule
}: PromptNotebookProps) {
  const { t, locale } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
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

  useEffect(() => {
    return () => {
      if (saveMessageTimerRef.current) {
        window.clearTimeout(saveMessageTimerRef.current)
      }
    }
  }, [])
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null)
  const [appendContent, setAppendContent] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorTitle, setEditorTitle] = useState('')
  // Refs that track the latest editor values so the debug API effect
  // does not need editorContent / editorTitle in its dependency array.
  const editorContentRef = useRef(editorContent)
  const editorTitleRef = useRef(editorTitle)
  editorContentRef.current = editorContent
  editorTitleRef.current = editorTitle
  const [clearEditorTrigger, setClearEditorTrigger] = useState(0)
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

  // Get the currently selected Prompt
  const selectedPrompt = useMemo(() => {
    return prompts.find(p => p.id === selectedId) || null
  }, [prompts, selectedId])

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
    if (!window.electronAPI?.debug?.autotest) return

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
        pinned: p.pinned,
        color: p.color ?? undefined,
        lastUsedAt: p.lastUsedAt
      })),
      getCleanupConfig: () => ({
        autoEnabled: promptCleanup.autoEnabled,
        autoKeepDays: promptCleanup.autoKeepDays,
        autoDeleteColored: promptCleanup.autoDeleteColored,
        lastAutoCleanupAt: promptCleanup.lastAutoCleanupAt
      }),
      getEditorContent: () => editorContentRef.current,
      getEditorHeight: () => {
        const editor = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor') as HTMLElement | null
        if (!editor) return null
        return editor.getBoundingClientRect().height
      },
      getPersistedEditorHeight: () => promptEditorHeight,
      setEditorContent: (content: string) => {
        const textarea = document.querySelector(
          '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-content'
        ) as HTMLTextAreaElement | null
        if (textarea) {
          const prototype = Object.getPrototypeOf(textarea) as HTMLTextAreaElement
          const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
          valueSetter?.call(textarea, content)
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
          return
        }
        setEditorContent(content)
      },
      submitEditor: () => {
        if (!editorContentRef.current.trim()) return
        onAddPrompt({
          title: editorTitleRef.current.trim(),
          content: editorContentRef.current.trim(),
          pinned: false,
          color: undefined
        })
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
      }
    }
    ;(window as any).__onwardPromptNotebookDebug = api
    return () => {
      if ((window as any).__onwardPromptNotebookDebug === api) {
        delete (window as any).__onwardPromptNotebookDebug
      }
    }
  }, [prompts, promptCleanup, promptEditorHeight, onAddPrompt, scheduleMap, tabId, terminals, onAddSchedule, onUpdateSchedule, onDeleteSchedule])

  // Get the content to be sent: use the editor content first, otherwise use the selected Prompt content
  const contentToSend = useMemo(() => {
    return editorContent.trim() || selectedPrompt?.content || ''
  }, [editorContent, selectedPrompt])

  const hasEditorContent = useMemo(() => {
    return !!editorContent.trim()
  }, [editorContent])

  const saveEditorContentAsNewPrompt = useCallback((color?: Prompt['color'], sendRecords?: PromptSendRecord[]) => {
    if (!editorContent.trim()) return
    onAddPrompt({
      title: editorTitle.trim(),
      content: editorContent.trim(),
      pinned: false,
      color: color ?? undefined,
      sendHistory: sendRecords
    })
  }, [editorContent, editorTitle, onAddPrompt])

  // Filter Prompt (Search)
  const filteredPrompts = useMemo(() => {
    if (!searchKeyword.trim()) return prompts
    const keyword = searchKeyword.toLowerCase()
    return prompts.filter(p =>
      p.title.toLowerCase().includes(keyword) ||
      p.content.toLowerCase().includes(keyword)
    )
  }, [prompts, searchKeyword])

  // Create new Prompt (commit)
  const handleSubmit = useCallback((title: string, content: string, color?: 'red' | 'yellow' | 'green' | null) => {
    onAddPrompt({
      title,
      content,
      pinned: false,
      color: color || undefined
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

  // Double click to edit
  const handleDoubleClick = useCallback((prompt: Prompt) => {
    setEditingPrompt(prompt)
  }, [])

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

  const buildSendRecords = useCallback((successTerminalIds: string[], action: PromptSendRecord['action']): PromptSendRecord[] => {
    const now = Date.now()
    return successTerminalIds.map(tid => {
      const terminal = terminals.find(t => t.id === tid)
      return {
        taskId: tid,
        taskName: terminal?.title || tid,
        sentAt: now,
        action
      }
    })
  }, [terminals])

  const applySuccessSideEffects = useCallback((result: TerminalBatchResult, sendRecords?: PromptSendRecord[]): TerminalBatchResult => {
    if (result.successIds.length === 0) {
      return result
    }

    // Save to history when the content is not empty (the editing state is saved as a new entry by default)
    if (hasEditorContent) {
      saveEditorContentAsNewPrompt(editingPrompt?.color, sendRecords)
    } else if (selectedPrompt) {
      onTouchPromptLastUsed(selectedPrompt.id)
      // Record sending history to existing prompt
      if (sendRecords && sendRecords.length > 0) {
        const existing = selectedPrompt.sendHistory ?? []
        const merged = [...sendRecords, ...existing].slice(0, 100)
        onUpdatePrompt({ ...selectedPrompt, sendHistory: merged }, true)
      }
    }

    // Clear editor and drafts
    setClearEditorTrigger(prev => prev + 1)
    onEditorDraftChange(null)

    // Exit editing state
    if (editingPrompt) {
      setEditingPrompt(null)
    }

    setSelectedId(null)

    return result
  }, [editingPrompt, hasEditorContent, onEditorDraftChange, onTouchPromptLastUsed, onUpdatePrompt, saveEditorContentAsNewPrompt, selectedPrompt])

  // Send to terminal (wrapper, add save and clear logic)
  const handleSendToTerminal = useCallback(async (terminalIds: string[], content: string): Promise<TerminalBatchResult> => {
    const fallback: TerminalBatchResult = { successIds: [], failedIds: [...terminalIds] }
    try {
      const rawResult = await onSend(terminalIds, content)
      const sendRecords = rawResult.successIds.length > 0
        ? buildSendRecords(rawResult.successIds, 'send')
        : undefined
      return applySuccessSideEffects(rawResult, sendRecords)
    } catch (error) {
      console.error('Prompt send failed:', error)
      return fallback
    }
  }, [onSend, applySuccessSideEffects, buildSendRecords])

  // Execution (wrapping, adding save and clear logic)
  const handleExecuteTerminal = useCallback(async (terminalIds: string[]): Promise<TerminalBatchResult> => {
    const fallback: TerminalBatchResult = { successIds: [], failedIds: [...terminalIds] }
    try {
      return applySuccessSideEffects(await onExecute(terminalIds))
    } catch (error) {
      console.error('Prompt execute failed:', error)
      return fallback
    }
  }, [onExecute, applySuccessSideEffects])

  // Send and execute (wrapper, add save and clear logic)
  const handleSendAndExecute = useCallback(async (terminalIds: string[], content: string): Promise<TerminalBatchResult> => {
    const fallback: TerminalBatchResult = { successIds: [], failedIds: [...terminalIds] }
    try {
      const rawResult = await onSendAndExecute(terminalIds, content)
      const sendRecords = rawResult.successIds.length > 0
        ? buildSendRecords(rawResult.successIds, 'sendAndExecute')
        : undefined
      return applySuccessSideEffects(rawResult, sendRecords)
    } catch (error) {
      console.error('Prompt send and execute failed:', error)
      return fallback
    }
  }, [onSendAndExecute, applySuccessSideEffects, buildSendRecords])

  // Drag to adjust width
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX
      const newWidth = Math.max(200, startWidth + delta)
      onWidthChange(newWidth)
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing-prompt-panel')
    }

    document.body.classList.add('resizing-prompt-panel')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width, onWidthChange])

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

  return (
    <>
      <div className={`prompt-notebook${hidden ? ' prompt-notebook-hidden' : ''}`} style={{ width }}>
        <div
          className="prompt-notebook-resizer"
          onMouseDown={handleMouseDown}
        />

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
          onSelect={handleSelect}
          onDoubleClick={handleDoubleClick}
          onDelete={handleDelete}
          onTogglePin={handleTogglePin}
          onAppend={handleAppend}
          onColorChange={handleColorChange}
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
        />

        {/* input area */}
        <PromptEditorWithAppend
          onSubmit={handleSubmit}
          onUpdatePrompt={onUpdatePrompt}
          editingPrompt={editingPrompt}
          onCancelEdit={handleCancelEdit}
          appendContent={appendContent}
          onAppendContentUsed={handleAppendContentUsed}
          onContentChange={setEditorContent}
          onTitleChange={setEditorTitle}
          clearTrigger={clearEditorTrigger}
          promptEditorHeight={promptEditorHeight}
          onPromptEditorHeightChange={onPromptEditorHeightChange}
          editorDraft={editorDraft}
          onEditorDraftChange={onEditorDraftChange}
          addToHistoryShortcut={addToHistoryShortcut}
          hidden={hidden}
          onSaveSuccess={handleSaveSuccess}
        />

        {/* Send control area */}
        <PromptSender
          terminals={terminals}
          promptContent={contentToSend}
          onSend={handleSendToTerminal}
          onExecute={handleExecuteTerminal}
          onSendAndExecute={handleSendAndExecute}
          onTerminalRename={onTerminalRename}
          onChangeWorkDir={onChangeWorkDir}
        />
      </div>

      {/* Delete confirmation dialog */}
      {!hidden && deleteConfirm.isOpen && (
        <div className="confirm-dialog-overlay" onClick={handleCancelDelete}>
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
        <div className="confirm-dialog-overlay" onClick={handleCancelImport}>
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
        <div className="confirm-dialog-overlay" onClick={handleCancelRetention}>
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
        <div className="prompt-send-history-overlay" onClick={() => setSendHistoryPrompt(null)}>
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
                      {record.action === 'send'
                        ? t('promptNotebook.sendHistory.action.send')
                        : record.action === 'execute'
                          ? t('promptNotebook.sendHistory.action.execute')
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
  onSubmit,
  onUpdatePrompt,
  editingPrompt,
  onCancelEdit,
  appendContent,
  onAppendContentUsed,
  onContentChange,
  onTitleChange,
  clearTrigger,
  promptEditorHeight,
  onPromptEditorHeightChange,
  editorDraft,
  onEditorDraftChange,
  addToHistoryShortcut,
  hidden = false,
  onSaveSuccess
}: {
  onSubmit: (title: string, content: string, color?: 'red' | 'yellow' | 'green' | null) => void
  onUpdatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  editingPrompt: Prompt | null
  onCancelEdit: () => void
  appendContent: string
  onAppendContentUsed: () => void
  onContentChange: (content: string) => void
  onTitleChange: (title: string) => void
  clearTrigger: number
  promptEditorHeight: number
  onPromptEditorHeightChange: (height: number) => void
  editorDraft: EditorDraft | null
  onEditorDraftChange: (draft: EditorDraft | null) => void
  addToHistoryShortcut: string | null
  hidden?: boolean
  onSaveSuccess?: () => void
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const MIN_EDITOR_HEIGHT = 100
  const [height, setHeight] = useState(() => Math.max(promptEditorHeight, MIN_EDITOR_HEIGHT))
  const heightRef = useRef(height)
  const isDraggingRef = useRef(false)
  const hasMountedRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { registerFocusEditor, registerSubmitEditor } = usePromptActions()
  const platform = window.electronAPI?.platform ?? 'darwin'
  const isMac = platform === 'darwin'
  const saveShortcutLabel = isMac ? '⌘S' : 'Ctrl+S'
  const saveAsShortcutLabel = isMac ? '⌘⇧S' : 'Ctrl+Shift+S'
  const cancelShortcutLabel = 'Esc'
  const saveShortcut = 'CommandOrControl+S'
  const saveAsShortcut = 'CommandOrControl+Shift+S'
  const cancelShortcut = 'Escape'

  const matchesAccelerator = useCallback((accelerator: string, expected: string) => {
    if (!accelerator) return false
    const normalize = (value: string) => value
      .split('+')
      .map(part => (part === 'Ctrl' ? 'Control' : part))
      .join('+')
    return normalize(accelerator) === normalize(expected)
  }, [])

  useEffect(() => {
    heightRef.current = height
  }, [height])

  // Silently restore drafts on first mount
  useEffect(() => {
    if (!hasMountedRef.current && editorDraft) {
      setTitle(editorDraft.title)
      setContent(editorDraft.content)
      setHeight(Math.max(promptEditorHeight, editorDraft.height, MIN_EDITOR_HEIGHT))
      hasMountedRef.current = true
    } else if (!hasMountedRef.current) {
      hasMountedRef.current = true
    }
  }, [editorDraft, promptEditorHeight])

  useEffect(() => {
    if (isDraggingRef.current) return
    const normalizedHeight = Math.max(promptEditorHeight, MIN_EDITOR_HEIGHT)
    heightRef.current = normalizedHeight
    setHeight((prev) => (prev === normalizedHeight ? prev : normalizedHeight))
  }, [promptEditorHeight])

  // Populate content when edit mode is activated
  useEffect(() => {
    if (editingPrompt) {
      setTitle(editingPrompt.title)
      setContent(editingPrompt.content)
    }
  }, [editingPrompt])

  // Debounce parent notifications (content, title, draft) to avoid
  // re-rendering the entire PromptNotebook tree on every keystroke.
  // Local state (content / title) stays instant for responsive typing.
  const parentNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!hasMountedRef.current) return

    if (parentNotifyTimerRef.current) {
      clearTimeout(parentNotifyTimerRef.current)
    }

    parentNotifyTimerRef.current = setTimeout(() => {
      onContentChange(content)
      onTitleChange(title)

      if (!title.trim() && !content.trim()) {
        onEditorDraftChange(null)
      } else {
        onEditorDraftChange({
          title,
          content,
          height,
          savedAt: Date.now()
        })
      }
    }, 300)

    return () => {
      if (parentNotifyTimerRef.current) {
        clearTimeout(parentNotifyTimerRef.current)
      }
    }
  }, [title, content, height, onContentChange, onTitleChange, onEditorDraftChange])

  // Handle additional content
  useEffect(() => {
    if (appendContent) {
      setContent(prev => prev ? `${prev}\n\n${appendContent}` : appendContent)
      onAppendContentUsed()
    }
  }, [appendContent, onAppendContentUsed])

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

  // Save processing (two strategies)
  const handleSave = useCallback((saveAsNew: boolean) => {
    if (!content.trim() || !editingPrompt) return

    if (saveAsNew) {
      // Create new entry (inherit colors)
      onSubmit(title.trim(), content.trim(), editingPrompt.color)
    } else {
      // Update the original entry directly (preserveTimestamp: true, keep the original position)
      const updatedPrompt = {
        ...editingPrompt,
        title: title.trim(),
        content: content.trim(),
        lastUsedAt: Date.now()
        // Do not modify updatedAt, createdAt, pinned, color
      }
      onUpdatePrompt(updatedPrompt, true)
    }

    // Clear editing state and drafts
    setTitle('')
    setContent('')
    onCancelEdit()
    onEditorDraftChange(null)
    onSaveSuccess?.()
  }, [title, content, editingPrompt, onSubmit, onUpdatePrompt, onCancelEdit, onEditorDraftChange, onSaveSuccess])

  // Submit processing (add new Prompt)
  const handleSubmit = useCallback(() => {
    if (!content.trim()) return

    onSubmit(title.trim(), content.trim())
    setTitle('')
    setContent('')
    // Clear draft after submission
    onEditorDraftChange(null)
  }, [title, content, onSubmit, onEditorDraftChange])

  // Cancel edit
  const handleCancel = useCallback(() => {
    setTitle('')
    setContent('')
    onCancelEdit()
    // Clear draft after canceling
    onEditorDraftChange(null)
    // Cancel the blur input box after editing to ensure that ESC can close the Editor normally next time
    textareaRef.current?.blur()
  }, [onCancelEdit, onEditorDraftChange])

  // Parent content/title notifications are handled by the debounced
  // effect above — no separate immediate effects needed here.

  // Respond to clear triggers
  useEffect(() => {
    if (clearTrigger > 0) {
      setTitle('')
      setContent('')
    }
  }, [clearTrigger])

  // Shortcut support
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Construct an accelerator format of the current keystroke
    const accelerator = buildAccelerator(e.nativeEvent)

    if (editingPrompt) {
      const isSaveShortcut = matchesAccelerator(accelerator, saveShortcut)
      const isSaveAsShortcut = matchesAccelerator(accelerator, saveAsShortcut)
      const isCancelShortcut = matchesAccelerator(accelerator, cancelShortcut) || e.key === 'Escape'

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

      if (isCancelShortcut) {
        e.preventDefault()
        handleCancel()
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

  }, [handleSubmit, handleSave, handleCancel, editingPrompt, addToHistoryShortcut, matchesAccelerator, saveShortcut, saveAsShortcut, cancelShortcut])

  // Register callback to Context (only visible instance registration)
  useEffect(() => {
    if (hidden) return
    registerFocusEditor(() => textareaRef.current?.focus())
    registerSubmitEditor(() => handleSubmit())
    return () => {
      registerFocusEditor(null)
      registerSubmitEditor(null)
    }
  }, [registerFocusEditor, registerSubmitEditor, handleSubmit, hidden])

  return (
    <div
      className="prompt-editor"
      style={{ height }}
      onKeyDown={handleKeyDown}
      data-prompt-editing={editingPrompt ? 'true' : undefined}
    >
      <div className="prompt-editor-resizer" onMouseDown={handleMouseDown} />

      <div className="prompt-editor-inputs">
        <input
          type="text"
          className="prompt-editor-title"
          placeholder={t('promptEditor.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          ref={textareaRef}
          className="prompt-editor-content"
          placeholder={t('promptNotebook.editorPlaceholder')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>

      <div className="prompt-editor-actions">
        {editingPrompt ? (
          <>
            <button
              className="prompt-editor-btn prompt-editor-btn-cancel"
              onClick={handleCancel}
              title={t('promptNotebook.shortcutTitle', { shortcut: cancelShortcutLabel })}
            >
              {t('common.cancel')}
            </button>
            <button
              className="prompt-editor-btn prompt-editor-btn-submit"
              onClick={() => handleSave(false)}
              disabled={!content.trim()}
              title={t('promptNotebook.shortcutTitle', { shortcut: saveShortcutLabel })}
            >
              {t('common.save')}
            </button>
            <button
              className="prompt-editor-btn prompt-editor-btn-submit"
              onClick={() => handleSave(true)}
              disabled={!content.trim()}
              title={t('promptNotebook.shortcutTitle', { shortcut: saveAsShortcutLabel })}
            >
              {t('promptNotebook.saveAsNew')}
            </button>
          </>
        ) : (
          <button
            className="prompt-editor-btn prompt-editor-btn-submit"
            onClick={handleSubmit}
            disabled={!content.trim()}
          >
            {t('promptEditor.addToHistory')}
          </button>
        )}
      </div>
    </div>
  )
})
