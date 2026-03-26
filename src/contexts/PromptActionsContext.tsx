/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, useRef, useCallback, ReactNode } from 'react'

interface PromptActionsContextValue {
  // Register callback (for PromptNotebook to call)
  registerFocusEditor: (callback: (() => void) | null) => void
  registerSubmitEditor: (callback: (() => void) | null) => void
  // Call the callback (called by WindowShortcutHandler)
  focusEditor: () => void
  submitEditor: () => void
  // Close the Settings panel (called when the shortcut is triggered)
  registerCloseSettings: (callback: (() => void) | null) => void
  closeSettings: () => void
}

const PromptActionsContext = createContext<PromptActionsContextValue | null>(null)

export function PromptActionsProvider({ children }: { children: ReactNode }) {
  const focusEditorRef = useRef<(() => void) | null>(null)
  const submitEditorRef = useRef<(() => void) | null>(null)
  const closeSettingsRef = useRef<(() => void) | null>(null)

  // Accept null when registering to support uninstall cleanup
  const registerFocusEditor = useCallback((callback: (() => void) | null) => {
    focusEditorRef.current = callback
  }, [])

  const registerSubmitEditor = useCallback((callback: (() => void) | null) => {
    submitEditorRef.current = callback
  }, [])

  const registerCloseSettings = useCallback((callback: (() => void) | null) => {
    closeSettingsRef.current = callback
  }, [])

  const focusEditor = useCallback(() => {
    focusEditorRef.current?.()
  }, [])

  const submitEditor = useCallback(() => {
    submitEditorRef.current?.()
  }, [])

  const closeSettings = useCallback(() => {
    closeSettingsRef.current?.()
  }, [])

  return (
    <PromptActionsContext.Provider value={{
      registerFocusEditor,
      registerSubmitEditor,
      registerCloseSettings,
      focusEditor,
      submitEditor,
      closeSettings
    }}>
      {children}
    </PromptActionsContext.Provider>
  )
}

export function usePromptActions() {
  const context = useContext(PromptActionsContext)
  if (!context) {
    throw new Error('usePromptActions must be used within PromptActionsProvider')
  }
  return context
}
