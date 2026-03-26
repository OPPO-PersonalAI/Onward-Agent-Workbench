/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, memo } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import type { TerminalBatchResult, TerminalInfo } from '../../types/prompt'
import { useI18n } from '../../i18n/useI18n'

interface PromptSenderProps {
  terminals: TerminalInfo[]
  promptContent: string
  onSend: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onExecute: (terminalIds: string[]) => Promise<TerminalBatchResult>
  onSendAndExecute: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onTerminalRename: (id: string, newTitle: string) => void
  onChangeWorkDir?: (terminalIds: string[], directory: string) => void
}

export const PromptSender = memo(function PromptSender({
  terminals,
  promptContent,
  onSend,
  onExecute,
  onSendAndExecute,
  onTerminalRename
}: PromptSenderProps) {
  const { t } = useI18n()
  const [selectedTerminals, setSelectedTerminals] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const [selectionNotice, setSelectionNotice] = useState('')
  const noticeTimerRef = useRef<number | null>(null)
  const selectClickTimerRef = useRef<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const terminalRows = Math.max(1, Math.ceil(terminals.length / 2))
  const terminalGridStyle: CSSProperties = { '--terminal-rows': terminalRows }

  // When the terminal list changes, update the selected status (remove non-existing terminals)
  useEffect(() => {
    const terminalIds = new Set(terminals.map(t => t.id))
    setSelectedTerminals(prev => {
      const newSet = new Set<string>()
      prev.forEach(id => {
        if (terminalIds.has(id)) {
          newSet.add(id)
        }
      })
      return newSet
    })
  }, [terminals])

  // Automatically focus on the edit input box
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const handleToggle = (id: string) => {
    setSelectedTerminals(prev => {
      const newSet = new Set(prev)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return newSet
    })
  }

  const handleCardClick = (event: MouseEvent<HTMLDivElement>, id: string) => {
    event.stopPropagation()
    if (selectClickTimerRef.current) {
      window.clearTimeout(selectClickTimerRef.current)
      selectClickTimerRef.current = null
    }
    selectClickTimerRef.current = window.setTimeout(() => {
      handleToggle(id)
      selectClickTimerRef.current = null
    }, 200)
  }

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
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
    if (e.key === 'Enter') {
      handleFinishEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const showNotice = (message: string) => {
    setSelectionNotice(message)
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current)
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setSelectionNotice('')
    }, 2000)
  }

  const showSelectTerminalNotice = () => {
    showNotice(t('promptSender.selectTerminalFirst'))
  }

  const runTerminalAction = async (
    actionName: 'promptSender.action.send' | 'promptSender.action.execute' | 'promptSender.action.sendAndExecute',
    runner: () => Promise<TerminalBatchResult>
  ) => {
    if (submittingRef.current) {
      return false
    }
    submittingRef.current = true
    setIsSubmitting(true)

    try {
      const result = await runner()
      if (result.failedIds.length > 0) {
        showNotice(t('promptSender.partialFailure', {
          count: result.failedIds.length,
          action: t(actionName)
        }))
      } else {
        setSelectionNotice('')
      }
      return true
    } catch (error) {
      console.error(`[PromptSender] ${actionName} failed:`, error)
      showNotice(t('promptSender.failure', { action: t(actionName) }))
      return false
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleSendToSelected = async () => {
    if (selectedTerminals.size === 0) return
    const terminalIds = Array.from(selectedTerminals)
    await runTerminalAction('promptSender.action.send', () => onSend(terminalIds, promptContent))
  }

  const handleSendAllAndExecute = async () => {
    if (terminals.length === 0 || !promptContent) return
    const terminalIds = terminals.map(t => t.id)
    await runTerminalAction('promptSender.action.sendAndExecute', () => onSendAndExecute(terminalIds, promptContent))
  }

  const handleExecute = async () => {
    if (selectedTerminals.size === 0) return
    const terminalIds = Array.from(selectedTerminals)
    await runTerminalAction('promptSender.action.execute', () => onExecute(terminalIds))
  }

  const handleSendAndExecute = async () => {
    if (selectedTerminals.size === 0) {
      showSelectTerminalNotice()
      return
    }
    const terminalIds = Array.from(selectedTerminals)
    await runTerminalAction('promptSender.action.sendAndExecute', () => onSendAndExecute(terminalIds, promptContent))
  }

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current)
      }
      if (selectClickTimerRef.current) {
        window.clearTimeout(selectClickTimerRef.current)
      }
    }
  }, [])

  // Debug API (only exposed in automated testing mode)
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const api = {
      getTerminalCards: () => terminals.map(t => ({
        id: t.id,
        title: t.title || `Task`,
        isSelected: selectedTerminals.has(t.id)
      })),
      getSelectedTerminalIds: () => Array.from(selectedTerminals),
      getActionButtons: () => {
        const btns = document.querySelectorAll('.prompt-sender-btn')
        return Array.from(btns).map(btn => ({
          label: btn.textContent?.trim() ?? '',
          disabled: (btn as HTMLButtonElement).disabled
        }))
      },
      getGridLayout: () => ({
        columns: 2,
        rows: Math.max(1, Math.ceil(terminals.length / 2)),
        totalCards: terminals.length
      }),
      getNotice: () => selectionNotice || null,
      isSubmitting: () => isSubmitting,
      clickAction: async (action: 'sendAndExecute' | 'execute' | 'send' | 'sendAllAndExecute') => {
        if (action === 'sendAndExecute') {
          await handleSendAndExecute()
          return true
        }
        if (action === 'execute') {
          await handleExecute()
          return true
        }
        if (action === 'send') {
          await handleSendToSelected()
          return true
        }
        if (action === 'sendAllAndExecute') {
          await handleSendAllAndExecute()
          return true
        }
        return false
      },
      selectTerminal: (id: string) => {
        if (!terminals.some(t => t.id === id)) return false
        setSelectedTerminals(prev => {
          const next = new Set(prev)
          next.add(id)
          return next
        })
        return true
      },
      deselectTerminal: (id: string) => {
        setSelectedTerminals(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        return true
      },
      deselectAllTerminals: () => {
        setSelectedTerminals(new Set())
      }
    }
    ;(window as any).__onwardPromptSenderDebug = api
    return () => {
      if ((window as any).__onwardPromptSenderDebug === api) {
        delete (window as any).__onwardPromptSenderDebug
      }
    }
  }, [terminals, selectedTerminals, selectionNotice, isSubmitting, promptContent])

  return (
    <div className="prompt-sender">
      <div className="prompt-sender-terminals" style={terminalGridStyle}>
        {terminals.length === 0 ? (
          <div className="prompt-sender-empty">{t('promptSender.noTerminals')}</div>
        ) : (
          terminals.map((terminal, index) => (
            <div
              key={terminal.id}
              className={`prompt-sender-terminal ${selectedTerminals.has(terminal.id) ? 'is-selected' : ''}`}
              style={{ '--t-color': `var(--rainbow-${index + 1})` } as React.CSSProperties}
              role="button"
              tabIndex={0}
              aria-pressed={selectedTerminals.has(terminal.id)}
              onClick={(event) => handleCardClick(event, terminal.id)}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (selectClickTimerRef.current) {
                  window.clearTimeout(selectClickTimerRef.current)
                  selectClickTimerRef.current = null
                }
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
                <span
                  className="prompt-sender-terminal-name"
                  title={t('promptSender.doubleClickToRename')}
                >
                  {terminal.title || `Task ${index + 1}`}
                </span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="prompt-sender-actions">
        <button
          className="prompt-sender-btn prompt-sender-btn-send-execute"
          onClick={() => { void handleSendAndExecute() }}
          disabled={selectedTerminals.size === 0 || isSubmitting}
          title={t('promptSender.title.sendAndExecute')}
        >
          {t('promptSender.button.sendAndExecute')}
        </button>
        <button
          className="prompt-sender-btn prompt-sender-btn-execute"
          onClick={() => { void handleExecute() }}
          disabled={selectedTerminals.size === 0 || isSubmitting}
          title={t('promptSender.title.execute')}
        >
          {t('promptSender.button.execute')}
        </button>
        <button
          className="prompt-sender-btn prompt-sender-btn-send"
          onClick={() => { void handleSendToSelected() }}
          disabled={selectedTerminals.size === 0 || isSubmitting}
          title={t('promptSender.title.send')}
        >
          {t('promptSender.button.send')}
        </button>
        <button
          className="prompt-sender-btn prompt-sender-btn-send-all-execute"
          onClick={() => { void handleSendAllAndExecute() }}
          disabled={terminals.length === 0 || !promptContent || isSubmitting}
          title={t('promptSender.title.sendAllAndExecute')}
        >
          {t('promptSender.button.sendAllAndExecute')}
        </button>
      </div>

      {selectionNotice && (
        <div className="prompt-sender-notice" role="status" aria-live="polite">
          {selectionNotice}
        </div>
      )}

    </div>
  )
})
