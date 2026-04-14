/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import { usePreviewSearch } from './usePreviewSearch'
import './PreviewSearchBar.css'

export interface PreviewSearchHandle {
  setQuery: (query: string) => void
  goToNext: () => void
  goToPrevious: () => void
  getMatchCount: () => number
  getCurrentIndex: () => number
}

interface PreviewSearchBarProps {
  previewRef: React.RefObject<HTMLDivElement | null>
  isOpen: boolean
  onClose: () => void
  renderedHtml: string
}

export const PreviewSearchBar = forwardRef<PreviewSearchHandle, PreviewSearchBarProps>(function PreviewSearchBar({ previewRef, isOpen, onClose, renderedHtml }, ref) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const { query, setQuery, matchCount, currentIndex, goToNext, goToPrevious } = usePreviewSearch({
    previewRef,
    isOpen,
    renderedHtml,
  })

  useImperativeHandle(ref, () => ({
    setQuery,
    goToNext,
    goToPrevious,
    getMatchCount: () => matchCount,
    getCurrentIndex: () => currentIndex,
  }), [setQuery, goToNext, goToPrevious, matchCount, currentIndex])

  useEffect(() => {
    if (!isOpen) return
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [isOpen])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) {
        goToPrevious()
      } else {
        goToNext()
      }
    }
  }, [goToNext, goToPrevious, onClose])

  const countText = useMemo(() => {
    if (!query) return ''
    if (matchCount === 0) return t('projectEditor.previewSearch.noMatches')
    return t('projectEditor.previewSearch.count', {
      current: String(currentIndex + 1),
      total: `${matchCount}${matchCount >= 1000 ? '+' : ''}`,
    })
  }, [currentIndex, matchCount, query, t])

  if (!isOpen) return null

  return (
    <div className="preview-search-bar">
      <input
        ref={inputRef}
        className="preview-search-input"
        type="text"
        placeholder={t('projectEditor.previewSearch.placeholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="preview-search-count">{countText}</span>
      <button
        type="button"
        className="preview-search-nav-btn"
        title={t('projectEditor.previewSearch.previous')}
        onClick={goToPrevious}
        disabled={matchCount === 0}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.646 4.646a.5.5 0 0 1 .708 0l4 4a.5.5 0 0 1-.708.708L8 5.707 4.354 9.354a.5.5 0 1 1-.708-.708l4-4z" />
        </svg>
      </button>
      <button
        type="button"
        className="preview-search-nav-btn"
        title={t('projectEditor.previewSearch.next')}
        onClick={goToNext}
        disabled={matchCount === 0}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8.354 11.354a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L8 10.293l3.646-3.647a.5.5 0 0 1 .708.708l-4 4z" />
        </svg>
      </button>
      <button
        type="button"
        className="preview-search-close-btn"
        title={t('projectEditor.previewSearch.close')}
        onClick={onClose}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
        </svg>
      </button>
    </div>
  )
})
