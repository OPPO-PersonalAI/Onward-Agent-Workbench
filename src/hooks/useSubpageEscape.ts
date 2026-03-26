/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react'

interface UseSubpageEscapeOptions {
  isOpen: boolean
  onEscape: () => void | Promise<void>
}

export function useSubpageEscape({ isOpen, onEscape }: UseSubpageEscapeOptions) {
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return
      if (event.key !== 'Escape') return
      // If the focus is in the Prompt editor being edited, let PromptNotebook handle it.
      const active = document.activeElement
      if (active?.closest('[data-prompt-editing="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      void onEscape()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, onEscape])
}
