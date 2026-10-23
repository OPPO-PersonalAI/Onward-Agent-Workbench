/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, useRef, useCallback, useMemo, useSyncExternalStore, ReactNode } from 'react'
import { perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
import type { PromptShortcutEvent } from '../utils/prompt-input'

export interface PromptLeaderView {
  event: PromptShortcutEvent
  targets: Array<{ id: string; title: string }>
  publishedAt: number
}

export interface PromptDraftSnapshot {
  revision: number
  content: string
  title: string
  sourceId: string | null
  color: 'red' | 'yellow' | 'green' | null
  composing: boolean
}

export interface PromptDraftController {
  snapshot: () => PromptDraftSnapshot
  clearIfRevision: (revision: number) => boolean
}

export type PromptInputDispatcher = (actionId: string, targetId?: string, origin?: 'button' | 'shortcut') => Promise<boolean>
export interface PromptInputTabState {
  selectedIds: string[]
  busy: boolean
  notice: { text: string; error: boolean } | null
}
const EMPTY_INPUT_STATE: PromptInputTabState = { selectedIds: [], busy: false, notice: null }

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
  // Conditionally close Settings on Task/Tab switch (keeps Settings open when previous panel was not Prompt)
  registerTryCloseSettingsOnSwitch: (callback: ((targetTabId?: string, targetActivePanel?: 'prompt' | null) => void) | null) => void
  tryCloseSettingsOnSwitch: (targetTabId?: string, targetActivePanel?: 'prompt' | null) => void
  registerDraftController: (tabId: string, controller: PromptDraftController) => () => void
  getDraftController: (tabId: string) => PromptDraftController | undefined
  registerInputDispatcher: (tabId: string, dispatcher: PromptInputDispatcher) => () => void
  setActiveInputTab: (tabId: string | null) => void
  isActiveInputTab: (tabId: string) => boolean
  setInputBlocked: (blocked: boolean) => void
  isInputBlocked: () => boolean
  dispatchInputAction: (tabId: string, actionId: string, targetId?: string, origin?: 'button' | 'shortcut') => Promise<boolean>
  publishInputState: (tabId: string, state: PromptInputTabState) => void
  getInputState: (tabId: string) => PromptInputTabState
  subscribeInputState: (listener: () => void) => () => void
  publishLeaderState: (state: PromptLeaderView | null) => void
  getLeaderState: () => PromptLeaderView | null
  subscribeLeaderState: (listener: () => void) => () => void
}

const PromptActionsContext = createContext<PromptActionsContextValue | null>(null)

export function PromptActionsProvider({ children }: { children: ReactNode }) {
  const focusEditorRef = useRef<(() => void) | null>(null)
  const submitEditorRef = useRef<(() => void) | null>(null)
  const closeSettingsRef = useRef<(() => void) | null>(null)
  const tryCloseSettingsOnSwitchRef = useRef<((targetTabId?: string, targetActivePanel?: 'prompt' | null) => void) | null>(null)
  const draftControllersRef = useRef(new Map<string, PromptDraftController>())
  const inputDispatchersRef = useRef(new Map<string, PromptInputDispatcher>())
  const inputStatesRef = useRef(new Map<string, PromptInputTabState>())
  const inputListenersRef = useRef(new Set<() => void>())
  const activeInputTabRef = useRef<string | null>(null)
  const inputBlockedRef = useRef(false)
  const leaderStateRef = useRef<PromptLeaderView | null>(null)
  const leaderListenersRef = useRef(new Set<() => void>())
  const publishLeaderState = useCallback((state: PromptLeaderView | null) => {
    const previous = leaderStateRef.current
    if (previous === state || (previous && state && previous.event === state.event &&
      previous.targets.length === state.targets.length && previous.targets.every((target, index) =>
        target.id === state.targets[index].id && target.title === state.targets[index].title))) return
    leaderStateRef.current = state
    leaderListenersRef.current.forEach(listener => listener())
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'view-published', active: Boolean(state), selecting: Boolean(state?.event.selecting) })
  }, [])
  const getLeaderState = useCallback(() => leaderStateRef.current, [])
  const subscribeLeaderState = useCallback((listener: () => void) => {
    leaderListenersRef.current.add(listener)
    return () => { leaderListenersRef.current.delete(listener) }
  }, [])

  const registerDraftController = useCallback((tabId: string, controller: PromptDraftController) => {
    draftControllersRef.current.set(tabId, controller)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, { phase: 'register', tabId })
    return () => {
      if (draftControllersRef.current.get(tabId) !== controller) return
      draftControllersRef.current.delete(tabId)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT, { phase: 'unregister', tabId })
    }
  }, [])
  const getDraftController = useCallback((tabId: string) => draftControllersRef.current.get(tabId), [])
  const registerInputDispatcher = useCallback((tabId: string, dispatcher: PromptInputDispatcher) => {
    inputDispatchersRef.current.set(tabId, dispatcher)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'register', tabId })
    return () => {
      if (inputDispatchersRef.current.get(tabId) !== dispatcher) return
      inputDispatchersRef.current.delete(tabId)
      inputStatesRef.current.delete(tabId)
      inputListenersRef.current.forEach(listener => listener())
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'unregister', tabId })
    }
  }, [])
  const setActiveInputTab = useCallback((tabId: string | null) => {
    if (activeInputTabRef.current === tabId) return
    const previousTabId = activeInputTabRef.current
    activeInputTabRef.current = tabId
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'active-tab-changed', previousTabId, tabId })
  }, [])
  const isActiveInputTab = useCallback((tabId: string) => activeInputTabRef.current === tabId, [])
  const setInputBlocked = useCallback((blocked: boolean) => {
    if (inputBlockedRef.current === blocked) return
    inputBlockedRef.current = blocked
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'blocked-changed', blocked })
  }, [])
  const isInputBlocked = useCallback(() => inputBlockedRef.current, [])
  const dispatchInputAction = useCallback(async (tabId: string, actionId: string, targetId?: string, origin: 'button' | 'shortcut' = 'shortcut') => {
    const dispatcher = inputDispatchersRef.current.get(tabId)
    if (tabId !== activeInputTabRef.current || !dispatcher) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'rejected', reason: 'inactive-tab', tabId })
      return false
    }
    return dispatcher(actionId, targetId, origin)
  }, [])
  const publishInputState = useCallback((tabId: string, state: PromptInputTabState) => {
    inputStatesRef.current.set(tabId, state)
    inputListenersRef.current.forEach(listener => listener())
  }, [])
  const getInputState = useCallback((tabId: string) => inputStatesRef.current.get(tabId) ?? EMPTY_INPUT_STATE, [])
  const subscribeInputState = useCallback((listener: () => void) => {
    inputListenersRef.current.add(listener)
    return () => { inputListenersRef.current.delete(listener) }
  }, [])

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

  const registerTryCloseSettingsOnSwitch = useCallback((callback: ((targetTabId?: string, targetActivePanel?: 'prompt' | null) => void) | null) => {
    tryCloseSettingsOnSwitchRef.current = callback
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

  const tryCloseSettingsOnSwitch = useCallback((targetTabId?: string, targetActivePanel?: 'prompt' | null) => {
    tryCloseSettingsOnSwitchRef.current?.(targetTabId, targetActivePanel)
  }, [])

  const value = useMemo(() => ({
    registerFocusEditor,
    registerSubmitEditor,
    registerCloseSettings,
    registerTryCloseSettingsOnSwitch,
    focusEditor,
    submitEditor,
    closeSettings,
    tryCloseSettingsOnSwitch,
    registerDraftController, getDraftController, registerInputDispatcher,
    setActiveInputTab, isActiveInputTab, dispatchInputAction,
    setInputBlocked, isInputBlocked,
    publishInputState, getInputState, subscribeInputState,
    publishLeaderState, getLeaderState, subscribeLeaderState
  }), [registerFocusEditor, registerSubmitEditor, registerCloseSettings, registerTryCloseSettingsOnSwitch,
    focusEditor, submitEditor, closeSettings, tryCloseSettingsOnSwitch,
    registerDraftController, getDraftController, registerInputDispatcher, setActiveInputTab,
    isActiveInputTab, dispatchInputAction, setInputBlocked, isInputBlocked, publishInputState, getInputState, subscribeInputState,
    publishLeaderState, getLeaderState, subscribeLeaderState])

  return (
    <PromptActionsContext.Provider value={value}>
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

/** Only action/selection changes notify subscribers; typing stays editor-local. */
export function usePromptInputTabState(tabId: string) {
  const { getInputState, subscribeInputState } = usePromptActions()
  const getSnapshot = useCallback(() => getInputState(tabId), [getInputState, tabId])
  return useSyncExternalStore(subscribeInputState, getSnapshot, getSnapshot)
}

/** Only the small cue consumers subscribe; Task output and editor typing do not. */
export function usePromptLeaderState() {
  const { getLeaderState, subscribeLeaderState } = usePromptActions()
  return useSyncExternalStore(subscribeLeaderState, getLeaderState, getLeaderState)
}
