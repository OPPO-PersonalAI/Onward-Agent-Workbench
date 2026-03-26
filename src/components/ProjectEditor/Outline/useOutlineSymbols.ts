/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutlineItem } from './types'
import { parseOutlineSymbols } from './outlineParser'

const DEBOUNCE_MS = 400

export interface UseOutlineSymbolsOptions {
  editor: import('monaco-editor').editor.IStandaloneCodeEditor | null
  filePath: string | null
  content: string
  isVisible: boolean
}

export interface UseOutlineSymbolsResult {
  symbols: OutlineItem[]
  activeItem: OutlineItem | null
  isLoading: boolean
}

function findDeepestContaining(items: OutlineItem[], line: number): OutlineItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (line >= item.startLine && line <= item.endLine) {
      const childMatch = findDeepestContaining(item.children, line)
      return childMatch ?? item
    }
  }
  return null
}

export function useOutlineSymbols({
  editor,
  filePath,
  content,
  isVisible,
}: UseOutlineSymbolsOptions): UseOutlineSymbolsResult {
  const [symbols, setSymbols] = useState<OutlineItem[]>([])
  const [activeItem, setActiveItem] = useState<OutlineItem | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const tokenRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const symbolsRef = useRef<OutlineItem[]>([])
  const lastFilePathRef = useRef<string | null>(null)

  // Parse symbols with debounce
  const triggerParse = useCallback(() => {
    if (!isVisible || !filePath) {
      setSymbols([])
      symbolsRef.current = []
      setIsLoading(false)
      return
    }

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }

    // Immediate parse on file switch
    const isFileSwitch = filePath !== lastFilePathRef.current
    lastFilePathRef.current = filePath

    const delay = isFileSwitch ? 0 : DEBOUNCE_MS

    setIsLoading(true)
    const currentToken = ++tokenRef.current

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const model = editor?.getModel() ?? null

      void parseOutlineSymbols(content, filePath, model).then((result) => {
        if (currentToken !== tokenRef.current) return
        setSymbols(result)
        symbolsRef.current = result
        setIsLoading(false)
      })
    }, delay)
  }, [isVisible, filePath, content, editor])

  // Trigger parse on content/file/visibility change
  useEffect(() => {
    triggerParse()
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [triggerParse])

  // Reset on file switch
  useEffect(() => {
    setSymbols([])
    symbolsRef.current = []
    setActiveItem(null)
  }, [filePath])

  // Cursor tracking
  useEffect(() => {
    if (!editor || !isVisible) return

    const disposable = editor.onDidChangeCursorPosition((e) => {
      const line = e.position.lineNumber
      const match = findDeepestContaining(symbolsRef.current, line)
      setActiveItem(match)
    })

    // Initial sync
    const pos = editor.getPosition()
    if (pos) {
      const match = findDeepestContaining(symbolsRef.current, pos.lineNumber)
      setActiveItem(match)
    }

    return () => disposable.dispose()
  }, [editor, isVisible, symbols])

  return { symbols, activeItem, isLoading }
}
