/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_HIGHLIGHTS = 1000
const DEBOUNCE_MS = 150
const HIGHLIGHT_CLASS = 'preview-search-highlight'
const ACTIVE_CLASS = 'preview-search-highlight-active'

/** Pixel tolerance when comparing vertical positions of highlights on the same visual line */
export const SORT_LINE_EPSILON_PX = 2

interface UsePreviewSearchOptions {
  previewRef: React.RefObject<HTMLDivElement | null>
  isOpen: boolean
  renderedHtml: string
}

interface UsePreviewSearchResult {
  query: string
  setQuery: (query: string) => void
  matchCount: number
  currentIndex: number
  goToNext: () => void
  goToPrevious: () => void
}

function clearHighlights(container: HTMLElement): void {
  const marks = container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`)
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
    parent.normalize()
  })
}

function applyHighlights(container: HTMLElement, query: string): HTMLElement[] {
  if (!query) return []

  const lowerQuery = query.toLowerCase()
  const marks: HTMLElement[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const matchedNodes: Array<{ node: Text; indices: number[] }> = []

  let textNode = walker.nextNode() as Text | null
  while (textNode) {
    const text = textNode.textContent || ''
    const lowerText = text.toLowerCase()
    const indices: number[] = []
    let startPos = 0
    while (startPos < lowerText.length) {
      const index = lowerText.indexOf(lowerQuery, startPos)
      if (index === -1) break
      indices.push(index)
      startPos = index + lowerQuery.length
    }
    if (indices.length > 0) {
      matchedNodes.push({ node: textNode, indices })
    }
    if (marks.length + indices.length > MAX_HIGHLIGHTS) break
    textNode = walker.nextNode() as Text | null
  }

  for (const { node, indices } of matchedNodes) {
    for (let i = indices.length - 1; i >= 0; i--) {
      if (marks.length >= MAX_HIGHLIGHTS) break
      const index = indices[i]
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + query.length)
      const mark = document.createElement('mark')
      mark.className = HIGHLIGHT_CLASS
      range.surroundContents(mark)
      marks.push(mark)
    }
  }

  // Sort by visual position to guarantee top-to-bottom, left-to-right navigation order
  // regardless of DOM order or layout shifts caused by surroundContents
  marks.sort((a, b) => {
    const rectA = a.getBoundingClientRect()
    const rectB = b.getBoundingClientRect()
    const topDiff = rectA.top - rectB.top
    if (Math.abs(topDiff) > SORT_LINE_EPSILON_PX) return topDiff
    return rectA.left - rectB.left
  })

  return marks
}

function setActiveHighlight(marks: HTMLElement[], index: number, scrollContainer: HTMLElement | null): void {
  marks.forEach(mark => mark.classList.remove(ACTIVE_CLASS))
  if (index < 0 || index >= marks.length) return
  const activeMark = marks[index]
  activeMark.classList.add(ACTIVE_CLASS)
  if (!scrollContainer) return
  const containerRect = scrollContainer.getBoundingClientRect()
  const markRect = activeMark.getBoundingClientRect()
  const markMiddle = markRect.top + markRect.height / 2
  const containerMiddle = containerRect.top + containerRect.height / 2
  const offset = markMiddle - containerMiddle
  // Skip scroll when the mark is already near the viewport center to avoid jitter
  if (Math.abs(offset) <= 5) return
  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight
  scrollContainer.scrollTo({
    top: Math.max(0, Math.min(maxScroll, scrollContainer.scrollTop + offset)),
    behavior: 'smooth',
  })
}

export function usePreviewSearch({
  previewRef,
  isOpen,
  renderedHtml,
}: UsePreviewSearchOptions): UsePreviewSearchResult {
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(-1)
  const marksRef = useRef<HTMLElement[]>([])
  const debounceTimerRef = useRef<number | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query

  const executeSearch = useCallback((searchQuery: string) => {
    const container = previewRef.current
    if (!container) return

    clearHighlights(container)
    marksRef.current = []
    if (!searchQuery) {
      setMatchCount(0)
      setCurrentIndex(-1)
      return
    }

    const marks = applyHighlights(container, searchQuery)
    marksRef.current = marks
    setMatchCount(marks.length)
    if (marks.length > 0) {
      setCurrentIndex(0)
      setActiveHighlight(marks, 0, container)
      return
    }
    setCurrentIndex(-1)
  }, [previewRef])

  useEffect(() => {
    if (!isOpen) return
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = window.setTimeout(() => {
      executeSearch(query)
    }, DEBOUNCE_MS)
    return () => {
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current)
      }
    }
  }, [executeSearch, isOpen, query])

  useEffect(() => {
    if (!isOpen || !queryRef.current) return
    const frame = window.requestAnimationFrame(() => {
      executeSearch(queryRef.current)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [executeSearch, isOpen, renderedHtml])

  useEffect(() => {
    if (isOpen) return
    const container = previewRef.current
    if (container) {
      clearHighlights(container)
    }
    marksRef.current = []
    setQuery('')
    setMatchCount(0)
    setCurrentIndex(-1)
  }, [isOpen, previewRef])

  const goToNext = useCallback(() => {
    const marks = marksRef.current
    if (marks.length === 0) return
    const nextIndex = (currentIndex + 1) % marks.length
    setCurrentIndex(nextIndex)
    setActiveHighlight(marks, nextIndex, previewRef.current)
  }, [currentIndex, previewRef])

  const goToPrevious = useCallback(() => {
    const marks = marksRef.current
    if (marks.length === 0) return
    const nextIndex = (currentIndex - 1 + marks.length) % marks.length
    setCurrentIndex(nextIndex)
    setActiveHighlight(marks, nextIndex, previewRef.current)
  }, [currentIndex, previewRef])

  return { query, setQuery, matchCount, currentIndex, goToNext, goToPrevious }
}
