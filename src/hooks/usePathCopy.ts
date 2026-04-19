/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react'
import type { TranslationKey } from '../i18n/core'

interface CopyMessage {
  type: 'success' | 'error'
  text: string
}

type TranslatorFn = (key: TranslationKey, params?: Record<string, string>) => string

/**
 * Shared hook for file-path copy operations.
 *
 * Provides clipboard copy with auto-dismiss toast feedback,
 * a double-click flash + selection-clear helper, and a
 * copy-by-kind utility for context menus.
 */
export function usePathCopy(t: TranslatorFn, errorKey: TranslationKey) {
  const [copyMessage, setCopyMessage] = useState<CopyMessage | null>(null)

  useEffect(() => {
    if (!copyMessage) return
    const timer = window.setTimeout(() => setCopyMessage(null), 2000)
    return () => window.clearTimeout(timer)
  }, [copyMessage])

  const copyToClipboard = useCallback(async (text: string, label: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyMessage({ type: 'success', text: t('common.copied', { label, text }) })
      return true
    } catch {
      setCopyMessage({ type: 'error', text: t(errorKey) })
      return false
    }
  }, [t, errorKey])

  const showCopyError = useCallback((text: string) => {
    setCopyMessage({ type: 'error', text })
  }, [])

  // Callers must pass a pre-captured element (capture `e.currentTarget` synchronously before any await,
  // since React clears SyntheticEvent.currentTarget after the handler returns).
  const flashCopyFeedback = useCallback((target: HTMLElement) => {
    window.getSelection()?.removeAllRanges()
    target.classList.add('copy-flash')
    window.setTimeout(() => target.classList.remove('copy-flash'), 300)
  }, [])

  return { copyMessage, copyToClipboard, showCopyError, flashCopyFeedback }
}
