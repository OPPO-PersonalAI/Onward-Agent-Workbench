/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Prompt } from '../../types/electron'
import { useI18n } from '../../i18n/useI18n'

interface PromptEditorProps {
  onSubmit: (title: string, content: string) => void
  editingPrompt: Prompt | null
  onCancelEdit: () => void
}

const MIN_HEIGHT = 100
const DEFAULT_HEIGHT = 150

export function PromptEditor({ onSubmit, editingPrompt, onCancelEdit }: PromptEditorProps) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  // Populate content when edit mode is activated
  useEffect(() => {
    if (editingPrompt) {
      setTitle(editingPrompt.title)
      setContent(editingPrompt.content)
    }
  }, [editingPrompt])

  // Handle drag to adjust height
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    const startY = e.clientY
    const startHeight = height

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = startY - e.clientY
      const newHeight = Math.max(MIN_HEIGHT, startHeight + delta)
      setHeight(newHeight)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing-editor-height')
    }

    document.body.classList.add('resizing-editor-height')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [height])

  // Submit processing
  const handleSubmit = useCallback(() => {
    if (!content.trim()) return

    onSubmit(title.trim(), content.trim())
    setTitle('')
    setContent('')
  }, [title, content, onSubmit])

  // Cancel edit
  const handleCancel = useCallback(() => {
    setTitle('')
    setContent('')
    onCancelEdit()
  }, [onCancelEdit])

  // Shortcut support
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape' && editingPrompt) {
      e.preventDefault()
      handleCancel()
    }
  }, [handleSubmit, handleCancel, editingPrompt])

  return (
    <div
      className="prompt-editor"
      ref={containerRef}
      style={{ height }}
      onKeyDown={handleKeyDown}
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
          className="prompt-editor-content"
          placeholder={t('promptEditor.contentPlaceholder')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>

      <div className="prompt-editor-actions">
        {editingPrompt && (
          <button
            className="prompt-editor-btn prompt-editor-btn-cancel"
            onClick={handleCancel}
          >
            {t('promptEditor.cancelEdit')}
          </button>
        )}
        <button
          className="prompt-editor-btn prompt-editor-btn-submit"
          onClick={handleSubmit}
          disabled={!content.trim()}
        >
          {editingPrompt ? t('promptEditor.saveChanges') : t('promptEditor.addToHistory')}
        </button>
      </div>
    </div>
  )
}
