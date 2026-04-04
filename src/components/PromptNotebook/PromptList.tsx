/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState, memo } from 'react'
import { Prompt } from '../../types/electron'
import type { PromptSchedule } from '../../types/tab.d.ts'
import { formatShortTime } from '../../utils/schedule'
import { useI18n } from '../../i18n/useI18n'

interface PromptListProps {
  prompts: Prompt[]
  selectedId: string | null
  searchKeyword: string
  onSelect: (id: string) => void
  onDoubleClick: (prompt: Prompt) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string) => void
  onAppend: (prompt: Prompt) => void
  onColorChange: (id: string, color: 'red' | 'yellow' | 'green' | null) => void
  onReorderPinned?: (dragId: string, targetId: string, position: 'before' | 'after') => void
  globalPromptIds?: string[]
  autoCleanupEnabled: boolean
  onExportAllPrompts: () => void
  onImportPrompts: () => void
  onRetentionKeepDays: (days: number) => void
  onRetentionKeepCustom: () => void
  onToggleAutoCleanup: (nextEnabled: boolean) => void
  /** Scheduled task mapping: promptId → PromptSchedule */
  scheduleMap?: Map<string, PromptSchedule>
  onSetSchedule?: (prompt: Prompt) => void
  onEditSchedule?: (prompt: Prompt) => void
  onCancelSchedule?: (promptId: string) => void
  onPauseSchedule?: (promptId: string) => void
  onResumeSchedule?: (promptId: string) => void
  onViewSendHistory?: (prompt: Prompt) => void
}

// Color configuration
const COLORS = [
  { key: 'red', hex: '#e74c3c' },
  { key: 'yellow', hex: '#f1c40f' },
  { key: 'green', hex: '#27ae60' }
] as const

const LONG_PRESS_DELAY = 280
const DRAG_MOVE_TOLERANCE = 6

interface PromptRetentionDropdownProps {
  autoCleanupEnabled: boolean
  onExportAllPrompts: () => void
  onImportPrompts: () => void
  onRetentionKeepDays: (days: number) => void
  onRetentionKeepCustom: () => void
  onToggleAutoCleanup: (nextEnabled: boolean) => void
}

function PromptRetentionDropdown({
  autoCleanupEnabled,
  onExportAllPrompts,
  onImportPrompts,
  onRetentionKeepDays,
  onRetentionKeepCustom,
  onToggleAutoCleanup
}: PromptRetentionDropdownProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const handleMenuAction = (action: () => void) => {
    setIsOpen(false)
    action()
  }

  return (
    <div className="prompt-retention-dropdown" ref={dropdownRef}>
      <button
        className={`prompt-retention-trigger ${isOpen ? 'open' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setIsOpen(prev => !prev)
        }}
        title={t('promptList.retention.title')}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className="prompt-retention-icon"
        >
          <circle cx="2" cy="6" r="1.2" fill="currentColor" />
          <circle cx="6" cy="6" r="1.2" fill="currentColor" />
          <circle cx="10" cy="6" r="1.2" fill="currentColor" />
        </svg>
      </button>

      {isOpen && (
        <div className="prompt-retention-menu" role="menu">
          <button
            className="prompt-retention-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuAction(onExportAllPrompts)
            }}
            role="menuitem"
          >
            {t('promptList.retention.exportAll')}
          </button>
          <button
            className="prompt-retention-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuAction(onImportPrompts)
            }}
            role="menuitem"
          >
            {t('promptList.retention.importAll')}
          </button>
          <div className="prompt-retention-separator" role="separator" />
          <button
            className="prompt-retention-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuAction(() => onRetentionKeepDays(7))
            }}
            role="menuitem"
          >
            {t('promptList.retention.keepRecentDays', { days: 7 })}
          </button>
          <button
            className="prompt-retention-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuAction(() => onRetentionKeepDays(14))
            }}
            role="menuitem"
          >
            {t('promptList.retention.keepRecentDays', { days: 14 })}
          </button>
          <button
            className="prompt-retention-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuAction(onRetentionKeepCustom)
            }}
            role="menuitem"
          >
            {t('promptList.retention.keepRecentCustom')}
          </button>
          <div className="prompt-retention-separator" role="separator" />
          <button
            className="prompt-retention-item prompt-retention-toggle"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuAction(() => onToggleAutoCleanup(!autoCleanupEnabled))
            }}
            role="menuitem"
          >
            <span className="prompt-retention-label">{t('promptList.retention.autoKeep30')}</span>
            <span className={`prompt-retention-switch ${autoCleanupEnabled ? 'on' : ''}`} />
          </button>
        </div>
      )}
    </div>
  )
}

// Highlight search keywords
function highlightText(text: string, keyword: string): React.ReactNode {
  if (!keyword.trim()) return text

  const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const parts = text.split(regex)

  return parts.map((part, index) => {
    if (part.toLowerCase() === keyword.toLowerCase()) {
      return (
        <mark key={index} className="prompt-highlight">
          {part}
        </mark>
      )
    }
    return part
  })
}

// Get the display text (title is displayed first, otherwise the first few lines of content are displayed)
function getDisplayText(prompt: Prompt): string {
  if (prompt.title) return prompt.title
  const lines = prompt.content.split('\n').slice(0, 4)
  return lines.join('\n')
}

export const PromptList = memo(function PromptList({
  prompts,
  selectedId,
  searchKeyword,
  onSelect,
  onDoubleClick,
  onDelete,
  onTogglePin,
  onAppend,
  onColorChange,
  onReorderPinned,
  globalPromptIds = [],
  autoCleanupEnabled,
  onExportAllPrompts,
  onImportPrompts,
  onRetentionKeepDays,
  onRetentionKeepCustom,
  onToggleAutoCleanup,
  scheduleMap,
  onSetSchedule,
  onEditSchedule,
  onCancelSchedule,
  onPauseSchedule,
  onResumeSchedule,
  onViewSendHistory
}: PromptListProps) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const dragStateRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    active: boolean
    element: HTMLElement | null
  } | null>(null)
  const dragListenersRef = useRef<{ move: (event: PointerEvent) => void; up: (event: PointerEvent) => void } | null>(null)
  const suppressClickRef = useRef(false)
  const lastReorderRef = useRef<{ id: string; position: 'before' | 'after' } | null>(null)

  // Sorting: scheduled(nextExecutionAt ascending order) → pinned in global order → unpinned(updatedAt descending order)
  const sortedPrompts = useMemo(() => {
    const promptMap = new Map(prompts.map(p => [p.id, p]))

    // There are prompts for active/paused scheduled tasks (active is sorted in ascending order by nextExecutionAt, and paused is ranked after active)
    const scheduled: Prompt[] = []
    const scheduledIds = new Set<string>()
    if (scheduleMap && scheduleMap.size > 0) {
      const activeSchedules = [...scheduleMap.values()]
        .filter(s => s.status === 'active')
        .sort((a, b) => a.nextExecutionAt - b.nextExecutionAt)
      const pausedSchedules = [...scheduleMap.values()]
        .filter(s => s.status === 'paused')
        .sort((a, b) => a.nextExecutionAt - b.nextExecutionAt)
      for (const s of [...activeSchedules, ...pausedSchedules]) {
        const prompt = promptMap.get(s.promptId)
        if (prompt) {
          scheduled.push(prompt)
          scheduledIds.add(prompt.id)
        }
      }
    }

    const pinnedInOrder: Prompt[] = []
    globalPromptIds.forEach(id => {
      if (scheduledIds.has(id)) return
      const prompt = promptMap.get(id)
      if (prompt && prompt.pinned) {
        pinnedInOrder.push(prompt)
      }
    })

    const extraPinned = prompts
      .filter(p => p.pinned && !globalPromptIds.includes(p.id) && !scheduledIds.has(p.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    const localPrompts = prompts
      .filter(p => !p.pinned && !scheduledIds.has(p.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    return [...scheduled, ...pinnedInOrder, ...extraPinned, ...localPrompts]
  }, [prompts, globalPromptIds, scheduleMap])

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const detachDragListeners = useCallback(() => {
    const listeners = dragListenersRef.current
    if (!listeners) return
    window.removeEventListener('pointermove', listeners.move)
    window.removeEventListener('pointerup', listeners.up)
    window.removeEventListener('pointercancel', listeners.up)
    dragListenersRef.current = null
  }, [])

  const resetDragState = useCallback(() => {
    clearLongPressTimer()
    if (dragStateRef.current?.active) {
      suppressClickRef.current = true
    }
    dragStateRef.current = null
    lastReorderRef.current = null
    setDraggingId(null)
    setDragOver(null)
    document.body.classList.remove('dragging-prompt')
    detachDragListeners()
  }, [clearLongPressTimer, detachDragListeners])

  useEffect(() => {
    return () => {
      clearLongPressTimer()
      detachDragListeners()
      document.body.classList.remove('dragging-prompt')
    }
  }, [clearLongPressTimer, detachDragListeners])

  // Click to select
  const handleClick = useCallback((id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onSelect(id)
  }, [onSelect])

  // Double click to edit
  const handleDoubleClick = useCallback((prompt: Prompt) => {
    if (dragStateRef.current?.active) return
    onDoubleClick(prompt)
  }, [onDoubleClick])

  // delete
  const handleDelete = useCallback((id: string) => {
    onDelete(id)
  }, [onDelete])

  // Switch Pin
  const handleTogglePin = useCallback((id: string) => {
    onTogglePin(id)
  }, [onTogglePin])

  // Append to input box
  const handleAppend = useCallback((prompt: Prompt) => {
    onAppend(prompt)
  }, [onAppend])

  // switch color
  const handleColorChange = useCallback((id: string, color: 'red' | 'yellow' | 'green') => {
    // Get the current prompt
    const prompt = prompts.find(p => p.id === id)
    // If the current color is the same as the clicked color, clear the color; otherwise set a new color
    const newColor = prompt?.color === color ? null : color
    onColorChange(id, newColor)
  }, [prompts, onColorChange])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handleContextMenu = useCallback((event: React.MouseEvent, prompt: Prompt) => {
    event.preventDefault()
    event.stopPropagation()
    if (dragStateRef.current?.active) return
    onSelect(prompt.id)
    setContextMenu({
      id: prompt.id,
      x: event.clientX,
      y: event.clientY
    })
  }, [onSelect])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, prompt: Prompt, isPinned: boolean) => {
    if (!onReorderPinned || !isPinned) return
    if (event.pointerType === 'mouse' && event.button !== 0) return

    clearLongPressTimer()

    dragStateRef.current = {
      id: prompt.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      element: event.currentTarget
    }

    longPressTimerRef.current = window.setTimeout(() => {
      const state = dragStateRef.current
      if (!state || state.id !== prompt.id) return
      state.active = true
      state.element?.setPointerCapture?.(state.pointerId)
      setDraggingId(prompt.id)
      document.body.classList.add('dragging-prompt')
    }, LONG_PRESS_DELAY)

    const moveHandler = (moveEvent: PointerEvent) => {
      const state = dragStateRef.current
      if (!state || moveEvent.pointerId !== state.pointerId) return

      if (!state.active) {
        const dx = Math.abs(moveEvent.clientX - state.startX)
        const dy = Math.abs(moveEvent.clientY - state.startY)
        if (dx + dy > DRAG_MOVE_TOLERANCE) {
          clearLongPressTimer()
          dragStateRef.current = null
          detachDragListeners()
        }
        return
      }

      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null
      const itemElement = target?.closest('.prompt-list-item') as HTMLElement | null
      if (!itemElement) {
        setDragOver(null)
        return
      }

      const targetId = itemElement.dataset.promptId
      const targetPinned = itemElement.dataset.pinned === 'true'
      if (!targetId || !targetPinned || targetId === state.id) {
        setDragOver(null)
        return
      }

      const rect = itemElement.getBoundingClientRect()
      const position: 'before' | 'after' = moveEvent.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
      setDragOver({ id: targetId, position })

      const last = lastReorderRef.current
      if (!last || last.id !== targetId || last.position !== position) {
        onReorderPinned(state.id, targetId, position)
        lastReorderRef.current = { id: targetId, position }
      }
    }

    const upHandler = () => {
      const state = dragStateRef.current
      if (state?.element?.releasePointerCapture) {
        try {
          state.element.releasePointerCapture(state.pointerId)
        } catch {
          // ignore
        }
      }
      resetDragState()
    }

    dragListenersRef.current = { move: moveHandler, up: upHandler }
    window.addEventListener('pointermove', moveHandler)
    window.addEventListener('pointerup', upHandler)
    window.addEventListener('pointercancel', upHandler)
  }, [onReorderPinned, clearLongPressTimer, detachDragListeners, resetDragState])

  const contextPrompt = useMemo(() => {
    if (!contextMenu) return null
    return prompts.find(p => p.id === contextMenu.id) || null
  }, [contextMenu, prompts])

  useEffect(() => {
    if (contextMenu && !contextPrompt) {
      setContextMenu(null)
    }
  }, [contextMenu, contextPrompt])

  useEffect(() => {
    if (!contextMenu) return

    const handleMouseDown = (event: MouseEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(event.target as Node)) {
        setContextMenu(null)
      }
    }

    const handleScroll = () => {
      setContextMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleScroll)
    window.addEventListener('scroll', handleScroll, true)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleScroll)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const padding = 8
    let nextX = contextMenu.x
    let nextY = contextMenu.y

    if (nextX + rect.width > window.innerWidth - padding) {
      nextX = Math.max(padding, window.innerWidth - rect.width - padding)
    }
    if (nextY + rect.height > window.innerHeight - padding) {
      nextY = Math.max(padding, window.innerHeight - rect.height - padding)
    }

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu(prev => {
        if (!prev) return prev
        return { ...prev, x: nextX, y: nextY }
      })
    }
  }, [contextMenu])

  return (
    <div className="prompt-list">
      <div className="prompt-list-header">
        <div className="prompt-list-header-left">
        <PromptRetentionDropdown
          autoCleanupEnabled={autoCleanupEnabled}
          onExportAllPrompts={onExportAllPrompts}
          onImportPrompts={onImportPrompts}
          onRetentionKeepDays={onRetentionKeepDays}
            onRetentionKeepCustom={onRetentionKeepCustom}
            onToggleAutoCleanup={onToggleAutoCleanup}
          />
          <span className="prompt-list-title">{t('promptList.title')}</span>
        </div>
        <span className="prompt-list-count">{t('promptList.count', { count: prompts.length })}</span>
      </div>
      <div className="prompt-list-items">
        {sortedPrompts.length === 0 ? (
          <div className="prompt-list-empty">{t('promptList.empty')}</div>
        ) : (
          sortedPrompts.map((prompt) => {
            const displayText = getDisplayText(prompt)
            const isGlobal = globalPromptIds.includes(prompt.id)
            const isPinned = isGlobal || prompt.pinned
            const isDragging = draggingId === prompt.id
            const dragOverPosition = dragOver?.id === prompt.id ? dragOver.position : null
            const activeSchedule = scheduleMap?.get(prompt.id)
            const hasActiveSchedule = activeSchedule?.status === 'active'
            const isPausedSchedule = activeSchedule?.status === 'paused'
            return (
              <div
                key={prompt.id}
                className={`prompt-list-item ${selectedId === prompt.id ? 'selected' : ''} ${isPinned ? 'pinned' : ''} ${isDragging ? 'dragging' : ''} ${dragOverPosition ? `drag-over-${dragOverPosition}` : ''} ${hasActiveSchedule ? 'scheduled' : ''} ${isPausedSchedule ? 'scheduled-paused' : ''}`}
                data-prompt-id={prompt.id}
                data-pinned={isPinned ? 'true' : 'false'}
                onClick={() => handleClick(prompt.id)}
                onDoubleClick={() => handleDoubleClick(prompt)}
                onContextMenu={(event) => handleContextMenu(event, prompt)}
                onPointerDown={(event) => handlePointerDown(event, prompt, isPinned)}
              >
                <div className="prompt-item-content">
                  {/* color dots */}
                  {prompt.color && (
                    <span
                      className={`prompt-item-color-dot prompt-item-color-${prompt.color}`}
                    />
                  )}
                  {(isGlobal || prompt.pinned) && (
                    <span className="prompt-item-pin-icon" title={isGlobal ? t('promptList.globalPrompt') : t('promptList.pinned')}>📌</span>
                  )}
                  {hasActiveSchedule && activeSchedule && (
                    <span className="prompt-item-schedule-badge" title={t('promptList.nextExecution', { time: formatShortTime(activeSchedule.nextExecutionAt) })}>
                      <svg className="prompt-item-schedule-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M8 4.5V8L10.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <span className="prompt-item-schedule-time">{formatShortTime(activeSchedule.nextExecutionAt)}</span>
                    </span>
                  )}
                  {isPausedSchedule && activeSchedule && (
                    <span className="prompt-item-schedule-badge paused" title={t('promptList.schedulePaused')}>
                      <svg className="prompt-item-schedule-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
                        <rect x="5.5" y="5" width="2" height="6" rx="0.5" fill="currentColor" />
                        <rect x="8.5" y="5" width="2" height="6" rx="0.5" fill="currentColor" />
                      </svg>
                      <span className="prompt-item-schedule-time">{t('promptList.paused')}</span>
                    </span>
                  )}
                  <span className="prompt-item-text">
                    {highlightText(displayText, searchKeyword)}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>

      {contextMenu && contextPrompt && (
        <div
          className="prompt-context-menu"
          ref={menuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="prompt-context-group">
            {COLORS.map(({ key, hex }) => {
              const isActive = contextPrompt.color === key
              return (
                <button
                  key={key}
                  className={`prompt-context-item ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    handleColorChange(contextPrompt.id, key)
                    closeContextMenu()
                  }}
                  role="menuitem"
                >
                  <span
                    className={`prompt-context-color-dot ${isActive ? 'active' : ''}`}
                    style={{ '--color': hex } as React.CSSProperties}
                  />
                  <span className="prompt-context-label">
                    {key === 'red' ? t('promptList.markRed') : key === 'yellow' ? t('promptList.markYellow') : t('promptList.markGreen')}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="prompt-context-separator" role="separator" />
          <button
            className="prompt-context-item"
            onClick={() => {
              handleTogglePin(contextPrompt.id)
              closeContextMenu()
            }}
            role="menuitem"
          >
            {(globalPromptIds.includes(contextPrompt.id) || contextPrompt.pinned) ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1.282a2 2 0 0 1 2.828 0l2.062 2.062a2 2 0 0 1 0 2.828L12.78 8.11a1 1 0 0 1-.293.207l-1.957.783.97.97a.75.75 0 0 1-1.06 1.06l-.97-.97-.783 1.957a1 1 0 0 1-.207.293L6.54 14.35a2 2 0 0 1-2.828 0L1.65 12.288a2 2 0 0 1 0-2.828l1.94-1.94a1 1 0 0 1 .293-.207l1.957-.783-.97-.97a.75.75 0 0 1 1.06-1.06l.97.97.783-1.957a1 1 0 0 1 .207-.293l1.938-1.938zM1.47 14.53l13.06-13.06a.75.75 0 1 0-1.06-1.06L.41 13.47a.75.75 0 1 0 1.06 1.06z" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1.282a2 2 0 0 1 2.828 0l2.062 2.062a2 2 0 0 1 0 2.828L12.78 8.11a1 1 0 0 1-.293.207l-1.957.783.97.97a.75.75 0 0 1-1.06 1.06l-.97-.97-.783 1.957a1 1 0 0 1-.207.293L6.54 14.35a2 2 0 0 1-2.828 0L1.65 12.288a2 2 0 0 1 0-2.828l1.94-1.94a1 1 0 0 1 .293-.207l1.957-.783-.97-.97a.75.75 0 0 1 1.06-1.06l.97.97.783-1.957a1 1 0 0 1 .207-.293l1.938-1.938z" /></svg>
            )}
            <span className="prompt-context-label">
              {(globalPromptIds.includes(contextPrompt.id) || contextPrompt.pinned) ? t('promptList.unpin') : t('promptList.pin')}
            </span>
          </button>
          {contextPrompt.pinned && (
            <button
              className="prompt-context-item"
              onClick={() => {
                handleAppend(contextPrompt)
                closeContextMenu()
              }}
              role="menuitem"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h5.5a.5.5 0 0 0 0-1H2V2h12v5.5a.5.5 0 0 0 1 0V2a1 1 0 0 0-1-1H2zm10.854 7.146a.5.5 0 0 0-.708.708L14.293 11H9.5a.5.5 0 0 0 0 1h4.793l-2.147 2.146a.5.5 0 0 0 .708.708l3-3a.5.5 0 0 0 0-.708l-3-3z" /></svg>
              <span className="prompt-context-label">{t('promptList.appendToEditor')}</span>
            </button>
          )}
          {/* View sending records */}
          {contextPrompt.sendHistory && contextPrompt.sendHistory.length > 0 && onViewSendHistory && (
            <button
              className="prompt-context-item"
              onClick={() => {
                onViewSendHistory(contextPrompt)
                closeContextMenu()
              }}
              role="menuitem"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M5 11.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm-3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" /></svg>
              <span className="prompt-context-label">{t('promptList.viewSendHistory', { count: contextPrompt.sendHistory.length })}</span>
            </button>
          )}
          {/* Execute related menu items regularly */}
          {(() => {
            const contextSchedule = scheduleMap?.get(contextPrompt.id)
            const isActive = contextSchedule?.status === 'active'
            const isPaused = contextSchedule?.status === 'paused'
            if (isActive || isPaused) {
              return (
                <>
                  <button
                    className="prompt-context-item"
                    onClick={() => {
                      onEditSchedule?.(contextPrompt)
                      closeContextMenu()
                    }}
                    role="menuitem"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" /></svg>
                    <span className="prompt-context-label">{t('promptList.editSchedule')}</span>
                  </button>
                  {isActive && (
                    <button
                      className="prompt-context-item"
                      onClick={() => {
                        onPauseSchedule?.(contextPrompt.id)
                        closeContextMenu()
                      }}
                      role="menuitem"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0-1.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM5.5 5a1 1 0 0 1 1 0v6a1 1 0 0 1-1 0V6a1 1 0 0 1 0-1zm4 0a1 1 0 0 1 1 1v4a1 1 0 0 1-2 0V6a1 1 0 0 1 1-1z" /></svg>
                      <span className="prompt-context-label">{t('promptList.pauseSchedule')}</span>
                    </button>
                  )}
                  {isPaused && (
                    <button
                      className="prompt-context-item"
                      onClick={() => {
                        onResumeSchedule?.(contextPrompt.id)
                        closeContextMenu()
                      }}
                      role="menuitem"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0-1.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM6.271 5.055A.5.5 0 0 0 5.5 5.5v5a.5.5 0 0 0 .771.42l4-2.5a.5.5 0 0 0 0-.84l-4-2.5z" /></svg>
                      <span className="prompt-context-label">{t('promptList.resumeSchedule')}</span>
                    </button>
                  )}
                  <button
                    className="prompt-context-item danger"
                    onClick={() => {
                      onCancelSchedule?.(contextPrompt.id)
                      closeContextMenu()
                    }}
                    role="menuitem"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0-1.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM5.354 5.354a.5.5 0 0 1 .707 0L8 7.293l1.939-1.94a.5.5 0 1 1 .707.708L8.707 8l1.94 1.939a.5.5 0 0 1-.708.707L8 8.707l-1.939 1.94a.5.5 0 1 1-.707-.708L7.293 8 5.354 6.061a.5.5 0 0 1 0-.707z" /></svg>
                    <span className="prompt-context-label">{t('promptList.cancelSchedule')}</span>
                  </button>
                </>
              )
            }
            return (
              <button
                className="prompt-context-item"
                onClick={() => {
                  onSetSchedule?.(contextPrompt)
                  closeContextMenu()
                }}
                role="menuitem"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 7.71V3.5z" /><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm0-1.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13z" /></svg>
                <span className="prompt-context-label">{t('promptList.setSchedule')}</span>
              </button>
            )
          })()}
          <div className="prompt-context-separator" role="separator" />
          <button
            className="prompt-context-item danger"
            onClick={() => {
              handleDelete(contextPrompt.id)
              closeContextMenu()
            }}
            role="menuitem"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
            <span className="prompt-context-label">{t('common.delete')}</span>
          </button>
        </div>
      )}
    </div>
  )
})
