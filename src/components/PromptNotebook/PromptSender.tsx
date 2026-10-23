/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, memo } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import type { TerminalInfo } from '../../types/prompt'
import { resolvePromptTargets, type PromptInputSettings } from '../../utils/prompt-input'
import { PromptActionButton } from './PromptActionButton'
import { useI18n } from '../../i18n/useI18n'
import { perfTrace, perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { performanceTrace } from '../../utils/performance-trace'
import type { ResolvedLayout } from '../../utils/layout-mode'
import {
  getTaskSelectorGeometry,
  taskSelectorGeometrySignature,
  type TaskSelectorSlot
} from '../../utils/task-selector-geometry'

/** How many rainbow accent slots App.css defines (`--rainbow-1`..`--rainbow-6`). */
const RAINBOW_SLOT_COUNT = 6

interface PromptSenderProps {
  terminals: TerminalInfo[]
  /**
   * The Task layout currently rendered by TerminalGrid. The selector mirrors
   * its shape so "the second card, top-right" means the same Task on both
   * sides of the window.
   */
  taskLayout: ResolvedLayout
  tabId: string
  hidden: boolean
  activeTab: boolean
  promptContent: string
  inputSettings: PromptInputSettings
  selectedIds: string[]
  onSelectionChange: (ids: string[]) => void
  registerSelectionFlush: (flush: () => void) => () => void
  onAction: (actionId: string) => Promise<boolean>
  isSubmitting: boolean
  notice: { text: string; error: boolean } | null
  onTerminalRename: (id: string, newTitle: string) => void
  onChangeWorkDir?: (terminalIds: string[], directory: string) => void
}

/** Inline grid placement for one mirrored slot. */
function slotStyle(slot: TaskSelectorSlot | undefined): CSSProperties {
  if (!slot) return {}
  return {
    gridColumn: `${slot.colStart} / span ${slot.colSpan}`,
    gridRow: `${slot.rowStart} / span ${slot.rowSpan}`
  }
}

export const PromptSender = memo(function PromptSender({
  terminals,
  taskLayout,
  tabId,
  hidden,
  activeTab,
  promptContent,
  inputSettings,
  selectedIds,
  onSelectionChange,
  registerSelectionFlush,
  onAction,
  isSubmitting,
  notice,
  onTerminalRename
}: PromptSenderProps) {
  const { t } = useI18n()
  const selectedTerminals = useMemo(() => new Set(selectedIds), [selectedIds])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const pendingSelectionRef = useRef<{ id: string; timer: number; unavailableIds: string[] } | null>(null)
  const [pendingCardId, setPendingCardId] = useState<string | null>(null)
  // Keep debug automation on the latest state without recreating the API object.
  const terminalsRef = useRef(terminals)
  const promptContentRef = useRef(promptContent)
  const selectedTerminalsRef = useRef(selectedTerminals)
  const selectionNoticeRef = useRef(notice?.text ?? '')
  const isSubmittingRef = useRef(isSubmitting)
  const actionRef = useRef(onAction)
  const selectionChangeRef = useRef(onSelectionChange)
  const settingsRef = useRef(inputSettings)
  // Mirror of the right-hand Task grid: same column / row track counts, and
  // for a custom layout the same per-Task rectangles. This component
  // receives debounced prompt content, so mapping and styles stay pinned
  // to the layout rather than recomputed per character.
  const geometry = useMemo(
    () => getTaskSelectorGeometry(taskLayout, terminals.length),
    [taskLayout, terminals.length]
  )
  const geometrySignature = useMemo(() => taskSelectorGeometrySignature(geometry), [geometry])
  const gridTrackStyle = useMemo(() => ({
    '--task-slot-cols': geometry.columns,
    '--task-slot-rows': geometry.rows
  }) as CSSProperties, [geometry])
  const geometryRef = useRef(geometry)
  const taskLayoutKindRef = useRef(taskLayout.kind)
  const selectedCount = selectedTerminals.size

  useEffect(() => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, {
      phase: 'sender-feedback', state: notice ? notice.error ? 'error-visible' : 'success-muted' : 'cleared'
    })
  }, [notice])

  terminalsRef.current = terminals
  promptContentRef.current = promptContent
  selectedTerminalsRef.current = selectedTerminals
  selectionNoticeRef.current = notice?.text ?? ''
  isSubmittingRef.current = isSubmitting
  geometryRef.current = geometry
  taskLayoutKindRef.current = taskLayout.kind
  actionRef.current = onAction
  selectionChangeRef.current = onSelectionChange
  settingsRef.current = inputSettings

  const updateSelection = useCallback((next: Set<string>) => {
    selectedTerminalsRef.current = next
    selectionChangeRef.current([...next])
  }, [])

  const pruneUnavailableSelectionAtGesture = useCallback(() => {
    const current = selectedTerminalsRef.current
    const next = new Set([...current].filter(id => terminalsRef.current.some(terminal => terminal.id === id)))
    if (next.size !== current.size) updateSelection(next)
  }, [updateSelection])

  // Diagnostic breadcrumb for "the selector no longer matches the grid".
  // Keyed on the geometry signature, so this fires on a layout switch, a
  // custom-preset edit or a Task count change — not on every render.
  useEffect(() => {
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_SENDER_LAYOUT_SYNC, {
      kind: taskLayoutKindRef.current,
      columns: geometryRef.current.columns,
      rows: geometryRef.current.rows,
      slots: geometryRef.current.slots.length,
      signature: geometrySignature
    })
  }, [geometrySignature])

  const recordTaskSelectionTrace = useCallback((id: string, selected: boolean, selectedCount: number) => {
    if (!performanceTrace.enabled) return
    performanceTrace.recordInstant('ui.prompt.task_select', {
      terminalId: id,
      selected,
      selectedCount,
      totalCount: terminalsRef.current.length
    }, 'prompt')
  }, [])

  // Automatically focus on the edit input box
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const handleToggle = useCallback((id: string) => {
    const newSet = new Set(selectedTerminalsRef.current)
    let selected = false
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
      selected = true
    }
    recordTaskSelectionTrace(id, selected, newSet.size)
    updateSelection(newSet)
  }, [recordTaskSelectionTrace, updateSelection])

  const flushPendingSelection = useCallback(() => {
    const pending = pendingSelectionRef.current
    if (!pending) return
    pendingSelectionRef.current = null
    window.clearTimeout(pending.timer)
    setPendingCardId(null)
    // Only discard targets already unavailable at the click. A target lost
    // during the rename delay must remain selected so dispatch rejects it.
    if (pending.unavailableIds.length) {
      updateSelection(new Set([...selectedTerminalsRef.current].filter(id => !pending.unavailableIds.includes(id))))
    }
    handleToggle(pending.id)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'selection-flushed', tabId })
  }, [handleToggle, updateSelection, tabId])

  useLayoutEffect(() => registerSelectionFlush(flushPendingSelection), [registerSelectionFlush, flushPendingSelection])

  const cancelPendingSelection = useCallback(() => {
    const pending = pendingSelectionRef.current
    if (!pending) return
    pendingSelectionRef.current = null
    window.clearTimeout(pending.timer)
    setPendingCardId(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'selection-cancelled', tabId })
  }, [tabId])

  const handleCardClick = (event: MouseEvent<HTMLDivElement>, id: string) => {
    event.stopPropagation()
    if (pendingSelectionRef.current?.id === id) {
      cancelPendingSelection()
    } else {
      // A click on another card is not the first card's rename gesture.
      flushPendingSelection()
    }
    pendingSelectionRef.current = {
      id, timer: window.setTimeout(flushPendingSelection, 200),
      unavailableIds: [...selectedTerminalsRef.current].filter(selected => !terminalsRef.current.some(terminal => terminal.id === selected))
    }
    setPendingCardId(id)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'selection-pending', tabId })
  }

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      flushPendingSelection()
      pruneUnavailableSelectionAtGesture()
      handleToggle(id)
    }
  }

  // Double click to start editing
  const handleStartEdit = (id: string, currentCustomName: string | null) => {
    setEditingId(id)
    setEditingTitle(currentCustomName || '')
  }

  // Complete editing
  const handleFinishEdit = () => {
    if (editingId) {
      onTerminalRename(editingId, editingTitle.trim())
    }
    setEditingId(null)
    setEditingTitle('')
  }

  // Cancel edit
  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingTitle('')
  }

  // Keyboard events
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      handleFinishEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  useEffect(() => {
    return () => {
      if (pendingSelectionRef.current) {
        window.clearTimeout(pendingSelectionRef.current.timer)
        pendingSelectionRef.current = null
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'selection-disposed', tabId })
      }
    }
  }, [tabId])

  // Debug API (only exposed in automated testing mode)
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest || !activeTab) return
    const api = {
      getTerminalCards: () => terminalsRef.current.map(t => ({
        id: t.id,
        title: t.title || `Task`,
        isSelected: selectedTerminalsRef.current.has(t.id)
      })),
      getPromptContent: () => promptContentRef.current,
      getSelectedCount: () => selectedTerminalsRef.current.size,
      getSelectionIndicatorStates: () => terminalsRef.current.map((terminal) => ({
        id: terminal.id,
        isActive: selectedTerminalsRef.current.has(terminal.id)
      })),
      getSelectedTerminalIds: () => Array.from(selectedTerminalsRef.current),
      getActionButtons: () => {
        const root = Array.from(document.querySelectorAll<HTMLElement>('.prompt-sender')).find(element => element.dataset.tabId === tabId)
        const btns = root?.querySelectorAll('.prompt-sender-btn') ?? []
        return Array.from(btns).map(btn => ({
          label: btn.getAttribute('aria-label') ?? '',
          actionId: (btn as HTMLElement).dataset.actionId,
          disabled: (btn as HTMLButtonElement).disabled
        }))
      },
      getGridLayout: () => ({
        columns: geometryRef.current.columns,
        rows: geometryRef.current.rows,
        totalCards: terminalsRef.current.length,
        layoutKind: taskLayoutKindRef.current,
        slots: geometryRef.current.slots.map((slot, index) => ({
          terminalId: terminalsRef.current[index]?.id ?? '',
          colStart: slot.colStart,
          colSpan: slot.colSpan,
          rowStart: slot.rowStart,
          rowSpan: slot.rowSpan
        }))
      }),
      getNotice: () => selectionNoticeRef.current || null,
      isSubmitting: () => isSubmittingRef.current,
      clickAction: async (action: string) => {
        if (!settingsRef.current.actions.some(candidate => candidate.id === action)) return false
        return actionRef.current(action)
      },
      selectTerminal: (id: string) => {
        if (!terminalsRef.current.some(t => t.id === id)) return false
        cancelPendingSelection()
        pruneUnavailableSelectionAtGesture()
        const next = new Set(selectedTerminalsRef.current)
        if (!next.has(id)) {
          next.add(id)
          recordTaskSelectionTrace(id, true, next.size)
        }
        updateSelection(next)
        return true
      },
      deselectTerminal: (id: string) => {
        cancelPendingSelection()
        pruneUnavailableSelectionAtGesture()
        const next = new Set(selectedTerminalsRef.current)
        next.delete(id)
        updateSelection(next)
        return true
      },
      deselectAllTerminals: () => {
        cancelPendingSelection()
        updateSelection(new Set())
      }
    }
    ;(window as any).__onwardPromptSenderDebug = api
    return () => {
      if ((window as any).__onwardPromptSenderDebug === api) {
        delete (window as any).__onwardPromptSenderDebug
      }
    }
  }, [tabId, hidden, activeTab, updateSelection, cancelPendingSelection, pruneUnavailableSelectionAtGesture, recordTaskSelectionTrace])

  return (
    <div className="prompt-sender" data-tab-id={tabId}>
      <div
        className="prompt-sender-terminals"
        style={gridTrackStyle}
        data-task-columns={geometry.columns}
        data-task-rows={geometry.rows}
        data-task-layout-kind={taskLayout.kind}
      >
        {terminals.length === 0 ? (
          <div className="prompt-sender-empty">{t('promptSender.noTerminals')}</div>
        ) : (
          terminals.map((terminal, index) => (
            <div
              key={terminal.id}
              className={`prompt-sender-terminal ${selectedTerminals.has(terminal.id) ? 'is-selected' : ''}`}
              // Only six rainbow accents exist; an 8-Task layout would
              // otherwise resolve `var(--rainbow-7)` to nothing and drop the
              // card's border colour entirely.
              style={{
                ...slotStyle(geometry.slots[index]),
                '--t-color': `var(--rainbow-${(index % RAINBOW_SLOT_COUNT) + 1})`
              } as React.CSSProperties}
              data-terminal-id={terminal.id}
              data-slot-index={index}
              role="button"
              tabIndex={0}
              aria-pressed={selectedTerminals.has(terminal.id)}
              onClick={(event) => handleCardClick(event, terminal.id)}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (pendingSelectionRef.current?.id === terminal.id) cancelPendingSelection()
                handleStartEdit(terminal.id, terminal.customName)
              }}
              onKeyDown={(event) => handleCardKeyDown(event, terminal.id)}
            >
              {editingId === terminal.id ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="prompt-sender-terminal-input"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={handleFinishEdit}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={`Task ${index + 1}`}
                />
              ) : (
                <>
                  {/*
                    A slot too narrow for a name shows the Task's position
                    number instead: a truncated "Tas…" identifies nothing,
                    while the number is the same handle Cmd+N uses. The swap
                    is a container query on the card itself, so it tracks the
                    real slot width rather than the panel width — measured
                    crossover for an 8-Task 4x2 layout is a panel around
                    250-280px; the 320px default keeps names.
                  */}
                  <span
                    className="prompt-sender-terminal-name"
                    title={t('promptSender.taskCardTitle', {
                      name: terminal.title || `Task ${index + 1}`
                    })}
                  >
                    {terminal.title || `Task ${index + 1}`}
                  </span>
                  <span
                    className="prompt-sender-terminal-index"
                    title={t('promptSender.taskCardTitle', {
                      name: terminal.title || `Task ${index + 1}`
                    })}
                  >
                    {index + 1}
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="prompt-sender-actions">
        {terminals.length > 0 && (
          <div
            className="prompt-sender-selection-indicator"
            style={gridTrackStyle}
            role="status"
            aria-live="polite"
            aria-label={t('promptSender.selection.aria', { count: selectedCount })}
          >
            {terminals.map((terminal, index) => (
              <span
                key={terminal.id}
                className={`prompt-sender-selection-cell${selectedTerminals.has(terminal.id) ? ' is-active' : ''}`}
                style={slotStyle(geometry.slots[index])}
                data-terminal-id={terminal.id}
                aria-hidden="true"
              />
            ))}
          </div>
        )}

        <div className="prompt-sender-action-buttons prompt-action-rail">
          {inputSettings.actions.filter(action => action.visible).map(action => {
            const targets = resolvePromptTargets(action, terminals.map(terminal => terminal.id),
              terminals.find(terminal => terminal.isActive)?.id ?? null, selectedIds)
            const variant = action.preset === 'sendAndExecute' ? 'send-execute'
              : action.preset === 'sendAllAndExecute' ? 'send-all-execute' : action.preset ?? 'custom'
            return (
              <PromptActionButton
                key={action.id}
                action={action} leader={inputSettings.leader}
                className={`prompt-sender-btn prompt-sender-btn-${variant}`}
                onMouseDown={event => event.preventDefault()}
                onClick={() => { void onAction(action.id) }}
                disabled={isSubmitting || (targets.ids.length === 0 && pendingCardId === null)}
              />
            )
          })}
        </div>
      </div>

      {selectedIds.some(id => !terminals.some(terminal => terminal.id === id)) && (
        <button type="button" className="prompt-sender-clear-targets" onClick={() => {
          cancelPendingSelection()
          updateSelection(new Set())
        }}>
          {t('promptInput.runtime.clearTargets')}
        </button>
      )}
      {notice?.error && (
        <div className="prompt-sender-notice" role="alert" aria-live="assertive">
          {notice.text}
        </div>
      )}

    </div>
  )
})
