/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TerminalInfo } from '../../types/prompt'
import { usePromptActions, usePromptInputTabState } from '../../contexts/PromptActionsContext'
import { useI18n } from '../../i18n/useI18n'
import type { PromptShortcutEvent } from '../../utils/prompt-input'
import { isAnyModalOpen, subscribeOpenModals } from '../../utils/modal-dismiss'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import './PromptNotebook.css'

interface PromptInputShortcutsProps {
  tabId: string
  terminals: TerminalInfo[]
  visibleCount: number
  activeTerminalId: string | null
  blocked: boolean
  promptHidden: boolean
}

interface PromptInputShortcutsDebugApi {
  setDispatchHeld: (held: boolean) => void
  getHeldDispatchCount: () => number
  setContinuationsHeld: (held: boolean) => void
  getHeldContinuationCount: () => number
  getLeaderState: () => PromptShortcutEvent | null
}

/** The main process owns key recognition, including focused guest contents. */
export const PromptInputShortcuts = memo(function PromptInputShortcuts({
  tabId, terminals, visibleCount, activeTerminalId, blocked, promptHidden
}: PromptInputShortcutsProps) {
  const { t } = useI18n()
  const { setActiveInputTab, setInputBlocked, dispatchInputAction, publishLeaderState } = usePromptActions()
  const inputState = usePromptInputTabState(tabId)
  const leaderStateRef = useRef<PromptShortcutEvent | null>(null)
  const [visibleLeaderState, setVisibleLeaderState] = useState<PromptShortcutEvent | null>(null)
  const setLeaderState = useCallback((state: PromptShortcutEvent | null) => {
    leaderStateRef.current = state
    setVisibleLeaderState(state)
    if (!state) publishLeaderState(null)
  }, [publishLeaderState])
  const [interactionBlocked, setInteractionBlocked] = useState(false)
  const [modalBlocked, setModalBlocked] = useState(isAnyModalOpen)
  const [bridgeNotice, setBridgeNotice] = useState<{ text: string } | null>(null)
  const armedOwnerRef = useRef<{ element: Element | null } | null>(null)
  const composingRef = useRef(false)
  const recordingRef = useRef(false)
  const currentRef = useRef({ tabId, blocked: false, generation: 1 })
  const visibleTerminals = useMemo(() => terminals.slice(0, visibleCount), [terminals, visibleCount])
  const visibleIdSignature = visibleTerminals.map(terminal => terminal.id).join('\u0000')
  const visibleIds = useMemo(() => visibleIdSignature ? visibleIdSignature.split('\u0000') : [], [visibleIdSignature])
  const visibleActiveId = activeTerminalId && visibleIds.includes(activeTerminalId) ? activeTerminalId : null
  const contextBlocked = blocked || modalBlocked || interactionBlocked
  useLayoutEffect(() => {
    const valid = visibleLeaderState?.tabId === tabId && !contextBlocked &&
      (!visibleLeaderState.targetId || visibleIds.includes(visibleLeaderState.targetId))
    publishLeaderState(valid ? { event: visibleLeaderState, publishedAt: performance.now(),
      targets: visibleTerminals.map(terminal => ({ id: terminal.id, title: terminal.title })) } : null)
  }, [visibleLeaderState, tabId, contextBlocked, visibleTerminals, visibleIds, publishLeaderState])
  useLayoutEffect(() => {
    const previous = currentRef.current
    currentRef.current = {
      tabId, blocked: contextBlocked,
      generation: previous.generation + (previous.tabId === tabId ? 0 : 1)
    }
  }, [tabId, contextBlocked])

  const cancelArmedOwner = useCallback((reason: 'context-changed' | 'blur') => {
    if (!armedOwnerRef.current) return
    armedOwnerRef.current = null
    setLeaderState(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'owner-cancel-send', reason })
    void window.electronAPI?.promptInput?.cancel(reason).then(() => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'owner-cancel-ack', reason })
    }).catch(() => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'owner-cancel-failed', reason })
    })
  }, [setLeaderState])

  useLayoutEffect(() => {
    setActiveInputTab(tabId)
    return () => setActiveInputTab(null)
  }, [setActiveInputTab, tabId])

  useEffect(() => {
    setModalBlocked(isAnyModalOpen())
    return subscribeOpenModals(() => {
      const blocked = isAnyModalOpen()
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'modal-state', blocked })
      setModalBlocked(blocked)
    })
  }, [])

  useEffect(() => {
    const updateInteraction = () => {
      const focused = document.activeElement
      recordingRef.current = focused instanceof HTMLElement && Boolean(focused.closest(
        '.shortcut-input, [data-prompt-shortcut-recorder], [data-prompt-input-recording="true"]'
      ))
      setInteractionBlocked(composingRef.current || recordingRef.current)
    }
    const compositionStart = () => { composingRef.current = true; updateInteraction() }
    const compositionEnd = () => { composingRef.current = false; updateInteraction() }
    const resetComposition = () => {
      cancelArmedOwner('blur')
      composingRef.current = false
      updateInteraction()
    }
    const focusIn = (event: FocusEvent) => {
      if (armedOwnerRef.current && event.target !== armedOwnerRef.current.element) cancelArmedOwner('context-changed')
      updateInteraction()
    }
    const focusOut = (event: FocusEvent) => {
      if (armedOwnerRef.current && event.target === armedOwnerRef.current.element && event.relatedTarget !== event.target) {
        cancelArmedOwner('context-changed')
      }
      updateInteraction()
    }
    const pointerDown = (event: PointerEvent) => {
      const owner = armedOwnerRef.current
      if (!owner) return
      if (!(event.target instanceof Node) || !owner.element?.contains(event.target)) cancelArmedOwner('context-changed')
    }
    document.addEventListener('compositionstart', compositionStart, true)
    document.addEventListener('compositionend', compositionEnd, true)
    document.addEventListener('focusin', focusIn, true)
    document.addEventListener('focusout', focusOut, true)
    document.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('blur', resetComposition)
    updateInteraction()
    return () => {
      document.removeEventListener('compositionstart', compositionStart, true)
      document.removeEventListener('compositionend', compositionEnd, true)
      document.removeEventListener('focusin', focusIn, true)
      document.removeEventListener('focusout', focusOut, true)
      document.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('blur', resetComposition)
    }
  }, [cancelArmedOwner])

  useLayoutEffect(() => {
    setInputBlocked(contextBlocked)
    const api = window.electronAPI?.promptInput
    if (!api) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'context-unavailable', tabId })
      return
    }
    let mounted = true
    const generation = currentRef.current.generation
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, {
      phase: 'context-send', tabId, generation, visible: visibleIds.length, activeTerminalId: visibleActiveId, blocked: contextBlocked
    })
    void api.setContext({ tabId, generation, visibleTerminalIds: visibleIds, activeTerminalId: visibleActiveId, blocked: contextBlocked }).then(() => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'context-ack', tabId, generation })
    }).catch(() => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'context-failed', tabId, generation })
      if (mounted) setBridgeNotice({ text: t('promptInput.runtime.failed') })
    })
    return () => { mounted = false }
  }, [tabId, visibleIds, visibleActiveId, contextBlocked, t, setInputBlocked])

  useEffect(() => {
    const api = window.electronAPI?.promptInput
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'mount', available: Boolean(api) })
    if (!api) return
    const handleShortcut = (event: PromptShortcutEvent) => {
      const current = currentRef.current
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, {
        phase: 'receive', kind: event.kind, tabId: event.tabId, actionId: event.actionId,
        generation: event.generation, targetId: event.targetId, reason: event.reason
      })
      if (event.generation !== current.generation) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, {
          phase: 'rejected', reason: 'stale-generation', tabId: event.tabId,
          generation: event.generation, currentGeneration: current.generation
        })
        return
      }
      if (event.tabId !== current.tabId || current.blocked || composingRef.current || recordingRef.current || isAnyModalOpen()) {
        armedOwnerRef.current = null
        setLeaderState(null)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'rejected', reason: 'context-changed' })
        return
      }
      if (event.active) {
        if ((event.targetId || event.selecting !== undefined) && !armedOwnerRef.current) {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'rejected', reason: 'stale-owner-state' })
          return
        }
        armedOwnerRef.current ??= { element: document.activeElement }
        setLeaderState(event)
        return
      }
      const hadOwner = armedOwnerRef.current !== null
      armedOwnerRef.current = null
      setLeaderState(null)
      if (event.kind === 'dispatch' && event.actionId) {
        if (!hadOwner) {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'rejected', reason: 'stale-owner-dispatch' })
          return
        }
        setBridgeNotice(null)
        void dispatchInputAction(event.tabId, event.actionId, event.targetId, 'shortcut')
      } else if (event.kind === 'cancel' && (event.reason === 'target-unavailable' || event.reason === 'target-conflict')) {
        setBridgeNotice({ text: t(event.reason === 'target-conflict' ? 'promptInput.runtime.conflict' : 'promptInput.runtime.unavailable') })
      }
    }
    // Allocated only in autotest mode. The queue survives tab/context changes;
    // releasing it exercises the same reader against its current refs.
    let dispatchHoldForAutotest: { held: boolean; events: PromptShortcutEvent[] } | null = null
    let continuationHoldForAutotest: { held: boolean; events: PromptShortcutEvent[] } | null = null
    const unsubscribe = api.onShortcut(event => {
      // Initial arm and cancellation still run immediately; only actual
      // post-arm IPC callbacks wait across a local DOM-owner cancellation.
      if (continuationHoldForAutotest?.held && (event.kind === 'dispatch' ||
        (event.kind === 'state' && event.active && (event.targetId || event.selecting !== undefined)))) {
        continuationHoldForAutotest.events.push(event)
        return
      }
      if (dispatchHoldForAutotest?.held && event.kind === 'dispatch') {
        dispatchHoldForAutotest.events.push(event)
        return
      }
      handleShortcut(event)
    })
    const debugWindow = window as Window & { __onwardPromptInputShortcutsDebug?: PromptInputShortcutsDebugApi }
    let debugApi: PromptInputShortcutsDebugApi | undefined
    if (window.electronAPI?.debug?.autotest) {
      dispatchHoldForAutotest = { held: false, events: [] }
      continuationHoldForAutotest = { held: false, events: [] }
      debugApi = {
        setDispatchHeld: (held) => {
          const hold = dispatchHoldForAutotest
          if (!hold) return
          hold.held = held
          if (!held) {
            const pending = hold.events.splice(0)
            for (const event of pending) handleShortcut(event)
          }
        },
        getHeldDispatchCount: () => dispatchHoldForAutotest?.events.length ?? 0,
        setContinuationsHeld: (held) => {
          const hold = continuationHoldForAutotest
          if (!hold) return
          hold.held = held
          if (!held) {
            const pending = hold.events.splice(0)
            for (const event of pending) handleShortcut(event)
          }
        },
        getHeldContinuationCount: () => continuationHoldForAutotest?.events.length ?? 0,
        getLeaderState: () => leaderStateRef.current ? { ...leaderStateRef.current } : null
      }
      debugWindow.__onwardPromptInputShortcutsDebug = debugApi
    }
    return () => {
      dispatchHoldForAutotest = null
      continuationHoldForAutotest = null
      if (debugApi && debugWindow.__onwardPromptInputShortcutsDebug === debugApi) {
        delete debugWindow.__onwardPromptInputShortcutsDebug
      }
      armedOwnerRef.current = null
      leaderStateRef.current = null
      publishLeaderState(null)
      unsubscribe()
      void api.cancel('unmount').catch(() => {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'cancel-failed' })
      })
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'unmount' })
    }
  }, [dispatchInputAction, t, setLeaderState, publishLeaderState])

  useLayoutEffect(() => {
    armedOwnerRef.current = null
    setLeaderState(null)
    setBridgeNotice(null)
  }, [tabId, contextBlocked])

  const notice = bridgeNotice || (promptHidden && inputState.notice?.error ? inputState.notice : null)
  const [dismissedNotice, setDismissedNotice] = useState<typeof notice>(null)
  useEffect(() => {
    if (notice) perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'error-notice-shown' })
  }, [notice])
  return notice && notice !== dismissedNotice ? <aside className="prompt-input-global-notice" role="alert">
    <span>{notice.text}</span>
    <button type="button" aria-label={t('common.close')} onClick={() => {
      setDismissedNotice(notice)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_SHORTCUT, { phase: 'error-notice-dismissed' })
    }}>×</button>
  </aside> : null
})
