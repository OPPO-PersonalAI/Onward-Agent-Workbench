/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react'
import { useI18n } from '../../i18n/useI18n'

interface TabItemProps {
  name: string
  customName: string | null
  isActive: boolean
  isOnly: boolean
  isDragOver?: boolean
  isDragging?: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (customName: string | null) => void
  onDragStart?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
}

export function TabItem({
  name,
  customName,
  isActive,
  isOnly,
  isDragOver,
  isDragging,
  onSelect,
  onClose,
  onRename,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}: TabItemProps) {
  const { t } = useI18n()
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(customName || '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleRenameStart = () => {
    setEditValue(customName || '')
    setIsEditing(true)
  }

  const handleClick = (e: React.MouseEvent) => {
    if (isEditing) {
      return
    }
    if (e.detail === 2) {
      e.stopPropagation()
      handleRenameStart()
      return
    }
    onSelect()
  }

  const handleInputBlur = () => {
    setIsEditing(false)
    const trimmedValue = editValue.trim()
    // If the input is empty, clear the custom name
    if (trimmedValue !== (customName || '')) {
      onRename(trimmedValue || null)
    }
  }

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleInputBlur()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
      setEditValue(customName || '')
    }
  }

  // Handle drag start
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
    onDragStart?.()
  }

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onClose()
  }

  const tabClassName = [
    'tab-item',
    isActive && 'active',
    isDragOver && 'drag-over',
    isDragging && 'dragging'
  ].filter(Boolean).join(' ')

  return (
    <div
      className={tabClassName}
      onClick={handleClick}
      draggable={!isEditing}
      onDragStart={handleDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="tab-name-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="tab-name">{name}</span>
      )}
      {!isOnly && (
        <button
          className="tab-close-btn"
          onClick={handleCloseClick}
          title={t('tabBar.closeTabTitle')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M9.5 3.205L8.795 2.5 6 5.295 3.205 2.5 2.5 3.205 5.295 6 2.5 8.795l.705.705L6 6.705 8.795 9.5l.705-.705L6.705 6z" />
          </svg>
        </button>
      )}
    </div>
  )
}
